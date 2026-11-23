'use strict';
/**
 * pdfflow 测试：PDF 文本流规范化（段落拼接 / 空格剥除 / 字符级框逆映射）
 * 对应缺陷：视觉行硬换行切断跨行实体、文本层空格切断匹配、整项共用框导致涂黑过宽。
 */

const { test, assert } = require('./helpers');
const pdfflow = require('../src/core/pdfflow');
const { detect } = require('../src/core/detector');

/** 构造一个模拟 pdfjs 文本项：等宽 CJK，1 单位 = 1 字宽 */
function mkItem(str, x, y, opts = {}) {
  const size = opts.size || 12;
  const w = opts.width != null ? opts.width : str.length * size;
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: w,
    height: size,
  };
}

test('pdfflow: 段落拼接——跨行实体在流中连续', () => {
  // 「渡溪县师资培训中心」被换行拆开：行尾「…培训中」+ 下行行首「心原工作人员」
  // 段首缩进（x=60），换行续行顶格（x=30）——与 Word 文书一致
  const items = [
    mkItem('戴沐白：我叫戴沐白，男，1962年3月22日出生，公民身份号码', 60, 700),
    mkItem('320826196203220015，回族，大学文化，渡溪县师资培训中', 30, 682),
    mkItem('心原工作人员，户籍所在地汉东省渡溪县湖田镇', 30, 664),
  ];
  const { text } = pdfflow.buildFlowFromItems(items);
  assert.ok(text.includes('渡溪县师资培训中心'), '跨行机构名应拼成完整串');
  assert.ok(text.includes('320826196203220015，回族'), '行间直接相连');
  assert.ok(!/\n/.test(text), '均匀行距不应产生段界');
});

test('pdfflow: 空格剥除——中西文间隙空格不入流', () => {
  const items = [
    mkItem('户籍所在地汉东省渡溪县湖田镇向阳北路 102 号 4 单元', 30, 700),
    mkItem('507 室，住渡溪县湖田镇湖田府华府 19 栋 701 室。。', 30, 682),
  ];
  const { text, chars } = pdfflow.buildFlowFromItems(items);
  assert.ok(!/\s/.test(text), '流中不应残留空白字符');
  assert.ok(text.includes('向阳北路102号4单元507室'), '地址要素应连续');
  assert.ok(text.includes('湖田府华府19栋701室'), '门牌楼栋应连续');
  assert.ok(chars.length === text.length, 'chars 与 text 按索引对齐');
});

test('pdfflow: detect 在流上命中完整地址与跨行机构', () => {
  const items = [
    mkItem('戴沐白：我叫戴沐白，男，公民身份号码', 60, 700),
    mkItem('320826196203220015，回族，大学文化，渡溪县师资培训中', 30, 682),
    mkItem('心原工作人员，户籍所在地汉东省渡溪县湖田镇向阳北路 102 号', 30, 664),
    mkItem('4 单元 507 室，住渡溪县湖田镇湖田府华府 19 栋 701 室。。', 30, 646),
  ];
  const { text, chars } = pdfflow.buildFlowFromItems(items);
  const res = detect(text, { toggles: {} });
  const values = res.items.map((it) => it.value);
  assert.ok(values.includes('渡溪县师资培训中心'), `跨行机构应命中，实际: ${values.join('、')}`);
  const addr = res.items.find((it) => it.type === 'address' && it.value.includes('湖田府华府'));
  assert.ok(!!addr, `第二住址应整体命中，实际地址: ${values.filter((v) => res.items.find((i) => i.type === 'address' && i.value === v)).join('、')}`);
  // 逆映射：命中区间反查字符框，框应落在对应行（不同行的两段地址 → 框跨两行）
  const item = res.items.find((it) => it.type === 'address' && it.value.includes('向阳北路'));
  assert.ok(!!item, '第一地址应命中');
  const boxes = [];
  for (let i = item.start; i < item.end; i++) {
    const b = chars[i].box;
    if (b && !boxes.some((x) => x === b)) boxes.push(b);
  }
  const ys = new Set(boxes.map((b) => Math.round(b.y1)));
  assert.ok(ys.size === 2, `地址跨两行应得到两行框，实际行数: ${ys.size}`);
});

test('pdfflow: 字符级框——命中区间只覆盖命中字符（不再整项涂黑）', () => {
  // 20 字长 item：旧实现命中中间「律师事务所」会把整项涂黑
  const long = '指定辩护人程明，临江市久久律师事务所律师。';
  const { text, chars } = pdfflow.buildFlowFromItems([mkItem(long, 30, 700)]);
  const res = detect(text, { toggles: {} });
  const org = res.items.find((it) => it.type === 'org' && it.value === '临江市久久律师事务所');
  assert.ok(!!org, '机构应命中');
  const hit = chars[org.start];
  const last = chars[org.end - 1];
  assert.ok(hit.box.x1 > 30, '命中首字符框应从 item 左缘右侧开始（内插）');
  assert.ok(last.box.x2 < 30 + long.length * 12, '命中尾字符框不应到达 item 右缘');
  assert.ok(last.box.x2 - hit.box.x1 === 10 * 12, '10 字机构等宽内插宽度应为 10×字宽');
  const before = chars[org.start - 1];
  assert.ok(before.box.x2 <= hit.box.x1, '命中前的字符框不与命中框重叠');
});

test('pdfflow: 行距启发式段界——大间距断段，均匀行距连段', () => {
  const items = [
    mkItem('标题：开庭笔录', 60, 700, { size: 16 }),
    mkItem('正文第一行戴沐白出庭', 60, 660),
    mkItem('正文第二行继续叙述', 60, 642),
    mkItem('页脚页码', 300, 40),
  ];
  const { text } = pdfflow.buildFlowFromItems(items);
  const segs = text.split('\n');
  assert.ok(segs.length >= 2, `大间距应产生段界，实际 ${segs.length} 段`);
  assert.ok(text.includes('正文第一行戴沐白出庭正文第二行继续叙述'), '均匀行距的正文行应相连');
});

test('pdfflow: OCR 块流——块内剥空格、按行距拼段、框内插', () => {
  const blocks = [
    { text: '被告人戴沐白 身份证 320826196203220015', box: { x1: 100, y1: 100, x2: 500, y2: 130 } },
    { text: '住汉东省渡溪县 湖田镇 向阳北路 102 号', box: { x1: 100, y1: 140, x2: 500, y2: 170 } },
  ];
  const { text, chars } = pdfflow.buildFlowFromBlocks(blocks);
  assert.ok(!/\s/.test(text), 'OCR 块内空格应剥除');
  assert.ok(text.includes('320826196203220015'), '数字应连续');
  assert.ok(text.includes('湖田镇向阳北路102号'), '地址应连续');
  assert.ok(chars.length === text.length, 'chars 与 text 对齐');
});

test('pdfflow: flowTextFromPages——页内拼段、页间断段', () => {
  const pages = [
    { lines: [{ y: 700, text: '第一页末行 渡溪县师资培训中' }, { y: 682, text: '心继续' }] },
    { lines: [{ y: 700, text: '第二页首行 戴沐白' }] },
  ];
  const text = pdfflow.flowTextFromPages(pages);
  assert.ok(text.includes('渡溪县师资培训中心继续'), '页内跨行应拼接');
  assert.ok(text.includes('继续\n第二页首行戴沐白'), '页间应断段且剥空格');
});

test('pdfflow: 宽度缺失退化——item 无 width 时字符框不丢弃', () => {
  const item = { str: '戴沐白出庭', transform: [12, 0, 0, 12, 60, 700], width: 0, height: 12 };
  const { text, chars } = pdfflow.buildFlowFromItems([item]);
  assert.ok(text === '戴沐白出庭');
  const boxes = chars.map((c) => c.box);
  assert.ok(boxes.every((b) => b.x2 > b.x1 && b.y2 > b.y1), '退化框应非零宽高');
});

test('pdfflow: boxesFromHits——跨行命中按行拆框，不产生整行大黑条', () => {
  // 实体跨两行：「渡溪县师资培训中」(行尾 x 大) + 「心」(下行行首 x 小)，
  // 并集矩形会横盖两行全部宽度；必须拆成每行一个窄框
  const items = [
    mkItem('大学文化，渡溪县师资培训中', 60, 700),
    mkItem('心原工作人员，继续叙述', 60, 682),
  ];
  const { text, chars } = pdfflow.buildFlowFromItems(items);
  const start = text.indexOf('渡溪县师资培训中心');
  assert.ok(start >= 0, '跨行机构应在流中连续');
  const boxes = pdfflow.boxesFromHits([{ start, end: start + 9 }], chars);
  assert.ok(boxes.length === 2, `跨行实体应拆成 2 个框，实际 ${boxes.length}`);
  const pageW = items[0].str.length * 12;
  for (const b of boxes) {
    assert.ok(b.x2 - b.x1 < pageW * 0.8, `单框宽度 ${b.x2 - b.x1} 不应接近整行宽 ${pageW}`);
  }
  // 每个框只覆盖一行（y 不相交）
  assert.ok(boxes[0].y1 >= boxes[1].y2 || boxes[1].y1 >= boxes[0].y2, '两框应分属不同行');
});

test('pdfflow: boxesFromHits——同行命中仍为单框', () => {
  const items = [mkItem('被告人戴沐白到庭', 60, 700)];
  const { text, chars } = pdfflow.buildFlowFromItems(items);
  const start = text.indexOf('戴沐白');
  const boxes = pdfflow.boxesFromHits([{ start, end: start + 3 }], chars);
  assert.ok(boxes.length === 1, '同行命中应为 1 个框');
  assert.ok(Math.abs((boxes[0].x2 - boxes[0].x1) - 3 * 12) < 1e-6, '框宽应为 3 字宽');
});

test('pdfflow: 缩进段界——段首行断开，顶格续行拼接', () => {
  // Word 文书：续行顶格（x=40），段首缩进两字（x=64，字高 12）
  const items = [
    mkItem('合议庭成员：审判员李白', 64, 718),
    mkItem('书记员：李晓', 64, 700),
    mkItem('戴沐白：我叫戴沐白，男，公民身份号码', 64, 682),
    mkItem('320826196203220015，回族，大学文化，渡溪县师资培训中', 40, 664),
    mkItem('心原工作人员，户籍所在地汉东省渡溪县', 40, 646),
  ];
  const { text } = pdfflow.buildFlowFromItems(items);
  const segs = text.split('\n');
  assert.ok(segs.length === 3, `缩进段首应断段得 3 段，实际 ${segs.length}: ${JSON.stringify(segs)}`);
  assert.ok(text.includes('审判员李白\n书记员'), '字段行之间应保留段界');
  assert.ok(text.includes('我叫戴沐白，男，公民身份号码320826196203220015'), '段首行与其顶格续行应拼接');
  assert.ok(text.includes('渡溪县师资培训中心'), '顶格续行仍应拼接（跨行实体）');
});

test('pdfflow: OCR 块倾斜容错——bbox 顶边交错时按 y 中心聚类保持阅读序', () => {
  // 真实照片（测试图1.jpg 代理词）坐标：页面倾斜约 7°，长行 bbox 顶边（71）
  // 高于上一行短行顶边（86）——按 y1 排序会把「我所接受…」排到「尊敬的…」前；
  // 按 y 中心（109.5 vs 122.5）+ 行内 x 排序则恢复正确阅读序
  const blocks = [
    { text: '代理词', box: { x1: 526, y1: 13, x2: 722, y2: 77 } },
    { text: '我所接受渡溪县法律援助中心的指派，依法接受本案申请人（劳', box: { x1: 240, y1: 71, x2: 1095, y2: 174 } },
    { text: '尊敬的审判长、审判员：', box: { x1: 186, y1: 86, x2: 493, y2: 133 } },
    { text: '动者）王铁柱的委托，担任其与渡南华文针织服饰有限公司劳动争议', box: { x1: 179, y1: 109, x2: 1100, y2: 217 } },
    { text: '一案的仲裁代理人。经过庭前调查、证据交换及今天的庭审，现结合', box: { x1: 180, y1: 148, x2: 1102, y2: 255 } },
  ];
  const { text } = pdfflow.buildFlowFromBlocks(blocks);
  const idxRespect = text.indexOf('尊敬的审判长');
  const idxAccept = text.indexOf('我所接受渡溪县法律援助中心');
  assert.ok(idxRespect >= 0 && idxAccept >= 0, '两行都应在流中');
  assert.ok(idxRespect < idxAccept, `阅读顺序应保持（尊敬的 在 我所接受 之前），实际: ${JSON.stringify(text.slice(0, 60))}`);
  assert.ok(text.includes('动者）王铁柱的委托'), '行文本不被改动');
  assert.ok(text.startsWith('代理词'), '标题应最先');
});

module.exports = {};
