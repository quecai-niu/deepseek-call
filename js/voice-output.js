'use strict';

/* ================================================================
 *  VoiceOutput —— TTS 语音合成封装
 * ================================================================ */
const VoiceOutput = {
  /**
   * 创建 TTS 实例
   * @param {Object} callbacks - { onEnd, onStart }
   * @returns {Object} { feedChunk(chunk), flush(), stop(), isSpeaking() }
   */
  create(callbacks) {
    let _queue = [];
    let _buffer = '';
    let _speaking = false;

    /** 句子分隔符：中文标点 + 换行 */
    function _splitSentences(text) {
      const delimRe = /([。！？!?\.\n])/g;
      const result = [];
      let lastIdx = 0;
      let match;
      while ((match = delimRe.exec(text)) !== null) {
        const end = match.index + match[0].length;
        const sentence = text.slice(lastIdx, end).trim();
        if (sentence && !/^[\s\p{P}]+$/u.test(sentence)) result.push(sentence);
        lastIdx = end;
      }
      const remaining = text.slice(lastIdx).trim();
      if (remaining && !/^[\s\p{P}]+$/u.test(remaining)) result.push(remaining);
      return result;
    }

    function _speakNext() {
      if (_queue.length === 0) {
        _speaking = false;
        callbacks.onEnd();
        return;
      }
      const sentence = _queue.shift();
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.lang = 'zh-CN';
      utterance.rate = callbacks.rate || 1.0;
      utterance.onstart = () => {
        _speaking = true;
        callbacks.onStart();
      };
      utterance.onend = () => _speakNext();
      utterance.onerror = () => _speakNext(); // 出错跳过当前句
      try { speechSynthesis.speak(utterance); } catch (_) { /* 不支持则静默 */ }
    }

    return {
      feedChunk(chunk) {
        _buffer += chunk;
        const sentences = _splitSentences(_buffer);
        if (sentences.length > 1) {
          // 最后一个可能不完整，保留
          _buffer = sentences.pop();
          for (const s of sentences) {
            _queue.push(s);
          }
          if (!_speaking) _speakNext();
        }
      },

      flush() {
        const remaining = _buffer.trim();
        if (remaining) _queue.push(remaining);
        _buffer = '';
        if (!_speaking && _queue.length > 0) _speakNext();
      },

      stop() {
        try { speechSynthesis.cancel(); } catch (_) { /* 静默 */ }
        _queue = [];
        _buffer = '';
        _speaking = false;
      },

      isSpeaking() {
        return _speaking || _queue.length > 0;
      }
    };
  }
};
