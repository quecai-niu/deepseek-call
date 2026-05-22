'use strict';

/* ================================================================
 *  App —— 主控制器
 * ================================================================ */
const App = {
  /** 对话历史（不含 system prompt） */
  _messages: [],
  /** 当前 AI 消息的 UI 引用 */
  _currentAI: null,
  /** 当前 AI 消息累积的 content */
  _currentContent: '',
  /** 当前 AI 消息累积的 reasoning_content */
  _currentReasoning: '',

  /* ---- 语音状态 ---- */
  _voiceState: 'idle',               // idle | listening | user_speaking | ai_thinking | ai_speaking
  _voiceInput: null,                 // VoiceInput 实例
  _voiceOutput: null,                // VoiceOutput 实例
  _currentRequestId: 0,              // 请求 ID（打断时防回调竞态）
  _interruptTimer: null,             // 打断确认定时器
  _voiceAvailable: false,            // 浏览器是否支持语音识别
  _voiceOutputDisabled: false,       // 浏览器是否不支持语音播报

  /* ---- 初始化 ---- */
  init() {
    this._bindDOM();
    this._loadSettings();
    this._syncModelSwitcher();
    this._syncEffortUI();
    this._loadAndRenderMessages();
    this._updateSendBtn();
    this._autoFocusInput();

    // 首次使用无 Key 自动弹出设置
    if (!SettingsStore.getApiKey()) {
      this._openSettings();
    }

    // 点击遮罩层关闭
    document.getElementById('settingsOverlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeSettings();
    });

    // ESC 关闭设置
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeSettings();
    });

    this._initVoice();
  },

  _bindDOM() {
    // 发送按钮
    document.getElementById('btnSend').addEventListener('click', () => this._handleSend());

    // 输入框
    const inputBox = document.getElementById('inputBox');
    inputBox.addEventListener('keydown', (e) => {
      // Enter 发送，Shift+Enter 换行
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._handleSend();
      }
    });

    // 自动调整高度 + 更新发送按钮
    inputBox.addEventListener('input', () => {
      this._updateSendBtn();
      inputBox.style.height = 'auto';
      inputBox.style.height = Math.min(inputBox.scrollHeight, 120) + 'px';
    });

    // 移动端键盘弹起时防止遮挡
    inputBox.addEventListener('focus', () => {
      setTimeout(() => inputBox.scrollIntoView({ behavior: 'smooth', block: 'end' }), 100);
    });

    // 模型切换
    document.querySelectorAll('.model-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.model-tag').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const model = btn.dataset.model;
        SettingsStore.setModel(model);
        // 自动设置思考模式
        this._autoSetThinkingForModel(model);
        this._syncEffortSettingVisibility();
        this._updateJsonPreview();
      });
    });

    // 工具栏：设置
    document.getElementById('btnSettings').addEventListener('click', () => this._openSettings());
    // 工具栏：清空
    document.getElementById('btnClear').addEventListener('click', () => {
      if (!window.confirm('确定清空所有对话？')) return;
      this._clearConversation();
    });

    // 设置面板：关闭
    document.getElementById('btnCloseSettings').addEventListener('click', () => this._closeSettings());
    // 设置面板：保存
    document.getElementById('btnSaveSettings').addEventListener('click', () => this._saveAndClose());
    // 设置面板：清空对话
    document.getElementById('btnClearConv').addEventListener('click', () => {
      if (!window.confirm('确定清空所有对话？')) return;
      this._clearConversation();
      this._closeSettings();
    });
    // 设置面板：Key 可见切换
    document.getElementById('btnToggleVis').addEventListener('click', () => {
      const input = document.getElementById('apiKeyInput');
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      document.getElementById('btnToggleVis').textContent = isPass ? '👁‍🗨' : '👁';
    });
    // 设置面板：Effort 选项
    document.querySelectorAll('.effort-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.effort-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        SettingsStore.setEffort(btn.dataset.effort);
        this._updateJsonPreview();
      });
    });
    // 设置面板：思考模式开关
    document.getElementById('thinkingToggle').addEventListener('change', () => {
      const checked = document.getElementById('thinkingToggle').checked;
      SettingsStore.setThinking(checked);
      this._syncEffortSettingVisibility();
      this._updateJsonPreview();
    });

    // 联网搜索：toggle 显示/隐藏 Tavily Key 输入框
    document.getElementById('webSearchToggle').addEventListener('change', () => {
      this._syncWebSearchVisibility();
    });

    // Tavily Key 可见切换
    document.getElementById('btnToggleTavilyVis').addEventListener('click', () => {
      const input = document.getElementById('tavilyKeyInput');
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      document.getElementById('btnToggleTavilyVis').textContent = isPass ? '👁' : '👁‍🗨';
    });

    // 朗读速度滑块实时更新
    const ttsRateSlider = document.getElementById('ttsRate');
    if (ttsRateSlider) {
      ttsRateSlider.addEventListener('input', () => {
        const valEl = document.getElementById('ttsRateValue');
        if (valEl) valEl.textContent = parseFloat(ttsRateSlider.value).toFixed(1) + 'x';
      });
      // 滑块松开时立即保存，保证 VoiceOutput 动态读取到最新值
      ttsRateSlider.addEventListener('change', () => {
        SettingsStore.setTtsRate(parseFloat(ttsRateSlider.value));
      });
    }

    // 诊断工具入口
    document.getElementById('btnDiagnose').addEventListener('click', () => {
      window.open('voice-test.html', '_blank');
    });

    // 综合测试入口（不用 window.open，移动端弹窗拦截会导致无反应）
    document.getElementById('btnTest').addEventListener('click', () => {
      location.href = 'test.html';
    });
  },

  _loadSettings() {
    document.getElementById('apiKeyInput').value = SettingsStore.getApiKey();
    // model switcher 同步在 _syncModelSwitcher 中处理
    // effort 同步在 _syncEffortUI 中处理

    // 加载朗读速度
    const savedRate = SettingsStore.getTtsRate();
    const ttsRateEl = document.getElementById('ttsRate');
    if (ttsRateEl) {
      ttsRateEl.value = savedRate;
      const valEl = document.getElementById('ttsRateValue');
      if (valEl) valEl.textContent = savedRate.toFixed(1) + 'x';
    }

    // 联网搜索
    document.getElementById('webSearchToggle').checked = SettingsStore.getWebSearch();
    document.getElementById('tavilyKeyInput').value = SettingsStore.getTavilyKey();
    this._syncWebSearchVisibility();
  },

  _syncModelSwitcher() {
    const model = SettingsStore.getModel();
    document.querySelectorAll('.model-tag').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.model === model);
    });
    // 初始化 thinking 状态（仅在无本地记录时根据模型自动设置）
    const thinking = SettingsStore.getThinking();
    document.getElementById('thinkingToggle').checked = thinking;
    this._syncEffortSettingVisibility();
    this._updateJsonPreview();
  },

  /** 根据模型自动设置思考模式 */
  _autoSetThinkingForModel(model) {
    const shouldThink = SettingsStore.THINKING_MODELS.includes(model);
    SettingsStore.setThinking(shouldThink);
    document.getElementById('thinkingToggle').checked = shouldThink;
  },

  /** 仅思考模式开启时显示 Effort 选项 */
  _syncEffortSettingVisibility() {
    const thinking = SettingsStore.getThinking();
    document.getElementById('effortGroup').style.display = thinking ? 'block' : 'none';
  },

  /** 联网搜索开关打开时显示 Tavily Key 输入框 */
  _syncWebSearchVisibility() {
    const checked = document.getElementById('webSearchToggle').checked;
    document.getElementById('tavilyKeyGroup').style.display = checked ? 'block' : 'none';
  },

  _syncEffortUI() {
    const effort = SettingsStore.getEffort();
    document.querySelectorAll('.effort-opt').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.effort === effort);
    });
  },

  _updateSendBtn() {
    const inputBox = document.getElementById('inputBox');
    const btnSend = document.getElementById('btnSend');
    const hasText = inputBox.value.trim().length > 0;
    const streaming = DeepSeekAPI.isStreaming();

    if (streaming) {
      // 显示停止按钮
      btnSend.disabled = false;
      btnSend.classList.add('stop');
      btnSend.innerHTML = ''; // 由 ::before 伪元素显示方块
    } else {
      btnSend.classList.remove('stop');
      btnSend.innerHTML = '&#9654;'; // ▶
      btnSend.disabled = !hasText;
    }

    // 语音通话模式下保持发送按钮可用，确保通话中文字输入不受阻
    if (this._voiceState !== 'idle' && !streaming) {
      btnSend.disabled = !hasText;
    }
  },

  _autoFocusInput() {
    // 通话模式不自动聚焦，避免移动端键盘遮挡界面
    if (this._voiceState !== 'idle') return;
    // 延迟聚焦，避免移动端键盘立即弹起
    setTimeout(() => {
      document.getElementById('inputBox').focus();
    }, 300);
  },

  /* ---- 发送消息 ---- */
  async _handleSend() {
    if (DeepSeekAPI.isStreaming()) {
      DeepSeekAPI.cancel();
      this._updateSendBtn();
      return;
    }

    // 语音模式下文字发送：如果 AI 正在说，打断它
    if (this._voiceState === 'ai_speaking' || this._voiceState === 'ai_thinking') {
      if (this._voiceOutput) this._voiceOutput.stop();
      this._currentRequestId++;
      DeepSeekAPI.cancel();
      this._currentAI = null;
      this._currentContent = '';
      this._currentReasoning = '';
    }

    const inputBox = document.getElementById('inputBox');
    const content = inputBox.value.trim();
    if (!content) return;

    if (!SettingsStore.getApiKey()) {
      this._openSettings();
      return;
    }

    // 用户消息
    const userUI = ChatUI.addMessage('user');
    const userTextEl = userUI.bubbleEl.querySelector('.msg-text');
    if (userTextEl) userTextEl.textContent = content;
    this._messages.push({ role: 'user', content: content });
    this._persistMessages();

    inputBox.value = '';
    inputBox.style.height = 'auto';
    this._autoFocusInput();

    this._sendAIMessage();
  },

  /* ---- 清空对话 ---- */
  _clearConversation() {
    // 先清理语音状态
    if (this._voiceInput) this._voiceInput.stop();
    if (this._voiceOutput) this._voiceOutput.stop();
    if (this._voiceState !== 'idle') this._transition('idle');

    this._messages = [];
    this._currentAI = null;
    this._currentContent = '';
    this._currentReasoning = '';
    SettingsStore.clearMessages();
    ChatUI.clear();
    // 如果正在 streaming，取消
    if (DeepSeekAPI.isStreaming()) {
      DeepSeekAPI.cancel();
    }
    this._updateSendBtn();
  },

  /* ---- 历史持久化 ---- */
  _persistMessages() {
    SettingsStore.saveMessages(this._messages);
  },

  _loadAndRenderMessages() {
    try {
      const messages = SettingsStore.getMessages();
      if (!messages.length) return;
      this._messages = messages;
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
    } catch (_) {
      // 数据损坏，从头开始
      this._messages = [];
    }
  },

  /* ---- 语音初始化 ---- */
  _initVoice() {
    this._voiceAvailable = VoiceInput.isAvailable();

    // 绑定通话按钮
    const btnCall = document.getElementById('btnCall');
    if (this._voiceAvailable) {
      btnCall.addEventListener('click', () => this._handleCallToggle());
    } else {
      btnCall.classList.add('disabled');
      btnCall.title = '您的浏览器不支持语音识别';
      btnCall.addEventListener('click', () => this._showVoiceToast());
    }
  },

  /* ---- 状态机 ---- */
  _transition(newState) {
    this._voiceState = newState;
    this._updateVoiceUI();

    switch (newState) {
      case 'idle':
        if (this._voiceInput) this._voiceInput.stop();
        if (this._voiceOutput) this._voiceOutput.stop();
        this._currentRequestId++;
        DeepSeekAPI.cancel();
        this._currentAI = null;
        this._currentContent = '';
        this._currentReasoning = '';
        break;
      case 'listening':
        if (this._voiceInput) this._voiceInput.start();
        break;
      case 'user_speaking':
        // VoiceInput 事件驱动，无需额外操作
        break;
      case 'ai_thinking':
        // AI 处理期间暂停拾音，防止 TTS 被麦克风捕获形成回声循环
        if (this._voiceInput) this._voiceInput.stop();
        break;
      case 'ai_speaking':
        // TTS 由 onContent 驱动
        break;
    }
  },

  /* ---- 通话按钮切换 ---- */
  _handleCallToggle() {
    switch (this._voiceState) {
      case 'idle':
        this._voiceInput = VoiceInput.create({
          onSpeechStart: () => {
            if (this._voiceState === 'ai_speaking' || this._voiceState === 'ai_thinking') {
              // 潜在打断，启动确认定时器
              this._interruptTimer = setTimeout(() => {
                // 2000ms 内无有效 onresult，判定为噪声，恢复
                if (this._voiceState === 'ai_speaking' || this._voiceState === 'ai_thinking') {
                  this._transition('idle');
                }
              }, 2000);
            } else {
              this._transition('user_speaking');
            }
          },
          onResult: (text) => {
            // 清除打断确认定时器
            if (this._interruptTimer) { clearTimeout(this._interruptTimer); this._interruptTimer = null; }

            // 打断清理
            if (this._voiceState === 'ai_speaking' || this._voiceState === 'ai_thinking') {
              this._voiceOutput.stop();
              this._currentRequestId++;
              DeepSeekAPI.cancel();
              this._currentAI = null;
              this._currentContent = '';
              this._currentReasoning = '';
            }

            // 发送用户语音
            const voiceUserUI = ChatUI.addMessage('user');
            const voiceTextEl = voiceUserUI.bubbleEl.querySelector('.msg-text');
            if (voiceTextEl) voiceTextEl.textContent = text;
            this._messages.push({ role: 'user', content: text });
            this._persistMessages();

            this._sendAIMessage();
          },
          onError: (type, msg) => {
            if (type === 'not-allowed') {
              this._showVoiceToast();
              this._transition('idle');
            } else if (type === 'not-available' || type === 'restart-failed') {
              this._transition('idle');
            }
            // 'network' / 'no-speech' 等自动降级，不打扰用户
          },
          onStateChange: (state) => {
            // VoiceInput 内部状态变化，用于跟踪
          }
        }, 1500);
        if (!this._voiceInput) { this._transition('idle'); return; }

        // 检测浏览器是否支持语音播报，不支持则降级为纯文字
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
            // 朗读完毕，回到监听
            if (this._voiceState === 'ai_speaking') {
              this._transition('listening');
            }
          }
        });
        // 预热 speechSynthesis，绕过 Chrome autoplay 策略
        if (!this._voiceOutputDisabled) {
          const warmup = new SpeechSynthesisUtterance('');
          warmup.volume = 0;
          speechSynthesis.speak(warmup);
        }
        this._transition('listening');
        break;

      default:
        // 挂断
        if (this._interruptTimer) { clearTimeout(this._interruptTimer); this._interruptTimer = null; }
        this._currentRequestId++;
        DeepSeekAPI.cancel();
        this._currentAI = null;
        this._currentContent = '';
        this._currentReasoning = '';
        this._transition('idle');
    }
  },

  /** 发送 AI 消息（语音或文字共用） */
  _sendAIMessage() {
    this._currentRequestId++;
    const requestId = this._currentRequestId;

    const aiUI = ChatUI.addMessage('assistant');
    const aiTextEl = aiUI.bubbleEl.querySelector('.msg-text');
    if (aiTextEl) aiTextEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    this._currentAI = aiUI;
    this._currentContent = '';
    this._currentReasoning = '';

    this._transition('ai_thinking');
    this._updateSendBtn();

    DeepSeekAPI.send(this._messages, {
      onSearchStart: () => {
        ChatUI.addSearchStatus('');
        this._transition('ai_thinking');
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
        // 语音 TTS
        if (this._voiceOutput && !this._voiceOutputDisabled) {
          this._voiceOutput.feedChunk(chunk);
          if (this._voiceState === 'ai_thinking') {
            this._transition('ai_speaking');
          }
        }
      },
      onDone: () => {
        if (requestId !== this._currentRequestId) return;
        if (this._voiceOutput) this._voiceOutput.flush();
        if (this._currentContent) {
          const msg = { role: 'assistant', content: this._currentContent };
          if (this._currentReasoning) msg.reasoning_content = this._currentReasoning;
          this._messages.push(msg);
          this._persistMessages();
        } else if (this._currentReasoning) {
          if (this._currentAI) {
            const doneTextEl = this._currentAI.bubbleEl.querySelector('.msg-text');
            if (doneTextEl) doneTextEl.textContent = '(思考完毕，但未生成回答)';
          }
          this._messages.push({ role: 'assistant', content: '', reasoning_content: this._currentReasoning });
          this._persistMessages();
        } else {
          if (this._currentAI) {
            const doneTextEl2 = this._currentAI.bubbleEl.querySelector('.msg-text');
            if (doneTextEl2) doneTextEl2.textContent = '(未收到回复)';
          }
        }
        this._currentAI = null;
        this._currentContent = '';
        this._currentReasoning = '';
        this._updateSendBtn();
      },
      onError: (type, msg) => {
        if (requestId !== this._currentRequestId) return;
        ChatUI.removeSearchStatus();
        this._currentAI = null;
        this._currentContent = '';
        this._currentReasoning = '';
        this._updateSendBtn();
        if (type === 'missing_key') {
          this._openSettings();
          return;
        }
        ChatUI.addError(msg || '请求失败，请稍后再试。');
      }
    });
  },

  /** 更新语音 UI */
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

  /** 语音不可用时提示 */
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

  /** 语音播报不可用时提示 */
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

  /* ---- 设置面板 ---- */
  _openSettings() {
    document.getElementById('settingsOverlay').classList.remove('hidden');
    document.getElementById('apiKeyInput').value = SettingsStore.getApiKey();
    document.getElementById('thinkingToggle').checked = SettingsStore.getThinking();
    this._syncEffortSettingVisibility();
    this._syncEffortUI();

    // 回读朗读速度
    const savedRate = SettingsStore.getTtsRate();
    const ttsRateEl = document.getElementById('ttsRate');
    if (ttsRateEl) {
      ttsRateEl.value = savedRate;
      const valEl = document.getElementById('ttsRateValue');
      if (valEl) valEl.textContent = savedRate.toFixed(1) + 'x';
    }

    // 回读联网搜索
    document.getElementById('webSearchToggle').checked = SettingsStore.getWebSearch();
    document.getElementById('tavilyKeyInput').value = SettingsStore.getTavilyKey();
    this._syncWebSearchVisibility();

    this._updateJsonPreview();
  },

  _closeSettings() {
    document.getElementById('settingsOverlay').classList.add('hidden');
  },

  _saveAndClose() {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    SettingsStore.setApiKey(apiKey);

    // 读取思考模式开关
    SettingsStore.setThinking(document.getElementById('thinkingToggle').checked);

    // 读取当前选中的 effort
    const activeEffort = document.querySelector('.effort-opt.active');
    if (activeEffort) {
      SettingsStore.setEffort(activeEffort.dataset.effort);
    }

    // 保存朗读速度
    const ttsRateEl = document.getElementById('ttsRate');
    if (ttsRateEl) {
      SettingsStore.setTtsRate(parseFloat(ttsRateEl.value));
    }

    // 保存联网搜索
    SettingsStore.setWebSearch(document.getElementById('webSearchToggle').checked);
    const tavilyKey = document.getElementById('tavilyKeyInput').value.trim();
    SettingsStore.setTavilyKey(tavilyKey);

    this._closeSettings();
  },

  /** 更新设置面板中的 JSON 预览 */
  _updateJsonPreview() {
    const model = SettingsStore.getModel();
    const body = {
      model: model,
      messages: [
        { role: 'system', content: SettingsStore.buildSystemPrompt() },
        { role: 'user', content: '用户消息...' }
      ],
      stream: true
    };
    const thinking = SettingsStore.getThinking();
    if (thinking) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = SettingsStore.getEffort();
    } else {
      body.thinking = { type: 'disabled' };
    }
    document.getElementById('jsonPreview').value = JSON.stringify(body, null, 2);
  }
};

App.init();
