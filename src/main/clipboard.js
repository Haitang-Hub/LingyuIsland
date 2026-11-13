'use strict';
/**
 * 剪贴板监听：检测到含〔编码〕的内容时，在胶囊上提示「还原文本」
 *  - 提示绑定到「检测到时的那段文本」快照，而不是点击瞬间剪贴板里的任意内容
 *  - 剪贴板一旦变成别的内容（或监听被关闭），旧提示立即失效
 */

const { clipboard } = require('electron');
const { hasCodes, countCodes } = require('../core/masker');

class ClipboardWatcher {
  /**
   * @param {{readText?: () => string}} [options] 可注入剪贴板读取函数，便于单元测试
   */
  constructor(options = {}) {
    this.readText = options.readText || (() => clipboard.readText());
    this.lastText = null;
    this.pendingText = null;   // 当前提示对应的那段文本（快照）
    this.timer = null;
    this.onFound = null;       // (info) => void
    this.onCleared = null;     // () => void
    this.getEnabled = () => true;
  }

  start(getEnabled, onFound, onCleared) {
    this.getEnabled = getEnabled || this.getEnabled;
    this.onFound = onFound || null;
    this.onCleared = onCleared || null;
    this.stop();
    this.timer = setInterval(() => this._poll(), 800);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 供 clip:restore 使用：只还原这一次复制的文本 */
  getPendingText() { return this.pendingText; }

  /**
   * 还原完成 / 内容失效后调用，避免把写回剪贴板的内容再识别一遍。
   * @param {string} text 当前剪贴板文本
   * @param {boolean} [silent=false] 还原流程自己会更新 UI，无需再广播 cleared
   */
  markHandled(text, silent = false) {
    this.lastText = text;
    const hadPending = this.pendingText !== null;
    this.pendingText = null;
    if (hadPending && !silent && this.onCleared) this.onCleared();
  }

  _clearPending() {
    if (this.pendingText === null) return;
    this.pendingText = null;
    if (this.onCleared) this.onCleared();
  }

  _poll() {
    let text = '';
    try { text = this.readText(); } catch { return; }
    if (!this.getEnabled()) {
      this._clearPending();
      this.lastText = text;
      return;
    }
    if (text === this.lastText) return;
    this.lastText = text;

    // 剪贴板换成别的内容 → 旧提示立即失效，还原只对「当前复制的那段文本」有效
    if (this.pendingText !== null && text !== this.pendingText) this._clearPending();

    if (!text || !hasCodes(text)) return;
    if (text === this.pendingText) return;
    this.pendingText = text;
    if (this.onFound) {
      this.onFound({ count: countCodes(text), preview: text.slice(0, 120) });
    }
  }
}

module.exports = { ClipboardWatcher };
