'use strict';

/* ================================================================
 *  VoiceInput —— 语音识别封装
 * ================================================================ */
const VoiceInput = {
  /** 检测浏览器是否支持语音识别 */
  isAvailable() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  /**
   * 创建语音识别实例
   * @param {Object} callbacks - { onSpeechStart, onResult(text), onInterimResult(text), onError(type, msg), onStateChange(state) }
   * @returns {Object} { start(), stop(), state }
   */
  create(callbacks) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      callbacks.onError('not-available', '浏览器不支持语音识别');
      return null;
    }

    let recognition = null;
    let _state = 'stopped'; // stopped | listening
    let _shouldRestart = false;
    let _restartFailCount = 0;

    function _createRecognition() {
      const rec = new SR();
      rec.lang = 'zh-CN';
      // 使用 single-shot 模式（continuous: false），避免 Chrome 连续模式 30 秒超时问题。
      // 每句话识别完成后 onend 触发，立即重启，消除语音丢失间隙。
      rec.continuous = false;
      rec.interimResults = true;

      rec.onspeechstart = () => {
        callbacks.onSpeechStart();
      };

      rec.onresult = (event) => {
        let finalText = '';
        let latestInterim = '';
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal && result[0]) {
            const text = (result[0].transcript || '').trim();
            if (text && !/^[\s\p{P}]+$/u.test(text)) {
              finalText += text;
            }
          } else if (result[0]) {
            const text = (result[0].transcript || '').trim();
            if (text) {
              latestInterim = text;
            }
          }
        }
        if (latestInterim && callbacks.onInterimResult) {
          callbacks.onInterimResult(latestInterim);
        }
        if (finalText) {
          callbacks.onResult(finalText);
        }
      };

      rec.onend = () => {
        if (_shouldRestart && _state === 'listening') {
          // 立即重启，消除间隙
          try {
            recognition = _createRecognition();
            recognition.start();
            _restartFailCount = 0;
          } catch (_) {
            _restartFailCount++;
            if (_restartFailCount >= 3) {
              _shouldRestart = false;
              _state = 'stopped';
              callbacks.onError('restart-failed', '语音识别连续启动失败');
            } else {
              // 等 200ms 后重试
              setTimeout(() => { if (_shouldRestart && _state === 'listening') {
                try { recognition = _createRecognition(); recognition.start(); _restartFailCount = 0; } catch (_) {}
              } }, 200);
            }
          }
        } else {
          _state = 'stopped';
          callbacks.onStateChange(_state);
        }
      };

      rec.onerror = (event) => {
        if (event.error === 'no-speech') {
          // 无语音输入，自动重启由 onend 处理
        } else if (event.error === 'aborted') {
          // 主动取消，静默
        } else if (event.error === 'not-allowed') {
          _shouldRestart = false;
          _state = 'stopped';
          callbacks.onError('not-allowed', '麦克风权限被拒绝');
        } else if (event.error === 'network') {
          callbacks.onError('network', '语音识别网络错误');
        } else {
          callbacks.onError(event.error, '语音识别错误: ' + event.error);
        }
      };

      return rec;
    }

    return {
      start() {
        if (_state !== 'stopped') return;
        _shouldRestart = true;
        _restartFailCount = 0;
        try {
          recognition = _createRecognition();
          recognition.start();
          _state = 'listening';
          callbacks.onStateChange(_state);
        } catch (err) {
          callbacks.onError('start-failed', '语音识别启动失败: ' + err.message);
        }
      },

      stop() {
        _shouldRestart = false;
        if (recognition) {
          try { recognition.abort(); } catch (_) { /* 静默 */ }
          recognition = null;
        }
        _state = 'stopped';
        callbacks.onStateChange(_state);
      },

      get state() { return _state; }
    };
  }
};
