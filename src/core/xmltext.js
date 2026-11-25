'use strict';
/**
 * Office XML 文本节点 ↔ 逻辑段落（纯 JS，无 Electron 依赖）
 *
 * 问题背景：Word 会把一个词拆进多个 <w:r>/<w:t>，尤其是从老 .doc 转出的 docx：
 *   「日出生，公民身份号码」|「 330106199001015670」|「，回族…滨湖路」|「138」|「号」|「3」|「幢」|「201」|「室」
 * 旧管道对每个 >text< 节点单独跑一次检测，关键词引导、姓名语境、地址正则全部
 * 在节点边界处断裂 —— 这正是身份证号、住址、人名整片漏检的根因。
 *
 * 本模块把**同一段落（w:p / a:p / si / c / row）内**的文本节点无缝拼成一段逻辑文本，
 * 让检测看到完整原文；再把「原文区间 → 屏蔽值」的编辑映射回各节点。
 * 跨节点实体由 maskEdits 按完整形态输出（屏蔽值落首节点），并在编码里记下
 * 原文分段长度；还原时 addEdit 依此把原文逐段回填，Office 往返逐字节一致。
 */

/** 只匹配 >文本< 之间的内容（标签属性里的 > 不会被误判） */
const TEXT_NODE_RE = />([^<>]*)</g;

/** XML 预定义命名实体（OOXML 文本节点里其余命名实体不合法，按原样保留） */
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * 解码文本节点里的字符实体，并保留「解码后每个 UTF-16 码元 → 原始片段」的映射。
 *
 * 有些上游导出器把整篇中文写成 &#24320;&#24237;... 数字字符引用。检测规则全部
 * 建立在汉字 Unicode 区间上，若把原始实体串直接送进 detector，姓名/地址/机构/
 * 案号会一条不命中，只有手机号/身份证这类纯数字正则照常工作，残留复检也跟着瞎。
 *
 * 解码后偏移必须贯穿 collectBlocks → transform → addEdit → renderNode 全链路，
 * 否则跨 run 实体的 partLens 切分和还原回填都会错位。写回时再按 map 落回原文偏移。
 *
 * @param {string} raw 原始 <w:t> 文本（XML 实体形式）
 * @returns {{text:string, map:Array<[number,number]>, numeric:boolean}}
 *   text 解码后的 Unicode 文本；map[i] 为 text 第 i 个码元对应的 [rawStart, rawEnd)；
 *   numeric 表示节点使用过数字字符引用，写回替换值时需保持该编码风格。
 */
function decodeNodeText(raw) {
  let text = '';
  const map = [];
  let numeric = false;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '&') {
      const rest = raw.slice(i);
      let m = /^&#[xX]([0-9a-fA-F]+);/.exec(rest);
      let ch = null;
      let end = 0;
      if (m) {
        try { ch = String.fromCodePoint(parseInt(m[1], 16)); } catch { ch = null; }
        if (ch !== null) { end = i + m[0].length; numeric = true; }
      }
      if (ch === null && (m = /^&#(\d+);/.exec(rest))) {
        try { ch = String.fromCodePoint(Number(m[1])); } catch { ch = null; }
        if (ch !== null) { end = i + m[0].length; numeric = true; }
      }
      if (ch === null && (m = /^&([a-zA-Z][a-zA-Z0-9]*);/.exec(rest))) {
        const named = NAMED_ENTITIES[m[1]];
        if (named !== undefined) { ch = named; end = i + m[0].length; }
      }
      if (ch !== null) {
        // 一个码点可能占 2 个 UTF-16 码元（emoji 等），两格都指向同一原始片段
        for (let k = 0; k < ch.length; k++) map.push([i, end]);
        text += ch;
        i = end;
        continue;
      }
    }
    map.push([i, i + 1]);
    text += raw[i];
    i++;
  }
  return { text, map, numeric };
}

/** numeric 风格节点写回替换值时，把非 ASCII 重新编码为十进制字符引用 */
function encodeNodeReplacement(rep, numeric) {
  const s = String(rep);
  if (!numeric) return s;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7f) out += `&#${cp};`;
    else if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else out += ch;
  }
  return out;
}

/**
 * 段落 / 单元格级边界标签。跨边界的节点不拼在一起，
 * 避免把上一段末尾和下一段开头连成一个假地址或假机构名。
 * (?=[\s>/]) 保证 <w:pPr> / <w:pict> / <col> 等不会被当成 <w:p> / <c>。
 */
const BLOCK_TAG_RE = /<\/?(?:w:p|a:p|si|c|row|w:tr|w:tc|w:tbl|w:body|w:hdr|w:ftr|w:txbxContent)(?=[\s>/])/g;

/**
 * 把一份 XML 切成逻辑块，每块含若干文本节点及块内拼接文本。
 * @returns {Array<{text:string, nodes:Array}>}
 */
function collectBlocks(xml) {
  const src = String(xml || '');
  const nodes = [];
  TEXT_NODE_RE.lastIndex = 0;
  let m;
  while ((m = TEXT_NODE_RE.exec(src)) !== null) {
    const raw = m[1];
    const d = decodeNodeText(raw);
    // start/end 仍是原始 XML 里的偏移，写回时按它替换整段 <w:t> 内容；
    // text/map 则是解码后的视图，供检测与编辑计算使用。
    nodes.push({
      start: m.index + 1,
      end: m.index + 1 + raw.length,
      raw,
      text: d.text,
      map: d.map,
      numeric: d.numeric,
    });
  }
  if (!nodes.length) return [];

  BLOCK_TAG_RE.lastIndex = 0;
  const bounds = [];
  while ((m = BLOCK_TAG_RE.exec(src)) !== null) bounds.push(m.index);

  const byBlock = new Map();
  let bi = 0;
  for (const n of nodes) {
    while (bi < bounds.length && bounds[bi] <= n.start) bi++;
    if (!byBlock.has(bi)) byBlock.set(bi, []);
    byBlock.get(bi).push(n);
  }

  const blocks = [];
  for (const list of byBlock.values()) {
    let text = '';
    for (const n of list) {
      n.off = text.length;     // 节点在块内文本中的起点
      n.edits = [];
      text += n.text;
    }
    blocks.push({ text, nodes: list });
  }
  return blocks;
}

/** 一份 XML 里所有逻辑块的文本（供 readFileText / 姓名预扫使用） */
function xmlBlockTexts(xml) {
  return collectBlocks(xml).map((b) => b.text).filter(Boolean);
}

/**
 * 把一条 [start,end) 的编辑分摊到块内的各个文本节点。
 * 跨节点时 replacement 放在第一个节点，其余节点清空。
 *
 * partLens：还原跨节点实体时使用。屏蔽时整条实体的屏蔽值只落在首个节点，
 * 但 vault 里记下了原文的原始分段长度；还原时按这些长度把原文逐段写回
 * 各自节点（首段替换屏蔽值，其余段插入到已清空/仅剩尾文的节点开头），
 * 从而让 Office 往返逐字节一致。
 */
function addEdit(block, start, end, replacement, partLens) {
  const ns = block.nodes;
  if (!ns.length || end <= start) return;
  const ends = ns.map((n) => n.off + n.text.length);
  let a = ends.findIndex((e) => e > start);
  if (a < 0) a = ns.length - 1;

  if (Array.isArray(partLens) && partLens.length > 1) {
    const total = partLens.reduce((s, n) => s + n, 0);
    if (total === String(replacement).length && a + partLens.length <= ns.length) {
      // 屏蔽时后续节点已被清空，重新读取时它们的 raw 里不再有实体可判断风格。
      // 用首节点（整条实体的落点）的风格回填全部分段，否则实体编码文档还原
      // 会把后半段写成字面中文，破坏逐字节一致。
      const baseNumeric = ns[a] && ns[a].numeric;
      let cursor = 0;
      for (let k = 0; k < partLens.length; k++) {
        const n = ns[a + k];
        const part = String(replacement).slice(cursor, cursor + partLens[k]);
        cursor += partLens[k];
        if (k === 0) {
          const s = Math.max(0, Math.min(n.text.length, start - n.off));
          const e = Math.max(s, Math.min(n.text.length, end - n.off));
          n.edits.push({ s, e, rep: part, numeric: baseNumeric });
        } else {
          n.edits.push({ s: 0, e: 0, rep: part, numeric: baseNumeric });
        }
      }
      return;
    }
  }

  let b = ends.findIndex((e) => e >= end);
  if (b < 0) b = ns.length - 1;
  if (b < a) b = a;

  for (let i = a; i <= b; i++) {
    const n = ns[i];
    const s = Math.max(0, Math.min(n.text.length, start - n.off));
    const e = Math.max(0, Math.min(n.text.length, end - n.off));
    n.edits.push({ s, e: Math.max(s, e), rep: i === a ? replacement : '' });
  }
}

/** 应用单节点内的编辑（区间互不重叠，按起点倒序；edits 用解码后坐标） */
function renderNode(n) {
  if (!n.edits.length) return n.raw;
  n.edits.sort((x, y) => y.s - x.s || y.e - x.e);
  let raw = n.raw;
  let lastStart = Infinity;
  for (const e of n.edits) {
    if (e.e > lastStart) continue;
    // map 把解码后坐标折回原始 XML 偏移；实体风格节点把替换值重新编码，
    // 这样原件是 &#24320; 形式时，还原回去仍是完全相同的字节。
    const rs = e.s < n.map.length ? n.map[e.s][0] : raw.length;
    const re = e.e > 0 && e.e <= n.map.length ? n.map[e.e - 1][1] : rs;
    if (re >= rs) {
      // 跨节点回填的分段用首节点继承来的风格（见 addEdit），其余用节点自身风格
      const numeric = e.numeric === undefined ? n.numeric : e.numeric;
      raw = raw.slice(0, rs) + encodeNodeReplacement(e.rep, numeric) + raw.slice(re);
    }
    lastStart = e.s;
  }
  return raw;
}

/**
 * 对 XML 的每个逻辑块执行 transform，再把编辑写回原 XML。
 *
 * @param {string} xml
 * @param {(blockText:string, boundaries?:number[]) => Array<{start,end,replacement}> | {edits:Array,count?:number}} transform
 *   第二个参数为块内各文本节点的起始偏移（首个恒为 0），
 *   屏蔽回调可据此把跨节点实体拆成每节点一份独立编码（见 masker.maskEdits）。
 * @returns {{xml:string, count:number}} count 为编辑项数（屏蔽项 / 还原项）
 */
function transformXmlText(xml, transform) {
  const src = String(xml || '');
  const blocks = collectBlocks(src);
  const changes = [];
  let count = 0;

  for (const b of blocks) {
    if (!b.text) continue;
    const r = transform(b.text, b.nodes.map((n) => n.off));
    const edits = Array.isArray(r) ? r : (r && r.edits) || [];
    count += (r && Number.isFinite(r.count)) ? r.count : edits.length;
    for (const e of edits) {
      if (e && Number.isFinite(e.start) && Number.isFinite(e.end)) {
        addEdit(b, e.start, e.end, e.replacement, e.partLens);
      }
    }
    for (const n of b.nodes) {
      if (!n.edits.length) continue;
      const next = renderNode(n);
      if (next !== n.raw) changes.push({ start: n.start, end: n.end, text: next });
    }
  }

  if (!changes.length) return { xml: src, count };
  changes.sort((a, b) => b.start - a.start);
  let out = src;
  for (const c of changes) out = out.slice(0, c.start) + c.text + out.slice(c.end);
  return { xml: out, count };
}

module.exports = { collectBlocks, xmlBlockTexts, transformXmlText };
