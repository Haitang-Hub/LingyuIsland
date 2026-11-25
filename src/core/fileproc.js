'use strict';
/**
 * 文件屏蔽管道
 *  - 文本类：txt/md/csv/json/代码等，自动识别 UTF-8 / GBK，保留原编码写回
 *  - Office 类：docx/xlsx/pptx（zip 内 XML 仅替换文本节点，原文跨排版 run 时跳过，绝不破坏结构）
 *  - 老式 .doc/.dot（OLE2 二进制）：先本地转换为临时 .docx 再走 Office 管道，
 *    结果统一以 .docx 落地（变长屏蔽值无法无损回写老二进制格式）
 *  - 原文件永不被覆盖：屏蔽结果写为 「xxx_屏蔽.ext」，还原结果写为 「xxx_还原.ext」
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const {
  maskText, restoreText, countCodes, hasRestorableCode, maskEdits, restoreEdits, cleanEdits,
  hasPlainMark,
} = require('./masker');
const { detect } = require('./detector');
const { collectEntities, createEntities, mergeEntities } = require('./entities');
const { xmlBlockTexts, transformXmlText } = require('./xmltext');
const {
  LEGACY_EXTS, isLegacyDoc, getConverted, converterHint,
} = require('./docconvert');
const pdfproc = require('./pdfproc');
const pdfflow = require('./pdfflow');
const pdfredact = require('./pdfredact');
const imageredact = require('./imageredact');
const { residualCheckDetailed, residualGate } = require('./residual');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

/** 写入失败分类：文件被占用 / 无权限 → locked，其余归 error */
function skipReasonForError(err) {
  const code = err && err.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? 'locked' : 'error';
}

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
const PDF_EXTS = new Set(['pdf']);
const IMAGE_EXTS = imageredact.IMAGE_EXTS;

// Office 中需要处理的 XML 文本部件
const OFFICE_PARTS = [
  /^word\/document\.xml$/, /^word\/header\d*\.xml$/, /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/, /^word\/endnotes\.xml$/, /^word\/comments\.xml$/,
  /^xl\/sharedStrings\.xml$/, /^xl\/worksheets\/sheet\d+\.xml$/,
  /^xl\/comments\d*\.xml$/,
  /^ppt\/slides\/slide\d+\.xml$/, /^ppt\/notesSlides\/notesSlide\d+\.xml$/,
  /^docProps\/core\.xml$/, /^docProps\/app\.xml$/, /^docProps\/custom\.xml$/,
];

// 元数据不走正文检测：正文规则会把 app.xml 里的模板编号当电话遮成
// 「087****8263〔电话·…〕」，而作者/标题/时间又只被部分命中。这里按字段清洗。
const CORE_CLEAR_FIELDS = [
  'dc:title', 'dc:subject', 'dc:creator', 'dc:description',
  'cp:keywords', 'cp:lastModifiedBy', 'cp:category', 'cp:contentStatus',
];
const CORE_DATE_FIELDS = ['dcterms:created', 'dcterms:modified', 'cp:lastPrinted'];
const APP_CLEAR_FIELDS = ['Company', 'Manager', 'Template', 'Category'];
const CUSTOM_VALUE_RE = /(<vt:(?:lpstr|bstr)>)[^<>]*(<\/vt:(?:lpstr|bstr)>)/gi;

function isMetadataPart(name) {
  return /^docProps\/(?:core|app|custom)\.xml$/.test(String(name || ''));
}

/** 字段级清洗 OOXML 元数据：清空身份/标题字段、归一化时间戳 */
function scrubOfficeMetadata(xml, name) {
  let out = String(xml || '');
  const clear = name === 'docProps/core.xml' ? CORE_CLEAR_FIELDS
    : name === 'docProps/app.xml' ? APP_CLEAR_FIELDS : null;
  if (clear) {
    for (const tag of clear) {
      const pair = new RegExp(`(<${tag}(?:\\s[^>]*)?>)[\\s\\S]*?(</${tag}>)`, 'gi');
      out = out.replace(pair, (_, a, b) => a + b);
      const self = new RegExp(`<${tag}(?:\\s[^>]*)?\\/>`, 'gi');
      out = out.replace(self, `<${tag}></${tag}>`);
    }
  }
  if (name === 'docProps/core.xml') {
    for (const tag of CORE_DATE_FIELDS) {
      const pair = new RegExp(`(<${tag}(?:\\s[^>]*)?>)[\\s\\S]*?(</${tag}>)`, 'gi');
      out = out.replace(pair, (_, a, b) => a + '2000-01-01T00:00:00Z' + b);
    }
  }
  if (name === 'docProps/custom.xml') out = out.replace(CUSTOM_VALUE_RE, (_, a, b) => a + b);
  return out;
}

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

/* ---------------- 老式 .doc 入口归一化 ---------------- */

/**
 * 老格式文件的结果统一使用 .docx 后缀：
 * 屏蔽值比原文长，无法在不重建 piece table 的前提下写回 OLE2 二进制。
 * @param {string} name 文件名或完整路径
 */
function outputNameOf(name) {
  const s = String(name || '');
  const ext = path.extname(s).slice(1).toLowerCase();
  return LEGACY_EXTS.has(ext) ? s.slice(0, -ext.length) + 'docx' : s;
}

/** 文件头是否为 zip（OOXML）——用于识别「后缀是 .doc、内容其实是 docx」的情况 */
function isZipFile(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(4);
      return fs.readSync(fd, buf, 0, 4, 0) === 4 && buf.equals(ZIP_MAGIC);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/**
 * 把「待读源文件」归一化为管道能处理的形式：
 *  - 普通文件 → 原样
 *  - 真 .doc/.dot（OLE2）→ 转换后的临时 .docx；转换不可用时 ext='legacy'
 *  - 后缀是 .doc 但其实是 OOXML zip → 直接按 docx 处理
 * @returns {{src:string, ext:string, legacy:boolean}}
 */
function normalizeSource(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const legacyName = LEGACY_EXTS.has(ext);
  if (isZipFile(filePath)) return { src: filePath, ext: legacyName ? 'docx' : ext, legacy: legacyName };
  if (isLegacyDoc(filePath)) {
    const converted = getConverted(filePath);
    if (converted) return { src: converted, ext: 'docx', legacy: true };
    return { src: filePath, ext: 'legacy', legacy: true };
  }
  if (legacyName) return { src: filePath, ext: 'legacy', legacy: true };
  return { src: filePath, ext, legacy: false };
}

function legacyUnavailable(filePath) {
  return { ok: false, path: filePath, skipped: 'legacy-convert', reason: converterHint() };
}

/* ---------------- 命名 ---------------- */

// 结果后缀：_屏蔽 / _还原，可带序号（_02、_03…），仅剥离位于结尾的
const RESULT_SUFFIX_RE = /_(屏蔽|还原)(?:_\d{1,3})*$/;

/** 去掉结尾的 _屏蔽 / _还原（含可能存在的序号），得到原始基名 */
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

const ENTITY_PRESCAN_LIMIT = 1.5 * 1024 * 1024;

function inheritedEntities(knownNames, opts = {}) {
  const legacy = createEntities();
  if (knownNames) for (const value of knownNames) legacy.name.add(value);
  if (opts.knownPlaces) for (const value of opts.knownPlaces) legacy.address.add(value);
  return legacy;
}

/** 姓名哈希：仅接受调用方显式传入，不读账本/缓存 */
function knownHashesFor(opts = {}) {
  return opts.knownNameHashes ? new Set(opts.knownNameHashes) : new Set();
}

function collectFileEntities(segments, toggles, inherited) {
  let total = 0;
  for (const seg of segments) {
    total += seg ? seg.length : 0;
    if (total > ENTITY_PRESCAN_LIMIT) return mergeEntities(inherited);
  }
  return collectEntities(segments, { toggles, knownEntities: inherited });
}

/* ---------------- 质量门禁：残留自检 ---------------- */

/** 兼容旧调用：只返回 warning 字符串；详细报告用 residualCheckDetailed */
function residualCheck(maskedText, toggles, knownNames, knownEntities) {
  return residualCheckDetailed(maskedText, toggles, knownNames, knownEntities)?.code;
}

/**
 * 段落级拼接 → 统一检测 → 编辑映射回各 <w:t> 节点。
 * 只改 >text< 之间的内容，标签、属性、run 结构一律不动。
 */
function maskXmlText(xml, vault, toggles, knownEntities, knownNameHashes, maskStyle) {
  const counts = {};
  const r = transformXmlText(xml, (blockText, boundaries) => {
    const { edits, items, counts: bc } = maskEdits(blockText, vault, {
      toggles, knownEntities, knownNameHashes, boundaries, maskStyle,
    });
    for (const t of Object.keys(bc || {})) counts[t] = (counts[t] || 0) + bc[t];
    return { edits, count: items.length };
  });
  return { xml: r.xml, count: r.count, counts };
}

function restoreXmlText(xml, vault) {
  const missing = [];
  const r = transformXmlText(xml, (blockText) => {
    if (!blockText.includes('〔')) return { edits: [], count: 0 };
    const x = restoreEdits(blockText, vault);
    for (const c of x.missing) if (!missing.includes(c)) missing.push(c);
    return { edits: cleanEdits(x.edits), count: x.restored.length };
  });
  return { xml: r.xml, count: r.count, missing };
}

/* ---------------- 内容识别 ---------------- */

/**
 * 读取文件中可供判断的纯文本
 *  - 文本类：按 UTF-8 / UTF-16 / GBK 解码
 *  - Office：拼接需处理 XML 部件里的文本节点
 * @returns {string|null} 二进制 / 超大 / 不支持格式返回 null
 */
function readFileText(filePath) {
  let n, stat;
  try {
    n = normalizeSource(filePath);
    if (n.ext === 'legacy') return null;
    stat = fs.statSync(n.src);
  } catch { return null; }
  if (stat.size > MAX_SIZE) return null;
  const ext = n.ext;

  if (OFFICE_EXTS.has(ext)) {
    try {
      const zip = new AdmZip(n.src);
      const parts = [];
      for (const entry of zip.getEntries()) {
        if (!OFFICE_PARTS.some((re) => re.test(entry.entryName))) continue;
        // 元数据不当正文语料：作者/模板号会污染案卷实体表
        if (isMetadataPart(entry.entryName)) continue;
        const xml = entry.getData().toString('utf8');
        // 段落级拼接：跨 run 的关键词、地址、机构名、姓名语境在此恢复
        const blocks = xmlBlockTexts(xml);
        if (blocks.length) parts.push(blocks.join('\n'));
      }
      return parts.join('\n');
    } catch { return null; }
  }
  if (TEXT_EXTS.has(ext) || ext === '') {
    try {
      const dec = decodeBuffer(fs.readFileSync(n.src));
      return dec ? dec.text : null;
    } catch { return null; }
  }
  return null;
}

/**
 * 明显的屏蔽/还原产物文件名：映射库暂时缺失时也走还原分支，
 * 由 restoreFile 明确提示哪些编码无法还原，而不是把产物当明文二次屏蔽。
 */
function isResultFileName(filePath) {
  return /_(屏蔽|还原)/.test(path.basename(filePath));
}

/**
 * 按内容 + 映射库判断处理方式：只有编码在映射库中查得到才算屏蔽产物 → 还原。
 * 仅有编码外观（测试样例〔姓名·abcdef〕等）的明文一律 → 屏蔽，避免整份文件
 * 被当成还原、原样写回。无法读取内容时返回 'mask'，交由 maskFile 给出明确提示。
 */
function detectFileIntent(filePath, vault) {
  // 图片走 OCR 不可逆遮盖，不按 vault 编码判断还原
  if (isImage(filePath)) return 'mask';
  const text = readFileText(filePath);
  if (!text || countCodes(text) === 0) return 'mask';
  return hasRestorableCode(text, vault) || isResultFileName(filePath) ? 'restore' : 'mask';
}

/* ---------------- 单文件处理 ---------------- */

/**
 * 屏蔽一个文件
 * @param {string} [outPath] 指定结果路径（不传则写为同目录的「xxx_屏蔽.ext」）
 * @returns {{ok:boolean, path:string, maskedPath?:string, count?:number,
 *            counts?:Record, skipped?:string, reason?:string}}
 */
function maskFile(filePath, vault, toggles, outPath, knownNames, opts = {}) {
  const n = normalizeSource(filePath);
  if (n.ext === 'legacy') return legacyUnavailable(filePath);
  const stat = fs.statSync(n.src);
  if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };
  // 「仅标已屏蔽」产物正文没有编码，detectFileIntent 会把它当明文再遮一遍。
  // 用结果文件名 + 固定标记识别，直接跳过，避免生成 _屏蔽_屏蔽 之类的怪文件。
  if (isResultFileName(filePath) && hasPlainMark(readFileText(filePath))) {
    return { ok: false, path: filePath, skipped: 'already-masked' };
  }
  const out = outPath || maskedPathOf(outputNameOf(filePath));

  if (OFFICE_EXTS.has(n.ext)) {
    const r = maskOffice(n.src, vault, toggles, out, knownNames, opts);
    r.path = filePath; // 报告里始终是用户拖入的原文件
    return r;
  }
  if (TEXT_EXTS.has(n.ext) || n.ext === '') {
    const buf = fs.readFileSync(n.src);
    const dec = decodeBuffer(buf);
    if (!dec) return { ok: false, path: filePath, skipped: 'binary' };
    if (countCodes(dec.text) > 0 && /_(屏蔽|还原)/.test(path.basename(filePath))) {
      return { ok: false, path: filePath, skipped: 'already-masked' };
    }
    // 文件独立：实体只从本文件内容自收集，不读写跨文件缓存。
    const knownHashes = knownHashesFor(opts);
    const inherited = inheritedEntities(knownNames, opts);
    const knownEnt = collectFileEntities([dec.text], toggles, inherited);
    const r = maskText(dec.text, vault, {
      toggles, knownEntities: knownEnt, knownNameHashes: knownHashes, maskStyle: opts.maskStyle,
    });
    if (r.items.length === 0) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    fs.writeFileSync(out, encodeText(r.masked, dec.encoding, dec.bom));
    // 质量门禁：对屏蔽产物复检；严格模式下删除产物并阻断交付
    const gate = residualGate(r.masked, toggles, opts, out);
    if (gate.ok === false) return { ok: false, path: filePath, ...gate };
    return { ok: true, path: filePath, maskedPath: out, count: r.items.length, counts: r.counts, ...(gate.warning ? gate : {}) };
  }
  return { ok: false, path: filePath, skipped: 'unsupported', reason: n.ext };
}

/**
 * 还原一个屏蔽文件（也支持任意含〔编码〕的文本文件）
 * @param {string} [outPath] 指定结果路径（不传则写为同目录的「xxx_还原.ext」）
 * @returns {{ok:boolean, path:string, restoredPath?:string, resolved?:number, missing?:string[]}}
 */
function restoreFile(filePath, vault, outPath) {
  const n = normalizeSource(filePath);
  if (n.ext === 'legacy') return legacyUnavailable(filePath);
  const stat = fs.statSync(n.src);
  if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };

  if (OFFICE_EXTS.has(n.ext)) {
    const r = restoreOffice(n.src, vault, outPath || restoredPathOf(outputNameOf(filePath)));
    r.path = filePath;
    return r;
  }
  const buf = fs.readFileSync(n.src);
  const dec = decodeBuffer(buf);
  if (!dec) return { ok: false, path: filePath, skipped: 'binary' };
  const r = restoreText(dec.text, vault);
  if (r.resolved === 0 && r.missing.length === 0) {
    return { ok: false, path: filePath, skipped: 'no-codes' };
  }
  const out = outPath || restoredPathOf(outputNameOf(filePath));
  fs.writeFileSync(out, encodeText(r.text, dec.encoding, dec.bom));
  return { ok: true, path: filePath, restoredPath: out, resolved: r.resolved, missing: r.missing };
}

/* ---------------- Office (docx/xlsx/pptx) ---------------- */

function maskOffice(filePath, vault, toggles, outPath, knownNames, opts = {}) {
  try {
    const zip = new AdmZip(filePath);
    const parts = [];
    for (const entry of zip.getEntries()) {
      if (!OFFICE_PARTS.some((re) => re.test(entry.entryName))) continue;
      parts.push({ name: entry.entryName, xml: entry.getData().toString('utf8') });
    }
    const out = outPath || maskedPathOf(filePath);
    const knownHashes = knownHashesFor(opts);
    // 先按逻辑块确认实体，再把完整实体表套用到全部段落和表格单元格。
    // 元数据不进语料：作者、模板号、时间戳不是案卷实体。
    const segments = [];
    for (const p of parts) {
      if (!isMetadataPart(p.name)) segments.push(...xmlBlockTexts(p.xml));
    }
    const inherited = inheritedEntities(knownNames, opts);
    const knownEnt = collectFileEntities(segments, toggles, inherited);

    let count = 0;
    const counts = {};
    let touched = false;
    for (const p of parts) {
      if (isMetadataPart(p.name)) {
        const cleaned = scrubOfficeMetadata(p.xml, p.name);
        if (cleaned !== p.xml) {
          zip.updateFile(p.name, Buffer.from(cleaned, 'utf8'));
          touched = true;
        }
        continue;
      }
      let xml = p.xml;
      let c = 0;
      const r = maskXmlText(xml, vault, toggles, knownEnt, knownHashes, opts.maskStyle);
      c += r.count;
      for (const t of Object.keys(r.counts || {})) counts[t] = (counts[t] || 0) + r.counts[t];
      if (c > 0) {
        xml = r.xml;
        zip.updateFile(p.name, Buffer.from(xml, 'utf8'));
        count += c;
        touched = true;
      }
    }
    if (!touched) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    zip.writeZip(out);
    // 质量门禁：对屏蔽产物（段落级拼接）复检
    const maskedZip = new AdmZip(out);
    const maskedParts = [];
    for (const p of parts) {
      if (isMetadataPart(p.name)) continue;
      const entry = maskedZip.getEntry(p.name);
      if (entry) maskedParts.push(...xmlBlockTexts(entry.getData().toString('utf8')));
    }
    const gate = residualGate(maskedParts.join('\n'), toggles, opts, out);
    if (gate.ok === false) return { ok: false, path: filePath, ...gate };
    return { ok: true, path: filePath, maskedPath: out, count, counts, ...(gate.warning ? gate : {}) };
  } catch (err) {
    return { ok: false, path: filePath, skipped: skipReasonForError(err), reason: String(err && err.message || err) };
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
      let xml = entry.getData().toString('utf8');
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
    return { ok: false, path: filePath, skipped: skipReasonForError(err), reason: String(err && err.message || err) };
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
      if (TEXT_EXTS.has(ext) || OFFICE_EXTS.has(ext) || PDF_EXTS.has(ext)
        || IMAGE_EXTS.has(ext) || LEGACY_EXTS.has(ext) || ext === '') out.push(p);
    }
  };
  for (const p of inputPaths || []) walk(p, 0);
  return out.slice(0, 200);
}

/* ---------------- PDF（异步：pdfjs 文本层提取 + 重新生成） ---------------- */

const isPdf = (p) => PDF_EXTS.has(path.extname(p || '').slice(1).toLowerCase());

/** 读取 PDF 文本层（供意图判断/预扫），无文本层返回 null */
async function readPdfText(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) return null;
    const ex = await pdfproc.extractPdf(fs.readFileSync(filePath));
    if (!ex.hasText) return null;
    // 预扫文本与涂黑检测同源：段落流让跨行实体可被第一遍收集，
    // 剥除文本层空格噪声，避免 knownEntities 传播表里只有被截断的残值
    return pdfflow.flowTextFromPages(ex.pages);
  } catch { return null; }
}

/**
 * PDF 只有一种处理意图：不可逆遮盖。
 * 旧版曾按 vault 编码判断为「还原」，PDF 改为涂黑后不再产生可还原编码，
 * 且产品要求 PDF 永不还原，因此这里恒返回 mask。
 */
async function detectPdfIntent(_filePath, _vault) {
  return 'mask';
}

/**
 * 遮蔽 PDF：逐行 maskText → 重新生成 PDF。
 * 扫描件（无文本层）返回 skipped='pdf-no-text'，留待 OCR。
 */
async function maskPdfFile(filePath, vault, toggles, outPath, opts = {}) {
  if (!isPdf(filePath)) return maskFile(filePath, vault, toggles, outPath, opts.knownNames, opts);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };
    const ex = await pdfproc.extractPdf(fs.readFileSync(filePath));
    if (!ex.hasText) return { ok: false, path: filePath, skipped: 'pdf-no-text' };
    const out = outPath || maskedPathOf(filePath);
    const perPage = [];
    let count = 0;
    const counts = {};
    const knownHashes = knownHashesFor(opts);
    const inherited = inheritedEntities(opts.knownNames, opts);
    const blocks = ex.pages.flatMap((page) => page.lines.map((line) => line.text));
    const knownEnt = collectFileEntities(blocks, toggles, inherited);
    for (const page of ex.pages) {
      const lines = [];
      for (const line of page.lines) {
        const r = maskText(line.text, vault, {
          toggles,
          knownEntities: knownEnt,
          knownNameHashes: knownHashes,
        });
        count += r.items.length;
        for (const t of Object.keys(r.counts || {})) counts[t] = (counts[t] || 0) + r.counts[t];
        lines.push(r.masked);
      }
      perPage.push(lines);
    }
    if (count === 0) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    const bytes = await pdfproc.renderPdf(ex, perPage, opts.pdfFont);
    fs.writeFileSync(out, bytes);
    // 质量门禁：对屏蔽产物复检
    const maskedJoined = perPage.map((l) => l.join('\n')).join('\n');
    const gate = residualGate(maskedJoined, toggles, opts, out);
    if (gate.ok === false) return { ok: false, path: filePath, ...gate };
    return { ok: true, path: filePath, maskedPath: out, count, counts, ...(gate.warning ? gate : {}) };
  } catch (err) {
    return { ok: false, path: filePath, skipped: skipReasonForError(err), reason: String((err && err.message) || err) };
  }
}

/**
 * PDF 不可逆遮盖：定位敏感区域 → 整页栅格化 → 黑框覆盖 → 无文本层 PDF。
 * 与旧 maskPdfFile 的区别：不写 vault、不产生〔编码〕、不支持还原。
 */
async function redactPdfFile(filePath, vault, toggles, outPath, opts = {}) {
  if (!isPdf(filePath)) return maskFile(filePath, vault, toggles, outPath, opts.knownNames, opts);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };
    const out = outPath || pdfredact.redactedPathOf(filePath);
    return await pdfredact.redactPdfFile(filePath, toggles, outPath, {
      dpi: opts.pdfDpi || opts.dpi,
      ocrEngineDir: opts.ocrEngineDir,
      padding: opts.pdfPadding,
      strictResidual: opts.strictResidual,
    });
  } catch (err) {
    return { ok: false, path: filePath, skipped: skipReasonForError(err), reason: String((err && err.message) || err) };
  }
}

/** PDF 永不支持还原：核心层直接拒绝，避免任何调用方绕过限制 */
async function restorePdfFile(filePath, _vault, _outPath) {
  if (!isPdf(filePath)) return restoreFile(filePath, _vault, _outPath);
  return { ok: false, path: filePath, skipped: 'pdf-restore-disabled' };
}

/* ---------------- 图片（异步：OCR 识别 + 不可逆遮盖） ---------------- */

const isImage = (p) => IMAGE_EXTS.has(path.extname(p || '').slice(1).toLowerCase());

/** 图片只有一种处理意图：不可逆遮盖（OCR 定位后涂黑，不写 vault） */
function detectImageIntent() {
  return 'mask';
}

/** 图片不可逆遮盖：OCR 定位敏感文字 → 黑框覆盖 → 重新编码（丢元数据） */
async function redactImageFile(filePath, vault, toggles, outPath, opts = {}) {
  if (!isImage(filePath)) return maskFile(filePath, vault, toggles, outPath, opts.knownNames, opts);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };
    return await imageredact.redactImageFile(filePath, toggles, outPath, {
      ocrEngineDir: opts.ocrEngineDir,
      padding: opts.imagePadding,
      strictResidual: opts.strictResidual,
    });
  } catch (err) {
    return { ok: false, path: filePath, skipped: skipReasonForError(err), reason: String((err && err.message) || err) };
  }
}

/** 图片永不支持还原 */
async function restoreImageFile(filePath, _vault, _outPath) {
  if (!isImage(filePath)) return restoreFile(filePath, _vault, _outPath);
  return { ok: false, path: filePath, skipped: 'image-restore-disabled' };
}

module.exports = {
  maskFile, restoreFile, collectPaths, decodeBuffer, encodeText,
  maskedPathOf, restoredPathOf, isJunkFile, TEXT_EXTS, OFFICE_EXTS, LEGACY_EXTS, PDF_EXTS, IMAGE_EXTS,
  outputNameOf, normalizeSource, readFileText, detectFileIntent,
  readPdfText, detectPdfIntent, maskPdfFile, redactPdfFile, restorePdfFile, isPdf,
  detectImageIntent, redactImageFile, restoreImageFile, isImage,
  redactedPathOf: pdfredact.redactedPathOf,
  scrubOfficeMetadata, isMetadataPart,
  residualCheck, residualCheckDetailed, residualGate, skipReasonForError,
};
