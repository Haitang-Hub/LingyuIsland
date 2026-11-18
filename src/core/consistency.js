'use strict';
/**
 * 交叉一致性检查（纯 JS，无 Electron 依赖）
 *
 * 同一案卷的多份文档往往包含同一批实体（当事人姓名、住址、机构、案号…）。
 * 单份文档屏蔽干净不代表案卷脱敏到位：某一份漏检，全名就仍可与其他文档的
 * 〔编码〕标记拼合还原。本模块在案卷级做两件事：
 *
 *  1. 原值泄漏：任一「原文档检出实体」若原样出现在任一屏蔽产物中 → 泄漏；
 *  2. 编码一致性：同一实体在不同屏蔽产物中应使用同一编码（同值同码），
 *     出现不同编码说明批次间用了不同映射库，还原时会互相丢失。
 *
 * 断言消息只输出截断后的实体片段（前 4 字 + ****），不回显完整原值。
 */

const { detect } = require('./detector');

/** 泄漏消息用截断值，避免日志/测试输出本身泄露隐私 */
function truncValue(v) {
  const s = String(v || '');
  // 姓名等短值（≤4 字）必须截得更短，否则 slice(0,4) 会原样回显完整姓名
  return s.length <= 4 ? s.slice(0, 1) + '****' : s.slice(0, 4) + '****';
}

/**
 * 屏蔽产物中是否残留「未屏蔽的原值」。
 * 地址/机构为「前2 + **** + 尾4」形态，尾 4 字按设计可见；
 * 当它恰好等于另一个检出实体时，不算泄漏。
 */
function containsPlain(masked, value) {
  const s = String(masked || '');
  let from = 0;
  while (from <= s.length) {
    const idx = s.indexOf(value, from);
    if (idx < 0) return false;
    // 紧邻可见尾段之前的星号是屏蔽形态的一部分：新格式 4 个，旧格式 6 个。
    let stars = 0;
    while (idx - stars - 1 >= 0 && s[idx - stars - 1] === '*') stars++;
    if (stars !== 4 && stars !== 6) return true;
    from = idx + value.length;
  }
  return false;
}

/**
 * @param {Array<{file:string, original:string, masked:string}>} entries 同案卷多文件
 * @param {{toggles?:Record<string,boolean>}} [options]
 * @returns {{ok:boolean, leaks:Array, codeMismatches:Array, entities:number}}
 *   leaks: [{ type, sample, files:[命中文件] }]
 *   codeMismatches: [{ type, sample, file, codes:[出现过的编码] }]
 */
function checkConsistency(entries, options = {}) {
  const leaks = [];
  const codeMismatches = [];
  const entities = new Map(); // value -> { type, files:Set, codes:Map(file->code) }

  // 1) 汇总原文档检出的全部实体
  for (const e of entries) {
    const { items } = detect(String(e.original || ''), options);
    for (const it of items) {
      if (!entities.has(it.value)) entities.set(it.value, { type: it.type, files: new Set() });
      entities.get(it.value).files.add(e.file);
    }
  }

  // 2) 屏蔽产物中逐实体排查原值残留 + 编码一致性
  const codeRe = /〔(?:[\u4e00-\u9fa5]{1,6}·)?([0-9a-f]{6,12})〕/g;
  for (const e of entries) {
    const masked = String(e.masked || '');
    for (const [value, meta] of entities) {
      if (containsPlain(masked, value)) {
        let leak = leaks.find((l) => l.sample === truncValue(value) && l.type === meta.type);
        if (!leak) {
          leak = { type: meta.type, sample: truncValue(value), files: [] };
          leaks.push(leak);
        }
        if (!leak.files.includes(e.file)) leak.files.push(e.file);
      }
    }
    // 该屏蔽产物里出现的编码，应与同案卷其他文件对同一实体一致
    codeRe.lastIndex = 0;
    let m;
    while ((m = codeRe.exec(masked)) !== null) {
      const hit = options.vault && options.vault.lookup ? options.vault.lookup(m[1]) : null;
      if (!hit) continue;
      const meta = entities.get(hit.value);
      if (!meta) continue;
      if (!meta.codes) meta.codes = new Map();
      const perFile = meta.codes.get(e.file) || new Set();
      perFile.add(m[1]);
      meta.codes.set(e.file, perFile);
    }
  }
  for (const [value, meta] of entities) {
    if (!meta.codes || meta.codes.size < 2) continue;
    const all = new Set();
    for (const set of meta.codes.values()) for (const c of set) all.add(c);
    if (all.size > 1) {
      codeMismatches.push({ type: meta.type, sample: truncValue(value), file: e0(meta.codes), codes: [...all] });
    }
  }
  return {
    ok: leaks.length === 0 && codeMismatches.length === 0,
    leaks,
    codeMismatches,
    entities: entities.size,
  };
}

function e0(codes) {
  for (const f of codes.keys()) return f;
  return '';
}

module.exports = { checkConsistency, truncValue };
