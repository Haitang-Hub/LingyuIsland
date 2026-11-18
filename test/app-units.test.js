'use strict';
/** 应用单元套件：导入/索引/设置/剪贴板/灵动岛/布局/外观/更新/版本/老式转换 */

const { test, assert, tempDir, rmDir } = require('./helpers');
const fs = require('fs');
const path = require('path');

/* ---------------- 导入与分类（imports.js） ---------------- */

const { isInsideRoot, uniqueTargetName, categoryOf, timeGroupOf, CATEGORY_LABEL } = require('../src/core/imports');

test('isInsideRoot：Windows 大小写/分隔符不敏感', () => {
  assert.strictEqual(isInsideRoot('F:\\Law\\Test\\a.docx', 'F:\\Law\\Test'), true);
  assert.strictEqual(isInsideRoot('f:/law/test/a.docx', 'F:\\Law\\Test'), true);
  assert.strictEqual(isInsideRoot('F:\\Law\\Test2\\a.docx', 'F:\\Law\\Test'), false);
  assert.strictEqual(isInsideRoot('D:\\other\\a.docx', 'F:\\Law\\Test'), false);
});

test('isInsideRoot：macOS 路径', () => {
  assert.strictEqual(isInsideRoot('/Users/t/docs/a.docx', '/Users/t/docs'), true);
  assert.strictEqual(isInsideRoot('/Users/t/other/a.docx', '/Users/t/docs'), false);
});

test('uniqueTargetName：无冲突直用，冲突加两位序号', () => {
  const dir = 'X:\\root';
  assert.strictEqual(uniqueTargetName(dir, '文件', '.docx', () => false), '文件.docx');
  const exists = new Set(['X:\\root\\文件.docx', 'X:\\root\\文件_02.docx']);
  assert.strictEqual(uniqueTargetName(dir, '文件', '.docx', (f) => exists.has(f)), '文件_03.docx');
});

test('categoryOf：常见扩展名归类', () => {
  assert.strictEqual(categoryOf('.docx'), 'doc');
  assert.strictEqual(categoryOf('pdf'), 'doc');
  assert.strictEqual(categoryOf('xlsx'), 'sheet');
  assert.strictEqual(categoryOf('csv'), 'sheet');
  assert.strictEqual(categoryOf('txt'), 'text');
  assert.strictEqual(categoryOf('md'), 'text');
  assert.strictEqual(categoryOf('py'), 'code');
  assert.strictEqual(categoryOf('png'), 'other');
  assert.ok(CATEGORY_LABEL[categoryOf('docx')]);
});

test('timeGroupOf：时间分组', () => {
  assert.strictEqual(timeGroupOf(Date.now()), '今天');
  assert.strictEqual(timeGroupOf(Date.now() - 86400000), '昨天');
  assert.strictEqual(timeGroupOf(Date.now() - 3 * 86400000), '本周');
  assert.strictEqual(timeGroupOf(Date.now() - 30 * 86400000), '更早');
  assert.strictEqual(timeGroupOf(0), '更早');
});

/* ---------------- 索引类别筛选（indexer.js） ---------------- */

const { Indexer } = require('../src/main/indexer');

function makeCategoryIndexer() {
  const idx = new Indexer();
  idx.root = 'D:\\测试根目录';
  const now = Date.now();
  const rows = [
    ['合同.docx', '法务/合同.docx', 'docx'],
    ['审批单.pdf', '行政/审批单.pdf', 'pdf'],
    ['花名册.xlsx', '人事/花名册.xlsx', 'xlsx'],
    ['客户.csv', '销售/客户.csv', 'csv'],
    ['纪要.txt', '纪要.txt', 'txt'],
    ['配置.json', '配置.json', 'json'],
    ['main.py', 'src/main.py', 'py'],
    ['页面.html', 'src/页面.html', 'html'],
    ['印章.png', '素材/印章.png', 'png'],
    ['录音.mp3', '行政/录音.mp3', 'mp3'],
  ];
  idx.entries = rows.map(([n, p, e], i) => ({ n, p, e, s: 100, m: now - i * 1000 }));
  return idx;
}

test('类别筛选：空查询只返回该类别的文件', () => {
  const idx = makeCategoryIndexer();
  assert.deepStrictEqual(idx.search('', 50, 'doc').items.map((i) => i.e).sort(), ['docx', 'pdf']);
  assert.deepStrictEqual(idx.search('', 50, 'sheet').items.map((i) => i.e).sort(), ['csv', 'xlsx']);
  assert.deepStrictEqual(idx.search('', 50, 'text').items.map((i) => i.e).sort(), ['json', 'txt']);
  assert.deepStrictEqual(idx.search('', 50, 'code').items.map((i) => i.e).sort(), ['html', 'py']);
  assert.deepStrictEqual(idx.search('', 50, 'other').items.map((i) => i.e).sort(), ['mp3', 'png']);
  assert.strictEqual(idx.search('', 50, 'all').total, 10);
});

test('类别筛选：与关键词叠加', () => {
  const idx = makeCategoryIndexer();
  assert.strictEqual(idx.search('客户', 50, 'sheet').total, 1, '「客户.csv」应命中表格类');
  assert.strictEqual(idx.search('客户', 50, 'doc').total, 0, '文档类不应命中');
  assert.strictEqual(idx.search('客户', 50, 'all').total, 1);
  assert.strictEqual(idx.search('src', 50, 'code').total, 2, '路径关键词应命中代码类');
});

test('类别筛选：counts 统计各分类且不受当前类别影响', () => {
  const idx = makeCategoryIndexer();
  const all = idx.search('', 50, 'all');
  const code = idx.search('', 50, 'code');
  assert.deepStrictEqual(code.counts, all.counts);
  assert.deepStrictEqual(code.counts, { all: 10, doc: 2, sheet: 2, text: 2, code: 2, other: 2 });
  assert.strictEqual(idx.search('客户', 50, 'all').counts.all, 1, 'counts 应随关键词变化');
});

test('类别筛选：total 不受 limit 截断，非法类别回退全部', () => {
  const idx = makeCategoryIndexer();
  const r = idx.search('', 3, 'all');
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.items[0].n, '合同.docx', '空查询应按修改时间倒序');
  const invalid = idx.search('', 50, 'unknown');
  assert.strictEqual(invalid.category, 'all');
  assert.strictEqual(invalid.total, 10);
});

test('类别筛选：未配置根目录时安全返回空结果', () => {
  const r = new Indexer().search('合同', 50, 'doc');
  assert.deepStrictEqual(r.items, []);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.counts.all, 0);
  assert.strictEqual(r.root, '');
});

/* ---------------- 自定义自动收起时长（store.js） ---------------- */

const {
  Store, DEFAULT_SETTINGS, normalizeCollapseDelay,
  COLLAPSE_MIN_SEC, COLLAPSE_MAX_SEC, DEFAULT_COLLAPSE_SEC,
} = require('../src/main/store');

const TMP = tempDir('lingyu-app-units-');
fs.mkdirSync(TMP, { recursive: true });

test('自动收起时长：默认值与范围常量', () => {
  assert.strictEqual(DEFAULT_COLLAPSE_SEC, 20);
  assert.strictEqual(DEFAULT_SETTINGS.autoCollapseDelay, 20);
  assert.strictEqual(COLLAPSE_MIN_SEC, 5);
  assert.strictEqual(COLLAPSE_MAX_SEC, 3600);
});

test('自动收起时长：边界裁剪与非法值回退', () => {
  assert.strictEqual(normalizeCollapseDelay(45), 45);
  assert.strictEqual(normalizeCollapseDelay(30.7), 31, '小数取整');
  assert.strictEqual(normalizeCollapseDelay('60'), 60, '数字字符串可用');
  assert.strictEqual(normalizeCollapseDelay(1), 5, '低于下限取下限');
  assert.strictEqual(normalizeCollapseDelay(99999), 3600, '高于上限取上限');
  assert.strictEqual(normalizeCollapseDelay('abc'), 20, '非数字回退默认');
  assert.strictEqual(normalizeCollapseDelay(NaN), 20);
  assert.strictEqual(normalizeCollapseDelay(Infinity), 20);
  assert.strictEqual(normalizeCollapseDelay('abc', 45), 45, '非法值可指定 fallback');
});

test('自动收起时长：saveSettings 统一裁剪并落盘', () => {
  const s = new Store();
  s.dir = TMP;
  const file = s.paths.settings;
  try {
    assert.strictEqual(s.saveSettings({ autoCollapseDelay: 45 }).autoCollapseDelay, 45);
    assert.strictEqual(s.saveSettings({ autoCollapseDelay: 99999 }).autoCollapseDelay, 3600);
    assert.strictEqual(s.saveSettings({ autoCollapseDelay: 'abc' }).autoCollapseDelay, 3600,
      '非法值回退到上一次有效值');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).autoCollapseDelay, 3600);
    assert.strictEqual(s.saveSettings({ clipboardWatch: false }).autoCollapseDelay, 3600);
    assert.strictEqual(s.settings.clipboardWatch, false);
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

test('自动收起时长：旧配置缺字段或非法值时自动补正', () => {
  const s = new Store();
  s.dir = TMP;
  const file = s.paths.settings;
  try {
    fs.writeFileSync(file, JSON.stringify({ rootDir: 'X:\\docs' }), 'utf8');
    s._loadSettings();
    assert.strictEqual(s.settings.autoCollapseDelay, 20, '缺字段补默认值');
    fs.writeFileSync(file, JSON.stringify({ autoCollapseDelay: -8 }), 'utf8');
    s._loadSettings();
    assert.strictEqual(s.settings.autoCollapseDelay, 5, '非法值裁剪');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

/* ---------------- 剪贴板监听（clipboard.js） ---------------- */

const { ClipboardWatcher } = require('../src/main/clipboard');

const MASKED_A = '联系人：138****5678〔ab12cd〕';
const MASKED_B = '联系人：139****5678〔ef34ab〕';
const PLAIN = '这是一段无关文本';

function makeClipWatcher() {
  const ref = { value: '' };
  const events = [];
  const w = new ClipboardWatcher({ readText: () => ref.value });
  let enabled = true;
  w.start(
    () => enabled,
    (info) => events.push(['found', info && info.count]),
    () => events.push(['cleared'])
  );
  w.stop(); // 手动驱动 _poll，避免定时器干扰
  return { ref, events, w, setEnabled: (v) => { enabled = v; } };
}

test('剪贴板监听：提示绑定检测到时的文本快照', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = MASKED_A;
  w._poll();
  assert.deepStrictEqual(events, [['found', 1]]);
  assert.strictEqual(w.getPendingText(), MASKED_A);
  w._poll();
  assert.strictEqual(events.length, 1);
});

test('剪贴板监听：换成别的内容后旧提示立即失效', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = MASKED_A; w._poll();
  ref.value = PLAIN; w._poll();
  assert.deepStrictEqual(events, [['found', 1], ['cleared']]);
  assert.strictEqual(w.getPendingText(), null);
});

test('剪贴板监听：换成另一段含编码文本时先清除再出新提示', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = MASKED_A; w._poll();
  ref.value = MASKED_B; w._poll();
  assert.deepStrictEqual(events, [['found', 1], ['cleared'], ['found', 1]]);
  assert.strictEqual(w.getPendingText(), MASKED_B, '快照应更新为最新一次复制的内容');
});

test('剪贴板监听：markHandled 后不再识别写回的明文', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = MASKED_A; w._poll();
  ref.value = '联系人：13812345678';
  w.markHandled(ref.value, true);
  assert.strictEqual(w.getPendingText(), null);
  assert.strictEqual(events.length, 1, 'silent 模式不应发 cleared');
  w._poll();
  assert.strictEqual(events.length, 1, '写回的明文不应再次触发提示');
});

test('剪贴板监听：关闭识别时清除提示', () => {
  const { ref, events, w, setEnabled } = makeClipWatcher();
  ref.value = MASKED_A; w._poll();
  setEnabled(false); w._poll();
  assert.deepStrictEqual(events, [['found', 1], ['cleared']]);
  assert.strictEqual(w.getPendingText(), null);
  setEnabled(true);
  ref.value = PLAIN; w._poll();
  assert.strictEqual(events.length, 2, '普通文本不应触发提示');
});

test('剪贴板监听：新格式〔手机号·ab12cd〕同样识别', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = '联系人：138****5678〔手机号·ab12cd〕';
  w._poll();
  assert.deepStrictEqual(events, [['found', 1]]);
});

/* ---------------- 同名冲突策略 ---------------- */

const { resolveConflictName, normalizeConflictPolicy, CONFLICT_POLICIES } = require('../src/core/imports');

function conflictExists(...names) {
  const dir = path.join(TMP, 'conflict');
  const set = new Set(names.map((n) => path.join(dir, n)));
  return { dir, fn: (p) => set.has(p) };
}

test('同名策略：策略值规范化', () => {
  assert.ok(CONFLICT_POLICIES.has('keep'));
  assert.ok(CONFLICT_POLICIES.has('overwrite'));
  assert.strictEqual(normalizeConflictPolicy('overwrite'), 'overwrite');
  assert.strictEqual(normalizeConflictPolicy('keep'), 'keep');
  assert.strictEqual(normalizeConflictPolicy('unknown'), 'keep');
  assert.strictEqual(normalizeConflictPolicy(undefined), 'keep');
});

test('同名策略：无冲突直接用原名', () => {
  const { dir, fn } = conflictExists();
  assert.deepStrictEqual(resolveConflictName(dir, '报告', '.docx', 'keep', fn),
    { name: '报告.docx', action: 'new' });
});

test('同名策略：保留两份时自动加序号', () => {
  const one = conflictExists('报告.docx');
  assert.deepStrictEqual(resolveConflictName(one.dir, '报告', '.docx', 'keep', one.fn),
    { name: '报告_02.docx', action: 'keep' });
  const two = conflictExists('报告.docx', '报告_02.docx');
  assert.deepStrictEqual(resolveConflictName(two.dir, '报告', '.docx', 'keep', two.fn),
    { name: '报告_03.docx', action: 'keep' });
});

test('同名策略：覆盖模式返回原名并标记 overwrite', () => {
  const { dir, fn } = conflictExists('报告.docx', '报告_02.docx');
  assert.deepStrictEqual(resolveConflictName(dir, '报告', '.docx', 'overwrite', fn),
    { name: '报告.docx', action: 'overwrite' });
});

test('同名策略：saveSettings 规范化并落盘', () => {
  const s = new Store();
  s.dir = TMP;
  const file = s.paths.settings;
  try {
    assert.strictEqual(s.saveSettings({ conflictPolicy: 'overwrite' }).conflictPolicy, 'overwrite');
    assert.strictEqual(s.saveSettings({ conflictPolicy: 'bad' }).conflictPolicy, 'keep');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).conflictPolicy, 'keep');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

/* ---------------- 外观（appearance / themes） ---------------- */

test('外观：主题注册表与 normalizeTheme / normalizeAccent', () => {
  const { normalizeTheme, normalizeAccent, THEMES, DEFAULT_THEME } = require('../src/core/themes');
  assert.strictEqual(THEMES.length, 8);
  assert.strictEqual(DEFAULT_THEME, 'midnight');
  assert.strictEqual(normalizeTheme('sakura'), 'sakura');
  assert.strictEqual(normalizeTheme('nope'), 'midnight');
  assert.strictEqual(normalizeTheme('nope', 'cloud'), 'cloud');
  assert.strictEqual(normalizeTheme('nope', 'bad'), 'midnight');
  assert.strictEqual(normalizeAccent('#34C77B'), '#34c77b');
  assert.strictEqual(normalizeAccent('red'), '');
  assert.strictEqual(normalizeAccent('#12345'), '');
  assert.strictEqual(normalizeAccent(''), '');
});

test('外观：normalizeAppearance 钳制 / 白名单 / 回退', () => {
  const { normalizeAppearance, ALPHA_MIN, ALPHA_MAX, RADIUS_MAX } = require('../src/core/appearance');
  const a = normalizeAppearance({
    theme: 'nosuchtheme', accent: '#FF8C42', alpha: 0.3, radius: 99, bgDim: 0.05,
    glass: 'x', panel: { w: 9, h: 99999 }, motion: 0,
    bg: { type: 'video', file: 'a.png' },
  }, null);
  assert.strictEqual(a.theme, 'midnight', '非法主题回退默认主题');
  assert.strictEqual(a.accent, '#ff8c42');
  assert.strictEqual(a.alpha, ALPHA_MIN, '低于下限钳回 0.55');
  assert.strictEqual(a.radius, RADIUS_MAX, '高于上限钳回 25');
  assert.strictEqual(a.glass, 'off');
  assert.deepStrictEqual(a.panel, { w: 360, h: 1000 }, '面板宽高各自钳制');
  assert.strictEqual(a.motion, false);
  assert.strictEqual(a.bgDim, 0.35, '背景遮罩低于下限钳回 0.35');
  assert.deepStrictEqual(a.bg, { type: 'video', file: '', name: '' }, '扩展名与类型不符 → 文件置空，类型保留');

  const b = normalizeAppearance({ alpha: 1.5, radius: 3, bg: { type: 'image' } }, null);
  assert.strictEqual(b.alpha, ALPHA_MAX);
  assert.strictEqual(b.radius, 10);
  assert.strictEqual(b.bg.type, 'image', 'type 单独 patch 生效');
  assert.strictEqual(b.bg.file, '');

  const c = normalizeAppearance(null, null);
  assert.strictEqual(c.theme, 'midnight');
  assert.strictEqual(c.alpha, 0.97);
  assert.strictEqual(c.radius, 18);
  assert.strictEqual(c.glass, 'off');
  assert.deepStrictEqual(c.panel, { w: 560, h: 700 }, '默认基准尺寸');
  assert.strictEqual(c.motion, true);
  assert.strictEqual(c.bgDim, 0.62, '背景遮罩默认 0.62');
  assert.deepStrictEqual(c.bg, { type: 'none', file: '', name: '' });

  const e = normalizeAppearance({ theme: 'cloud' }, { bgDim: 0.5, bg: { type: 'image', file: 'bg-1.png' } });
  assert.strictEqual(e.bgDim, 0.5);
  assert.strictEqual(e.bg.file, 'bg-1.png');

  const d = normalizeAppearance({ bg: { type: 'image', file: '..\\evil.png' } }, null);
  assert.strictEqual(d.bg.file, '');
});

test('外观：背景格式白名单（含 bmp/avif，拒绝 mov/mkv）与展示文件名', () => {
  const { normalizeAppearance, normalizeBgFile, normalizeBgName } = require('../src/core/appearance');

  for (const f of ['bg-1.png', 'bg-2.jpg', 'bg-3.jpeg', 'bg-4.webp', 'bg-5.gif', 'bg-6.bmp', 'bg-7.avif']) {
    assert.strictEqual(normalizeBgFile(f, 'image'), f, '图片应允许 ' + f);
  }
  assert.strictEqual(normalizeBgFile('bg-1.mp4', 'video'), 'bg-1.mp4');
  assert.strictEqual(normalizeBgFile('bg-1.webm', 'video'), 'bg-1.webm');
  assert.strictEqual(normalizeBgFile('bg-1.mov', 'video'), '', 'mov 无法解码，必须拒绝');
  assert.strictEqual(normalizeBgFile('bg-1.mkv', 'video'), '', 'mkv 无法解码，必须拒绝');

  assert.strictEqual(normalizeBgName('C:\\Users\\me\\图片\\风景.png', 'image'), '风景.png');
  assert.strictEqual(normalizeBgName('/home/me/a<b>.png', 'image'), 'ab.png');
  assert.strictEqual(normalizeBgName('x'.repeat(80), 'image').length, 60);
  assert.strictEqual(normalizeBgName('风景.png', 'none'), '');

  const a = normalizeAppearance({ bg: { type: 'image', file: 'bg-9.bmp', name: 'D:\\素材\\桌面.bmp' } }, null);
  assert.deepStrictEqual(a.bg, { type: 'image', file: 'bg-9.bmp', name: '桌面.bmp' });
  const b = normalizeAppearance({ bg: { type: 'image' } }, a);
  assert.strictEqual(b.bg.file, 'bg-9.bmp');
  assert.strictEqual(b.bg.name, '桌面.bmp');
  const c = normalizeAppearance({ bg: { type: 'none' } }, b);
  assert.deepStrictEqual(c.bg, { type: 'none', file: '', name: '' });
});

test('外观：saveSettings 持久化并规范化 appearance', () => {
  const s = new Store();
  s.dir = TMP;
  const file = s.paths.settings;
  try {
    const next = s.saveSettings({ appearance: { theme: 'sakura', alpha: 0.4, radius: 5, bg: { type: 'image', file: 'bg-abc.png' } } });
    assert.strictEqual(next.appearance.theme, 'sakura');
    assert.strictEqual(next.appearance.alpha, 0.55);
    assert.strictEqual(next.appearance.radius, 10);
    assert.strictEqual(next.appearance.bg.type, 'image');
    assert.strictEqual(next.appearance.bg.file, 'bg-abc.png');
    const n2 = s.saveSettings({ appearance: { theme: 'cloud' } });
    assert.strictEqual(n2.appearance.theme, 'cloud');
    assert.strictEqual(n2.appearance.bg.file, 'bg-abc.png');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).appearance.theme, 'cloud');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

/* ---------------- 面板点击外部收起 & 灵动岛（island.js） ---------------- */

const { Island } = require('../src/main/island');

function makeIslandStub(state) {
  const island = new Island();
  island.layout = () => {};
  island.panel = {
    isVisible: () => state.visible,
    hide() { state.visible = false; },
    show() { state.visible = true; state.shown.push('show'); },
    focus() { state.shown.push('focus'); },
    showInactive() { state.shown.push('showInactive'); },
    webContents: { send() {} },
  };
  return island;
}

test('面板：显示即激活窗口（始终点击面板外即收起）', () => {
  const s1 = { visible: false, shown: [] };
  const a = makeIslandStub(s1);
  a.showPanel();
  assert.deepStrictEqual(s1.shown, ['show', 'focus'], '面板必须激活窗口，blur 才能触发收起');
});

test('面板：胶囊点击视为点击面板外', () => {
  const s1 = { visible: true, shown: [] };
  const a = makeIslandStub(s1);
  a.onPillClick();
  assert.strictEqual(s1.visible, false, '面板可见时应收起，而不是重新展开');

  const s2 = { visible: false, shown: [] };
  const b = makeIslandStub(s2);
  b.onPillClick();
  assert.strictEqual(s2.visible, true, '面板不可见时点击胶囊应展开面板');
  assert.deepStrictEqual(s2.shown, ['show', 'focus']);
});

function makePillStub(island) {
  island.layout = () => {};
  island.panel = { isVisible: () => false, hide() {} };
  island.pill = {
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive() {},
    setIgnoreMouseEvents(_flag, _opts) {},
    setPosition() {},
    webContents: { send(ch, v) { island._lastSent = [ch, v]; } },
  };
}

test('灵动岛：收起为顶部线段（点击穿透 + 状态广播）', () => {
  const island = new Island();
  makePillStub(island);
  const events = [];
  island.onPillStateChange = () => events.push(island._pillVisible);
  island.collapsePill();
  assert.strictEqual(island.pillCollapsed, true);
  assert.strictEqual(island._pillVisible, false);
  assert.deepStrictEqual(island._lastSent, ['pill:state', 'collapsed']);
  assert.deepStrictEqual(events, [false]);
  island.collapsePill();
  assert.deepStrictEqual(events, [false]);
});

test('灵动岛：悬停线段展开回胶囊', () => {
  const island = new Island();
  makePillStub(island);
  island.setPillVisible(false);
  assert.strictEqual(island.pillCollapsed, true);
  island.setPillVisible(true);
  assert.strictEqual(island.pillCollapsed, false);
  assert.strictEqual(island._pillVisible, true);
  assert.deepStrictEqual(island._lastSent, ['pill:state', 'expanded']);
  island._lastSent = null;
  island.expandPill();
  assert.strictEqual(island._lastSent, null);
});

/* ---------------- 多分辨率 / DPI 自适应布局 ---------------- */

const {
  computeIslandLayout, normalizePanelSize, matchPreset, autoUiScale,
  PANEL_PRESETS, PANEL_LIMITS, BASE,
} = require('../src/core/layout');

const wa = (width, height, x = 0, y = 0) => ({ x, y, width, height });

function assertFits(area, plan, label) {
  const { pill, panel } = plan;
  for (const [name, w] of [['胶囊', pill], ['面板', panel]]) {
    assert.ok(w.x >= area.x, `${label}: ${name}左侧越界`);
    assert.ok(w.y >= area.y, `${label}: ${name}顶部越界`);
    assert.ok(w.x + w.width <= area.x + area.width, `${label}: ${name}右侧越界`);
    assert.ok(w.y + w.height <= area.y + area.height, `${label}: ${name}底部越界`);
  }
  assert.ok(panel.y >= pill.y + pill.height, `${label}: 面板与胶囊重叠`);
}

const SCREENS = [
  ['1080p @100%', wa(1920, 1040)],
  ['1366×768', wa(1366, 728)],
  ['1440p @100%', wa(2560, 1400)],
  ['4K @100%', wa(3840, 2100)],
  ['4K @150%（DIP 工作区）', wa(2560, 1400)],
  ['主屏带偏移（外接副屏为主）', wa(1920, 1040, 1920, 100)],
  ['小工作区 800×400', wa(800, 400)],
  ['窄竖屏 600×900', wa(600, 900)],
  ['超宽屏 3440×1440', wa(3440, 1400)],
];

test('自适应布局：常见分辨率下窗口都完整可见且不与胶囊重叠', () => {
  for (const [label, area] of SCREENS) {
    const plan = computeIslandLayout(area);
    assertFits(area, plan, label);
    assert.ok(plan.uiScale >= 0.85 && plan.uiScale <= 1.3, `${label}: 缩放超出范围`);
  }
});

test('自适应布局：1080p 基准保持设计尺寸，缩放为 1', () => {
  const p = computeIslandLayout(wa(1920, 1040));
  assert.strictEqual(p.uiScale, 1);
  assert.deepStrictEqual(p.pill, { x: 774, y: 6, width: BASE.pillW, height: BASE.pillH });
  assert.strictEqual(p.panel.y, 62);
  assert.strictEqual(p.panel.width, BASE.panelW);
  assert.strictEqual(p.panel.height, BASE.panelH);
});

test('自适应布局：高分屏放大、低分屏缩小，切换分辨率会改变窗口尺寸', () => {
  const small = computeIslandLayout(wa(1366, 728));
  const big = computeIslandLayout(wa(3840, 2100));
  assert.ok(big.uiScale > small.uiScale, '4K 应比 768p 更大');
  assert.ok(small.panel.height < big.panel.height, '小屏面板应被压缩/缩小');
  assert.ok(small.panel.y >= small.pill.y + small.pill.height, '旧公式会把面板上移与胶囊重叠');
});

test('自适应布局：面板高度按可用空间裁剪，绝不靠上移窗口硬塞', () => {
  const area = wa(1024, 500);
  const p = computeIslandLayout(area);
  assertFits(area, p, '1024×500');
  assert.ok(p.panel.y > area.y, '面板顶部必须留在胶囊下方');
  assert.ok(p.panel.height < BASE.panelH, '可用高度不足时应压缩面板');
});

test('自适应布局：面板宽高独立，可细长 / 宽扁（非等比放大）', () => {
  const area = wa(1920, 1040);
  const { narrow, standard, wide } = PANEL_PRESETS;
  const plan = (s) => computeIslandLayout(area, { panelW: s.w, panelH: s.h });
  const pn = plan(narrow), ps = plan(standard), pw = plan(wide);

  assert.ok(pn.panel.width < ps.panel.width && pn.panel.height > ps.panel.height, '细长档应更窄更高');
  assert.ok(pw.panel.width > ps.panel.width && pw.panel.height < ps.panel.height, '宽扁档应更宽更矮');

  for (const [p, s, label] of [[pn, narrow, '细长'], [ps, standard, '标准'], [pw, wide, '宽扁']]) {
    assert.ok(Math.abs(p.panel.width / p.panelScale - s.w) <= 1, `${label}档宽度视口不符`);
    assert.ok(Math.abs(p.panel.height / p.panelScale - s.h) <= 1, `${label}档高度视口不符`);
    assertFits(area, p, label);
  }
  for (const [label, a] of SCREENS) {
    for (const s of [narrow, standard, wide]) {
      assertFits(a, computeIslandLayout(a, { panelW: s.w, panelH: s.h }), `${label}×${s.id}`);
    }
  }
  assert.deepStrictEqual(computeIslandLayout(area, { panelW: wide.w, panelH: wide.h }).pill,
    computeIslandLayout(area, { panelW: narrow.w, panelH: narrow.h }).pill);

  assert.deepStrictEqual(normalizePanelSize({ w: 99999, h: 1 }), { w: PANEL_LIMITS.maxW, h: PANEL_LIMITS.minH });
  assert.deepStrictEqual(normalizePanelSize({ w: 'x', h: NaN }), { w: BASE.panelW, h: BASE.panelH });
  assert.deepStrictEqual(normalizePanelSize(null, { w: 700, h: 640 }), { w: 700, h: 640 }, '缺省沿用上一次');
  assert.strictEqual(matchPreset({ w: wide.w, h: wide.h }), 'wide');
  assert.strictEqual(matchPreset({ w: 700, h: 640 }), '');
  assert.strictEqual(autoUiScale(1920, 1040), 1);
});

test('自适应布局：胶囊宽度跟随字体档位等比伸缩，且不越出屏幕', () => {
  const area = wa(1920, 1040);
  const pillW = (fs) => computeIslandLayout(area, { fontScale: fs }).pill.width;
  assert.ok(pillW(0.9) < pillW(1) && pillW(1) < pillW(1.15) && pillW(1.15) < pillW(1.3),
    '字体档位越高胶囊越宽');
  assert.ok(Math.abs(pillW(1.3) / pillW(1) - 1.3) <= 0.02, '宽度按档位系数等比伸缩');
  assert.strictEqual(pillW(2), pillW(1.3), '越界档位钳到上限');
  assert.strictEqual(pillW(0.1), pillW(0.85), '越界档位钳到下限');
  assert.strictEqual(pillW('x'), pillW(1), '非法档位回退标准');
  for (const [label, a] of SCREENS) {
    for (const fs of [0.9, 1, 1.15, 1.3]) {
      assertFits(a, computeIslandLayout(a, { fontScale: fs }), `${label}×fs${fs}`);
    }
  }
});

test('自适应布局：收起态胶囊贴顶，面板位置不受影响', () => {
  const area = wa(1920, 1040, 100, 30);
  const expanded = computeIslandLayout(area, { collapsed: false });
  const collapsed = computeIslandLayout(area, { collapsed: true });
  assert.strictEqual(collapsed.pill.y, 30);
  assert.strictEqual(expanded.pill.y, 36);
  assert.strictEqual(collapsed.panel.y, expanded.panel.y);
  assertFits(area, collapsed, '收起态');
});

test('自适应布局：非法工作区不抛错且结果仍为有限整数', () => {
  const p = computeIslandLayout({ x: NaN, y: NaN, width: 0, height: 0 });
  for (const w of [p.pill, p.panel]) {
    for (const k of ['x', 'y', 'width', 'height']) {
      assert.ok(Number.isFinite(w[k]) && Number.isInteger(w[k]));
    }
  }
  assert.ok(p.panel.height >= 1);
});

test('灵动岛位置：0.5 居中与旧版纯居中完全一致，缺省回退 0.5', () => {
  const area = wa(1920, 1040, 100, 30);
  const legacy = computeIslandLayout(area);
  const center = computeIslandLayout(area, { pillX: 0.5 });
  assert.strictEqual(center.pill.x, legacy.pill.x);
  assert.strictEqual(center.panel.x, legacy.panel.x);
  assert.strictEqual(computeIslandLayout(area, { pillX: undefined }).pill.x, legacy.pill.x);
});

test('灵动岛位置：0 与 1 分别贴左右安全边，且 0 不被当成缺省', () => {
  const area = wa(1920, 1040, 100, 30);
  const left = computeIslandLayout(area, { pillX: 0 });
  const right = computeIslandLayout(area, { pillX: 1 });
  const edge = 8;
  assert.strictEqual(left.pill.x, 100 + edge);
  assert.strictEqual(right.pill.x, 100 + 1920 - edge - right.pill.width);
  assert.notStrictEqual(left.pill.x, computeIslandLayout(area).pill.x);
});

test('灵动岛位置：越界比例被钳回，面板跟随胶囊且不越出屏幕', () => {
  const area = wa(1920, 1040, 100, 30);
  const edge = 8;
  for (const ratio of [-0.3, 0.02, 0.5, 0.97, 1.6]) {
    const p = computeIslandLayout(area, { pillX: ratio });
    assert.ok(p.pill.x >= 100 + edge && p.pill.x <= 100 + 1920 - edge - p.pill.width,
      `ratio=${ratio} 胶囊越界`);
    assert.ok(p.panel.x >= 100 + edge && p.panel.x <= 100 + 1920 - edge - p.panel.width,
      `ratio=${ratio} 面板越界`);
    assert.ok(Math.abs(p.panel.x + p.panel.width / 2 - (p.pill.x + p.pill.width / 2))
      <= p.panel.width / 2 + p.pill.width / 2, `ratio=${ratio} 面板未跟随胶囊`);
  }
});

/* ---------------- 版本更新 ---------------- */

test('compareVersions：相等/小于/大于', () => {
  const { compareVersions } = require('../src/core/version');
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1);
  assert.strictEqual(compareVersions('1.2.0', '9.9.9'), -1);
});

test('compareVersions：多位数与前缀 v', () => {
  const { compareVersions } = require('../src/core/version');
  assert.strictEqual(compareVersions('v1.10.0', '1.9.0'), 1);
  assert.strictEqual(compareVersions('2.0.0', '10.0.0'), -1, '逐段数字比较，不能按字符串比');
  assert.strictEqual(compareVersions('1.0.0-rc1', '1.0.0'), 0, '预发布后缀段解析为 0，宽松处理');
});

test('compareVersions：非法输入不抛错', () => {
  const { compareVersions } = require('../src/core/version');
  assert.strictEqual(compareVersions('', '1.0.0'), -1);
  assert.strictEqual(compareVersions(null, '1.0.0'), -1);
  assert.strictEqual(compareVersions('abc', '1.0.0'), -1);
});

test('depsEqual：依赖变化检测', () => {
  const { depsEqual } = require('../src/main/updater');
  assert.strictEqual(depsEqual({ a: '^1.0.0', b: '^2.0.0' }, { b: '^2.0.0', a: '^1.0.0' }), true);
  assert.strictEqual(depsEqual({ a: '^1.0.0' }, { a: '^1.0.1' }), false);
  assert.strictEqual(depsEqual({ a: '^1.0.0' }, { a: '^1.0.0', b: '^2.0.0' }), false);
  assert.strictEqual(depsEqual(undefined, {}), true);
  assert.strictEqual(depsEqual({}, undefined), true);
});

test('applyStaged：拷贝覆盖与跳过列表（临时目录模拟）', () => {
  const { copyTreeSync, SKIP_COPY, createUpdater } = require('../src/main/updater');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lingyu-upd-'));
  try {
    const appDir = path.join(tmp, 'app');
    fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'node_modules', 'electron'), { recursive: true });
    fs.mkdirSync(path.join(appDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'src', 'old.txt'), 'OLD');
    fs.writeFileSync(path.join(appDir, 'package.json'), '{"version":"1.0.0"}');
    fs.writeFileSync(path.join(appDir, 'node_modules', 'electron', 'keep.txt'), 'MUST-STAY');
    fs.writeFileSync(path.join(appDir, '.git', 'HEAD'), 'MUST-STAY');

    const pkg = path.join(tmp, 'stage', 'package');
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'src', 'old.txt'), 'NEW');
    fs.writeFileSync(path.join(pkg, 'src', 'new.txt'), 'ADDED');
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"9.9.9"}');

    const up = createUpdater({ appDir, currentVersion: '1.0.0', onBroadcast: () => {} });
    const r = up.applyStaged();
    assert.strictEqual(r.ok, false, '未进入 staged 状态时不应应用');

    copyTreeSync(pkg, appDir, SKIP_COPY);
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'src', 'old.txt'), 'utf8'), 'NEW', '旧文件被覆盖');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'src', 'new.txt'), 'utf8'), 'ADDED', '新文件被加入');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'), '{"version":"9.9.9"}');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'node_modules', 'electron', 'keep.txt'), 'utf8'),
      'MUST-STAY', 'node_modules 不被触碰');
    assert.strictEqual(fs.readFileSync(path.join(appDir, '.git', 'HEAD'), 'utf8'), 'MUST-STAY', '.git 不被触碰');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
