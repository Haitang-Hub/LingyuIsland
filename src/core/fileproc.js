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
} = require('./masker');
const { detect, hashName } = require('./detector');
const { collectEntities, createEntities, mergeEntities } = require('./entities');
const { xmlBlockTexts, transformXmlText } = require('./xmltext');
const {
  LEGACY_EXTS, isLegacyDoc, getConverted, converterHint,
} = require('./docconvert');
const pdfproc = require('./pdfproc');

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
  return mergeEntities(legacy, opts.knownEntities);
}

function collectFileEntities(segments, toggles, inherited) {
  let total = 0;
  for (const seg of segments) {
    total += seg ? seg.length : 0;
    if (total > ENTITY_PRESCAN_LIMIT) return mergeEntities(inherited);
  }
  return collectEntities(segments, { toggles, knownEntities: inherited });
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
    // v4 起才信任缓存：旧版检测器/守卫缺口可能写入误判姓名的哈希（庭审指令
    // 「开庭/入庭」曾被确认成姓名并经哈希传播毒化全篇），修复后一律弃用重新积累。
    if (data && data.v === 4 && data.dirs && typeof data.dirs === 'object') return data;
  } catch { /* 缺失/损坏 → 全新 */ }
  return { v: 4, dirs: {} };
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

/* ---------------- 质量门禁：残留自检 ---------------- */

/**
 * 用同一套检测器对屏蔽产物复检：如仍有敏感信息检出，
 * 返回 'residual-pii'（warning 标记，不阻断流程）。
 */
function residualCheck(maskedText, toggles, knownNames, knownEntities) {
  try {
    const { items } = detect(maskedText, { toggles, knownNames, knownEntities });
    return items.length ? 'residual-pii' : undefined;
  } catch { return undefined; }
}

/**
 * 段落级拼接 → 统一检测 → 编辑映射回各 <w:t> 节点。
 * 只改 >text< 之间的内容，标签、属性、run 结构一律不动。
 */
function maskXmlText(xml, vault, toggles, knownEntities, knownNameHashes) {
  const r = transformXmlText(xml, (blockText, boundaries) => {
    const { edits, items } = maskEdits(blockText, vault, {
      toggles, knownEntities, knownNameHashes, boundaries,
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
    const outDir = path.dirname(out);
    // 跨文件已知姓名缓存（应用数据目录，按案卷目录区分；opts.namesFile 未传则跳过持久化）
    const knownHashes = opts.namesFile ? loadKnownNameHashes(opts.namesFile, outDir) : new Set();
    const inherited = inheritedEntities(knownNames, opts);
    const knownEnt = collectFileEntities([dec.text], toggles, inherited);
    const r = maskText(dec.text, vault, {
      toggles, knownEntities: knownEnt, knownNameHashes: knownHashes,
    });
    if (r.items.length === 0) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    fs.writeFileSync(out, encodeText(r.masked, dec.encoding, dec.bom));
    // 本文件确认的姓名并入跨文件缓存（只存哈希），供后续批次命中无语境重名
    if (opts.namesFile) saveKnownNameHashes(opts.namesFile, outDir, [...knownEnt.name]);
    // 质量门禁：对屏蔽产物复检，残留敏感信息则以 warning 标记
    const warning = residualCheck(r.masked, toggles, undefined, knownEnt);
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
    // 先按逻辑块确认实体，再把完整实体表套用到全部段落和表格单元格。
    const segments = [];
    for (const p of parts) segments.push(...xmlBlockTexts(p.xml));
    const inherited = inheritedEntities(knownNames, opts);
    const knownEnt = collectFileEntities(segments, toggles, inherited);

    let count = 0;
    let touched = false;
    for (const p of parts) {
      let xml = p.xml;
      let c = 0;
      const r = maskXmlText(xml, vault, toggles, knownEnt, knownHashes);
      c += r.count;
      if (c > 0) {
        xml = r.xml;
        zip.updateFile(p.name, Buffer.from(xml, 'utf8'));
        count += c;
        touched = true;
      }
    }
    if (!touched) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    zip.writeZip(out);
    // 本文件确认的姓名并入跨文件缓存（只存哈希）
    if (opts.namesFile) saveKnownNameHashes(opts.namesFile, path.dirname(out), [...knownEnt.name]);
    // 质量门禁：对屏蔽产物（段落级拼接）复检
    const maskedZip = new AdmZip(out);
    const maskedParts = [];
    for (const p of parts) {
      const entry = maskedZip.getEntry(p.name);
      if (entry) maskedParts.push(...xmlBlockTexts(entry.getData().toString('utf8')));
    }
    const warning = residualCheck(maskedParts.join('\n'), toggles, undefined, knownEnt);
    return { ok: true, path: filePath, maskedPath: out, count, counts: {}, ...(warning ? { warning } : {}) };
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

/** 判断 PDF 是屏蔽产物（编码可在映射库还原）还是明文 */
async function detectPdfIntent(filePath, vault) {
  const text = await readPdfText(filePath);
  if (!text || countCodes(text) === 0) return 'mask';
  return hasRestorableCode(text, vault) || isResultFileName(filePath) ? 'restore' : 'mask';
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
        lines.push(r.masked);
      }
      perPage.push(lines);
    }
    if (count === 0) return { ok: true, path: filePath, count: 0, counts: {}, skipped: 'no-pii' };
    const bytes = await pdfproc.renderPdf(ex, perPage, opts.pdfFont);
    fs.writeFileSync(out, bytes);
    // 质量门禁：对屏蔽产物复检
    const maskedJoined = perPage.map((l) => l.join('\n')).join('\n');
    const warning = residualCheck(maskedJoined, toggles, undefined, knownEnt);
    return { ok: true, path: filePath, maskedPath: out, count, counts: {}, ...(warning ? { warning } : {}) };
  } catch (err) {
    return { ok: false, path: filePath, skipped: skipReasonForError(err), reason: String((err && err.message) || err) };
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
    for (const lines of perPage) {
      for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].trim()) lines.splice(i, 1);
    }
    const bytes = await pdfproc.renderPdf(ex, perPage);
    fs.writeFileSync(out, bytes);
    return { ok: true, path: filePath, restoredPath: out, resolved, missing };
  } catch (err) {
    return { ok: false, path: filePath, skipped: skipReasonForError(err), reason: String((err && err.message) || err) };
  }
}

module.exports = {
  maskFile, restoreFile, collectPaths, decodeBuffer, encodeText,
  maskedPathOf, restoredPathOf, isJunkFile, TEXT_EXTS, OFFICE_EXTS, LEGACY_EXTS, PDF_EXTS,
  outputNameOf, normalizeSource, readFileText, detectFileIntent,
  readPdfText, detectPdfIntent, maskPdfFile, restorePdfFile, isPdf,
  loadKnownNameHashes, saveKnownNameHashes, caseDirKey, KNOWN_NAMES_FILE,
  residualCheck, skipReasonForError,
};
