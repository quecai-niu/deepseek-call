'use strict';

/* ================================================================
 *  DeepSeekAPI —— API 调用 + SSE 解析 + 联网搜索
 * ================================================================ */

/** 联网搜索工具定义（DeepSeek Function Calling） */
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索互联网获取实时信息。当用户询问时事、新闻、天气、股票、最新动态等需要实时数据的问题时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，尽量使用中文'
        }
      },
      required: ['query']
    }
  }
};

const DeepSeekAPI = {
  /** 当前 AbortController，用于取消请求 */
  _controller: null,
  /** 是否正在请求中 */
  _streaming: false,

  /**
   * 发送消息
   * @param {Array} messages - [{role, content}, ...]
   * @param {Object} callbacks - { onReasoning, onContent, onDone, onError, onSearchStart, onSearchProgress, onSearchEnd }
   */
  async send(messages, callbacks) {
    const apiKey = SettingsStore.getApiKey();
    if (!apiKey) {
      callbacks.onError('missing_key');
      return;
    }

    this._controller = new AbortController();
    this._streaming = true;

    try {
      const webSearchEnabled = SettingsStore.getWebSearch() && !!SettingsStore.getTavilyKey();

      if (webSearchEnabled) {
        const handled = await this._tryWebSearch(messages, callbacks);
        if (handled) return;
      }

      // 不走联网搜索，直接 stream
      await this._streamResponse(messages, callbacks);
    } catch (err) {
      this._streaming = false;
      if (err.name === 'AbortError') {
        callbacks.onDone();
        return;
      }
      callbacks.onError('network', '网络连接失败，请检查网络后重试。');
    }
  },

  /**
   * 尝试联网搜索流程（非 stream 判断 + 工具调用）
   * @returns {boolean} 是否已处理完成（true 表示已产生回答）
   */
  async _tryWebSearch(messages, callbacks) {
    callbacks.onSearchStart?.();

    // Step 1: 非 stream 请求 + tools
    const requestBody = this._buildRequestBody(messages, {
      tools: [WEB_SEARCH_TOOL],
      tool_choice: 'auto',
      stream: false
    });

    let data;
    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + SettingsStore.getApiKey(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: this._controller.signal
      });

      if (!resp.ok) {
        // 工具调用失败，回退到普通 stream
        callbacks.onSearchEnd?.();
        return false;
      }

      data = await resp.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // 网络异常，清理搜索状态后回退到普通 stream
      callbacks.onSearchEnd?.();
      return false;
    }
    const choice = data?.choices?.[0];
    const message = choice?.message;
    const toolCalls = message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // 模型认为不需要搜索，直接输出回答
      callbacks.onSearchEnd?.();
      if (message?.content) {
        callbacks.onContent(message.content);
        callbacks.onDone();
        return true;
      }
      return false;
    }

    // Step 2: 构造 assistant 消息（含 tool_calls）
    const assistantMsg = {
      role: 'assistant',
      content: message?.content || '',
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments }
      }))
    };

    // Step 3: 执行搜索
    const toolResults = [];
    for (const tc of toolCalls) {
      try {
        const args = JSON.parse(tc.function.arguments);
        const query = args.query || '';
        callbacks.onSearchProgress?.(query);
        const result = await this._tavilySearch(query);
        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: '搜索执行失败' });
      }
    }

    // Step 4: 带搜索结果重新请求（stream）
    callbacks.onSearchEnd?.();
    const enriched = [...messages, assistantMsg, ...toolResults];
    await this._streamResponse(enriched, callbacks);
    return true;
  },

  /**
   * 流式请求 DeepSeek 并解析 SSE
   * @param {Array} messages - 完整消息列表（含 tool 消息时已组装好）
   * @param {Object} callbacks
   */
  async _streamResponse(messages, callbacks) {
    const requestBody = this._buildRequestBody(messages, { stream: true });

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SettingsStore.getApiKey()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: this._controller.signal
    });

    if (!response.ok) {
      this._streaming = false;
      let errMsg = '';
      if (response.status === 401) {
        errMsg = 'API Key 无效，请检查设置。';
      } else if (response.status === 429) {
        errMsg = '请求过于频繁，请稍后再试。';
      } else if (response.status === 402) {
        errMsg = '账户余额不足，请充值。';
      } else if (response.status >= 500) {
        errMsg = 'DeepSeek 服务器错误，请稍后再试。';
      } else {
        try {
          const errBody = await response.json();
          errMsg = errBody?.error?.message || `请求失败 (${response.status})`;
        } catch (_) {
          errMsg = `请求失败 (${response.status})`;
        }
      }
      callbacks.onError('api_error', errMsg);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          this._streaming = false;
          callbacks.onDone();
          return;
        }

        try {
          const json = JSON.parse(dataStr);
          const delta = json?.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.reasoning_content) {
            callbacks.onReasoning(delta.reasoning_content);
          }

          if (delta.content) {
            callbacks.onContent(delta.content);
          }
        } catch (_) {
          // SSE 解析错误 —— 静默跳过
        }
      }

      await new Promise(r => setTimeout(r, 0));
    }

    this._streaming = false;
    callbacks.onDone();
  },

  /** 调用 Tavily 搜索 API */
  async _tavilySearch(query) {
    const apiKey = SettingsStore.getTavilyKey();
    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: query,
          search_depth: 'basic',
          max_results: 5
        }),
        signal: this._controller?.signal
      });
      if (!resp.ok) return `搜索失败 (${resp.status})`;
      const data = await resp.json();
      return (data.results || []).map(r => `- ${r.title}: ${r.content} (${r.url})`).join('\n') || '未找到相关结果';
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return `搜索异常: ${err.message}`;
    }
  },

  /**
   * 构建请求体
   * @param {Array} messages - 消息列表（不含 system prompt）
   * @param {Object} extra - 额外字段（tools, tool_choice, stream 等）
   */
  _buildRequestBody(messages, extra = {}) {
    const model = SettingsStore.getModel();
    const body = {
      model: model,
      messages: [
        { role: 'system', content: SettingsStore.buildSystemPrompt() },
        ...messages
      ],
      stream: extra.stream !== false,
      ...extra
    };

    // 思考模式
    const thinking = SettingsStore.getThinking();
    if (thinking) {
      body.thinking = { type: 'enabled' };
      if (extra.stream !== false) {
        body.reasoning_effort = SettingsStore.getEffort();
      }
    } else {
      body.thinking = { type: 'disabled' };
    }

    // 非 stream 请求删除 stream 字段
    if (extra.stream === false) {
      delete body.stream;
    }

    return body;
  },

  /** 取消当前请求 */
  cancel() {
    if (this._controller && this._streaming) {
      this._controller.abort();
      this._streaming = false;
    }
  },

  /** 是否正在流式输出中 */
  isStreaming() {
    return this._streaming;
  }
};
