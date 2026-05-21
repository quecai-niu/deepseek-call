'use strict';

/* ================================================================
 *  ChatUI —— DOM 操作与渲染
 * ================================================================ */
const ChatUI = {
  _messagesEl: document.getElementById('messages'),
  _emptyStateEl: document.getElementById('emptyState'),
  _reasoningReady: false,
  _scrollRafId: null,

  /** 清除消息列表 */
  clear() {
    // 移除除 emptyState 外的所有子节点
    const children = Array.from(this._messagesEl.children);
    for (const child of children) {
      if (child.id !== 'emptyState') {
        child.remove();
      }
    }
    this._showEmpty(true);
  },

  _showEmpty(show) {
    this._emptyStateEl.style.display = show ? 'flex' : 'none';
  },

  /**
   * 添加一条消息
   * @returns {{ rowEl, bubbleEl, reasoningWrapEl, reasoningContentEl }}
   */
  addMessage(role) {
    this._showEmpty(false);

    const row = document.createElement('div');
    row.className = `msg-row ${role}`;

    // reasoning 折叠区（仅 assistant 有，先创建但默认不显示）
    let reasoningWrap = null;
    let reasoningContentEl = null;
    if (role === 'assistant') {
      reasoningWrap = document.createElement('div');
      reasoningWrap.className = 'reasoning-wrap';
      reasoningWrap.style.display = 'none';

      const header = document.createElement('div');
      header.className = 'reasoning-header';
      header.innerHTML = '<span class="reasoning-icon">&#9654;</span><span>思考过程</span>';

      reasoningContentEl = document.createElement('div');
      reasoningContentEl.className = 'reasoning-content collapsed';

      // 点击切换展开/折叠
      header.addEventListener('click', () => {
        const icon = header.querySelector('.reasoning-icon');
        const collapsed = reasoningContentEl.classList.toggle('collapsed');
        icon.classList.toggle('open', !collapsed);
      });

      reasoningWrap.appendChild(header);
      reasoningWrap.appendChild(reasoningContentEl);
      row.appendChild(reasoningWrap);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = '<div class="msg-text"></div>';
    row.appendChild(bubble);

    // 新消息重置 reasoning 就绪状态
    if (role === 'assistant') {
      this._reasoningReady = false;
    }

    this._messagesEl.appendChild(row);
    this._scrollToBottom();

    return { rowEl: row, bubbleEl: bubble, reasoningWrapEl: reasoningWrap, reasoningContentEl: reasoningContentEl };
  },

  /** 更新消息文本（增量追加） */
  updateBubble(bubbleEl, chunk) {
    const textEl = bubbleEl.querySelector('.msg-text');
    if (textEl) {
      // 首次追加内容时清除 typing dots
      const dots = textEl.querySelector('.typing-dots');
      if (dots) dots.remove();
      textEl.appendChild(document.createTextNode(chunk));
    }
    this._scrollToBottom();
  },

  /** 追加 reasoning 文本（增量追加） */
  appendReasoning(reasoningWrapEl, reasoningContentEl, chunk) {
    if (!this._reasoningReady) {
      reasoningWrapEl.style.display = 'block';
      reasoningContentEl.classList.remove('collapsed');
      const icon = reasoningWrapEl.querySelector('.reasoning-icon');
      if (icon) icon.classList.add('open');
      this._reasoningReady = true;
    }
    reasoningContentEl.appendChild(document.createTextNode(chunk));
    this._scrollToBottom();
  },

  /** 添加错误消息 */
  addError(msg) {
    this._showEmpty(false);
    const row = document.createElement('div');
    row.className = 'msg-row error';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = msg;
    row.appendChild(bubble);
    this._messagesEl.appendChild(row);
    this._scrollToBottom();
  },

  /** 滚动到底部（rAF 去重，避免频繁调用堆积） */
  _scrollToBottom() {
    if (this._scrollRafId) return;
    this._scrollRafId = requestAnimationFrame(() => {
      this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
      this._scrollRafId = null;
    });
  }
};
