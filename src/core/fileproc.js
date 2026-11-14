'use strict';
/**
 * 文件屏蔽管道
 *  - 文本类：txt/md/csv/json/代码等，自动识别 UTF-8 / GBK，保留原编码写回
 *  - Office 类：docx/xlsx/pptx（zip 内 XML 仅替换文本节点，原文跨排版 run 时跳过，绝不破坏结构）
 *  - 原文件永不被覆盖：屏蔽结果写为 「xxx_屏蔽.ext」，还原结果写为 「xxx_还原.ext」
 */

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const { maskText, restoreText, countCodes } = require('./masker');
const { detect } = require('./detector');

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * 系统垃圾文件（Office「~$」所有者锁文件、LibreOffice「.~lock」锁文件、缩略图/桌面配置等）
 * —— 不索引、不导入、不屏蔽
 */
function isJunkFile(name) {
  return (
    name.startsWith('~$') ||
    /^\.~lock\./.test(name) ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name === '.DS_Store'
  );
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml',
  'xml', 'html', 'htm', 'shtml', 'ini', 'cfg', 'conf', 'log', 'srt', 'vtt', 'tex',
  'sql', 'js', 'ts', 'jsx', 'tsx', 'vue', 'py', 'java', 'kt', 'go', 'rs', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'rb', 'sh', 'bat', 'ps1', 'css', 'scss', 'less',
  'properties', 'env', 'gitignore', 'dockerfile', 'makefile',
]);
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);

// Office 中需要处理的 XML 文本部件
const OFFICE_PARTS = [
  /^word\/document\.xml$/, /^word\/header\d*\.xml$/, /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/, /^word\/endnotes\.xml$/, /^word\/comments\.xml$/,
  /^xl\/sharedStrings\.xml$/, /^xl\/worksheets\/sheet\d+\.xml$/,
  /^xl\/comments\d*\.xml$/,
  /^ppt\/slides\/slide\d+\.xml$/, /^ppt\/notesSlides\/notesSlide\d+\.xml$/,
  /^docProps\/core\.xml$/, /^docProps\/app\.xml$/,
];

/* ---------------- 编码识别 ---------------- */

/** @returns {{encoding:string, text:string, bom:boolean} | null} null 表示二进制/无法识别 */
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8', bom: true, text: buf.slice(3).toString('utf8') };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', bom: true, text: buf.slice(2).toString('utf16le') };
  }
  // 尝试严格 UTF-8
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    return { encoding: 'utf8', bom: false, text: dec.decode(buf) };
  } catch { /* 不是合法 UTF-8，继续 */ }

  // GBK（中文 Windows 常见）
  const text = iconv.decode(buf, 'gbk');
  const bad = (text.match(/\ufffd/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (bad > 0 && bad / Math.max(text.length, 1) > 0.01) return null; // 乱码率高 → 二进制
  if (bad === 0 && cjk === 0 && buf.includes(0)) return null;        // 含 NUL → 二进制
  return { encoding: 'gbk', bom: false, text };
}

function encodeText(text, encoding, bom) {
  if (encoding === 'utf16le') {
    const head = bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0);
    return Buffer.concat([head, Buffer.from(text, 'utf16le')]);
  }
  if (encoding === 'gbk') return iconv.encode(text, 'gbk');
  const head = bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  return Buffer.concat([head, Buffer.from(text, 'utf8')]);
}

/* ---------------- 命名 ---------------- */

// 结果后缀：_屏蔽（新）/ _脱敏（v1.1 及更早的旧产物，向后兼容）/ _还原，可带序号（_02、_03…），仅剥离位于结尾的
const RESULT_SUFFIX_RE = /_(屏蔽|脱敏|还原)(?:_\d{1,3})*$/;

/** 去掉结尾的 _屏蔽 / _脱敏 / _还原（含可能存在的序号），得到原始基名 */
function stripResultSuffix(base) {
  let out = String(base || '');
  let prev;
  do {
    prev = out;
    out = out.replace(RESULT_SUFFIX_RE, '');
  } while (out !== prev && out);
  return out || base;
}

/**
 * 屏蔽结果路径：xxx_屏蔽.ext
 * 还原产物再次屏蔽时按原名归类 —— 「06_民事起诉状_还原.docx」→「06_民事起诉状_屏蔽.docx」，
 * 而不是「06_民事起诉状_还原_屏蔽.docx」
 */
function maskedPathOf(p) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = stripResultSuffix(path.basename(p, ext));
  return path.join(dir, `${base}_屏蔽${ext}`);
}

/** 还原结果路径：xxx_还原.ext（屏蔽产物 → 还原产物，名字回到原名） */
function restoredPathOf(p) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = stripResultSuffix(path.basename(p, ext));
  return path.join(dir, `${base}_还原${ext}`);
}

/* ---------------- 文本节点安全替换（Office XML 用） ---------------- */

/**
 * 收集一份文档里「有语境证据」的姓名，用于跨段落传播：
 * 首次出现处有「原告：」「，男，」「村医」等锚点，后文只出现名字也能命中
 * 超大文本跳过预扫（几 MB 级别两遍扫描明显变慢，收益有限）
 */
const NAME_PRESCAN_LIMIT = 1.5 * 1024 * 1024;

function collectKnownNames(segments, toggles) {
  const set = new Set();
  let total = 0;
  for (const seg of segments) {
    total += seg ? seg.length : 0;
    if (total > NAME_PRESCAN_LIMIT) return set;
  }
  for (const seg of segments) {
    if (!seg || !seg.trim()) continue;
    for (const it of detect(seg, { toggles }).items) {
      if (it.type === 'name' && it.confident) set.add(it.value);
    }
  }
  return set;
}

/** 合并「本文档已有姓名」与「同批次其它文档已确认姓名」 */
function mergeKnown(a, b) {
  if (!b || !b.size) return a;
  const out = new Set(a);
  for (const v of b) if (v) out.add(v);
  return out;
}

/** 仅替换 >text< 之间的内容；返回 {xml, count} */
function maskXmlText(xml, vault, toggles, knownNames) {
  let count = 0;
  const out = xml.replace(/>([^<>]*)</g, (whole, seg) => {
    if (!seg) return whole;
    const r = maskText(seg, vault, { toggles, knownNames });
    if (r.items.length === 0) return whole;
    count += r.items.length;
    return `>${r.masked}<`;
  });
  return { xml: out, count };
}

function restoreXmlText(xml, vault) {
  let count = 0;
  const out = xml.replace(/>([^<>]*)</g, (whole, seg) => {
    if (!seg || !seg.includes('〔')) return whole;
    const r = restoreText(seg, vault);
    if (r.resolved === 0) return whole;
    count += r.resolved;
    return `>${r.text}<`;
  });
  return { xml: out, count };
}

/* ---------------- 内容识别 ---------------- */

/**
 * 读取文件中可供判断的纯文本
 *  - 文本类：按 UTF-8 / UTF-16 / GBK 解码
 *  - Office：拼接需处理 XML 部件里的文本节点
 * @returns {string|null} 二进制 / 超大 / 不支持格式返回 null
 */
function readFileText(filePath) {
  let ext, stat;
  try {
    ext = path.extname(filePath).slice(1).toLowerCase();
    stat = fs.statSync(filePath);
  } catch { return null; }
  if (stat.size > MAX_SIZE) return null;

  if (OFFICE_EXTS.has(ext)) {
    try {
      const zip = new AdmZip(filePath);
      const parts = [];
      for (const entry of zip.getEntries()) {
        if (!OFFICE_PARTS.some((re) => re.test(entry.entryName))) continue;
        const xml = entry.getData().toString('utf8');
        let seg = '';
        for (const m of xml.matchAll(/>([^<>]*)</g)) seg += m[1] + '\n';
        parts.push(seg);
      }
      return parts.join('\n');
    } catch { return null; }
  }
  if (TEXT_EXTS.has(ext) || ext === '') {
    try {
      const dec = decodeBuffer(fs.readFileSync(filePath));
      return dec ? dec.text : null;
    } catch { return null; }
  }
  return null;
}

/**
 * 按内容判断处理方式：含〔编码〕的是屏蔽产物 → 还原；其余视为明文 → 屏蔽。
 * 无法读取内容时返回 'mask'，交由 maskFile 给出「格式不支持」等明确提示。
 */
function detectFileIntent(filePath) {
  const text = readFileText(filePath);
  return text && countCodes(text) > 0 ? 'restore' : 'mask';
}

/* ---------------- 单文件处理 ---------------- */

/**
 * 屏蔽一个文件
 * @param {string} [outPath] 指定结果路径（不传则写为同目录的「xxx_屏蔽.ext」）
 * @returns {{ok:boolean, path:string, maskedPath?:string, count?:number,
 *            counts?:Record, skipped?:string, reason?:string}}
 */
function maskFile(filePath, vault, toggles, outPath, knownNames) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };

  if (OFFICE_EXTS.has(ext)) return maskOffice(filePath, vault, toggles, outPath, knownNames);
  if (TEXT_EXTS.has(ext) || ext === '') {
    const buf = fs.readFileSync(filePath);
    const dec = decodeBuffer(buf);
    if (!dec) return { ok: false, path: filePath, skipped: 'binary' };
    if (countCodes(dec.text) > 0 && /_(屏蔽|脱敏)/.test(path.basename(filePath))) {
      return { ok: false, path: filePath, skipped: 'already-masked' };
    }
    const known = mergeKnown(collectKnownNames([dec.text], toggles), knownNames);
    const r = maskText(dec.text, vault, { toggles, knownNames: known });
    if (r.items.length === 0) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    const out = outPath || maskedPathOf(filePath);
    fs.writeFileSync(out, encodeText(r.masked, dec.encoding, dec.bom));
    return { ok: true, path: filePath, maskedPath: out, count: r.items.length, counts: r.counts };
  }
  return { ok: false, path: filePath, skipped: 'unsupported', reason: ext };
}

/**
 * 还原一个屏蔽文件（也支持任意含〔编码〕的文本文件）
 * @param {string} [outPath] 指定结果路径（不传则写为同目录的「xxx_还原.ext」）
 * @returns {{ok:boolean, path:string, restoredPath?:string, resolved?:number, missing?:string[]}}
 */
function restoreFile(filePath, vault, outPath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };

  if (OFFICE_EXTS.has(ext)) return restoreOffice(filePath, vault, outPath);
  const buf = fs.readFileSync(filePath);
  const dec = decodeBuffer(buf);
  if (!dec) return { ok: false, path: filePath, skipped: 'binary' };
  const r = restoreText(dec.text, vault);
  if (r.resolved === 0 && r.missing.length === 0) {
    return { ok: false, path: filePath, skipped: 'no-codes' };
  }
  const out = outPath || restoredPathOf(filePath);
  fs.writeFileSync(out, encodeText(r.text, dec.encoding, dec.bom));
  return { ok: true, path: filePath, restoredPath: out, resolved: r.resolved, missing: r.missing };
}

/* ---------------- Office (docx/xlsx/pptx) ---------------- */

function maskOffice(filePath, vault, toggles, outPath, knownNames) {
  try {
    const zip = new AdmZip(filePath);
    const parts = [];
    for (const entry of zip.getEntries()) {
      if (!OFFICE_PARTS.some((re) => re.test(entry.entryName))) continue;
      parts.push({ name: entry.entryName, xml: entry.getData().toString('utf8') });
    }
    // 先扫一遍全文收集已确认姓名，再统一替换（保证后文只出现名字时也能命中）
    const segments = [];
    for (const p of parts) {
      for (const m of p.xml.matchAll(/>([^<>]*)</g)) if (m[1]) segments.push(m[1]);
    }
    const known = mergeKnown(collectKnownNames(segments, toggles), knownNames);

    let count = 0;
    let touched = false;
    for (const p of parts) {
      const r = maskXmlText(p.xml, vault, toggles, known);
      if (r.count > 0) {
        zip.updateFile(p.name, Buffer.from(r.xml, 'utf8'));
        count += r.count;
        touched = true;
      }
    }
    if (!touched) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    const out = outPath || maskedPathOf(filePath);
    zip.writeZip(out);
    return { ok: true, path: filePath, maskedPath: out, count, counts: {} };
  } catch (err) {
    return { ok: false, path: filePath, skipped: 'error', reason: String(err && err.message || err) };
  }
}

function restoreOffice(filePath, vault, outPath) {
  try {
    const zip = new AdmZip(filePath);
    let count = 0;
    let touched = false;
    let missing = [];
    for (const entry of zip.getEntries()) {
      if (!OFFICE_PARTS.some((re) => re.test(entry.entryName))) continue;
      const xml = entry.getData().toString('utf8');
      const r = restoreXmlText(xml, vault);
      if (r.count > 0) {
        zip.updateFile(entry.entryName, Buffer.from(r.xml, 'utf8'));
        count += r.count;
        touched = true;
      }
      missing = missing.concat(r.missing || []);
    }
    if (!touched) return { ok: false, path: filePath, skipped: 'no-codes' };
    const out = outPath || restoredPathOf(filePath);
    zip.writeZip(out);
    return { ok: true, path: filePath, restoredPath: out, resolved: count, missing };
  } catch (err) {
    return { ok: false, path: filePath, skipped: 'error', reason: String(err && err.message || err) };
  }
}

/* ---------------- 批量 ---------------- */

/** 收集拖入项（支持目录递归，最多 200 个受支持文件；跳过 ~$ 锁文件等系统垃圾） */
function collectPaths(inputPaths) {
  const out = [];
  const walk = (p, depth) => {
    if (out.length >= 200 || depth > 6) return;
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { return; }
      for (const n of names.sort()) {
        if (isJunkFile(n)) continue;
        walk(path.join(p, n), depth + 1);
      }
    } else {
      if (isJunkFile(path.basename(p))) return;
      const ext = path.extname(p).slice(1).toLowerCase();
      if (TEXT_EXTS.has(ext) || OFFICE_EXTS.has(ext) || ext === '') out.push(p);
    }
  };
  for (const p of inputPaths || []) walk(p, 0);
  return out.slice(0, 200);
}

module.exports = {
  maskFile, restoreFile, collectPaths, decodeBuffer, encodeText,
  maskedPathOf, restoredPathOf, isJunkFile, TEXT_EXTS, OFFICE_EXTS,
  readFileText, detectFileIntent,
};
