'use strict';

/* ================================================================
 *  DeepSeekAPI —— API 调用 + SSE 解析
 * ================================================================ */
const DeepSeekAPI = {
  /** 当前 AbortController，用于取消请求 */
  _controller: null,
  /** 是否正在请求中 */
  _streaming: false,

  /**
   * 发送消息并流式返回
   * @param {Array} messages - [{role, content}, ...]
   * @param {Object} callbacks - { onReasoning, onContent, onDone, onError }
   */
  async send(messages, callbacks) {
    const apiKey = SettingsStore.getApiKey();
    if (!apiKey) {
      callbacks.onError('missing_key');
      return;
    }

    const model = SettingsStore.getModel();
    const body = {
      model: model,
      messages: [{ role: 'system', content: SettingsStore.buildSystemPrompt() }, ...messages],
      stream: true
    };

    // 思考模式
    const thinking = SettingsStore.getThinking();
    if (thinking) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = SettingsStore.getEffort();
    } else {
      body.thinking = { type: 'disabled' };
    }

    this._controller = new AbortController();
    this._streaming = true;

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
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
          // 尝试读取 body 中的错误信息
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

        // 按行解析 SSE
        const lines = buffer.split('\n');
        // 最后一行可能不完整，保留到下次
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

            // reasoning_content（R1 模型的思考过程）
            if (delta.reasoning_content) {
              callbacks.onReasoning(delta.reasoning_content);
            }

            // content（最终回答）
            if (delta.content) {
              callbacks.onContent(delta.content);
            }
          } catch (_) {
            // SSE 解析错误 —— 静默跳过
          }
        }

        // 每处理完一批 lines，让出主线程避免卡顿
        await new Promise(r => setTimeout(r, 0));
      }

      // stream 结束时如果没有 [DONE] 标记
      this._streaming = false;
      callbacks.onDone();
    } catch (err) {
      this._streaming = false;
      if (err.name === 'AbortError') {
        // 用户主动取消，不报错
        callbacks.onDone();
        return;
      }
      callbacks.onError('network', '网络连接失败，请检查网络后重试。');
    }
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
