'use strict';
/**
 * 遮盖任务池（主进程侧）
 *
 * 把图片 / PDF 的不可逆遮盖放进独立的 utility 进程执行：
 *  - pdfjs 渲染、canvas 合成、JPEG 编码都是同步调用，留在主进程会冻结界面
 *  - OCR 引擎（RapidOCR-json）也放在子进程内常驻，主进程不必背着模型内存
 *
 * 可靠性：
 *  - 任务串行执行（同一时刻一个文件），避免多份大图同时占内存
 *  - 工作进程崩溃 → 本任务退回进程内执行一次，保证结果不丢
 *  - 非 Electron 环境（单元测试）或 fork 失败 → 直接进程内执行
 */

const path = require('path');
const { runRedactTask } = require('../core/redact-task');

const TASK_TIMEOUT_MS = 10 * 60 * 1000;

let utilityProcess = null;
try {
  // 单测环境里 electron 只导出可执行文件路径，解构得到 undefined
  ({ utilityProcess } = require('electron') || {});
} catch { /* 非 Electron 环境 */ }

class RedactPool {
  constructor() {
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.fallback = false;
  }

  _dropProc() {
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.kill(); } catch { /* ignore */ } }
    return proc;
  }

  _rejectAll(err) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(err);
    }
    this.pending.clear();
  }

  _onExit() {
    this.proc = null;
    this._rejectAll(new Error('遮盖进程已退出'));
  }

  _onMessage(msg) {
    if (!msg || msg.type !== 'result') return;
    const item = this.pending.get(msg.id);
    if (!item) return;
    this.pending.delete(msg.id);
    clearTimeout(item.timer);
    item.resolve(msg.result);
  }

  _ensure() {
    if (this.proc) return true;
    if (this.fallback) return false;
    if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
      this.fallback = true;
      return false;
    }
    let proc;
    try {
      proc = utilityProcess.fork(path.join(__dirname, 'redact-worker.js'), [], {
        serviceName: 'lingyu-redact',
        stdio: 'ignore',
      });
    } catch {
      this.fallback = true;
      return false;
    }
    proc.on('message', (msg) => this._onMessage(msg));
    proc.on('exit', () => this._onExit());
    this.proc = proc;
    return true;
  }

  _post(task) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error('遮盖任务超时（工作进程无响应）');
        err.code = 'WORKER_TIMEOUT';
        reject(err);
        this._dropProc();
        this._rejectAll(err);
      }, TASK_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.postMessage({ type: 'task', id, task });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async _runOnce(task) {
    if (!this._ensure()) return runRedactTask(task);
    try {
      return await this._post(task);
    } catch (err) {
      // 超时说明任务本身有问题，退回主进程只会把界面一起卡死 → 直接报错
      if (err && err.code === 'WORKER_TIMEOUT') {
        return {
          ok: false,
          path: task.filePath,
          skipped: 'error',
          reason: String(err.message || err),
        };
      }
      // 工作进程崩溃 / 通信失败：本任务在进程内重做一次
      return runRedactTask(task);
    }
  }

  /** 串行执行一个遮盖任务 */
  run(task) {
    const runOnce = () => this._runOnce(task);
    const p = this.queue.then(runOnce, runOnce);
    this.queue = p.then(() => undefined, () => undefined);
    return p;
  }

  /** 应用退出：通知工作进程收尾（引擎随进程一起释放） */
  dispose() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try { proc.postMessage({ type: 'dispose' }); } catch { /* ignore */ }
    const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 800);
    if (typeof t.unref === 'function') t.unref();
  }
}

let _pool = null;

function getRedactPool() {
  if (!_pool) _pool = new RedactPool();
  return _pool;
}

module.exports = { RedactPool, getRedactPool };
