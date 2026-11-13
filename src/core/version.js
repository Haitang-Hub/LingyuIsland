'use strict';
/**
 * 版本号比较（纯 JS，无依赖，供 node 单测与主进程共用）
 *
 * compareVersions(a, b)：按 semver 三段数字比较
 *   a < b 返回 -1；a === b 返回 0；a > b 返回 1
 * 非法输入（缺段/非数字段）一律视为 0 补齐，不抛错
 */

function parsePart(v) {
  const parts = String(v == null ? '' : v).trim().replace(/^v/i, '').split('.');
  return parts.map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function compareVersions(a, b) {
  const pa = parsePart(a);
  const pb = parsePart(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

module.exports = { compareVersions };
