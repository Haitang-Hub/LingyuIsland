'use strict';
/**
 * Office XML 文本节点 ↔ 逻辑段落（纯 JS，无 Electron 依赖）
 *
 * 问题背景：Word 会把一个词拆进多个 <w:r>/<w:t>，尤其是从老 .doc 转出的 docx：
 *   「日出生，公民身份号码」|「 330106199001015670」|「，回族…文三路」|「138」|「号」|「3」|「幢」|「201」|「室」
 * 旧管道对每个 >text< 节点单独跑一次检测，关键词引导、姓名语境、地址正则全部
 * 在节点边界处断裂 —— 这正是身份证号、住址、人名整片漏检的根因。
 *
 * 本模块把**同一段落（w:p / a:p / si / c / row）内**的文本节点无缝拼成一段逻辑文本，
 * 让检测看到完整原文；再把「原文区间 → 屏蔽值」的编辑映射回各节点：
 * 跨节点的实体，屏蔽值整体落在第一个被覆盖的节点，其余节点清空，
 * 拼接后的可见文本与直接对整段做 maskText 完全一致，且绝不改动标签结构。
 */

/** 只匹配 >文本< 之间的内容（标签属性里的 > 不会被误判） */
const TEXT_NODE_RE = />([^<>]*)</g;

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
    const text = m[1];
    nodes.push({ start: m.index + 1, end: m.index + 1 + text.length, text });
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
 */
function addEdit(block, start, end, replacement) {
  const ns = block.nodes;
  if (!ns.length || end <= start) return;
  const ends = ns.map((n) => n.off + n.text.length);
  let a = ends.findIndex((e) => e > start);
  if (a < 0) a = ns.length - 1;
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

/** 应用单节点内的编辑（区间互不重叠，按起点倒序） */
function renderNode(n) {
  if (!n.edits.length) return n.text;
  n.edits.sort((x, y) => y.s - x.s || y.e - x.e);
  let s = n.text;
  let lastStart = Infinity;
  for (const e of n.edits) {
    if (e.e > lastStart) continue;
    s = s.slice(0, e.s) + String(e.rep) + s.slice(e.e);
    lastStart = e.s;
  }
  return s;
}

/**
 * 对 XML 的每个逻辑块执行 transform，再把编辑写回原 XML。
 *
 * @param {string} xml
 * @param {(blockText:string) => Array<{start,end,replacement}> | {edits:Array,count?:number}} transform
 * @returns {{xml:string, count:number}} count 为编辑项数（屏蔽项 / 还原项）
 */
function transformXmlText(xml, transform) {
  const src = String(xml || '');
  const blocks = collectBlocks(src);
  const changes = [];
  let count = 0;

  for (const b of blocks) {
    if (!b.text) continue;
    const r = transform(b.text);
    const edits = Array.isArray(r) ? r : (r && r.edits) || [];
    count += (r && Number.isFinite(r.count)) ? r.count : edits.length;
    for (const e of edits) {
      if (e && Number.isFinite(e.start) && Number.isFinite(e.end)) {
        addEdit(b, e.start, e.end, e.replacement);
      }
    }
    for (const n of b.nodes) {
      if (!n.edits.length) continue;
      const next = renderNode(n);
      if (next !== n.text) changes.push({ start: n.start, end: n.end, text: next });
    }
  }

  if (!changes.length) return { xml: src, count };
  changes.sort((a, b) => b.start - a.start);
  let out = src;
  for (const c of changes) out = out.slice(0, c.start) + c.text + out.slice(c.end);
  return { xml: out, count };
}

module.exports = { collectBlocks, xmlBlockTexts, transformXmlText };
