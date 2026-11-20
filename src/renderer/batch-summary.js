'use strict';
/**
 * 批量处理结果摘要（仅胶囊使用）
 *
 * 只用两种反馈色（绿色 = 运行中/完成，红色 = 出错/未完成）：
 * - ok  绿：已完成 / 其他说明性提示 / 最后一条「处理完成」
 * - err 红：未完成，且必须带原因说明；含红色的轮播在胶囊侧停留更久
 *
 * 轮播顺序：已完成 → 产物 → 未完成(红) → 其他提示 → 处理完成(恒为最后一条)。
 * 每行控制在 16 个全角字位内（半角算半个）——胶囊文字区实测约 18 字，
 * 超出会被截断；长说明放不下就精简措辞，不硬塞。
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
    const irreversible = n(d.irreversible);
    const noPii = n(d.noPii);
    const convertFailed = n(d.convertFailed);
    const pdfNoText = n(d.pdfNoText);
    const locked = n(d.locked);
    const skipped = n(d.skipped);
    const otherSkipped = Math.max(0, skipped - convertFailed - pdfNoText - locked);

    // 已完成 / 产物：绿色（行宽预算内尽量短）
    const doneParts = [];
    if (masked) doneParts.push(`屏蔽 ${masked} 份`);
    if (restored) doneParts.push(`还原 ${restored} 份`);

    const outputParts = [];
    if (overwritten) outputParts.push(`覆盖 ${overwritten} 份`);
    if (trashed) outputParts.push(`回收站 ${trashed} 份`);

    // 未完成：红色，每行都带原因说明
    const unfinished = [];
    if (locked) unfinished.push(`${locked} 份被占用（关闭后重试）`);
    if (restoreMissing) unfinished.push(`编码无法识别 ${restoreMissing} 个`);
    if (convertFailed) unfinished.push(`.doc 转换失败 ${convertFailed} 份`);
    if (pdfNoText) unfinished.push(`扫描件 ${pdfNoText} 份（无文本层）`);
    if (otherSkipped) unfinished.push(`${otherSkipped} 份不支持或过大`);

    // 其他提示：绿色
    const notices = [];
    if (alreadyMasked) notices.push(`已是屏蔽 ${alreadyMasked} 份`);
    if (irreversible) notices.push(`PDF/图片 遮盖 ${irreversible} 份（不可还原）`);
    if (noPii) notices.push(`未检出敏感信息 ${noPii} 份`);

    const hasSuccess = doneParts.length > 0 || outputParts.length > 0;
    const hasUnfinished = unfinished.length > 0;
    const lines = [];

    if (hasSuccess) {
      // 最多拼两段，避免三位数场景下整行超宽被截断
      lines.push({
        text: `已完成：${doneParts.concat(outputParts).slice(0, 2).join(' · ')}`,
        tone: TONE.OK,
      });
      if (outputParts.length && total > 1 && doneParts.length) {
        // 产物逐行展开，一行放不下两个信息
        outputParts.forEach((p) => lines.push({ text: `副本已生成 · ${p}`, tone: TONE.OK }));
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
