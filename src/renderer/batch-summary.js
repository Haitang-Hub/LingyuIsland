'use strict';
/**
 * 批量处理结果摘要（仅胶囊使用）
 *
 * 只用三种反馈色：
 * - ok  绿：已完成 / 其他说明性提示 / 最后一条「处理完成」
 * - err 红：未完成，且必须带原因说明
 * - busy 橙：处理中（由 pill.js 的 busy 态负责，不在此模块）
 *
 * 轮播顺序：已完成 → 产物 → 未完成(红) → 其他提示 → 处理完成(恒为最后一条)。
 * 不使用 native title 弹窗；面板保持原有 toast，不引入新文案。
 */
(function (global) {
  'use strict';

  const TONE = { OK: 'ok', ERR: 'err' };

  function n(v) {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  }

  /**
   * 从 mask:done 构造胶囊轮播行。
   * @returns {{lines: Array<{text: string, tone: string}>, hasSuccess: boolean,
   *            hasUnfinished: boolean, celebrate: boolean}}
   */
  function buildBatchSummary(done) {
    const d = done || {};
    const total = n(d.total);
    const masked = n(d.masked);
    const restored = n(d.restored);
    const overwritten = n(d.overwritten);
    const trashed = n(d.trashed);
    const restoreMissing = n(d.restoreMissing);
    const alreadyMasked = n(d.alreadyMasked);
    const noPii = n(d.noPii);
    const convertFailed = n(d.convertFailed);
    const pdfNoText = n(d.pdfNoText);
    const skipped = n(d.skipped);
    const otherSkipped = Math.max(0, skipped - convertFailed - pdfNoText);

    // 已完成 / 产物：绿色
    const doneParts = [];
    if (masked) doneParts.push(`屏蔽 ${masked} 份`);
    if (restored) doneParts.push(`还原 ${restored} 份`);

    const outputParts = [];
    if (overwritten) outputParts.push(`覆盖同名 ${overwritten} 份`);
    if (trashed) outputParts.push(`移入回收站 ${trashed} 份`);

    // 未完成：红色，每行都带原因说明
    const unfinished = [];
    if (restoreMissing) unfinished.push(`编码无法识别 ${restoreMissing} 个（可能已被修改）`);
    if (convertFailed) unfinished.push(`.doc 转换失败 ${convertFailed} 份（请在 Word 中另存为 .docx）`);
    if (pdfNoText) unfinished.push(`扫描件 PDF ${pdfNoText} 份（无可提取文本）`);
    if (otherSkipped) unfinished.push(`无法处理 ${otherSkipped} 份（格式不支持或过大）`);

    // 其他提示：绿色
    const notices = [];
    if (alreadyMasked) notices.push(`已是屏蔽 ${alreadyMasked} 份（未找到可还原编码）`);
    if (noPii) notices.push(`未检出敏感信息 ${noPii} 份`);

    const hasSuccess = doneParts.length > 0 || outputParts.length > 0;
    const hasUnfinished = unfinished.length > 0;
    const lines = [];

    if (hasSuccess) {
      lines.push({
        text: `已完成：${doneParts.concat(outputParts).slice(0, 3).join(' · ')}`,
        tone: TONE.OK,
      });
      if (outputParts.length && total > 1 && doneParts.length) {
        lines.push({ text: `副本已生成 · ${outputParts.join(' · ')}`, tone: TONE.OK });
      }
    }

    unfinished.forEach((text) => lines.push({ text: `未完成：${text}`, tone: TONE.ERR }));
    notices.forEach((text) => lines.push({ text, tone: TONE.OK }));

    if (!hasSuccess && !hasUnfinished && !notices.length) {
      lines.push({ text: '未生成新副本', tone: TONE.OK });
    }

    // 所有处理都以绿色「处理完成」收尾
    lines.push({ text: '处理完成', tone: TONE.OK });

    return {
      lines,
      hasSuccess,
      hasUnfinished,
      celebrate: hasSuccess && !hasUnfinished,
    };
  }

  const api = { TONE, buildBatchSummary };
  global.BatchSummary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
