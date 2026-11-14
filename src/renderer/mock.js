'use strict';
/**
 * 浏览器环境 Mock（仅在 window.island 不存在时生效，用于 UI 检查）
 * Electron 运行时 preload 已注入真实 API，此文件自动跳过
 */

if (!window.island) {
  const now = Date.now();
  const MIN = 60 * 1000;

  // 与 src/core/imports.js 的 CATEGORY_EXTS 保持一致，浏览器预览同样能演示筛选
  const CAT_EXTS = {
    doc: ['docx', 'doc', 'pdf', 'pptx', 'ppt', 'odt', 'rtf', 'wps', 'pages'],
    sheet: ['xlsx', 'xls', 'csv', 'tsv', 'ods', 'numbers'],
    text: ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'log', 'srt', 'vtt', 'properties'],
    code: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs',
           'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'vue', 'html', 'htm', 'css', 'scss', 'less',
           'toml', 'tex', 'swift', 'dart', 'lua'],
  };
  const catOf = (e) => {
    const x = String(e || '').toLowerCase();
    for (const [k, list] of Object.entries(CAT_EXTS)) if (list.includes(x)) return k;
    return 'other';
  };
  const COLLAPSE_RANGE = { min: 5, max: 3600, default: 20 };
  const clampDelay = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(COLLAPSE_RANGE.max, Math.max(COLLAPSE_RANGE.min, Math.round(n)));
  };

  const settings = {
    rootDir: 'D:\\工作文档',
    importBehavior: 'keep',
    conflictPolicy: 'keep',
    toggles: {
      phone: true, idCard: true, bank: true, email: true,
      name: true, address: true, passport: true, plate: true,
      caseNo: true, license: true, org: true,
      landline: false, im: false, hkmt: false, uscc: false,
    },
    clipboardWatch: true,
    autoCollapse: true,
    autoCollapseDelay: 20,
    launchOnBoot: false,
  };

  const history = [
    { id: 'h3', ts: now - 8 * MIN, origPath: 'D:\\工作文档\\人事\\员工花名册.xlsx', maskedPath: 'D:\\工作文档\\人事\\员工花名册_屏蔽.xlsx', count: 24, counts: { name: 8, phone: 8, idCard: 8 }, summary: '姓名×8、手机号×8、身份证×8' },
    { id: 'h2', ts: now - 55 * MIN, origPath: 'D:\\工作文档\\销售\\客户通讯录.csv', maskedPath: 'D:\\工作文档\\销售\\客户通讯录_屏蔽.csv', count: 15, counts: { name: 5, phone: 6, email: 4 }, summary: '姓名×5、手机号×6、邮箱×4' },
    { id: 'h1', ts: now - 26 * 60 * MIN, origPath: 'D:\\工作文档\\会议纪要0412.txt', maskedPath: 'D:\\工作文档\\会议纪要0412_屏蔽.txt', count: 3, counts: { phone: 2, name: 1 }, summary: '手机号×2、姓名×1' },
  ];

  // 相对路径统一用 “/”，与真实索引一致（打开文件时由 joinPath 转成平台分隔符）
  const indexFiles = [
    { n: '员工花名册.xlsx', p: '人事/员工花名册.xlsx', e: 'xlsx', s: 48213, m: now - 8 * MIN },
    { n: '员工花名册_屏蔽.xlsx', p: '人事/员工花名册_屏蔽.xlsx', e: 'xlsx', s: 47102, m: now - 7 * MIN },
    { n: '客户通讯录.csv', p: '销售/客户通讯录.csv', e: 'csv', s: 15320, m: now - 55 * MIN },
    { n: '客户通讯录_屏蔽.csv', p: '销售/客户通讯录_屏蔽.csv', e: 'csv', s: 14897, m: now - 54 * MIN },
    { n: '会议纪要0412.txt', p: '会议纪要0412.txt', e: 'txt', s: 8241, m: now - 26 * 60 * MIN },
    { n: '会议纪要0412_屏蔽.txt', p: '会议纪要0412_屏蔽.txt', e: 'txt', s: 8102, m: now - 25 * 60 * MIN },
    { n: '劳动合同模板.docx', p: '法务/劳动合同模板.docx', e: 'docx', s: 92410, m: now - 3 * 24 * 60 * MIN },
    { n: '供应商清单.json', p: '采购/供应商清单.json', e: 'json', s: 12034, m: now - 5 * 24 * 60 * MIN },
    { n: '项目预算表.xlsx', p: '财务/项目预算表.xlsx', e: 'xlsx', s: 33121, m: now - 6 * 24 * 60 * MIN },
    { n: '报销明细_3月.csv', p: '财务/报销明细_3月.csv', e: 'csv', s: 21044, m: now - 7 * 24 * 60 * MIN },
    { n: '出差审批单.pdf', p: '行政/出差审批单.pdf', e: 'pdf', s: 220145, m: now - 9 * 24 * 60 * MIN },
    { n: '值班安排.txt', p: '行政/值班安排.txt', e: 'txt', s: 3120, m: now - 10 * 24 * 60 * MIN },
    { n: '数据清洗.py', p: '脚本/数据清洗.py', e: 'py', s: 6420, m: now - 2 * 24 * 60 * MIN },
    { n: '报表模板.html', p: '脚本/报表模板.html', e: 'html', s: 11890, m: now - 4 * 24 * 60 * MIN },
    { n: 'build.js', p: '脚本/build.js', e: 'js', s: 3310, m: now - 11 * 24 * 60 * MIN },
    { n: '公司印章.png', p: '素材/公司印章.png', e: 'png', s: 88400, m: now - 12 * 24 * 60 * MIN },
    { n: '会议录音.mp3', p: '行政/会议录音.mp3', e: 'mp3', s: 2401000, m: now - 13 * 24 * 60 * MIN },
  ];

  const SAMPLE_MASKED = '联系人：张*〔9dbf93〕，手机 138****5678〔6903db〕，身份证 3301……567X〔c81e72〕。性别：男 年龄：35岁。';

  // 浏览器演示用的极简事件总线：让 mask:done 等广播也能触发 UI 反馈
  const listeners = new Map();
  const emit = (channel, data) => {
    for (const cb of listeners.get(channel) || []) {
      try { cb(data); } catch { /* ignore */ }
    }
  };
  const mockDone = (n) => ({
    results: [], total: n,
    masked: n, restored: 0, restoredTotal: 0, restoreMissing: 0,
    alreadyMasked: 0, noPii: 0, skipped: 0,
    totalPII: n * 3, trashed: 0, importedCount: 0, overwritten: 0,
  });

  window.island = {
    async invoke(channel, ...args) {
      await new Promise((r) => setTimeout(r, 120));
      switch (channel) {
        case 'settings:get':
          return {
            settings, vaultEncrypted: true, vaultSize: 23,
            index: { root: settings.rootDir, count: 1247, scanning: false },
            platform: 'win32',
            collapseRange: COLLAPSE_RANGE,
          };
        case 'settings:set': {
          const patch = args[0] || {};
          const next = {
            ...settings, ...patch,
            toggles: { ...settings.toggles, ...(patch.toggles || {}) },
          };
          if ('autoCollapseDelay' in patch) {
            next.autoCollapseDelay = clampDelay(patch.autoCollapseDelay, settings.autoCollapseDelay);
          }
          Object.assign(settings, next);
          return settings;
        }
        case 'history:list':
          return history;
        case 'history:clear':
          history.length = 0;
          return true;
        case 'search:query': {
          const q = (args[0] || '').trim().toLowerCase();
          const cat = ['all', 'doc', 'sheet', 'text', 'code', 'other'].includes(args[2]) ? args[2] : 'all';
          const limit = Number.isFinite(args[1]) && args[1] > 0 ? args[1] : 50;
          const counts = { all: 0, doc: 0, sheet: 0, text: 0, code: 0, other: 0 };
          const pool = indexFiles.filter((f) =>
            !q || f.n.toLowerCase().includes(q) || f.p.toLowerCase().includes(q));
          for (const f of pool) { counts.all++; counts[catOf(f.e)]++; }
          const filtered = pool
            .filter((f) => cat === 'all' || catOf(f.e) === cat)
            .sort((a, b) => b.m - a.m);
          // 与真实索引一致：total 是该类别命中总数，items 受 limit 截断，counts 不受类别影响
          return { items: filtered.slice(0, limit), total: filtered.length, counts, category: cat, root: settings.rootDir };
        }
        case 'index:stats':
          return { root: settings.rootDir, count: 1247, scanning: false };
        case 'mask:restore-text': {
          const text = args[0] || '';
          return {
            text: text
              .replace(/〔9dbf93〕/g, '张伟')
              .replace(/〔6903db〕/g, '13812345678')
              .replace(/〔c81e72〕/g, '330106199001015672'),
            resolved: (text.match(/〔[0-9a-f]{6,12}〕/g) || []).length,
            restored: [], missing: [],
          };
        }
        case 'mask:files': {
          const done = mockDone((args[0] || []).length);
          setTimeout(() => emit('mask:done', done), 60);
          return done;
        }
        case 'clip:restore':
          return { ok: true, resolved: 3, missing: [], text: SAMPLE_MASKED };
        case 'clipboard:write-text':
          if (navigator.clipboard && args[0]) navigator.clipboard.writeText(args[0]).catch(() => {});
          return true;
        case 'dialog:pick-root':
          settings.rootDir = 'D:\\工作文档';
          return settings.rootDir;
        case 'dialog:pick-files': {
          const done = mockDone(1);
          setTimeout(() => emit('mask:done', done), 60);
          return done;
        }
        case 'mask:restore-file':
          return { ok: true, restoredPath: 'D:\\工作文档\\人事\\员工花名册_还原.xlsx', resolved: 24 };
        case 'app:open-path': case 'app:reveal-path': case 'app:quit':
        case 'panel:hide': case 'pill:expand': case 'panel:show-tab':
        case 'index:rescan':
        case 'update:open-page':
          return null;
        case 'app:version':
          return '1.0.0';
        case 'update:check':
          return { current: '1.0.0', latest: '1.0.0', hasUpdate: false, releasePage: '' };
        case 'update:status':
          return { state: 'idle', current: '1.0.0', latest: null, hasUpdate: false, depsChanged: false };
        case 'update:install':
          return { ok: false, reason: '浏览器演示模式不支持更新' };
        case 'update:apply':
          return { ok: false, reason: '浏览器演示模式不支持更新' };
        default:
          return null;
      }
    },
    on(channel, cb) {
      listeners.set(channel, [...(listeners.get(channel) || []), cb]);
      // 浏览器演示：模拟一次剪贴板提示；mask:done 由 invoke 触发，保持与真实链路一致
      if (channel === 'clip:found') setTimeout(() => cb({ count: 3, preview: SAMPLE_MASKED }), 1200);
      return () => {
        listeners.set(channel, (listeners.get(channel) || []).filter((f) => f !== cb));
      };
    },
    filePath() { return null; },
    __mock: SAMPLE_MASKED,
  };
}
