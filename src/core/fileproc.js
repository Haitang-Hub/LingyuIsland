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
  maskText, restoreText, countCodes, maskEdits, restoreEdits, cleanEdits,
} = require('./masker');
const { detect, hashName } = require('./detector');
const { xmlBlockTexts, transformXmlText } = require('./xmltext');
const {
  LEGACY_EXTS, getConverted, converterHint,
} = require('./docconvert');
const pdfproc = require('./pdfproc');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

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
const PDF_EXTS = new Set(['pdf']);

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
  if (!LEGACY_EXTS.has(ext)) return { src: filePath, ext, legacy: false };
  if (isZipFile(filePath)) return { src: filePath, ext: 'docx', legacy: true };
  const converted = getConverted(filePath);
  if (converted) return { src: converted, ext: 'docx', legacy: true };
  return { src: filePath, ext: 'legacy', legacy: true };
}

function legacyUnavailable(filePath) {
  return { ok: false, path: filePath, skipped: 'legacy-convert', reason: converterHint() };
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
  return collectKnownEntities(segments, toggles).names;
}

/**
 * 收集一份文档里「有语境证据」的姓名与地名，用于跨段落传播：
 *  - 姓名：仅收 strong 证据（角色标签 / 男女结构 / 职业前缀等）确认的；
 *    弱证据（邻接 PII / 动作词）不入缓存，防止「执行/文件」这类
 *    姓氏字开头的复合词被传播成全篇姓名。
 *  - 地名：已确认地址值（≥3 字），供「石牌垌下房亲邻群」这类
 *    无引导词、无行政区划后缀的提及命中。
 */
function collectKnownEntities(segments, toggles) {
  const names = new Set();
  const places = new Set();
  let total = 0;
  for (const seg of segments) {
    total += seg ? seg.length : 0;
    if (total > NAME_PRESCAN_LIMIT) return { names, places };
  }
  for (const seg of segments) {
    if (!seg || !seg.trim()) continue;
    for (const it of detect(seg, { toggles }).items) {
      if (it.type === 'name' && it.confident) names.add(it.value);
      else if (it.type === 'address' && it.value.length >= 3) places.add(it.value);
    }
  }
  return { names, places };
}

/** 合并「本文档已有姓名」与「同批次其它文档已确认姓名」 */
function mergeKnown(a, b) {
  if (!b || !b.size) return a;
  const out = new Set(a);
  for (const v of b) if (v) out.add(v);
  return out;
}

/* ---------------- 跨文件已知姓名缓存（应用数据目录，只存哈希，不存明文） ---------------- */

// 缓存统一存放在应用数据目录（store.paths.knownNames），案卷目录内不留任何文件；
// 按案卷目录路径区分条目，案卷文件夹拷贝/移动不带走姓名记忆。
const KNOWN_NAMES_FILE = 'mask-names.json';

const HASH_RE = /^[0-9a-f]{64}$/;

/** 案卷目录的存储键：绝对路径，Windows 下大小写不敏感 */
function caseDirKey(caseDir) {
  const abs = path.resolve(String(caseDir || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function readNamesStore(storeFile) {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    // v2 起才信任缓存：v1 是旧版检测器（负例词表不全）写下的，
    // 其中混有把「执行/执业/文件」等复合词误确认成姓名的「毒哈希」，
    // 会经哈希传播污染整篇脱敏产物 —— 旧缓存一律弃用，重新积累。
    if (data && data.v === 2 && data.dirs && typeof data.dirs === 'object') return data;
  } catch { /* 缺失/损坏 → 全新 */ }
  return { v: 2, dirs: {} };
}

/**
 * 读取某案卷目录的已确认姓名哈希。
 * @param {string} storeFile 应用数据目录下的缓存文件（store.paths.knownNames）
 * @param {string} caseDir 案卷目录
 * 上一批文档确认过的姓名（原告陈阿满 → 后文「陈阿满」无语境）在本批文档里
 * 也能命中；缓存只存 sha256 哈希，泄露缓存不会泄露姓名本身。
 * 兼容清理：旧版曾把 .mask-names.json 放在案卷目录内，且内容出自旧版检测器
 * （可能含毒哈希）——读取时直接删除案卷内旧文件，不吸收其内容。
 */
function loadKnownNameHashes(storeFile, caseDir) {
  const set = new Set();
  if (!storeFile || !caseDir) return set;
  const store = readNamesStore(storeFile);
  const key = caseDirKey(caseDir);
  const entry = store.dirs[key];
  if (entry && Array.isArray(entry.hashes)) {
    for (const h of entry.hashes) if (HASH_RE.test(h)) set.add(h);
  }
  // 旧版案卷内缓存：直接删除（内容出自旧版检测器，不可信），案卷目录不留文件
  const legacy = path.join(path.resolve(caseDir), '.mask-names.json');
  try {
    if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });
  } catch { /* 清理失败不阻塞主流程 */ }
  return set;
}

/** 把本批确认姓名的哈希合并写回应用数据目录缓存（幂等） */
function saveKnownNameHashes(storeFile, caseDir, names) {
  if (!storeFile || !caseDir) return false;
  try {
    const store = readNamesStore(storeFile);
    const key = caseDirKey(caseDir);
    const entry = store.dirs[key] && Array.isArray(store.dirs[key].hashes)
      ? store.dirs[key].hashes.filter((h) => HASH_RE.test(h)) : [];
    const merged = new Set(entry);
    for (const n of names) if (n) merged.add(hashName(n));
    if (merged.size === entry.length) return false;
    store.dirs[key] = { hashes: [...merged] };
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(store), 'utf8');
    return true;
  } catch { return false; }
}

/* ---------------- 虚构声明强制注入 ---------------- */

const DISCLAIMER_MARK = '灵屿岛脱敏声明';
// 注意：声明会插入 PDF 首页顶部，必须保持在一行宽度内（约 ≤30 字），
// 否则文本层抽取会折行，「屏蔽→还原」的逐字一致会被破坏。
const DISCLAIMER_TEXT = `〔${DISCLAIMER_MARK}〕本文件经屏蔽处理，可凭映射库还原。`;
// docx 注入的整段 <w:p>（注入与剥离用同一常量，保证幂等）
const DISCLAIMER_PARA = `<w:p><w:r><w:t xml:space="preserve">${DISCLAIMER_TEXT}</w:t></w:r></w:p>`;

/** docx：把声明段插到正文开头（幂等：已有声明不重复插入） */
function injectOfficeDisclaimer(xml) {
  if (xml.includes(DISCLAIMER_MARK)) return xml;
  return xml.replace(/(<w:body[^>]*>)/i, `$1${DISCLAIMER_PARA}`);
}

/** docx 还原：剥离声明段，保证「屏蔽→还原」后正文与原件一致 */
function stripOfficeDisclaimer(xml) {
  if (!xml.includes(DISCLAIMER_MARK)) return xml;
  return xml.split(DISCLAIMER_PARA).join('');
}

/* ---------------- 质量门禁：残留自检 ---------------- */

/**
 * 用同一套检测器对屏蔽产物复检：如仍有敏感信息检出，
 * 返回 'residual-pii'（warning 标记，不阻断流程）。
 */
function residualCheck(maskedText, toggles, knownNames) {
  try {
    const { items } = detect(maskedText, { toggles, knownNames });
    return items.length ? 'residual-pii' : undefined;
  } catch { return undefined; }
}

/**
 * 段落级拼接 → 统一检测 → 编辑映射回各 <w:t> 节点。
 * 只改 >text< 之间的内容，标签、属性、run 结构一律不动。
 */
function maskXmlText(xml, vault, toggles, knownNames, knownNameHashes, knownPlaces) {
  const r = transformXmlText(xml, (blockText, boundaries) => {
    const { edits, items } = maskEdits(blockText, vault, {
      toggles, knownNames, knownNameHashes, knownPlaces, boundaries,
    });
    return { edits, count: items.length };
  });
  return { xml: r.xml, count: r.count };
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
function maskFile(filePath, vault, toggles, outPath, knownNames, opts = {}) {
  const n = normalizeSource(filePath);
  if (n.ext === 'legacy') return legacyUnavailable(filePath);
  const stat = fs.statSync(n.src);
  if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };
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
    if (countCodes(dec.text) > 0 && /_(屏蔽|脱敏)/.test(path.basename(filePath))) {
      return { ok: false, path: filePath, skipped: 'already-masked' };
    }
    const outDir = path.dirname(out);
    // 跨文件已知姓名缓存（应用数据目录，按案卷目录区分；opts.namesFile 未传则跳过持久化）
    const knownHashes = opts.namesFile ? loadKnownNameHashes(opts.namesFile, outDir) : new Set();
    const knownEnt = collectKnownEntities([dec.text], toggles);
    const known = mergeKnown(knownEnt.names, knownNames);
    const r = maskText(dec.text, vault, {
      toggles, knownNames: known, knownNameHashes: knownHashes, knownPlaces: knownEnt.places,
    });
    if (r.items.length === 0) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    fs.writeFileSync(out, encodeText(r.masked, dec.encoding, dec.bom));
    // 本文件确认的姓名并入跨文件缓存（只存哈希），供后续批次命中无语境重名
    if (opts.namesFile) {
      saveKnownNameHashes(opts.namesFile, outDir, [
        ...known,
        ...r.items.filter((i) => i.type === 'name' && i.confident).map((i) => i.value),
      ]);
    }
    // 质量门禁：对屏蔽产物复检，残留敏感信息则以 warning 标记
    const warning = residualCheck(r.masked, toggles, known);
    return { ok: true, path: filePath, maskedPath: out, count: r.items.length, counts: r.counts, ...(warning ? { warning } : {}) };
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
    // 跨文件已知姓名缓存（应用数据目录，按案卷目录区分；opts.namesFile 未传则跳过持久化）
    const knownHashes = opts.namesFile ? loadKnownNameHashes(opts.namesFile, path.dirname(out)) : new Set();
    // 先按段落级文本扫一遍收集已确认姓名，再统一替换
    // （逐节点预扫会因「被告人：」与姓名分属不同 run 而整批漏掉）
    const segments = [];
    for (const p of parts) segments.push(...xmlBlockTexts(p.xml));
    const knownEnt = collectKnownEntities(segments, toggles);
    const known = mergeKnown(knownEnt.names, knownNames);

    let count = 0;
    let touched = false;
    for (const p of parts) {
      let xml = p.xml;
      let c = 0;
      const r = maskXmlText(xml, vault, toggles, known, knownHashes, knownEnt.places);
      c += r.count;
      if (c > 0) {
        // 虚构声明强制注入：仅 docx 正文，幂等（已有声明不重复插入）
        if (p.name === 'word/document.xml' && opts.declare !== false) {
          xml = injectOfficeDisclaimer(r.xml);
        } else {
          xml = r.xml;
        }
        zip.updateFile(p.name, Buffer.from(xml, 'utf8'));
        count += c;
        touched = true;
      }
    }
    if (!touched) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    zip.writeZip(out);
    // 本文件确认的姓名并入跨文件缓存（只存哈希）
    if (opts.namesFile) saveKnownNameHashes(opts.namesFile, path.dirname(out), [...known]);
    // 质量门禁：对屏蔽产物（段落级拼接）复检
    const maskedZip = new AdmZip(out);
    const maskedParts = [];
    for (const p of parts) {
      const entry = maskedZip.getEntry(p.name);
      if (entry) maskedParts.push(...xmlBlockTexts(entry.getData().toString('utf8')));
    }
    const warning = residualCheck(maskedParts.join('\n'), toggles, known);
    return { ok: true, path: filePath, maskedPath: out, count, counts: {}, ...(warning ? { warning } : {}) };
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
      let xml = entry.getData().toString('utf8');
      // 屏蔽时注入的虚构声明段在此剥离，保证「屏蔽→还原」正文与原件逐字一致
      if (entry.entryName === 'word/document.xml') xml = stripOfficeDisclaimer(xml);
      const r = restoreXmlText(xml, vault);
      if (r.count > 0) {
        zip.updateFile(entry.entryName, Buffer.from(r.xml, 'utf8'));
        count += r.count;
        touched = true;
      } else if (xml !== entry.getData().toString('utf8')) {
        // 没有编码但剥离了声明段：也要写回，避免还原产物残留声明
        zip.updateFile(entry.entryName, Buffer.from(r.xml, 'utf8'));
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
      if (TEXT_EXTS.has(ext) || OFFICE_EXTS.has(ext) || PDF_EXTS.has(ext) || LEGACY_EXTS.has(ext) || ext === '') out.push(p);
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
    return ex.hasText ? ex.text : null;
  } catch { return null; }
}

/** 判断 PDF 是屏蔽产物（含编码）还是明文 */
async function detectPdfIntent(filePath) {
  const text = await readPdfText(filePath);
  return text && countCodes(text) > 0 ? 'restore' : 'mask';
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
    const knownHashes = opts.knownNameHashes
      || (opts.namesFile ? loadKnownNameHashes(opts.namesFile, path.dirname(out)) : new Set());
    for (const page of ex.pages) {
      const lines = [];
      for (const line of page.lines) {
        const r = maskText(line.text, vault, {
          toggles,
          knownNames: opts.knownNames,
          knownPlaces: opts.knownPlaces,
          knownNameHashes: knownHashes,
        });
        count += r.items.length;
        lines.push(r.masked);
      }
      perPage.push(lines);
    }
    if (count === 0) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    // 虚构声明强制注入：首页顶部插入一行声明。
    // 必须同步给提取结构补一行元数据（x/y/size），否则后续内容行会整体
    // 顺延到默认坐标（页面顶部），「还原→再抽取」的行序会与原件不一致。
    if (opts.declare !== false) {
      if (!perPage.length) perPage.push([]);
      if (!ex.pages.length) ex.pages.push({ width: 595, height: 842, lines: [] });
      if (!ex.pages[0].lines.length) {
        ex.pages[0].lines.push({ x: 40, y: ex.pages[0].height - 60, size: 12 });
      }
      ex.pages[0].lines.unshift({ x: 40, y: ex.pages[0].height - 60, size: 12 });
      perPage[0].unshift(DISCLAIMER_TEXT);
    }
    const bytes = await pdfproc.renderPdf(ex, perPage, opts.pdfFont);
    fs.writeFileSync(out, bytes);
    // 质量门禁：对屏蔽产物复检
    const maskedJoined = perPage.map((l) => l.join('\n')).join('\n');
    const warning = residualCheck(maskedJoined, toggles, opts.knownNames);
    return { ok: true, path: filePath, maskedPath: out, count, counts: {}, ...(warning ? { warning } : {}) };
  } catch (err) {
    return { ok: false, path: filePath, skipped: 'error', reason: String((err && err.message) || err) };
  }
}

/** 还原 PDF：逐行 restoreText → 重新生成 PDF */
async function restorePdfFile(filePath, vault, outPath) {
  if (!isPdf(filePath)) return restoreFile(filePath, vault, outPath);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) return { ok: false, path: filePath, skipped: 'too-large' };
    const ex = await pdfproc.extractPdf(fs.readFileSync(filePath));
    if (!ex.hasText) return { ok: false, path: filePath, skipped: 'pdf-no-text' };
    const out = outPath || restoredPathOf(filePath);
    const perPage = [];
    let resolved = 0;
    const missing = [];
    for (const page of ex.pages) {
      const lines = [];
      for (const line of page.lines) {
        const r = restoreText(line.text, vault);
        resolved += r.resolved;
        for (const c of r.missing) if (!missing.includes(c)) missing.push(c);
        lines.push(r.text);
      }
      perPage.push(lines);
    }
    if (resolved === 0 && missing.length === 0) return { ok: false, path: filePath, skipped: 'no-codes' };
    // 剥离屏蔽时注入的声明文本，保证「屏蔽→还原」文本层与原件逐字一致。
    // 声明行可能被抽取层与相邻行合并，按子串剥离而非整行丢弃。
    for (const lines of perPage) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(DISCLAIMER_MARK)) lines[i] = lines[i].split(DISCLAIMER_TEXT).join('');
      }
    }
    for (const lines of perPage) {
      for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].trim()) lines.splice(i, 1);
    }
    const bytes = await pdfproc.renderPdf(ex, perPage);
    fs.writeFileSync(out, bytes);
    return { ok: true, path: filePath, restoredPath: out, resolved, missing };
  } catch (err) {
    return { ok: false, path: filePath, skipped: 'error', reason: String((err && err.message) || err) };
  }
}

module.exports = {
  maskFile, restoreFile, collectPaths, decodeBuffer, encodeText,
  maskedPathOf, restoredPathOf, isJunkFile, TEXT_EXTS, OFFICE_EXTS, LEGACY_EXTS, PDF_EXTS,
  outputNameOf, normalizeSource, readFileText, detectFileIntent,
  readPdfText, detectPdfIntent, maskPdfFile, restorePdfFile, isPdf,
  loadKnownNameHashes, saveKnownNameHashes, caseDirKey, KNOWN_NAMES_FILE,
  injectOfficeDisclaimer, stripOfficeDisclaimer, DISCLAIMER_MARK, DISCLAIMER_TEXT,
  residualCheck,
};
