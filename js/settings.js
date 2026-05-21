'use strict';

/* ================================================================
 *  SettingsStore —— localStorage 读写
 * ================================================================ */
const STORE_KEYS = {
  apiKey: 'ds_api_key',
  model: 'ds_model',
  effort: 'ds_effort',
  thinking: 'ds_thinking',
  messages: 'ds_messages'
};

const SettingsStore = {
  /** 需要开启思考的模型列表 */
  THINKING_MODELS: ['deepseek-reasoner', 'deepseek-v4-pro'],

  getApiKey() {
    try { return localStorage.getItem(STORE_KEYS.apiKey) || ''; } catch (_) { return ''; }
  },
  setApiKey(val) {
    try { localStorage.setItem(STORE_KEYS.apiKey, val); } catch (_) { /* 静默失败 */ }
  },
  getModel() {
    try { return localStorage.getItem(STORE_KEYS.model) || 'deepseek-v4-pro'; } catch (_) { return 'deepseek-v4-pro'; }
  },
  setModel(val) {
    try { localStorage.setItem(STORE_KEYS.model, val); } catch (_) { /* 静默失败 */ }
  },
  getEffort() {
    try { return localStorage.getItem(STORE_KEYS.effort) || 'high'; } catch (_) { return 'high'; }
  },
  setEffort(val) {
    try { localStorage.setItem(STORE_KEYS.effort, val); } catch (_) { /* 静默失败 */ }
  },
  getThinking() {
    try {
      const val = localStorage.getItem(STORE_KEYS.thinking);
      if (val !== null) return val === 'true';
      // 无记录时根据模型决定默认值
      return this.THINKING_MODELS.includes(this.getModel());
    } catch (_) { return true; }
  },
  setThinking(val) {
    try { localStorage.setItem(STORE_KEYS.thinking, val ? 'true' : 'false'); } catch (_) { /* 静默失败 */ }
  },
  getMessages() {
    try {
      const raw = localStorage.getItem(STORE_KEYS.messages);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  },
  saveMessages(arr) {
    try {
      const toSave = arr.slice(-100);
      localStorage.setItem(STORE_KEYS.messages, JSON.stringify(toSave));
    } catch (_) { /* localStorage 满或不可用 */ }
  },
  clearMessages() {
    try { localStorage.removeItem(STORE_KEYS.messages); } catch (_) { /* 静默失败 */ }
  },

  /** 动态构建 system prompt，包含当前模型和思考模式信息 */
  buildSystemPrompt() {
    const model = this.getModel();
    const thinking = this.getThinking();
    let prompt = '你是一个有帮助的AI助手。\n\n';
    prompt += `当前运行模型：${model}。`;
    if (thinking) {
      const effort = this.getEffort();
      const effortMap = { low: '低', medium: '中', high: '高', max: '最高' };
      const effortLabel = effortMap[effort] || effort;
      prompt += `思考模式已开启，推理深度为：${effortLabel}。`;
    } else {
      prompt += '思考模式未开启。';
    }
    return prompt;
  }
};
