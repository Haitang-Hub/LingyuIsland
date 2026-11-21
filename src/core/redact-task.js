'use strict';
/**
 * 不可逆遮盖任务分发（图片 / PDF）
 *
 * 主进程与独立工作进程（src/main/redact-worker.js）共用同一入口，
 * 保证「进程内兜底」与「工作进程」两条路径行为完全一致。
 */

const fs = require('fs');
const path = require('path');
const { redactImageFile, IMAGE_EXTS } = require('./imageredact');
const { redactPdfFile } = require('./pdfredact');

const PDF_EXTS = new Set(['pdf']);
// 与 fileproc 的上限保持一致：超大文件不进入 OCR / 渲染，避免内存爆掉
const MAX_SIZE = 20 * 1024 * 1024;

function extOf(p) {
  return path.extname(String(p || '')).slice(1).toLowerCase();
}

function kindOfFile(p) {
  const ext = extOf(p);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return null;
}

/**
 * 执行一次遮盖任务。
 * @param {{kind?:string, filePath:string, toggles:object, outPath?:string, opts?:object}} task
 */
async function runRedactTask(task) {
  const t = task || {};
  const kind = t.kind || kindOfFile(t.filePath);
  try {
    const stat = fs.statSync(t.filePath);
    if (stat.size > MAX_SIZE) return { ok: false, path: t.filePath, skipped: 'too-large' };
  } catch (err) {
    return {
      ok: false,
      path: t.filePath,
      skipped: err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES' ? 'locked' : 'error',
      reason: String((err && err.message) || err),
    };
  }
  if (kind === 'image') return redactImageFile(t.filePath, t.toggles, t.outPath, t.opts || {});
  if (kind === 'pdf') return redactPdfFile(t.filePath, t.toggles, t.outPath, t.opts || {});
  return { ok: false, path: t.filePath, skipped: 'unsupported', reason: '只支持图片与 PDF' };
}

module.exports = { runRedactTask, kindOfFile, MAX_SIZE, PDF_EXTS };
