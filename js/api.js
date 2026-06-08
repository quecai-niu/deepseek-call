'use strict';

/* ================================================================
 *  Backend APIs —— conversations + streaming chat
 * ================================================================ */
const ConversationAPI = {
  async listConversations() {
    const data = await this._request('/api/conversations');
    return data.conversations || [];
  },

  async createConversation(title) {
    const data = await this._request('/api/conversations', {
      method: 'POST',
      body: { title }
    });
    return data.conversation;
  },

  async getMessages(conversationId) {
    return this._request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
  },

  async updateConversation(conversationId, patch) {
    const data = await this._request(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: patch
    });
    return data.conversation;
  },

  async health() {
    return this._request('/api/health', { auth: false });
  },

  async _request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (options.auth !== false) {
      const token = await AuthService.getAccessToken();
      if (!token) throw new Error('请先登录。');
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      data = {};
    }

    if (!response.ok) {
      const err = new Error(data.message || `请求失败 (${response.status})`);
      err.code = data.error || 'api_error';
      throw err;
    }

    return data;
  }
};

const DeepSeekAPI = {
  _controller: null,
  _streaming: false,

  /**
   * Send one user message through the backend chat API.
   * @param {Object} payload - { conversationId, content, model, thinking, effort, webSearch }
   * @param {Object} callbacks
   */
  async send(payload, callbacks) {
    const token = await AuthService.getAccessToken();
    if (!token) {
      callbacks.onError?.('unauthorized', '请先登录后再发送消息。');
      return;
    }

    this._controller = new AbortController();
    this._streaming = true;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: this._controller.signal
      });

      if (!response.ok) {
        this._streaming = false;
        const data = await safeJson(response);
        callbacks.onError?.(data.error || 'api_error', data.message || `请求失败 (${response.status})`);
        return;
      }

      await this._readSse(response, callbacks);
    } catch (err) {
      this._streaming = false;
      if (err.name === 'AbortError') {
        callbacks.onDone?.({ cancelled: true });
        return;
      }
      callbacks.onError?.('network', '网络连接失败，请检查后重试。');
    }
  },

  cancel() {
    if (this._controller && this._streaming) {
      this._controller.abort();
      this._streaming = false;
    }
  },

  isStreaming() {
    return this._streaming;
  },

  async _readSse(response, callbacks) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        this._handleSseChunk(chunk, callbacks);
      }
    }

    if (buffer.trim()) this._handleSseChunk(buffer, callbacks);
    this._streaming = false;
  },

  _handleSseChunk(chunk, callbacks) {
    let event = 'message';
    const dataLines = [];

    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }

    let data = {};
    try {
      data = dataLines.length ? JSON.parse(dataLines.join('\n')) : {};
    } catch (_) {
      data = {};
    }

    switch (event) {
      case 'conversation':
        callbacks.onConversation?.(data);
        break;
      case 'search_start':
        callbacks.onSearchStart?.();
        break;
      case 'search_progress':
        callbacks.onSearchProgress?.(data.query || '');
        break;
      case 'search_end':
        callbacks.onSearchEnd?.();
        break;
      case 'reasoning':
        callbacks.onReasoning?.(data.chunk || '');
        break;
      case 'content':
        callbacks.onContent?.(data.chunk || '');
        break;
      case 'done':
        this._streaming = false;
        callbacks.onDone?.(data);
        break;
      case 'error':
        this._streaming = false;
        callbacks.onError?.(data.error || 'api_error', data.message || '请求失败，请稍后再试。');
        break;
      default:
        break;
    }
  }
};

async function safeJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}
