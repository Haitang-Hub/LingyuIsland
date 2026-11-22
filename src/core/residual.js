'use strict';
/**
 * 交付前残留复核闸口。
 * 屏蔽产物必须用与屏蔽同源的检测器复检；命中时给出可定位报告，
 * 严格模式下删除本次生成的产物并阻断交付（绝不触碰用户原文件）。
 */

const fs = require('fs');
const { detect } = require('./detector');

function residualCheckDetailed(maskedText, toggles, knownNames, knownEntities, knownNameHashes) {
  try {
    const text = String(maskedText || '');
    const { items } = detect(text, { toggles, knownNames, knownEntities, knownNameHashes });
    if (!items.length) return null;
    return {
      code: 'residual-pii',
      count: items.length,
      items: items.slice(0, 20).map((it) => ({
        type: it.type,
        value: it.value,
        start: it.start,
        end: it.end,
        excerpt: text.slice(Math.max(0, it.start - 20), Math.min(text.length, it.end + 20)),
      })),
    };
  } catch { return null; }
}

function residualGate(maskedText, toggles, opts = {}, outPath) {
  // 文件独立：复检只用本次产物文本和同源显式实体，不读账本/缓存。
  const report = residualCheckDetailed(
    maskedText,
    toggles,
    opts.knownNames,
    opts.knownEntities,
    opts.knownNameHashes,
  );
  if (!report) return {};
  if (!opts.strictResidual) return { warning: report.code, residual: report };
  try { if (outPath && fs.existsSync(outPath)) fs.rmSync(outPath, { force: true }); } catch { /* 锁定时仅阻断 */ }
  return {
    ok: false,
    skipped: 'residual-pii',
    reason: '屏蔽产物复检仍检出敏感信息，已阻断交付',
    warning: report.code,
    residual: report,
  };
}

module.exports = { residualCheckDetailed, residualGate };
