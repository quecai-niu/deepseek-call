'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT_DIR = path.resolve(__dirname, '..');

loadDotEnv(path.join(ROOT_DIR, '.env'));

const CONFIG = {
  port: Number(process.env.PORT || 5173),
  supabaseUrl: stripTrailingSlash(process.env.SUPABASE_URL || ''),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  contextMessageLimit: Number(process.env.CONTEXT_MESSAGE_LIMIT || 80),
  contextCharBudget: Number(process.env.CONTEXT_CHAR_BUDGET || 32000)
};

const ALLOWED_MODELS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner'
]);

const THINKING_MODELS = new Set(['deepseek-reasoner', 'deepseek-v4-pro']);

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the internet for current facts when the user asks about news, weather, stocks, recent events, or other time-sensitive information.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        }
      },
      required: ['query']
    }
  }
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav'
};

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/config.js') {
      sendConfig(res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res, url);
      return;
    }

    serveStatic(url, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'server_error', message: '服务器内部错误。' });
    } else {
      res.end();
    }
  }
});

server.listen(CONFIG.port, () => {
  console.log(`DeepSeek Chat server listening on http://localhost:${CONFIG.port}`);
});

async function routeApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      supabaseConfigured: isSupabaseConfigured(),
      deepseekConfigured: Boolean(CONFIG.deepseekApiKey)
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    const user = await requireUser(req, res);
    if (!user) return;
    const conversations = await listConversations(user.id);
    sendJson(res, 200, { conversations });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/conversations') {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const title = normalizeTitle(body.title || '新对话');
    const conversation = await createConversation(user.id, title);
    sendJson(res, 201, { conversation });
    return;
  }

  const messagesMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (req.method === 'GET' && messagesMatch) {
    const user = await requireUser(req, res);
    if (!user) return;
    const conversationId = messagesMatch[1];
    const conversation = await getConversationForUser(conversationId, user.id);
    if (!conversation) {
      sendJson(res, 404, { error: 'not_found', message: '对话不存在。' });
      return;
    }
    const messages = await listMessages(conversationId, user.id);
    sendJson(res, 200, { conversation, messages });
    return;
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (req.method === 'PATCH' && conversationMatch) {
    const user = await requireUser(req, res);
    if (!user) return;
    const conversationId = conversationMatch[1];
    const conversation = await getConversationForUser(conversationId, user.id);
    if (!conversation) {
      sendJson(res, 404, { error: 'not_found', message: '对话不存在。' });
      return;
    }
    const body = await readJson(req);
    const patch = {};
    if (typeof body.title === 'string') patch.title = normalizeTitle(body.title);
    if (body.archived === true) patch.archived_at = new Date().toISOString();
    if (body.archived === false) patch.archived_at = null;
    patch.updated_at = new Date().toISOString();
    const updated = await updateConversation(conversationId, user.id, patch);
    sendJson(res, 200, { conversation: updated });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    await handleChat(req, res);
    return;
  }

  sendJson(res, 404, { error: 'not_found', message: '接口不存在。' });
}

async function handleChat(req, res) {
  if (!CONFIG.deepseekApiKey) {
    sendJson(res, 503, { error: 'config_missing', message: '后端缺少 DEEPSEEK_API_KEY。' });
    return;
  }

  const user = await requireUser(req, res);
  if (!user) return;

  const body = await readJson(req);
  const content = String(body.content || '').trim();
  if (!content) {
    sendJson(res, 400, { error: 'empty_message', message: '消息不能为空。' });
    return;
  }
  if (content.length > 20000) {
    sendJson(res, 400, { error: 'message_too_long', message: '单条消息过长。' });
    return;
  }

  let conversation = null;
  if (body.conversationId) {
    conversation = await getConversationForUser(String(body.conversationId), user.id);
    if (!conversation) {
      sendJson(res, 404, { error: 'not_found', message: '对话不存在。' });
      return;
    }
  } else {
    conversation = await createConversation(user.id, deriveTitle(content));
  }

  const userMessage = await insertMessage({
    conversationId: conversation.id,
    userId: user.id,
    role: 'user',
    content,
    model: normalizeModel(body.model)
  });

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  beginSse(res);
  writeSse(res, 'conversation', { conversation, userMessage });

  try {
    const contextRows = await listRecentMessages(conversation.id, user.id, CONFIG.contextMessageLimit);
    const contextMessages = buildContextMessages(contextRows);
    const requestBodyBase = {
      model: normalizeModel(body.model),
      messages: [
        { role: 'system', content: buildSystemPrompt(body) },
        ...trimContextMessages(contextMessages, CONFIG.contextCharBudget)
      ],
      stream: true
    };

    applyThinkingOptions(requestBodyBase, body);

    const prepared = await prepareWebSearchIfNeeded({
      body,
      requestBodyBase,
      conversationId: conversation.id,
      userId: user.id,
      signal: abortController.signal,
      res
    });

    if (prepared.handled) {
      await finalizeAssistantMessage({
        conversation,
        userId: user.id,
        content: prepared.content,
        reasoningContent: '',
        model: requestBodyBase.model,
        res
      });
      return;
    }

    const assistant = await streamDeepSeek(prepared.requestBody, res, abortController.signal);
    await finalizeAssistantMessage({
      conversation,
      userId: user.id,
      content: assistant.content,
      reasoningContent: assistant.reasoningContent,
      model: requestBodyBase.model,
      res
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    writeSse(res, 'error', {
      error: err.code || 'chat_error',
      message: err.publicMessage || '请求失败，请稍后再试。'
    });
    res.end();
  }
}

async function prepareWebSearchIfNeeded({ body, requestBodyBase, conversationId, userId, signal, res }) {
  const webSearch = Boolean(body.webSearch) && Boolean(CONFIG.tavilyApiKey);
  if (!webSearch) {
    return { handled: false, requestBody: requestBodyBase };
  }

  writeSse(res, 'search_start', {});

  const decisionBody = {
    ...requestBodyBase,
    stream: false,
    tools: [WEB_SEARCH_TOOL],
    tool_choice: 'auto'
  };
  delete decisionBody.reasoning_effort;

  const decision = await deepSeekJson(decisionBody, signal);
  const message = decision?.choices?.[0]?.message;
  const toolCalls = message?.tool_calls || [];

  if (!toolCalls.length) {
    writeSse(res, 'search_end', {});
    if (message?.content) {
      writeSse(res, 'content', { chunk: message.content });
      return { handled: true, content: message.content };
    }
    return { handled: false, requestBody: requestBodyBase };
  }

  const assistantMsg = {
    role: 'assistant',
    content: message?.content || '',
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: toolCall.type,
      function: {
        name: toolCall.function?.name,
        arguments: toolCall.function?.arguments
      }
    }))
  };

  const toolResults = [];
  for (const toolCall of toolCalls) {
    let query = '';
    try {
      const args = JSON.parse(toolCall.function?.arguments || '{}');
      query = String(args.query || '').trim();
    } catch (_) {
      query = '';
    }

    writeSse(res, 'search_progress', { query });
    const output = query ? await tavilySearch(query, signal) : '搜索请求缺少 query。';
    toolResults.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: output
    });

    await insertToolRun({
      conversationId,
      userId,
      name: 'web_search',
      input: { query },
      output,
      status: 'completed'
    }).catch(() => {});
  }

  writeSse(res, 'search_end', {});
  return {
    handled: false,
    requestBody: {
      ...requestBodyBase,
      messages: [...requestBodyBase.messages, assistantMsg, ...toolResults]
    }
  };
}

async function finalizeAssistantMessage({ conversation, userId, content, reasoningContent, model, res }) {
  const assistantMessage = await insertMessage({
    conversationId: conversation.id,
    userId,
    role: 'assistant',
    content: content || '',
    reasoningContent: reasoningContent || '',
    model
  });

  const updatedConversation = await updateConversation(conversation.id, userId, {
    updated_at: new Date().toISOString()
  });

  writeSse(res, 'done', {
    conversation: updatedConversation,
    assistantMessage
  });
  res.end();
}

async function streamDeepSeek(requestBody, res, signal) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.deepseekApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const message = await getDeepSeekErrorMessage(response);
    const err = new Error(message);
    err.publicMessage = message;
    err.code = 'deepseek_error';
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoningContent = '';

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
        return { content, reasoningContent };
      }

      try {
        const json = JSON.parse(dataStr);
        const delta = json?.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          writeSse(res, 'reasoning', { chunk: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          writeSse(res, 'content', { chunk: delta.content });
        }
      } catch (_) {
        // Ignore malformed chunks and keep the stream alive.
      }
    }
  }

  return { content, reasoningContent };
}

async function deepSeekJson(requestBody, signal) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.deepseekApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const message = await getDeepSeekErrorMessage(response);
    const err = new Error(message);
    err.publicMessage = message;
    err.code = 'deepseek_error';
    throw err;
  }

  return response.json();
}

async function tavilySearch(query, signal) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: CONFIG.tavilyApiKey,
        query,
        search_depth: 'basic',
        max_results: 5
      }),
      signal
    });

    if (!response.ok) return `搜索失败 (${response.status})`;
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item) => `- ${item.title}: ${item.content} (${item.url})`).join('\n') || '未找到相关结果';
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return `搜索异常: ${err.message}`;
  }
}

function buildContextMessages(rows) {
  return rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => {
      const message = {
        role: row.role,
        content: row.content || ''
      };
      if (row.role === 'assistant' && row.reasoning_content) {
        message.content = `${row.reasoning_content}\n\n${row.content || ''}`.trim();
      }
      return message;
    });
}

function trimContextMessages(messages, charBudget) {
  const result = [];
  let total = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    const size = (item.content || '').length + item.role.length;
    if (result.length && total + size > charBudget) break;
    result.unshift(item);
    total += size;
  }

  return result;
}

function buildSystemPrompt(body) {
  const model = normalizeModel(body.model);
  const thinking = normalizeThinking(body);
  let prompt = '你是一个有帮助的AI助手。\n\n';
  prompt += `当前运行模型：${model}。`;
  if (thinking) {
    const effort = normalizeEffort(body.effort);
    const effortMap = { low: '低', medium: '中', high: '高', max: '最高' };
    prompt += `思考模式已开启，推理深度为：${effortMap[effort] || effort}。`;
  } else {
    prompt += '思考模式未开启。';
  }
  return prompt;
}

function applyThinkingOptions(requestBody, body) {
  if (normalizeThinking(body)) {
    requestBody.thinking = { type: 'enabled' };
    requestBody.reasoning_effort = normalizeEffort(body.effort);
  } else {
    requestBody.thinking = { type: 'disabled' };
  }
}

async function requireUser(req, res) {
  if (!isSupabaseConfigured()) {
    sendJson(res, 503, { error: 'config_missing', message: '后端缺少 Supabase 环境变量。' });
    return null;
  }

  const token = getBearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: 'unauthorized', message: '请先登录。' });
    return null;
  }

  const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: CONFIG.supabaseAnonKey,
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效，请重新登录。' });
    return null;
  }

  const user = await response.json();
  await ensureProfile(user).catch(() => {});
  return { id: user.id, email: user.email || '' };
}

async function ensureProfile(user) {
  if (!user?.id) return;
  await supabaseRest('profiles?on_conflict=id', {
    method: 'POST',
    body: {
      id: user.id,
      email: user.email || null,
      updated_at: new Date().toISOString()
    },
    prefer: 'resolution=merge-duplicates,return=minimal'
  });
}

async function listConversations(userId) {
  return supabaseRest(`conversations?select=id,title,created_at,updated_at,archived_at&user_id=eq.${encodeURIComponent(userId)}&archived_at=is.null&order=updated_at.desc`, {
    method: 'GET'
  });
}

async function createConversation(userId, title) {
  const rows = await supabaseRest('conversations', {
    method: 'POST',
    body: {
      user_id: userId,
      title: normalizeTitle(title),
      updated_at: new Date().toISOString()
    }
  });
  return rows[0];
}

async function getConversationForUser(conversationId, userId) {
  const rows = await supabaseRest(`conversations?select=id,title,created_at,updated_at,archived_at&user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(conversationId)}&limit=1`, {
    method: 'GET'
  });
  return rows[0] || null;
}

async function updateConversation(conversationId, userId, patch) {
  const rows = await supabaseRest(`conversations?id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: patch
  });
  return rows[0] || null;
}

async function insertMessage({ conversationId, userId, role, content, reasoningContent = '', model = '' }) {
  const rows = await supabaseRest('messages', {
    method: 'POST',
    body: {
      conversation_id: conversationId,
      user_id: userId,
      role,
      content: content || '',
      reasoning_content: reasoningContent || null,
      model: model || null,
      token_count: estimateTokenCount(`${reasoningContent || ''}\n${content || ''}`)
    }
  });
  return rows[0];
}

async function insertToolRun({ conversationId, userId, name, input, output, status }) {
  const rows = await supabaseRest('tool_runs', {
    method: 'POST',
    body: {
      conversation_id: conversationId,
      user_id: userId,
      name,
      input,
      output,
      status
    }
  });
  return rows[0];
}

async function listMessages(conversationId, userId) {
  return supabaseRest(`messages?select=id,conversation_id,role,content,reasoning_content,model,token_count,created_at&conversation_id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${encodeURIComponent(userId)}&order=created_at.asc`, {
    method: 'GET'
  });
}

async function listRecentMessages(conversationId, userId, limit) {
  const rows = await supabaseRest(`messages?select=role,content,reasoning_content,created_at&conversation_id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=${Number(limit) || 80}`, {
    method: 'GET'
  });
  return rows.reverse();
}

async function supabaseRest(pathname, options = {}) {
  if (!isSupabaseConfigured()) {
    const err = new Error('Supabase is not configured.');
    err.publicMessage = '后端缺少 Supabase 环境变量。';
    err.code = 'config_missing';
    throw err;
  }

  const headers = {
    apikey: CONFIG.supabaseServiceRoleKey,
    'Content-Type': 'application/json'
  };
  if (CONFIG.supabaseServiceRoleKey.startsWith('eyJ')) {
    headers.Authorization = `Bearer ${CONFIG.supabaseServiceRoleKey}`;
  }

  if (options.prefer !== false) {
    headers.Prefer = options.prefer || 'return=representation';
  }

  const response = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(text || `Supabase request failed (${response.status})`);
    err.publicMessage = '数据库请求失败。';
    err.code = 'supabase_error';
    throw err;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function getDeepSeekErrorMessage(response) {
  if (response.status === 401) return 'DeepSeek API Key 无效，请检查后端配置。';
  if (response.status === 429) return '请求过于频繁，请稍后再试。';
  if (response.status === 402) return 'DeepSeek 账户余额不足，请充值。';
  if (response.status >= 500) return 'DeepSeek 服务器错误，请稍后再试。';
  try {
    const body = await response.json();
    return body?.error?.message || `请求失败 (${response.status})`;
  } catch (_) {
    return `请求失败 (${response.status})`;
  }
}

function sendConfig(res) {
  const publicConfig = {
    supabaseUrl: CONFIG.supabaseUrl,
    supabaseAnonKey: CONFIG.supabaseAnonKey,
    supabaseConfigured: Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey)
  };
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(`window.APP_CONFIG = ${JSON.stringify(publicConfig)};\n`);
}

function beginSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}

function writeSse(res, event, data) {
  if (res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    const err = new Error('Invalid JSON');
    err.publicMessage = '请求体不是合法 JSON。';
    err.code = 'invalid_json';
    throw err;
  }
}

function serveStatic(url, res) {
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    sendJson(res, 400, { error: 'bad_request', message: '路径无效。' });
    return;
  }

  const filePath = path.normalize(path.join(ROOT_DIR, decoded));
  if (!filePath.startsWith(ROOT_DIR)) {
    sendJson(res, 403, { error: 'forbidden', message: '禁止访问。' });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not_found', message: '文件不存在。' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function applyCors(req, res) {
  const origin = process.env.CORS_ORIGIN || req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function isSupabaseConfigured() {
  return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && CONFIG.supabaseServiceRoleKey);
}

function normalizeModel(model) {
  return ALLOWED_MODELS.has(model) ? model : 'deepseek-v4-flash';
}

function normalizeThinking(body) {
  const model = normalizeModel(body.model);
  if (!THINKING_MODELS.has(model)) return false;
  if (typeof body.thinking === 'boolean') return body.thinking;
  return true;
}

function normalizeEffort(effort) {
  return ['low', 'medium', 'high', 'max'].includes(effort) ? effort : 'high';
}

function normalizeTitle(title) {
  const cleaned = String(title || '新对话').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 60) || '新对话';
}

function deriveTitle(content) {
  return normalizeTitle(content).slice(0, 32);
}

function estimateTokenCount(text) {
  return Math.ceil(String(text || '').length / 2);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}
