'use strict';
/** 泄漏修复回归：卡号弱语境 / 机构边界 / 缓存守卫 / 文件独立 / 元数据 / 复核闸口 */

const { test, assert, BANK1, tempDir, rmDir, makeDocx } = require('./helpers');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { detect, luhnValid } = require('../src/core/detector');
const { isSafeNameForCache } = require('../src/core/entities');
const { residualCheckDetailed, residualGate } = require('../src/core/residual');
const { maskFile } = require('../src/core/fileproc');
const { Vault } = require('../src/core/masker');

// 由虚构卡号改校验位得到非法号：模拟文书中手填错校验位的卡号
const BANK_BAD = BANK1.slice(0, -1) + (BANK1[BANK1.length - 1] === '0' ? '1' : '0');

test('卡号：关键词 + 引号中的非法校验位号码仍必须遮蔽', () => {
  assert.strictEqual(luhnValid(BANK_BAD), false, '样本校验位应为非法');
  const text = `交易卡号为“${BANK_BAD}”的银行交易流水`;
  const items = detect(text).items.filter((i) => i.type === 'bank');
  assert.ok(items.some((i) => i.value === BANK_BAD), JSON.stringify(items));
});

test('卡号：弱语境裸号兜底，模板号不误伤', () => {
  assert.ok(detect(`交易流水 ${BANK_BAD} 已核对`).items.some((i) => i.type === 'bank' && i.value === BANK_BAD));
  assert.strictEqual(detect('模板号0878968263').items.filter((i) => i.type === 'bank').length, 0);
});

test('机构边界：找到/前往不吞进机构字号', () => {
  const values = (t) => detect(t).items.filter((i) => i.type === 'org').map((i) => i.value);
  assert.deepStrictEqual(values('我先是找到云岭县育才中学校长'), ['云岭县育才中学']);
  assert.deepStrictEqual(values('前往云岭县育才中学'), ['云岭县育才中学']);
});

test('姓名缓存守卫：虚词收尾的毒种子不得入库', () => {
  assert.strictEqual(isSafeNameForCache('李敬舟'), true);
  assert.strictEqual(isSafeNameForCache('李敬舟在'), false);
  assert.strictEqual(isSafeNameForCache('李敬舟和'), false);
});

test('文件独立：无语境姓名单靠本文件不被识别，不靠跨文件缓存命中', () => {
  // 甲文件里「高兴，男，1990年出生」是人名；乙文件「不是高兴，而是伤心」里是形容词。
  // 两文件独立时，乙文件不应因为甲文件的确认而被遮——处理流程不再自动传账本/缓存。
  const text = '不是高兴，而是伤心';
  assert.strictEqual(detect(text).items.length, 0, '本文件自检测不应命中');

  const dir = tempDir('lingyu-independent-');
  try {
    const src = path.join(dir, 'essay.txt');
    fs.writeFileSync(src, text, 'utf8');
    // 不传 knownNames / caseBook / namesFile：与主流程一致
    const r = maskFile(src, new Vault(), undefined, path.join(dir, 'essay_屏蔽.txt'));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.count, 0, '独立性下无语境姓名不应命中');
  } finally {
    rmDir(dir);
  }
});

test('Office 元数据：作者/模板号/时间戳字段级清洗，不进正文实体表', () => {
  const dir = tempDir('lingyu-meta-');
  try {
    const src = path.join(dir, 'meta.docx');
    makeDocx(src, '原告：张三，手机 13812345678。');
    const zip = new AdmZip(src);
    zip.addFile('docProps/core.xml', Buffer.from(
      '<?xml version="1.0"?><cp:coreProperties xmlns:dc="d" xmlns:cp="c" xmlns:dcterms="t" xmlns:xsi="x">'
      + '<dc:title>阅卷记录黄小明</dc:title><dc:creator>微软用户</dc:creator>'
      + '<cp:lastModifiedBy>李棠</cp:lastModifiedBy>'
      + '<dcterms:created xsi:type="dcterms:W3CDTF">2026-11-10T08:42:00Z</dcterms:created>'
      + '</cp:coreProperties>', 'utf8'));
    zip.addFile('docProps/app.xml', Buffer.from(
      '<?xml version="1.0"?><Properties><Company>海风事务所</Company>'
      + '<Template>0878968263</Template><Manager>王五</Manager></Properties>', 'utf8'));
    zip.writeZip(src);

    const out = path.join(dir, 'meta_屏蔽.docx');
    const r = maskFile(src, new Vault(), undefined, out);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const outZip = new AdmZip(out);
    const core = outZip.getEntry('docProps/core.xml').getData().toString('utf8');
    const app = outZip.getEntry('docProps/app.xml').getData().toString('utf8');
    for (const v of ['黄小明', '微软用户', '李棠', '2026-11-10T08:42:00Z']) {
      assert.ok(!core.includes(v), `core.xml 不应残留 ${v}`);
    }
    for (const v of ['海风事务所', '王五', '0878968263', '087****8263']) {
      assert.ok(!app.includes(v), `app.xml 不应残留或误遮 ${v}`);
    }
  } finally {
    rmDir(dir);
  }
});

test('复核闸口：详细报告可定位，严格模式删除产物并阻断交付', () => {
  const report = residualCheckDetailed('问：电话13812345678。', {}, new Set());
  assert.ok(report && report.code === 'residual-pii');
  assert.strictEqual(report.items[0].value, '13812345678');
  assert.ok(report.items[0].excerpt.includes('13812345678'));
  assert.strictEqual(residualCheckDetailed('电话138****5678', {}, new Set()), null);

  const dir = tempDir('lingyu-gate-');
  try {
    const out = path.join(dir, 'result.txt');
    fs.writeFileSync(out, '本次生成的产物', 'utf8');
    const g = residualGate('电话13812345678', {}, { strictResidual: true }, out);
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.skipped, 'residual-pii');
    assert.ok(!fs.existsSync(out), '严格模式应删除本次产物');
    const soft = residualGate('电话13812345678', {}, {}, out);
    assert.strictEqual(soft.warning, 'residual-pii');
    assert.ok(soft.residual.items.length > 0);
  } finally {
    rmDir(dir);
  }
});

test('头衔锚点：无冒号「副总经理+姓名」经全文件复现确认，孤例动词不误伤', () => {
  const { collectEntities } = require('../src/core/entities');
  // 虚构样本：某副总经理在文书里出现 5 次、上下文各异 → 应确认为姓名
  const doc = [
    '被告人李敬舟联系某公司副总经理王志远，请求提供帮助。',
    '上述虚假合同，王志远表示同意并签字。',
    '2023年3月，王志远按照李敬舟的安排办理了相关手续。',
    '公司在扣除手续费后，将现金交给王志远。',
    '随后王志远在停车场将该款全部交给李敬舟。',
  ];
  const known = collectEntities(doc, {});
  assert.ok(known.name.has('王志远'), '多次复现的头衔姓名应被确认');

  // 单处 detect 不当场确认（证据不足，交给全文件判定）
  const single = detect('副总经理王志远，请求帮忙').items;
  assert.ok(!single.some((i) => i.value === '王志远'), '单处弱证据不应立即确认');

  // 复现不足的弱候选不得被确认：同样结构但全文只出现一次（非独占行，绕开既有 blockClosed）
  const weak = collectEntities([
    '该公司副总经理周建国请假回家。',
    '其余事项另行通知。',
  ], {});
  assert.ok(!weak.name.has('周建国'), '仅出现一次的头衔弱候选不应被确认为姓名');
});

test('法律文书姓名闭合：角色+逗号谓语、普通动作、的证言、同案犯、祖父', () => {
  const nameHits = (text) => detect(text).items
    .filter((i) => i.type === 'name').map((i) => i.value);

  assert.deepStrictEqual(nameHits('辩护人李晓龙，指派。'), ['李晓龙']);
  assert.deepStrictEqual(nameHits('被害人王芳停放在此车内现金2000元。'), ['王芳']);
  assert.deepStrictEqual(nameHits('证人陈阿满的证言；'), ['陈阿满']);
  assert.deepStrictEqual(nameHits('同案犯张伟的供述；'), ['张伟']);
  assert.deepStrictEqual(nameHits('其祖父李敬舟愿意履行监护职责'), ['李敬舟']);

  // 封闭结构负例：角色词后是动作/泛称或普通状语时不得猜姓名
  assert.deepStrictEqual(nameHits('辩护人出庭，核对身份。'), []);
  assert.deepStrictEqual(nameHits('证人证言；'), []);
  assert.deepStrictEqual(nameHits('祖父长期在外务工'), []);
  assert.deepStrictEqual(nameHits('被害人停放车辆后离开'), []);
});

test('地址：村庄类「庄」+门牌可识别，普通名词不误伤', () => {
  const addressHits = (text) => detect(text).items
    .filter((i) => i.type === 'address').map((i) => i.value);
  assert.deepStrictEqual(addressHits('户籍所在地及住址裴庄46号。'), ['裴庄46号']);
  assert.deepStrictEqual(addressHits('张家庄1号'), ['张家庄1号']);
  assert.deepStrictEqual(addressHits('委会裴庄46号。'), ['裴庄46号']);
  assert.deepStrictEqual(addressHits('村委会裴庄46号。'), ['裴庄46号']);
  assert.deepStrictEqual(addressHits('村庄46号'), []);
  assert.deepStrictEqual(addressHits('庄子46号'), []);
});
