'use strict';

/* ================================================================
 *  App —— main controller
 * ================================================================ */
const App = {
  _messages: [],
  _conversations: [],
  _activeConversationId: null,
  _currentAI: null,
  _currentContent: '',
  _currentReasoning: '',
  _warnedLongConversations: new Set(),

  _voiceState: 'idle',
  _voiceInput: null,
  _voiceOutput: null,
  _currentRequestId: 0,
  _interruptTimer: null,
  _voiceAvailable: false,
  _voiceOutputDisabled: false,

  async init() {
    this._bindDOM();
    this._loadSettings();
    this._syncModelSwitcher();
    this._syncEffortUI();
    this._updateSendBtn();
    this._autoFocusInput();
    this._initVoice();
    this._updateJsonPreview();
    this._checkBackendHealth();

    let authReady = false;
    await AuthService.init(() => {
      if (authReady) this._handleAuthChanged();
    });
    authReady = true;
    await this._handleAuthChanged(true);
  },

  _bindDOM() {
    document.getElementById('btnSend').addEventListener('click', () => this._handleSend());
    document.getElementById('btnNewConversation').addEventListener('click', () => this._startNewConversation());
    document.getElementById('btnLogout').addEventListener('click', () => this._handleSignOut());

    const inputBox = document.getElementById('inputBox');
    inputBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._handleSend();
      }
    });

    inputBox.addEventListener('input', () => {
      this._updateSendBtn();
      inputBox.style.height = 'auto';
      inputBox.style.height = Math.min(inputBox.scrollHeight, 120) + 'px';
    });

    inputBox.addEventListener('focus', () => {
      setTimeout(() => inputBox.scrollIntoView({ behavior: 'smooth', block: 'end' }), 100);
    });

    document.querySelectorAll('.model-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.model-tag').forEach((item) => item.classList.remove('active'));
        btn.classList.add('active');
        const model = btn.dataset.model;
        SettingsStore.setModel(model);
        this._autoSetThinkingForModel(model);
        this._syncEffortSettingVisibility();
        this._updateJsonPreview();
      });
    });

    document.getElementById('btnSettings').addEventListener('click', () => this._openSettings());
    document.getElementById('btnClear').addEventListener('click', () => this._confirmNewConversation());

    document.getElementById('btnCloseSettings').addEventListener('click', () => this._closeSettings());
    document.getElementById('btnSaveSettings').addEventListener('click', () => this._saveAndClose());
    document.getElementById('btnClearConv').addEventListener('click', () => {
      this._startNewConversation();
      this._closeSettings();
    });

    document.getElementById('btnSignIn').addEventListener('click', () => this._handleSignIn());
    document.getElementById('btnSignUp').addEventListener('click', () => this._handleSignUp());
    document.getElementById('btnSignOut').addEventListener('click', () => this._handleSignOut());

    document.querySelectorAll('.effort-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.effort-opt').forEach((item) => item.classList.remove('active'));
        btn.classList.add('active');
        SettingsStore.setEffort(btn.dataset.effort);
        this._updateJsonPreview();
      });
    });

    document.getElementById('thinkingToggle').addEventListener('change', () => {
      const checked = document.getElementById('thinkingToggle').checked;
      SettingsStore.setThinking(checked);
      this._syncEffortSettingVisibility();
      this._updateJsonPreview();
    });

    document.getElementById('webSearchToggle').addEventListener('change', () => {
      SettingsStore.setWebSearch(document.getElementById('webSearchToggle').checked);
      this._updateJsonPreview();
    });

    const ttsRateSlider = document.getElementById('ttsRate');
    if (ttsRateSlider) {
      ttsRateSlider.addEventListener('input', () => {
        const valEl = document.getElementById('ttsRateValue');
        if (valEl) valEl.textContent = parseFloat(ttsRateSlider.value).toFixed(1) + 'x';
      });
      ttsRateSlider.addEventListener('change', () => {
        SettingsStore.setTtsRate(parseFloat(ttsRateSlider.value));
      });
    }

    document.getElementById('btnDiagnose').addEventListener('click', () => {
      window.open('voice-test.html', '_blank');
    });

    document.getElementById('btnTest').addEventListener('click', () => {
      location.href = 'test.html';
    });

    document.getElementById('settingsOverlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeSettings();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeSettings();
    });
  },

  _loadSettings() {
    const savedRate = SettingsStore.getTtsRate();
    const ttsRateEl = document.getElementById('ttsRate');
    if (ttsRateEl) {
      ttsRateEl.value = savedRate;
      const valEl = document.getElementById('ttsRateValue');
      if (valEl) valEl.textContent = savedRate.toFixed(1) + 'x';
    }

    document.getElementById('webSearchToggle').checked = SettingsStore.getWebSearch();
  },

  async _handleAuthChanged(initial = false) {
    this._syncAuthUI();

    if (!AuthService.isConfigured()) {
      this._resetConversationState('Supabase Auth 未配置');
      if (initial) this._openSettings();
      return;
    }

    if (!AuthService.getUser()) {
      this._resetConversationState('请先登录后开始对话');
      if (initial) this._openSettings();
      return;
    }

    await this._loadConversations({ selectLatest: initial });
  },

  _syncAuthUI() {
    const configured = AuthService.isConfigured();
    const user = AuthService.getUser();
    const email = user?.email || '';

    document.getElementById('authStateText').textContent = user ? email : configured ? '未登录' : 'Supabase 未配置';
    document.getElementById('btnLogout').style.display = user ? 'inline-flex' : 'none';
    document.getElementById('btnSignOut').style.display = user ? 'block' : 'none';
    document.getElementById('btnSignIn').disabled = !configured;
    document.getElementById('btnSignUp').disabled = !configured;
    document.getElementById('authEmailInput').disabled = !configured || Boolean(user);
    document.getElementById('authPasswordInput').disabled = !configured || Boolean(user);

    if (user) {
      document.getElementById('authEmailInput').value = email;
      this._setAuthMessage('已登录，历史对话会保存到云端。');
    } else if (!configured) {
      this._setAuthMessage('请先配置 SUPABASE_URL 和 SUPABASE_ANON_KEY。');
    } else {
      this._setAuthMessage('Supabase Auth 登录后会保存并恢复你的历史对话。');
    }

    const inputBox = document.getElementById('inputBox');
    inputBox.placeholder = user ? '输入消息...' : '请先登录...';
    this._updateSendBtn();
  },

  async _checkBackendHealth() {
    const statusEl = document.getElementById('backendConfigStatus');
    try {
      const health = await ConversationAPI.health();
      const parts = [];
      parts.push(health.supabaseConfigured ? 'Supabase 已配置' : 'Supabase 未配置');
      parts.push(health.deepseekConfigured ? 'DeepSeek 已配置' : 'DeepSeek 未配置');
      statusEl.textContent = parts.join('，');
      statusEl.classList.toggle('ok', health.supabaseConfigured && health.deepseekConfigured);
      statusEl.classList.toggle('warn', !health.supabaseConfigured || !health.deepseekConfigured);
    } catch (_) {
      statusEl.textContent = '后端未启动或不可访问';
      statusEl.classList.add('warn');
    }
  },

  async _handleSignIn() {
    const { email, password } = this._getAuthForm();
    if (!email || !password) {
      this._setAuthMessage('请输入邮箱和密码。');
      return;
    }
    try {
      this._setAuthMessage('正在登录...');
      await AuthService.signIn(email, password);
      await this._loadConversations({ selectLatest: true });
      this._closeSettings();
    } catch (err) {
      this._setAuthMessage(err.message || '登录失败。');
    }
  },

  async _handleSignUp() {
    const { email, password } = this._getAuthForm();
    if (!email || !password) {
      this._setAuthMessage('请输入邮箱和密码。');
      return;
    }
    try {
      this._setAuthMessage('正在注册...');
      await AuthService.signUp(email, password);
      if (AuthService.getUser()) {
        await this._loadConversations({ selectLatest: true });
        this._closeSettings();
      } else {
        this._setAuthMessage('注册成功，请按 Supabase 项目设置完成邮箱确认后登录。');
      }
    } catch (err) {
      this._setAuthMessage(err.message || '注册失败。');
    }
  },

  async _handleSignOut() {
    try {
      await AuthService.signOut();
      this._resetConversationState('请先登录后开始对话');
      this._openSettings();
    } catch (err) {
      this._setAuthMessage(err.message || '退出失败。');
    }
  },

  _getAuthForm() {
    return {
      email: document.getElementById('authEmailInput').value.trim(),
      password: document.getElementById('authPasswordInput').value
    };
  },

  _setAuthMessage(message) {
    document.getElementById('authMessage').textContent = message;
  },

  async _loadConversations(options = {}) {
    if (!AuthService.getUser()) return;

    try {
      this._conversations = await ConversationAPI.listConversations();
      this._renderConversationList();

      const activeStillExists = this._conversations.some((item) => item.id === this._activeConversationId);
      if (options.selectLatest && this._conversations.length && !activeStillExists) {
        await this._selectConversation(this._conversations[0].id);
      } else if (!this._conversations.length) {
        this._startNewConversation({ silent: true });
      } else {
        this._updateActiveTitle();
      }
    } catch (err) {
      ChatUI.addError(err.message || '加载对话失败。');
    }
  },

  _renderConversationList() {
    const listEl = document.getElementById('conversationList');
    listEl.innerHTML = '';

    if (!AuthService.getUser()) {
      listEl.innerHTML = '<div class="conversation-empty">登录后显示历史对话</div>';
      return;
    }

    if (!this._conversations.length) {
      listEl.innerHTML = '<div class="conversation-empty">还没有历史对话</div>';
      return;
    }

    for (const conversation of this._conversations) {
      const btn = document.createElement('button');
      btn.className = 'conversation-item';
      btn.classList.toggle('active', conversation.id === this._activeConversationId);
      btn.title = conversation.title || '新对话';
      btn.innerHTML = `
        <span class="conversation-title"></span>
        <span class="conversation-date">${this._formatDate(conversation.updated_at || conversation.created_at)}</span>
      `;
      btn.querySelector('.conversation-title').textContent = conversation.title || '新对话';
      btn.addEventListener('click', () => this._selectConversation(conversation.id));
      listEl.appendChild(btn);
    }
  },

  async _selectConversation(conversationId) {
    if (DeepSeekAPI.isStreaming()) DeepSeekAPI.cancel();

    this._activeConversationId = conversationId;
    this._messages = [];
    this._currentAI = null;
    this._currentContent = '';
    this._currentReasoning = '';
    ChatUI.clear();
    document.getElementById('emptyState').lastElementChild.textContent = AuthService.getUser() ? '开始新对话吧' : '请先登录后开始对话';
    this._renderConversationList();
    this._updateActiveTitle();

    try {
      const data = await ConversationAPI.getMessages(conversationId);
      this._activeConversationId = data.conversation.id;
      this._messages = data.messages || [];
      this._renderMessages(this._messages);
      this._upsertConversation(data.conversation);
    } catch (err) {
      ChatUI.addError(err.message || '加载消息失败。');
    }
  },

  _renderMessages(messages) {
    ChatUI.clear();
    for (const msg of messages) {
      if (msg.role === 'user') {
        const ui = ChatUI.addMessage('user');
        const textEl = ui.bubbleEl.querySelector('.msg-text');
        if (textEl) textEl.textContent = msg.content || '';
      } else if (msg.role === 'assistant') {
        const ui = ChatUI.addMessage('assistant');
        const textEl = ui.bubbleEl.querySelector('.msg-text');
        if (textEl) textEl.textContent = msg.content || '';
        if (msg.reasoning_content) {
          ui.reasoningWrapEl.style.display = 'block';
          ui.reasoningContentEl.classList.remove('collapsed');
          const icon = ui.reasoningWrapEl.querySelector('.reasoning-icon');
          if (icon) icon.classList.add('open');
          ui.reasoningContentEl.textContent = msg.reasoning_content;
        }
      }
    }
  },

  _upsertConversation(conversation) {
    if (!conversation?.id) return;
    const index = this._conversations.findIndex((item) => item.id === conversation.id);
    if (index >= 0) {
      this._conversations[index] = { ...this._conversations[index], ...conversation };
    } else {
      this._conversations.unshift(conversation);
    }
    this._conversations.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    this._renderConversationList();
    this._updateActiveTitle();
  },

  _startNewConversation(options = {}) {
    if (DeepSeekAPI.isStreaming()) DeepSeekAPI.cancel();
    if (this._voiceInput) this._voiceInput.stop();
    if (this._voiceOutput) this._voiceOutput.stop();
    this._voiceState = 'idle';
    this._activeConversationId = null;
    this._messages = [];
    this._currentAI = null;
    this._currentContent = '';
    this._currentReasoning = '';
    ChatUI.clear();
    this._renderConversationList();
    this._updateActiveTitle();
    this._updateVoiceUI();
    this._updateSendBtn();
    if (!options.silent) this._autoFocusInput();
  },

  _confirmNewConversation() {
    if (this._messages.length && !window.confirm('开始新对话？当前对话会保留在历史列表中。')) return;
    this._startNewConversation();
  },

  _resetConversationState(emptyText) {
    this._activeConversationId = null;
    this._messages = [];
    this._conversations = [];
    ChatUI.clear();
    document.getElementById('emptyState').lastElementChild.textContent = emptyText || '开始和 DeepSeek 对话吧';
    this._renderConversationList();
    this._updateActiveTitle();
    this._updateSendBtn();
  },

  _updateActiveTitle() {
    const active = this._conversations.find((item) => item.id === this._activeConversationId);
    document.getElementById('activeTitle').textContent = active?.title || '新对话';
    this._renderConversationList();
  },

  _formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  },

  _syncModelSwitcher() {
    const model = SettingsStore.getModel();
    document.querySelectorAll('.model-tag').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.model === model);
    });
    document.getElementById('thinkingToggle').checked = SettingsStore.getThinking();
    this._syncEffortSettingVisibility();
    this._updateJsonPreview();
  },

  _autoSetThinkingForModel(model) {
    const shouldThink = SettingsStore.THINKING_MODELS.includes(model);
    SettingsStore.setThinking(shouldThink);
    document.getElementById('thinkingToggle').checked = shouldThink;
  },

  _syncEffortSettingVisibility() {
    const thinking = SettingsStore.getThinking();
    document.getElementById('effortGroup').style.display = thinking ? 'block' : 'none';
  },

  _syncEffortUI() {
    const effort = SettingsStore.getEffort();
    document.querySelectorAll('.effort-opt').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.effort === effort);
    });
  },

  _updateSendBtn() {
    const inputBox = document.getElementById('inputBox');
    const btnSend = document.getElementById('btnSend');
    const hasText = inputBox.value.trim().length > 0;
    const streaming = DeepSeekAPI.isStreaming();
    const signedIn = Boolean(AuthService.getUser());

    if (streaming) {
      btnSend.disabled = false;
      btnSend.classList.add('stop');
      btnSend.innerHTML = '';
    } else {
      btnSend.classList.remove('stop');
      btnSend.innerHTML = '&#9654;';
      btnSend.disabled = !hasText || !signedIn;
    }

    if (this._voiceState !== 'idle' && !streaming) {
      btnSend.disabled = !hasText || !signedIn;
    }
  },

  _autoFocusInput() {
    if (this._voiceState !== 'idle') return;
    setTimeout(() => {
      document.getElementById('inputBox').focus();
    }, 300);
  },

  async _handleSend() {
    if (DeepSeekAPI.isStreaming()) {
      DeepSeekAPI.cancel();
      this._updateSendBtn();
      return;
    }

    if (!AuthService.getUser()) {
      this._openSettings();
      ChatUI.addError('请先登录后再发送消息。');
      return;
    }

    if (this._voiceState === 'ai_speaking' || this._voiceState === 'ai_thinking') {
      if (this._voiceOutput) this._voiceOutput.stop();
      this._currentRequestId += 1;
      DeepSeekAPI.cancel();
      this._currentAI = null;
      this._currentContent = '';
      this._currentReasoning = '';
    }

    const inputBox = document.getElementById('inputBox');
    const content = inputBox.value.trim();
    if (!content) return;

    if (this._messages.length >= 1000) {
      ChatUI.addError('当前对话已达到上限，请开始新对话。');
      return;
    }
    if (this._messages.length >= 500 && !this._warnedLongConversations.has(this._activeConversationId || 'new')) {
      this._warnedLongConversations.add(this._activeConversationId || 'new');
      ChatUI.addError('当前对话已经很长，建议适时开始新对话。历史不会删除。');
    }

    this._appendUserMessage(content);
    inputBox.value = '';
    inputBox.style.height = 'auto';
    this._autoFocusInput();

    this._sendAIMessage(content);
  },

  _appendUserMessage(content) {
    const userUI = ChatUI.addMessage('user');
    const userTextEl = userUI.bubbleEl.querySelector('.msg-text');
    if (userTextEl) userTextEl.textContent = content;
    this._messages.push({ role: 'user', content });
  },

  _sendAIMessage(content) {
    this._currentRequestId += 1;
    const requestId = this._currentRequestId;

    const aiUI = ChatUI.addMessage('assistant');
    const aiTextEl = aiUI.bubbleEl.querySelector('.msg-text');
    if (aiTextEl) aiTextEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    this._currentAI = aiUI;
    this._currentContent = '';
    this._currentReasoning = '';

    if (this._voiceState !== 'idle') this._transition('ai_thinking');
    this._updateSendBtn();

    DeepSeekAPI.send({
      conversationId: this._activeConversationId,
      content,
      model: SettingsStore.getModel(),
      thinking: SettingsStore.getThinking(),
      effort: SettingsStore.getEffort(),
      webSearch: SettingsStore.getWebSearch()
    }, {
      onConversation: (data) => {
        if (requestId !== this._currentRequestId) return;
        if (data.conversation) {
          this._activeConversationId = data.conversation.id;
          this._upsertConversation(data.conversation);
        }
      },
      onSearchStart: () => {
        ChatUI.addSearchStatus('');
        if (this._voiceState !== 'idle') this._transition('ai_thinking');
      },
      onSearchProgress: (query) => {
        ChatUI.updateSearchStatus(query);
      },
      onSearchEnd: () => {
        ChatUI.removeSearchStatus();
      },
      onReasoning: (chunk) => {
        if (requestId !== this._currentRequestId) return;
        if (this._currentAI) {
          this._currentReasoning += chunk;
          ChatUI.appendReasoning(
            this._currentAI.reasoningWrapEl,
            this._currentAI.reasoningContentEl,
            chunk
          );
        }
      },
      onContent: (chunk) => {
        if (requestId !== this._currentRequestId) return;
        if (this._currentAI) {
          this._currentContent += chunk;
          ChatUI.updateBubble(this._currentAI.bubbleEl, chunk);
        }
        if (this._voiceOutput && !this._voiceOutputDisabled) {
          this._voiceOutput.feedChunk(chunk);
          if (this._voiceState === 'ai_thinking') this._transition('ai_speaking');
        }
      },
      onDone: (data) => {
        if (requestId !== this._currentRequestId) return;
        ChatUI.removeSearchStatus();
        if (this._voiceOutput) this._voiceOutput.flush();

        if (data?.cancelled && !this._currentContent && this._currentAI) {
          const doneTextEl = this._currentAI.bubbleEl.querySelector('.msg-text');
          if (doneTextEl) doneTextEl.textContent = '(已停止)';
        } else if (this._currentContent || this._currentReasoning) {
          const msg = {
            role: 'assistant',
            content: this._currentContent,
            reasoning_content: this._currentReasoning
          };
          if (data?.assistantMessage?.id) msg.id = data.assistantMessage.id;
          this._messages.push(msg);
        } else if (this._currentAI) {
          const doneTextEl = this._currentAI.bubbleEl.querySelector('.msg-text');
          if (doneTextEl) doneTextEl.textContent = '(未收到回复)';
        }

        if (data?.conversation) this._upsertConversation(data.conversation);
        if (this._voiceState === 'ai_thinking' && !this._voiceOutput) this._transition('idle');
        this._currentAI = null;
        this._currentContent = '';
        this._currentReasoning = '';
        this._updateSendBtn();
      },
      onError: (type, msg) => {
        if (requestId !== this._currentRequestId) return;
        ChatUI.removeSearchStatus();
        if (this._currentAI) {
          const textEl = this._currentAI.bubbleEl.querySelector('.msg-text');
          if (textEl) textEl.textContent = '(请求失败)';
        }
        this._currentAI = null;
        this._currentContent = '';
        this._currentReasoning = '';
        this._updateSendBtn();
        if (type === 'unauthorized') this._openSettings();
        if (this._voiceState !== 'idle') this._transition('idle');
        ChatUI.addError(msg || '请求失败，请稍后再试。');
      }
    });
  },

  _initVoice() {
    this._voiceAvailable = VoiceInput.isAvailable();
    const btnCall = document.getElementById('btnCall');
    if (this._voiceAvailable) {
      btnCall.addEventListener('click', () => this._handleCallToggle());
    } else {
      btnCall.classList.add('disabled');
      btnCall.title = '您的浏览器不支持语音识别';
      btnCall.addEventListener('click', () => this._showVoiceToast());
    }
  },

  _transition(newState) {
    this._voiceState = newState;
    this._updateVoiceUI();

    switch (newState) {
      case 'idle':
        if (this._voiceInput) this._voiceInput.stop();
        if (this._voiceOutput) this._voiceOutput.stop();
        this._currentRequestId += 1;
        DeepSeekAPI.cancel();
        this._currentAI = null;
        this._currentContent = '';
        this._currentReasoning = '';
        break;
      case 'listening':
        if (this._voiceInput) this._voiceInput.start();
        break;
      case 'ai_thinking':
        if (this._voiceInput) this._voiceInput.stop();
        break;
      default:
        break;
    }
  },

  _handleCallToggle() {
    switch (this._voiceState) {
      case 'idle':
        if (!AuthService.getUser()) {
          this._openSettings();
          ChatUI.addError('请先登录后再使用语音通话。');
          return;
        }

        this._voiceInput = VoiceInput.create({
          onSpeechStart: () => {
            if (this._voiceState === 'ai_speaking' || this._voiceState === 'ai_thinking') {
              this._interruptTimer = setTimeout(() => {
                if (this._voiceState === 'ai_speaking' || this._voiceState === 'ai_thinking') {
                  this._transition('idle');
                }
              }, 2000);
            } else {
              this._transition('user_speaking');
            }
          },
          onResult: (text) => {
            if (this._interruptTimer) {
              clearTimeout(this._interruptTimer);
              this._interruptTimer = null;
            }

            if (this._voiceState === 'ai_speaking' || this._voiceState === 'ai_thinking') {
              if (this._voiceOutput) this._voiceOutput.stop();
              this._currentRequestId += 1;
              DeepSeekAPI.cancel();
              this._currentAI = null;
              this._currentContent = '';
              this._currentReasoning = '';
            }

            this._appendUserMessage(text);
            this._sendAIMessage(text);
          },
          onError: (type) => {
            if (type === 'not-allowed') {
              this._showVoiceToast();
              this._transition('idle');
            } else if (type === 'not-available' || type === 'restart-failed') {
              this._transition('idle');
            }
          },
          onStateChange: () => {}
        }, 1500);

        if (!this._voiceInput) {
          this._transition('idle');
          return;
        }

        if (!('speechSynthesis' in window)) {
          this._voiceOutputDisabled = true;
          this._showVoiceOutputToast();
        } else {
          this._voiceOutputDisabled = false;
        }

        this._voiceOutput = VoiceOutput.create({
          getRate: () => SettingsStore.getTtsRate(),
          onStart: () => {},
          onEnd: () => {
            if (this._voiceState === 'ai_speaking') this._transition('listening');
          }
        });

        if (!this._voiceOutputDisabled) {
          const warmup = new SpeechSynthesisUtterance('');
          warmup.volume = 0;
          speechSynthesis.speak(warmup);
        }
        this._transition('listening');
        break;

      default:
        if (this._interruptTimer) {
          clearTimeout(this._interruptTimer);
          this._interruptTimer = null;
        }
        this._currentRequestId += 1;
        DeepSeekAPI.cancel();
        this._currentAI = null;
        this._currentContent = '';
        this._currentReasoning = '';
        this._transition('idle');
        break;
    }
  },

  _updateVoiceUI() {
    const btnCall = document.getElementById('btnCall');
    const voiceStatus = document.getElementById('voiceStatus');
    const statusText = document.getElementById('voiceStatusText');

    btnCall.classList.remove('idle', 'listening', 'ai-active');

    switch (this._voiceState) {
      case 'idle':
        btnCall.innerHTML = '&#128222;';
        btnCall.classList.add('idle');
        voiceStatus.style.display = 'none';
        break;
      case 'listening':
        btnCall.innerHTML = '&#128222;';
        btnCall.classList.add('listening');
        voiceStatus.style.display = 'flex';
        statusText.textContent = '正在聆听...';
        break;
      case 'user_speaking':
        btnCall.innerHTML = '&#128222;';
        btnCall.classList.add('listening');
        voiceStatus.style.display = 'flex';
        statusText.textContent = '识别中...';
        break;
      case 'ai_thinking':
        btnCall.innerHTML = '&#128222;';
        btnCall.classList.add('ai-active');
        voiceStatus.style.display = 'flex';
        statusText.textContent = 'AI 思考中...';
        break;
      case 'ai_speaking':
        btnCall.innerHTML = '&#128222;';
        btnCall.classList.add('ai-active');
        voiceStatus.style.display = 'flex';
        statusText.textContent = 'AI 回复中...';
        break;
    }
  },

  _showVoiceToast() {
    const existing = document.getElementById('voiceToast');
    if (existing) return;
    const toast = document.createElement('div');
    toast.id = 'voiceToast';
    toast.className = 'voice-toast';
    toast.textContent = '当前浏览器不支持语音识别，请使用 Chrome 或 Edge 浏览器';
    const messagesEl = document.getElementById('messages');
    messagesEl.insertBefore(toast, messagesEl.firstChild);
    setTimeout(() => { toast.remove(); }, 4000);
  },

  _showVoiceOutputToast() {
    const existing = document.getElementById('voiceToast');
    if (existing) return;
    const toast = document.createElement('div');
    toast.id = 'voiceToast';
    toast.className = 'voice-toast';
    toast.textContent = '当前浏览器不支持语音播报，AI 回复将以文字显示';
    const messagesEl = document.getElementById('messages');
    messagesEl.insertBefore(toast, messagesEl.firstChild);
    setTimeout(() => { toast.remove(); }, 4000);
  },

  _openSettings() {
    document.getElementById('settingsOverlay').classList.remove('hidden');
    document.getElementById('thinkingToggle').checked = SettingsStore.getThinking();
    this._syncEffortSettingVisibility();
    this._syncEffortUI();

    const savedRate = SettingsStore.getTtsRate();
    const ttsRateEl = document.getElementById('ttsRate');
    if (ttsRateEl) {
      ttsRateEl.value = savedRate;
      const valEl = document.getElementById('ttsRateValue');
      if (valEl) valEl.textContent = savedRate.toFixed(1) + 'x';
    }

    document.getElementById('webSearchToggle').checked = SettingsStore.getWebSearch();
    this._syncAuthUI();
    this._checkBackendHealth();
    this._updateJsonPreview();
  },

  _closeSettings() {
    document.getElementById('settingsOverlay').classList.add('hidden');
  },

  _saveAndClose() {
    SettingsStore.setThinking(document.getElementById('thinkingToggle').checked);

    const activeEffort = document.querySelector('.effort-opt.active');
    if (activeEffort) SettingsStore.setEffort(activeEffort.dataset.effort);

    const ttsRateEl = document.getElementById('ttsRate');
    if (ttsRateEl) SettingsStore.setTtsRate(parseFloat(ttsRateEl.value));

    SettingsStore.setWebSearch(document.getElementById('webSearchToggle').checked);
    this._updateJsonPreview();
    this._closeSettings();
  },

  _updateJsonPreview() {
    const body = {
      conversationId: this._activeConversationId || null,
      content: '用户消息...',
      model: SettingsStore.getModel(),
      thinking: SettingsStore.getThinking(),
      effort: SettingsStore.getEffort(),
      webSearch: SettingsStore.getWebSearch()
    };
    const previewEl = document.getElementById('jsonPreview');
    if (previewEl) previewEl.value = JSON.stringify(body, null, 2);
  }
};

App.init();
