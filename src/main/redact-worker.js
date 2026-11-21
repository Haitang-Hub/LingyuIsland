'use strict';
/**
 * 遮盖工作进程（Electron utilityProcess）
 *
 * 为什么单独起进程：pdfjs 渲染、canvas 合成、JPEG 编码都是同步重活，
 * 放在主进程会冻结界面（实测单张 A4 扫描件 1s 以上无响应）。
 * 这里只负责「接收任务 → 执行 → 回传结果」，OCR 引擎也常驻在本进程内。
 */

const { runRedactTask } = require('../core/redact-task');
const { disposeOcrEngine } = require('../core/pdfredact');

const port = process.parentPort;

if (port) {
  port.on('message', async (event) => {
    const msg = (event && event.data) || {};
    if (msg.type === 'task') {
      let result;
      try {
        result = await runRedactTask(msg.task);
      } catch (err) {
        result = {
          ok: false,
          path: msg.task && msg.task.filePath,
          skipped: 'error',
          reason: String((err && err.message) || err),
        };
      }
      port.postMessage({ type: 'result', id: msg.id, result });
      return;
    }
    if (msg.type === 'dispose') {
      disposeOcrEngine();
      port.postMessage({ type: 'bye' });
      setTimeout(() => process.exit(0), 50);
    }
  });
  if (typeof port.start === 'function') port.start();
}
