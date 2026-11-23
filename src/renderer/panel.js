'use strict';
/* 灵屿岛主面板逻辑：概览 / 快速查找 / 文本恢复 / 设置 */

const $ = (sel) => document.querySelector(sel);

const els = {
  vaultChip: $('#vaultChip'),
  closeBtn: $('#closeBtn'),
  tabs: [...document.querySelectorAll('.tab')],
  panelRoot: document.querySelector('.panel'),
  panelBg: $('#panelBg'),
  views: {
    home: $('#view-home'), search: $('#view-search'),
    restore: $('#view-restore'), appearance: $('#view-appearance'),
    settings: $('#view-settings'),
  },
  dropzone: $('#dropzone'),
  pickBtn: $('#pickBtn'),
  rootPath: $('#rootPath'), rootCount: $('#rootCount'), rootBtn: $('#rootBtn'),
  histList: $('#histList'), histEmpty: $('#histEmpty'), histTotal: $('#histTotal'),
  histClearBtn: $('#histClearBtn'),
  searchInput: $('#searchInput'), rescanBtn: $('#rescanBtn'),
  catChips: $('#catChips'),   importSeg: $('#importSeg'), conflictSeg: $('#conflictSeg'),
  searchList: $('#searchList'), searchEmpty: $('#searchEmpty'),
  searchMeta: $('#searchMeta'), searchHint: $('#searchHint'),
  restoreInput: $('#restoreInput'), restoreOut: $('#restoreOut'),
  restoreResultField: $('#restoreResultField'), restoreEmpty: $('#restoreEmpty'),
  restoreWarn: $('#restoreWarn'), copyRestoreBtn: $('#copyRestoreBtn'),
  clearRestoreBtn: $('#clearRestoreBtn'),
  toggleList: $('#toggleList'), behaviorList: $('#behaviorList'),
  themeGrid: $('#themeGrid'), accentRow: $('#accentRow'),
  alphaSlider: $('#alphaSlider'), alphaVal: $('#alphaVal'),
  radiusSlider: $('#radiusSlider'), radiusVal: $('#radiusVal'),
  fontSeg: $('#fontSeg'),
  bgSeg: $('#bgSeg'), bgPickBtn: $('#bgPickBtn'), bgClearBtn: $('#bgClearBtn'),
  bgFileNote: $('#bgFileNote'), bgDesc: $('#bgDesc'), bgThumb: $('#bgThumb'),
  glassSeg: $('#glassSeg'), glassDesc: $('#glassDesc'),
  panelWSlider: $('#panelWSlider'), panelWVal: $('#panelWVal'),
  panelHSlider: $('#panelHSlider'), panelHVal: $('#panelHVal'),
  panelPresets: $('#panelPresets'), motionSwitch: $('#motionSwitch'),
  pillResetBtn: $('#pillResetBtn'),
  detectHead: $('#detectHead'), detectBody: $('#detectBody'),
  detectSummary: $('#detectSummary'), detectToggleBtn: $('#detectToggleBtn'),
  settingRoot: $('#settingRoot'), settingRootBtn: $('#settingRootBtn'),
  indexDesc: $('#indexDesc'), vaultDesc: $('#vaultDesc'),
  vaultFolderBtn: $('#vaultFolderBtn'), vaultFolderPath: $('#vaultFolderPath'),
  collapseDelayRow: $('#collapseDelayRow'), collapseDelayInput: $('#collapseDelayInput'),
  collapseDelayHint: $('#collapseDelayHint'), collapseDelayPresets: $('#collapseDelayPresets'),
  aboutVersion: $('#aboutVersion'), updateCheckBtn: $('#updateCheckBtn'),
  updateBox: $('#updateBox'),
  updateStatusText: $('#updateStatusText'), updateInstallBtn: $('#updateInstallBtn'),
  updatePageBtn: $('#updatePageBtn'),
  toasts: $('#toasts'),
};

let settingsCache = null;
// 合法范围由主进程 settings:get 下发，这里是 IPC 未就绪时的兜底值
let collapseRange = { min: 5, max: 3600, default: 20 };
let searchState = { items: [], selected: -1, root: '' };
let searchCategory = 'all';
let lastSearchSeq = 0;

const CATEGORIES = [
  ['all', '全部'], ['doc', '文档'], ['sheet', '表格'],
  ['image', '图片'], ['text', '文本'], ['other', '其他'],
];

function timeGroupOf(ts) {
  if (!ts) return '更早';
  const d = new Date(ts);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return '本周';
  return '更早';
}

/* ---------------- 工具 ---------------- */

function uiConfirm(text, okLabel = '确定') {
  return new Promise((resolve) => {
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = okLabel;
    const mask = $('#confirmMask');
    mask.hidden = false;
    const done = (v) => {
      mask.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
      else if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    };
    document.addEventListener('keydown', onKey, true);
    $('#confirmOk').onclick = () => done(true);
    $('#confirmCancel').onclick = () => done(false);
    mask.onclick = (e) => { if (e.target === mask) done(false); };
  });
}

function toast(text, type = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = text;
  els.toasts.appendChild(el);
  // 最多同时显示 3 条：批量处理时提示会连发，堆太多会挡住列表
  while (els.toasts.children.length > 3) els.toasts.firstElementChild.remove();
  setTimeout(() => el.remove(), ms);
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${hm}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `昨天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return m ? m[1].toUpperCase() : 'FILE';
}

function joinPath(root, rel) {
  if (!root) return rel;
  // Windows 根目录（盘符或含 \）→ 分隔符统一为 \；其余（macOS/Linux）用 /
  const isWin = /^[A-Za-z]:[\\/]/.test(root) || root.includes('\\');
  const sep = isWin ? '\\' : '/';
  const body = isWin ? rel.replace(/\//g, '\\') : rel;
  return root.endsWith(sep) ? root + body : root + sep + body;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------- 标签页 ---------------- */

function switchTab(name) {
  for (const t of els.tabs) {
    const active = t.dataset.tab === name;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  }
  for (const [k, v] of Object.entries(els.views)) {
    v.classList.toggle('is-active', k === name);
  }
  if (name === 'search') { setTimeout(() => els.searchInput.focus(), 60); loadSearch(); }
}

for (const t of els.tabs) t.addEventListener('click', () => switchTab(t.dataset.tab));
els.closeBtn.addEventListener('click', () => window.island.invoke('panel:hide'));

/* 面板开合：主进程负责窗口整体淡入淡出，这里补一层缩放与位移（浮岛浮起 / 收回的观感）。
   这段不受「界面动效」开关控制——开合手感属于基础体验，关掉动效也保持顺滑。 */
function playPanelPhase(phase) {
  const el = els.panelRoot;
  if (!el) return;
  el.classList.remove('is-opening', 'is-closing');
  void el.offsetWidth; // 强制回流：连续开合时同名动画能重新播放
  el.classList.add(phase === 'enter' ? 'is-opening' : 'is-closing');
  clearTimeout(playPanelPhase.timer);
  playPanelPhase.timer = setTimeout(() => {
    el.classList.remove('is-opening', 'is-closing');
  }, 340);
}
window.island.on('panel:enter', () => playPanelPhase('enter'));
window.island.on('panel:exit', () => playPanelPhase('exit'));

window.island.on('panel:show-tab', (tab) => {
  switchTab(tab || 'home');
  if (tab === 'restore') {
    // 从剪贴板提示进入 → 预填剪贴板内容
    navigator.clipboard.readText().then((t) => {
      if (t && t.includes('〔') && !els.restoreInput.value) {
        els.restoreInput.value = t;
        runRestore();
      }
    }).catch(() => {});
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.island.invoke('panel:hide');
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); switchTab('search'); }
});

/* ---------------- 概览 ---------------- */

function renderHistory(items) {
  els.histList.innerHTML = '';
  els.histTotal.textContent = items.length ? `${items.length} 条记录` : '';
  els.histEmpty.hidden = items.length > 0;
  els.histClearBtn.hidden = items.length === 0;
  for (const h of items) {
    const li = document.createElement('li');
    li.className = 'row';
    const name = (h.maskedPath || '').split(/[\\/]/).pop();
    li.innerHTML = `
      <span class="file-ico">${esc(extOf(name).slice(0, 4))}</span>
      <div class="row-main">
        <div class="row-name">${esc(name)}</div>
        <div class="row-sub"><span>${esc(h.summary || '')}</span></div>
      </div>
      <span class="row-side">${fmtTime(h.ts)}</span>
      <div class="row-actions">
        <button class="icon-btn" data-act="open" aria-label="打开屏蔽文件">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 3.5H3A1.5 1.5 0 0 0 1.5 5v8A1.5 1.5 0 0 0 3 14.5h8A1.5 1.5 0 0 0 12.5 13V9.5M9.5 1.5h5v5M14 2L7.5 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        </button>
        <button class="icon-btn" data-act="reveal" aria-label="在文件夹中显示">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2h6A1.5 1.5 0 0 1 15 6v6a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 2 12V4z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
        </button>
      </div>`;
    li.querySelector('[data-act="open"]').addEventListener('click', () =>
      window.island.invoke('app:open-path', h.maskedPath));
    li.querySelector('[data-act="reveal"]').addEventListener('click', () =>
      window.island.invoke('app:reveal-path', h.maskedPath));
    els.histList.appendChild(li);
  }
}

async function loadHistory() {
  renderHistory(await window.island.invoke('history:list'));
}

els.histClearBtn.addEventListener('click', async () => {
  if (!await uiConfirm('确定清空全部屏蔽记录？已生成的屏蔽文件与映射库不受影响。', '清空')) return;
  await window.island.invoke('history:clear');
  toast('已清空记录', 'ok');
});

function renderRoot(settings, index) {
  const root = settings.rootDir;
  els.rootPath.textContent = root || '未配置（点击「更改」选择文件夹）';
  els.rootCount.textContent = index && root ? `已索引 ${index.count} 个文件` : '';
  els.settingRoot.textContent = root || '未配置';
  els.indexDesc.textContent = root
    ? (index && index.scanning ? '正在扫描根目录…' : `已索引 ${index.count} 个文件，可在「快速查找」中秒搜。`)
    : '配置后可在「快速查找」中秒搜根目录下的所有文件。';
}

async function loadHome() {
  const st = await window.island.invoke('settings:get');
  settingsCache = st.settings;
  renderVaultChip(st);
  renderRoot(st.settings, st.index);
  await loadHistory();
}

els.pickBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  window.island.invoke('dialog:pick-files'); // 完成提示统一由 mask:done 广播给出
});
els.dropzone.addEventListener('click', () => els.pickBtn.click());
els.rootBtn.addEventListener('click', () => window.island.invoke('dialog:pick-root'));

/** 智能处理的完成提示：屏蔽与还原分别汇总，问题单独提示 */
function showMaskResult(done) {
  if (!done) return;
  if (done.error === 'no-root') {
    toast('请先在「设置」中配置文件根目录', 'err');
    switchTab('settings');
    return;
  }
  if (done.total === 0) return;

  const okParts = [];
  if (done.masked > 0) okParts.push(`屏蔽完成 ${done.masked} 份 · ${done.totalPII} 处敏感信息`);
  if (done.irreversible > 0) okParts.push(`其中 PDF/图片 不可逆遮盖 ${done.irreversible} 份（不支持还原）`);
  if (done.restored > 0) okParts.push(`还原完成 ${done.restored} 份 · ${done.restoredTotal} 处`);
  if (done.overwritten > 0) okParts.push(`已覆盖 ${done.overwritten} 个同名文件`);
  if (done.trashed > 0) okParts.push(`${done.trashed} 份原文件已移入回收站`);

  const problems = [];
  if (done.restoreMissing > 0) problems.push(`${done.restoreMissing} 个编码无法识别，可能已被修改`);
  if (done.alreadyMasked > 0) problems.push(`${done.alreadyMasked} 份已是屏蔽文件且未找到可还原编码`);
  if (done.noPii > 0) problems.push(`未检出敏感信息（${done.noPii} 份）`);
  const convertFailed = done.convertFailed || 0;
  if (convertFailed > 0) {
    problems.push(`${convertFailed} 份 .doc 未能自动转换${done.convertReason ? `：${done.convertReason}` : '，请在 Word 中另存为 .docx 后重试'}`);
  }
  const pdfNoText = done.pdfNoText || 0;
  if (pdfNoText > 0) problems.push(`${pdfNoText} 份 PDF 无文本层且未配置 OCR 引擎`);
  const otherSkipped = (done.skipped || 0) - convertFailed - pdfNoText;
  if (otherSkipped > 0) {
    const reason = String(done.firstSkipReason || '').trim();
    problems.push(`${otherSkipped} 份文件无法处理（格式不支持或过大）${reason ? `：${reason}` : ''}`);
  }

  // 错误（编码失效/已屏蔽）用红色 err；仅跳过类失败用橙色 warn
  const hasErr = done.restoreMissing > 0 || done.alreadyMasked > 0;
  const hasWarn = (done.skipped || 0) > 0;
  if (okParts.length) {
    toast(okParts.join('，'), 'ok');
    loadHistory();
  }
  if (problems.length) toast(problems.join('；'), hasErr ? 'err' : hasWarn ? 'warn' : '');
  if (!okParts.length && !problems.length) toast('处理完成，未生成新副本');
}

window.island.on('mask:done', (done) => {
  if (done.error === 'no-root') { showMaskResult(done); return; }
  if (done.total > 0) showMaskResult(done);
});

/* ---------------- 拖放 ---------------- */

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  els.dropzone.classList.add('drag');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropzone.classList.remove('drag');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove('drag');
  const paths = [...(e.dataTransfer.files || [])]
    .map((f) => window.island.filePath(f))
    .filter(Boolean);
  if (!paths.length) return;
  toast(`正在识别并处理 ${paths.length} 个文件…`);
  await window.island.invoke('mask:files', paths);
});

/* ---------------- 快速查找 ---------------- */

function renderSearch(data) {
  searchState.root = data.root;
  updateChipCounts(data.counts);

  const q = els.searchInput.value.trim();
  const cat = data.category && data.category !== 'all' ? data.category : '';
  const catName = cat ? (CATEGORIES.find(([v]) => v === cat)?.[1] || cat) : '';
  const scope = q ? `「${q.length > 16 ? q.slice(0, 16) + '…' : q}」` : '最近修改';

  if (!data.root) {
    els.searchMeta.textContent = '尚未配置根目录，请到「设置」中选择文件夹';
  } else if (data.total > 0) {
    const more = data.total > data.items.length ? ` · 显示前 ${data.items.length} 个` : '';
    els.searchMeta.textContent = `${catName ? catName + ' · ' : ''}${scope} · 共 ${data.total} 个结果${more}`;
  } else {
    els.searchMeta.textContent = catName ? `「${catName}」类别下没有匹配的文件` : '没有匹配的文件';
  }

  els.searchEmpty.hidden = data.items.length > 0 || !data.root;
  if (!els.searchEmpty.hidden) {
    const emptyText = els.searchEmpty.querySelector('p');
    const emptySub = els.searchEmpty.querySelector('.empty-sub');
    // 当前类别无结果但其他类别有 → 引导用户切换到「全部」，而不是怀疑关键词
    const otherCatHasResult = cat && data.counts && data.counts.all > data.total;
    emptyText.textContent = otherCatHasResult ? `「${catName}」类别没有匹配的文件` : '没有匹配的文件';
    emptySub.textContent = otherCatHasResult
      ? '切换到「全部」，或试试更短的关键词'
      : '试试更短的关键词，或在设置中检查根目录';
  }
  els.searchList.innerHTML = '';
  searchState.items = data.items;
  searchState.selected = data.items.length ? 0 : -1;

  // 空查询时按时间分组（今天/昨天/本周/更早）；搜索结果平铺
  const grouped = !els.searchInput.value.trim();
  let lastGroup = null;
  data.items.forEach((it, i) => {
    if (grouped) {
      const g = timeGroupOf(it.m);
      if (g !== lastGroup) {
        lastGroup = g;
        const head = document.createElement('li');
        head.className = 'group-head';
        head.textContent = g;
        els.searchList.appendChild(head);
      }
    }
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.idx = String(i);
    const fullPath = joinPath(data.root, it.p);
    li.innerHTML = `
      <span class="file-ico">${esc((it.e || 'file').slice(0, 4).toUpperCase())}</span>
      <div class="row-main">
        <div class="row-name">${esc(it.n)}</div>
        <div class="row-sub"><span class="path">${esc(it.p)}</span></div>
      </div>
      <span class="row-side">${fmtSize(it.s)}<br>${fmtTime(it.m)}</span>
      <div class="row-actions">
        <button class="icon-btn" data-act="open" aria-label="打开文件">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 3.5H3A1.5 1.5 0 0 0 1.5 5v8A1.5 1.5 0 0 0 3 14.5h8A1.5 1.5 0 0 0 12.5 13V9.5M9.5 1.5h5v5M14 2L7.5 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        </button>
        <button class="icon-btn" data-act="reveal" aria-label="定位到文件夹">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2h6A1.5 1.5 0 0 1 15 6v6a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 2 12V4z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
        </button>
      </div>`;
    li.querySelector('[data-act="open"]').addEventListener('click', () =>
      window.island.invoke('app:open-path', fullPath));
    li.querySelector('[data-act="reveal"]').addEventListener('click', () =>
      window.island.invoke('app:reveal-path', fullPath));
    // 整行点击打开文件；点在按钮上时跳过，避免「定位到文件夹」冒泡后又把文件打开（也避免「打开」触发两次）
    li.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      window.island.invoke('app:open-path', fullPath);
    });
    els.searchList.appendChild(li);
  });
  highlightSelected();
}

function highlightSelected() {
  const rows = [...els.searchList.querySelectorAll('.row')];
  rows.forEach((li) => li.classList.toggle('selected', Number(li.dataset.idx) === searchState.selected));
  const sel = rows.find((li) => Number(li.dataset.idx) === searchState.selected);
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

/* ---------------- 类别筛选 chips ---------------- */

function buildChips() {
  els.catChips.innerHTML = '';
  for (const [v, label] of CATEGORIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn' + (v === searchCategory ? ' is-active' : '');
    b.dataset.cat = v;
    b.innerHTML = `${esc(label)}<span class="chip-count" aria-hidden="true">0</span>`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v === searchCategory));
    b.addEventListener('click', () => {
      if (searchCategory === v) return; // 重复点击当前类别不重复请求
      searchCategory = v;
      for (const c of els.catChips.children) {
        c.classList.toggle('is-active', c === b);
        c.setAttribute('aria-selected', String(c === b));
      }
      loadSearch();
    });
    els.catChips.appendChild(b);
  }
}

/** 把索引层返回的各类别命中数写到 chips 上（不受当前选中类别影响） */
function updateChipCounts(counts) {
  const c = counts || {};
  for (const chip of els.catChips.children) {
    const n = Number(c[chip.dataset.cat] || 0);
    const badge = chip.querySelector('.chip-count');
    if (badge) badge.textContent = n > 999 ? '999+' : String(n);
    chip.classList.toggle('is-empty', n === 0);
  }
}

// chips 获得焦点时，左右方向键切换类别
els.catChips.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const chips = [...els.catChips.children];
  const i = chips.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const step = e.key === 'ArrowRight' ? 1 : chips.length - 1;
  const next = chips[(i + step) % chips.length];
  next.focus();
  next.click();
});

async function loadSearch() {
  // 快速连点类别或连续输入时，只保留最后一次请求的结果，避免旧结果覆盖新结果
  const seq = ++lastSearchSeq;
  let data;
  try {
    data = await window.island.invoke('search:query', els.searchInput.value, 60, searchCategory);
  } catch (err) {
    toast('查找失败：' + (err && err.message || err), 'err');
    return;
  }
  if (seq !== lastSearchSeq) return;
  renderSearch(data || { items: [], total: 0, root: '' });
}

// 索引重建/文件变更后，若正停留在查找页则刷新结果
const refreshSearchAfterIndex = debounce(() => {
  if (els.views.search.classList.contains('is-active')) loadSearch();
}, 250);

els.searchInput.addEventListener('input', debounce(() => loadSearch(), 160));

els.searchInput.addEventListener('keydown', (e) => {
  const items = searchState.items;
  if (e.key === 'ArrowDown') { e.preventDefault(); if (searchState.selected < items.length - 1) searchState.selected++; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (searchState.selected > 0) searchState.selected--; }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const it = items[searchState.selected];
    if (!it) return;
    const full = joinPath(searchState.root, it.p);
    if (e.shiftKey) window.island.invoke('app:reveal-path', full);
    else window.island.invoke('app:open-path', full);
    return;
  } else return;
  highlightSelected();
});

els.rescanBtn.addEventListener('click', async () => {
  await window.island.invoke('index:rescan');
  toast('已开始重建索引…');
});

/* ---------------- 文本恢复 ---------------- */

async function runRestore() {
  const text = els.restoreInput.value;
  if (!text.trim()) {
    els.restoreResultField.hidden = true;
    els.restoreEmpty.hidden = true;
    els.copyRestoreBtn.disabled = true;
    return;
  }
  const r = await window.island.invoke('mask:restore-text', text);
  // 文本里没有任何编码：不回显同样内容，给出提示并禁用复制
  const noCodes = r.resolved === 0 && (!r.missing || r.missing.length === 0);
  els.restoreResultField.hidden = noCodes;
  els.restoreEmpty.hidden = !noCodes;
  if (noCodes) {
    els.copyRestoreBtn.disabled = true;
    return;
  }
  // 未识别的编码标红
  const html = esc(r.text).replace(
    /〔[\u4e00-\u9fa5]{1,6}·[0-9a-f]{6,12}〕/g,
    (m) => `<span class="code" style="color:var(--orange)">${m}</span>`
  );
  els.restoreOut.innerHTML = html;
  if (r.missing && r.missing.length) {
    els.restoreWarn.hidden = false;
    els.restoreWarn.textContent = `${r.missing.length} 个编码无法识别（橙色标记）——编码被改动过将无法还原`;
  } else {
    els.restoreWarn.hidden = true;
  }
  els.copyRestoreBtn.disabled = false;
}
els.restoreInput.addEventListener('input', debounce(runRestore, 120));

els.copyRestoreBtn.addEventListener('click', async () => {
  const text = els.restoreOut.textContent;
  if (!text) return;
  // 主进程写剪贴板：不依赖窗口焦点（面板常以不抢焦点方式弹出）
  try {
    await window.island.invoke('clipboard:write-text', text);
    toast('还原结果已复制到剪贴板', 'ok');
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      toast('还原结果已复制到剪贴板', 'ok');
    } catch {
      toast('复制失败，请手动选中「还原结果」里的文字复制', 'err');
    }
  }
});
els.clearRestoreBtn.addEventListener('click', () => {
  els.restoreInput.value = '';
  runRestore();
});

/* ---------------- 设置 ---------------- */

const DETECT_ITEMS = [
  ['phone', '手机号'], ['idCard', '身份证号'], ['bank', '银行卡号'],
  ['email', '电子邮箱'], ['name', '中文姓名'], ['address', '家庭住址'],
  ['passport', '护照号'], ['plate', '车牌号'],
  ['caseNo', '案号'], ['license', '执业证号'], ['org', '机构名称'],
  // 可选检测项：默认关闭
  ['landline', '固定电话/传真'], ['im', '微信/QQ'],
  ['hkmt', '港澳台证件'], ['uscc', '统一社会信用代码'],
];
const BEHAVIORS = [
  ['clipboardWatch', '剪贴板自动识别', '复制了含编码的内容时，胶囊提示一键恢复'],
  ['autoCollapse', '灵动岛自动收起', '无操作时收起为顶部线段，悬停展开；关闭后一直显示'],
  ['fullscreenAutoHide', '全屏时自动隐藏', '其他应用全屏时临时让位，不遮挡全屏内容；退出全屏自动恢复'],
  ['launchOnBoot', '开机自启', '登录 Windows 后自动运行灵屿岛'],
];

function makeSwitch(label, desc, on, onChange) {
  const row = document.createElement('div');
  row.className = 'switch-row';
  const lab = document.createElement('div');
  lab.innerHTML = `<div class="sw-label">${esc(label)}</div>` + (desc ? `<div class="sw-desc">${esc(desc)}</div>` : '');
  const sw = document.createElement('button');
  sw.className = 'switch' + (on ? ' on' : '');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(on));
  sw.setAttribute('aria-label', label);
  sw.addEventListener('click', () => {
    const next = !sw.classList.contains('on');
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  row.appendChild(lab);
  row.appendChild(sw);
  return row;
}

/** 检测项紧凑勾选框：勾选框在前，label 在后（与 makeSwitch 的开关样式区分） */
function makeCheck(label, on, onChange) {
  const row = document.createElement('div');
  row.className = 'check-row';
  const box = document.createElement('button');
  box.className = 'checkbox' + (on ? ' on' : '');
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', String(on));
  box.setAttribute('aria-label', label);
  box.addEventListener('click', () => {
    const next = !box.classList.contains('on');
    box.classList.toggle('on', next);
    box.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  const lab = document.createElement('span');
  lab.className = 'check-label';
  lab.textContent = label;
  row.appendChild(box);
  row.appendChild(lab);
  return row;
}

function renderImportSeg(s) {
  for (const b of els.importSeg.children) {
    const active = b.dataset.v === (s.importBehavior || 'keep');
    b.classList.toggle('is-active', active);
    b.classList.toggle('danger-active', active && b.dataset.v === 'discard');
    b.setAttribute('aria-checked', String(active));
  }
}

function renderConflictSeg(s) {
  const v = s.conflictPolicy || 'keep';
  for (const b of els.conflictSeg.children) {
    const active = b.dataset.v === v;
    b.classList.toggle('is-active', active);
    b.classList.toggle('danger-active', active && b.dataset.v === 'overwrite');
    b.setAttribute('aria-checked', String(active));
  }
}

function renderSettings(st) {
  const s = st.settings;
  renderImportSeg(s);
  renderConflictSeg(s);
  // 检测项（紧凑网格，勾选框在前，折叠在 .detect-head，摘要实时更新）
  els.toggleList.innerHTML = '';
  for (const [key, label] of DETECT_ITEMS) {
    els.toggleList.appendChild(makeCheck(label, s.toggles[key], (v) => {
      window.island.invoke('settings:set', { toggles: { [key]: v } });
      updateDetectSummary();
    }));
  }
  updateDetectSummary();
  // 行为
  els.behaviorList.innerHTML = '';
  for (const [key, label, desc] of BEHAVIORS) {
    els.behaviorList.appendChild(makeSwitch(label, desc, s[key], (v) =>
      window.island.invoke('settings:set', { [key]: v })));
  }
  // 自动收起时长：范围由主进程下发，值以主进程规范化结果为准
  if (st.collapseRange) collapseRange = st.collapseRange;
  renderCollapseDelay(s);
}

/** 同步时长控件：合法范围、当前值、开关联动、预设高亮 */
function renderCollapseDelay(s) {
  const enabled = !!s.autoCollapse;
  const n = Number(s.autoCollapseDelay) || collapseRange.default;
  els.collapseDelayInput.min = String(collapseRange.min);
  els.collapseDelayInput.max = String(collapseRange.max);
  // 正在输入时不覆盖光标里的内容（设置变更广播会重绘本区域）
  if (document.activeElement !== els.collapseDelayInput) {
    els.collapseDelayInput.value = String(n);
  }
  els.collapseDelayInput.disabled = !enabled;
  els.collapseDelayRow.classList.toggle('is-disabled', !enabled);
  els.collapseDelayHint.textContent = enabled
    ? `${collapseRange.min} – ${collapseRange.max} 秒，修改后立即生效`
    : '开启「灵动岛自动收起」后可设置';
  for (const b of els.collapseDelayPresets.children) {
    b.disabled = !enabled;
    b.classList.toggle('is-active', enabled && Number(b.dataset.sec) === n);
  }
}

/** 保存时长并立即生效；以主进程返回的规范化值为准 */
async function saveCollapseDelay(value) {
  if (!settingsCache || !settingsCache.autoCollapse) return;
  try {
    const s = await window.island.invoke('settings:set', { autoCollapseDelay: value });
    settingsCache = s;
    renderCollapseDelay(s);
    toast(`自动收起时间已设为 ${s.autoCollapseDelay} 秒`, 'ok', 2000);
  } catch (err) {
    toast('保存失败：' + (err && err.message || err), 'err');
  }
}

/* ---------------- 外观：主题 / 强调色 / 透明度 / 圆角 / 背景 / 毛玻璃 / 密度 / 动效 ---------------- */

const T = window.IslandThemes || { THEMES: [], ACCENT_PRESETS: [], normalizeTheme: (v) => v || 'midnight' };
let bgVideoEl = null;

/* ---------------- 色彩工具：强调色对比度 ---------------- */

function hexRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** WCAG 相对亮度（0~1），用于决定强调色上的文字取黑还是白 */
function relLuminance(hex) {
  const rgb = hexRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 强调色底上的文字色：亮底配深墨、暗底配白，任何自定义色都不会糊成一片 */
function inkOn(hex) {
  return relLuminance(hex) > 0.32 ? '#0b0f14' : '#ffffff';
}

function themeAccent(id) {
  const t = (T.THEMES || []).find((x) => x.id === id);
  return (t && t.swatch && t.swatch[2]) || '#0a84ff';
}

/** 滑杆已填充比例（CSS 用 --p 画“已走过”的轨道） */
function syncRangeFill(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max);
  const v = Number(input.value);
  const p = Number.isFinite(max) && max > min ? ((v - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--p', Math.min(100, Math.max(0, p)).toFixed(2) + '%');
}

/** 应用外观到当前窗口（面板与胶囊共用同一套变量名） */
/** 字体大小生效：标准及以上只缩文字（布局与控件尺寸不动）；
 *  「小」档整面等比压缩——zoom 把文字与间距同步收紧，同样的窗口装下更多内容。
 *  缩放比钳在 0.85~1.3，非法值回退 1。 */
function applyFontScale(root, v) {
  const fs = Math.min(1.3, Math.max(0.85, Number(v) || 1));
  if (fs < 1) {
    root.style.zoom = String(fs);
    root.style.setProperty('--font-scale', '1');
  } else {
    root.style.removeProperty('zoom');
    root.style.setProperty('--font-scale', String(fs));
  }
}

function applyAppearance(a) {
  const root = document.documentElement;
  const themeId = T.normalizeTheme(a.theme);
  root.dataset.theme = themeId;
  root.classList.toggle('motion-off', a.motion === false);
  root.style.setProperty('--island-alpha', String(Math.min(1, Math.max(0.55, Number(a.alpha) || 0.97))));
    const r = Math.round(Math.min(25, Math.max(10, Number(a.radius) || 18)));
    root.style.setProperty('--panel-radius', r + 'px');
    root.style.setProperty('--pill-radius', Math.min(22, r + 4) + 'px');
    applyFontScale(root, a.fontScale);
  // 强调色：自定义色要同步「文字色」——亮色强调配深墨字，避免白字糊在浅蓝/浅绿上
  root.style.setProperty('--accent-on', inkOn(a.accent || themeAccent(themeId)));
  if (a.accent) root.style.setProperty('--accent', a.accent);
  else root.style.removeProperty('--accent');
  // 背景遮罩浓度：独立于透明度，专门保证背景图前的内容可读
  // 磨砂质感：界面内模拟（窗体级系统材质会涂满窗口矩形、破坏圆角）
  root.classList.toggle('glass-weak', a.glass === 'auto');
  root.classList.toggle('glass-on', a.glass === 'on');
  applyBackground(a);
}

/** 背景层：islandbg:// 协议文件名 → 图片 / 静音循环视频 */
function applyBackground(a) {
  const wrap = els.panelBg;
  const type = a.bg && a.bg.type;
  const file = a.bg && a.bg.file;
  if ((type === 'image' || type === 'video') && file) {
    const url = 'islandbg://bg/' + encodeURIComponent(file);
    // 同一文件重复渲染时保留现有节点，避免视频每广播一次就重头播放
    const cur = wrap.firstElementChild;
    if (cur && cur.dataset.bgFile === file && cur.tagName.toLowerCase() === (type === 'video' ? 'video' : 'img')) {
      els.panelRoot.dataset.bg = type;
      els.panelRoot.classList.add('has-bg');
      return;
    }
    wrap.innerHTML = '';
    // 文件无法解码（损坏 / 编码不受支持）时明确告知，而不是留一块没反应的空白
    const onErr = () => {
      toast(type === 'video'
        ? '这段视频无法播放（需 H.264 编码的 mp4 或 webm），已恢复为无背景'
        : '这张图片无法显示，已恢复为无背景，请换用 png / jpg 格式', 'err');
      window.island.invoke('appearance:clear-bg');
    };
    if (type === 'video') {
      bgVideoEl = document.createElement('video');
      bgVideoEl.src = url;
      bgVideoEl.autoplay = true;
      bgVideoEl.muted = true;
      bgVideoEl.loop = true;
      bgVideoEl.playsInline = true;
      bgVideoEl.dataset.bgFile = file;
      bgVideoEl.addEventListener('error', onErr, { once: true });
      wrap.appendChild(bgVideoEl);
    } else {
      bgVideoEl = null;
      const img = document.createElement('img');
      img.alt = '';
      img.dataset.bgFile = file;
      img.addEventListener('error', onErr, { once: true });
      img.src = url;
      wrap.appendChild(img);
    }
    els.panelRoot.dataset.bg = type;
    els.panelRoot.classList.add('has-bg');
  } else {
    wrap.innerHTML = '';
    bgVideoEl = null;
    els.panelRoot.classList.remove('has-bg');
    delete els.panelRoot.dataset.bg;
  }
}

/** 面板隐藏时暂停背景视频，省 GPU / 电量 */
function setBgPlayback(play) {
  if (!bgVideoEl) return;
  try { if (play) bgVideoEl.play().catch(() => {}); else bgVideoEl.pause(); } catch { /* ignore */ }
}

function buildThemeGrid() {
  els.themeGrid.innerHTML = '';
  for (const t of T.THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-card';
    b.dataset.theme = t.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', t.name);
    // 迷你预览：底色 / 卡片 / 强调色三层，一眼看出主题气质
    const pv = document.createElement('span');
    pv.className = 'theme-preview';
    pv.setAttribute('aria-hidden', 'true');
    pv.style.setProperty('--tp0', t.swatch[0]);
    pv.style.setProperty('--tp1', t.swatch[1]);
    pv.style.setProperty('--tp2', t.swatch[2]);
    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = t.name;
    const check = document.createElement('span');
    check.className = 'theme-check';
    check.setAttribute('aria-hidden', 'true');
    b.appendChild(pv);
    b.appendChild(name);
    b.appendChild(check);
    b.addEventListener('click', () =>
      window.island.invoke('settings:set', { appearance: { theme: t.id } }));
    els.themeGrid.appendChild(b);
  }
}

function buildAccentRow() {
  els.accentRow.innerHTML = '';
  for (const v of T.ACCENT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'accent-dot' + (v === '' ? ' follow' : '');
    b.dataset.accent = v;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', v === '' ? '跟随主题' : '强调色 ' + v);
    if (v) {
      b.style.setProperty('background', v);
      b.style.setProperty('--on-accent', inkOn(v));
    } else {
      b.textContent = 'A';
      b.style.setProperty('--on-accent', '#ffffff');
    }
    b.addEventListener('click', () =>
      window.island.invoke('settings:set', { appearance: { accent: v } }));
    els.accentRow.appendChild(b);
  }
}

/** 同步外观页控件到设置值（不覆盖正在拖动的滑杆） */
function renderAppearance(st) {
  const a = st.settings.appearance;
  if (!a) return;
  applyAppearance(a);

  for (const b of els.themeGrid.children) {
    const active = b.dataset.theme === a.theme;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-checked', String(active));
  }
  for (const b of els.accentRow.children) {
    const active = (b.dataset.accent || '') === (a.accent || '');
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-checked', String(active));
  }

  const alphaPct = Math.round(Math.min(1, Math.max(0.55, Number(a.alpha) || 0.97)) * 100);
  if (document.activeElement !== els.alphaSlider) els.alphaSlider.value = String(alphaPct);
  els.alphaVal.textContent = alphaPct + '%';
  syncRangeFill(els.alphaSlider);
  if (document.activeElement !== els.radiusSlider) els.radiusSlider.value = String(a.radius);
  els.radiusVal.textContent = a.radius + 'px';
  syncRangeFill(els.radiusSlider);
  // 字体大小：档位选中态（存档可能是旧滑杆的中间值，主进程已吸附到档位）
  const fontScale = Number(a.fontScale) || 1;
  for (const b of els.fontSeg.children) {
    const active = Number(b.dataset.v) === fontScale;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-checked', String(active));
  }

  const hasBg = !!(a.bg && a.bg.file && a.bg.type !== 'none');

  els.motionSwitch.classList.toggle('on', a.motion !== false);
  els.motionSwitch.setAttribute('aria-checked', String(a.motion !== false));

  for (const group of [els.bgSeg, els.glassSeg]) {
    const key = group === els.bgSeg ? (a.bg && a.bg.type) : a.glass;
    for (const b of group.children) {
      const active = b.dataset.v === key;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-checked', String(active));
    }
  }

  // 面板尺寸：滑杆不被拖动中的输入框覆盖，预设按钮按精确宽高命中高亮
  const pw = (a.panel && a.panel.w) || 560;
  const ph = (a.panel && a.panel.h) || 700;
  if (document.activeElement !== els.panelWSlider) els.panelWSlider.value = String(pw);
  els.panelWVal.textContent = pw + ' px';
  if (document.activeElement !== els.panelHSlider) els.panelHSlider.value = String(ph);
  els.panelHVal.textContent = ph + ' px';
  syncRangeFill(els.panelWSlider);
  syncRangeFill(els.panelHSlider);
  markPanelPreset(pw, ph);
  els.bgPickBtn.disabled = !a.bg || a.bg.type === 'none';
  els.bgClearBtn.disabled = !a.bg || !a.bg.file;
  // 旧存档没有原始文件名：只报「已应用」，不把内部 hash 文件名露给用户
  els.bgFileNote.textContent = a.bg && a.bg.file
    ? (a.bg.name ? a.bg.name + '（已应用）' : '背景已应用')
    : '';
  // 缩略图：让用户一眼看到「用的就是这张图」，而不是只看到一个文件名
  if (a.bg && a.bg.file) {
    els.bgThumb.hidden = false;
    els.bgThumb.dataset.type = a.bg.type;
    els.bgThumb.style.backgroundImage = 'url("islandbg://bg/' + encodeURIComponent(a.bg.file) + '")';
  } else {
    els.bgThumb.hidden = true;
    els.bgThumb.dataset.type = '';
    els.bgThumb.style.backgroundImage = '';
  }
  els.bgDesc.textContent = a.bg && a.bg.type === 'video' && a.bg.file
    ? '视频背景运行中：面板隐藏时自动暂停。若画面卡顿，建议更换更小的文件或使用图片背景。'
    : '图片 ≤10MB，视频 ≤20MB（mp4/webm，静音循环播放）。背景文件仅存本机，面板隐藏时视频自动暂停。';

  els.glassDesc.textContent = a.glass === 'off'
    ? '当前为实色外框。开启磨砂只会让外框与背景更通透，内容片保持实色，文字不会跟着变淡。'
    : '磨砂已开启：外框更通透、背景图更柔和；内容片衬底不变，文字始终清晰。';
}

/* 滑杆：input 实时预览，change 落盘（CSS 变量自动联动背景暗化层，无需重建背景） */
els.alphaSlider.addEventListener('input', () => {
  const v = Number(els.alphaSlider.value) / 100;
  document.documentElement.style.setProperty('--island-alpha', String(v));
  els.alphaVal.textContent = els.alphaSlider.value + '%';
});
els.alphaSlider.addEventListener('change', () =>
  window.island.invoke('settings:set', { appearance: { alpha: Number(els.alphaSlider.value) / 100 } }));

els.radiusSlider.addEventListener('input', () => {
  const r = Number(els.radiusSlider.value);
  document.documentElement.style.setProperty('--panel-radius', r + 'px');
  document.documentElement.style.setProperty('--pill-radius', Math.min(22, r + 4) + 'px');
  els.radiusVal.textContent = r + 'px';
});
els.radiusSlider.addEventListener('change', () =>
  window.island.invoke('settings:set', { appearance: { radius: Number(els.radiusSlider.value) } }));

// 字体大小档位：点击先本地生效（不等广播回环），再落盘等待 settings:changed 校准
for (const b of els.fontSeg.children) {
  b.addEventListener('click', () => {
    const v = Number(b.dataset.v);
    applyFontScale(document.documentElement, v);
    window.island.invoke('settings:set', { appearance: { fontScale: v } });
  });
}

/* ---------- 鼠标交互：面板跟随光晕 + 按钮水滴涟漪 ----------
   两者都只在「界面动效」开启时生成，关掉后 DOM 里不会出现动画元素。 */
els.panelRoot.addEventListener('mousemove', (e) => {
  if (document.documentElement.classList.contains('motion-off')) return;
  const r = els.panelRoot.getBoundingClientRect();
  // 直接写 CSS 变量，不经过 rAF：后台窗口的 rAF 可能被节流，跟随光晕会整段失效
  els.panelRoot.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  els.panelRoot.style.setProperty('--my', (e.clientY - r.top) + 'px');
  els.panelRoot.classList.add('has-pointer');
});
els.panelRoot.addEventListener('mouseleave', () => {
  els.panelRoot.classList.remove('has-pointer');
});

function dropRipple(btn, x, y) {
  const r = btn.getBoundingClientRect();
  // 正圆水波：从按下点向外均匀荡开，单色无外环（与灵动岛的圆形反馈同调）
  const size = Math.max(r.width, r.height) * 1.35;
  const d = document.createElement('span');
  d.className = 'ripple';
  d.style.width = d.style.height = size + 'px';
  d.style.left = (x - r.left - size / 2) + 'px';
  d.style.top = (y - r.top - size / 2) + 'px';
  btn.appendChild(d);
  setTimeout(() => d.remove(), 520);
}

document.addEventListener('pointerdown', (e) => {
  if (document.documentElement.classList.contains('motion-off')) return;
  const btn = e.target.closest && e.target.closest('.btn, .seg, .tab, .icon-btn, .preset, .chip-btn');
  if (!btn || btn.disabled) return;
  dropRipple(btn, e.clientX, e.clientY);
});

/* 界面动效开关（点按 / 空格 / 回车都可用） */
function toggleMotion() {
  const on = !els.motionSwitch.classList.contains('on');
  window.island.invoke('settings:set', { appearance: { motion: on } });
}
els.motionSwitch.addEventListener('click', toggleMotion);
els.motionSwitch.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleMotion(); }
});

/* 任意 range 拖动时同步填充比例（--p），滑杆才有“已走过”的色带 */
document.addEventListener('input', (e) => {
  if (e.target && e.target.type === 'range') syncRangeFill(e.target);
});

for (const b of els.bgSeg.children) {
  b.addEventListener('click', async () => {
    try {
      await window.island.invoke('settings:set', { appearance: { bg: { type: b.dataset.v } } });
    } catch (err) {
      toast('切换背景类型失败：' + (err && err.message ? err.message : err), 'err');
    }
  });
}
els.bgPickBtn.addEventListener('click', async () => {
  const a = settingsCache && settingsCache.appearance;
  const kind = a && a.bg && a.bg.type === 'video' ? 'video' : 'image';
  // 旧实例（preload 未更新）或主进程异常时，这里会抛错；必须给提示，
  // 否则表现就是「点了完全没反应」
  let r;
  try {
    r = await window.island.invoke('dialog:pick-bg', kind);
  } catch (err) {
    toast('无法打开文件选择框：' + (err && err.message ? err.message : err) + '（若刚更新过，请重启应用）', 'err');
    return;
  }
  if (!r) return;
  if (r.ok === false && r.canceled) return;
  if (r.ok === false) {
    toast('背景设置失败：' + (r.reason || '未知原因'), 'err');
    return;
  }
  toast(kind === 'video' ? '视频背景已应用' : '图片背景已应用', 'ok');
});
els.bgClearBtn.addEventListener('click', async () => {
  try {
    await window.island.invoke('appearance:clear-bg');
    toast('背景已清除', 'ok');
  } catch (err) {
    toast('清除背景失败：' + (err && err.message ? err.message : err), 'err');
  }
});

for (const b of els.glassSeg.children) {
  b.addEventListener('click', () =>
    window.island.invoke('settings:set', { appearance: { glass: b.dataset.v } }));
}
/* 面板尺寸：拖动时只更新数值显示，松手（change）才真正改窗口。
   不边拖边改窗口——面板是水平居中的，改宽度会让滑杆在指针下移位，
   数值会被反复推高（正反馈），松手生效才不会「一拖就到底」。 */
function panelSizeFromSliders() {
  return { w: Number(els.panelWSlider.value), h: Number(els.panelHSlider.value) };
}
function markPanelPreset(w, h) {
  for (const b of els.panelPresets.children) {
    const active = Number(b.dataset.w) === w && Number(b.dataset.h) === h;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  }
}
function showPanelSizeLabels() {
  const s = panelSizeFromSliders();
  els.panelWVal.textContent = s.w + ' px';
  els.panelHVal.textContent = s.h + ' px';
  syncRangeFill(els.panelWSlider);
  syncRangeFill(els.panelHSlider);
  markPanelPreset(s.w, s.h);
}
function commitPanelSize() {
  window.island.invoke('settings:set', { appearance: { panel: panelSizeFromSliders() } });
}
for (const el2 of [els.panelWSlider, els.panelHSlider]) {
  el2.addEventListener('input', showPanelSizeLabels);
  el2.addEventListener('change', commitPanelSize);
}
for (const b of els.panelPresets.children) {
  b.addEventListener('click', () => {
    els.panelWSlider.value = b.dataset.w;
    els.panelHSlider.value = b.dataset.h;
    showPanelSizeLabels();
    commitPanelSize();
  });
}

// 灵动岛恢复默认位置（顶部居中）：主进程负责移动窗口与持久化
els.pillResetBtn.addEventListener('click', () =>
  window.island.invoke('pill:reset-position'));

window.island.on('panel:state', (open) => setBgPlayback(!!open));

function renderVaultChip(st) {  const n = st.vaultSize;
  els.vaultChip.textContent = st.vaultEncrypted
    ? `映射 ${n} 条 · 已加密`
    : `映射 ${n} 条 · 未加密`;
  els.vaultChip.classList.toggle('plain', !st.vaultEncrypted);
  els.vaultDesc.textContent = st.vaultEncrypted
    ? `映射库共 ${n} 条编码↔原文对应关系，仅存本机（${st.platform === 'darwin' ? 'Keychain' : 'Windows DPAPI'} 加密），不联网传输。`
    : `映射库共 ${n} 条。系统加密不可用，当前为明文存储。`;
  if (st.vaultPath) {
    els.vaultFolderPath.textContent = st.vaultPath;
    els.vaultFolderPath.title = st.vaultPath;
  }
}

els.settingRootBtn.addEventListener('click', () => window.island.invoke('dialog:pick-root'));

for (const b of els.importSeg.children) {
  b.addEventListener('click', async () => {
    if (b.dataset.v === 'discard' && b.dataset.v !== (settingsCache && settingsCache.importBehavior)) {
      const ok = await uiConfirm('启用后，拖入/选择的文件在复制到根目录并屏蔽完成时，会把原位置的文件移入系统回收站（可随时找回）。确定启用？', '启用');
      if (!ok) return;
    }
    window.island.invoke('settings:set', { importBehavior: b.dataset.v });
  });
}

for (const b of els.conflictSeg.children) {
  b.addEventListener('click', async () => {
    if (b.dataset.v === (settingsCache && settingsCache.conflictPolicy)) return;
    if (b.dataset.v === 'overwrite') {
      const ok = await uiConfirm(
        '启用「覆盖同名」后，拖入的同名文件会直接替换根目录中的旧文件，旧内容不可恢复。原位置的文件不受影响。确定启用？',
        '启用');
      if (!ok) return;
    }
    const s = await window.island.invoke('settings:set', { conflictPolicy: b.dataset.v });
    settingsCache = s;
    renderConflictSeg(s);
  });
}

els.vaultFolderBtn.addEventListener('click', () => {
  window.island.invoke('app:open-vault-folder');
});

/* ---------------- 自定义自动收起时长 ---------------- */

// change 在失焦 / 回车 / 微调箭头时触发，避免输入过程中的中间值被反复写入
els.collapseDelayInput.addEventListener('change', () => {
  const raw = els.collapseDelayInput.value.trim();
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) {
    // 非法输入（含清空）→ 恢复为已保存的值
    els.collapseDelayInput.value = String(
      (settingsCache && settingsCache.autoCollapseDelay) || collapseRange.default);
    return;
  }
  saveCollapseDelay(n);
});
els.collapseDelayInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.collapseDelayInput.blur(); }
});
for (const b of els.collapseDelayPresets.children) {
  b.addEventListener('click', () => {
    if (b.disabled) return;
    els.collapseDelayInput.value = b.dataset.sec;
    saveCollapseDelay(Number(b.dataset.sec));
  });
}

/* ---------------- 检测项折叠 ---------------- */

// 展开状态持久化（默认收起：检测项不常改，不占页面空间）
const DETECT_EXPANDED_KEY = 'lingyu.detectExpanded';

function setDetectExpanded(expanded) {
  els.detectBody.hidden = !expanded;
  els.detectHead.setAttribute('aria-expanded', String(expanded));
  els.detectToggleBtn.textContent = expanded ? '收起' : '展开';
  try { localStorage.setItem(DETECT_EXPANDED_KEY, expanded ? '1' : '0'); } catch { /* ignore */ }
}

function updateDetectSummary() {
  const total = els.toggleList.querySelectorAll('.checkbox').length;
  const on = els.toggleList.querySelectorAll('.checkbox.on').length;
  els.detectSummary.textContent = `已启用 ${on}/${total}`;
}

els.detectHead.addEventListener('click', () =>
  setDetectExpanded(els.detectBody.hidden));
els.detectHead.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetectExpanded(els.detectBody.hidden); }
});
// 初始化折叠状态（localStorage 缺省 → 收起）
setDetectExpanded((() => {
  try { return localStorage.getItem(DETECT_EXPANDED_KEY) === '1'; } catch { return false; }
})());

/* ---------------- 版本更新 ---------------- */

// 与主进程 updater 状态机同步的本地镜像：idle / available / downloading / staged
let updateState = { state: 'idle', latest: null, depsChanged: false, hasUpdate: false };
let updateCurrentVersion = '';

// 同一次失败可能从异步事件与 IPC 返回值各来一次；5 秒内同文案只提示一条。
let lastUpdateError = { message: '', at: 0 };
function notifyUpdateError(message) {
  const text = '更新失败：' + (message || '未知原因');
  const now = Date.now();
  if (lastUpdateError.message === text && now - lastUpdateError.at < 5000) return;
  lastUpdateError = { message: text, at: now };
  toast(text, 'err');
}

function renderUpdateUI() {
  const st = updateState;
  els.updateBox.hidden = !(st.hasUpdate || st.state === 'staged');
  if (els.updateBox.hidden) return;
  // 两种后端（源码覆盖 / electron-updater）都支持一键更新，安装按钮恒可用
  if (st.state === 'downloading') {
    els.updateStatusText.textContent = '正在下载新版本…';
    els.updateInstallBtn.disabled = true;
  } else if (st.state === 'extract') {
    els.updateStatusText.textContent = '正在解压校验…';
    els.updateInstallBtn.disabled = true;
  } else if (st.state === 'staged') {
    els.updateStatusText.textContent = `新版本 v${st.latest} 已就绪，重启应用完成安装`
      + (st.depsChanged ? '。注意：依赖有变化，重启后需在项目目录手动执行 npm install。' : '');
    els.updateInstallBtn.disabled = false;
    els.updateInstallBtn.textContent = '重启完成安装';
  } else {
    els.updateStatusText.textContent = `发现新版本 v${st.latest}（当前 v${updateCurrentVersion}）`;
    els.updateInstallBtn.disabled = false;
    els.updateInstallBtn.textContent = '立即更新';
  }
}

els.updateCheckBtn.addEventListener('click', async () => {
  els.updateCheckBtn.disabled = true;
  els.updateCheckBtn.textContent = '检查中…';
  try {
    const r = await window.island.invoke('update:check');
    if (r.error) {
      // 检查失败 ≠ 没有新版本：明确报错，不误导用户「已是最新」
      toast('检查更新失败：' + r.error, 'err');
    } else if (r.hasUpdate) {
      updateState = { state: 'idle', latest: r.latest, depsChanged: false, hasUpdate: true, packaged: !!r.packaged };
      renderUpdateUI();
    } else {
      toast(`已是最新版本 v${r.current}`, 'ok');
      updateState = { state: 'idle', latest: null, depsChanged: false, hasUpdate: false };
      renderUpdateUI();
    }
  } catch (err) {
    toast('检查更新失败：' + (err && err.message || err), 'err');
  } finally {
    els.updateCheckBtn.disabled = false;
    els.updateCheckBtn.textContent = '检查更新';
  }
});

els.updateInstallBtn.addEventListener('click', async () => {
  if (updateState.state === 'staged') {
    const ok = await uiConfirm('重启应用以完成安装？未完成的屏蔽任务会继续保留，映射库已自动保存。', '重启');
    if (!ok) return;
    try {
      await window.island.invoke('update:apply'); // 成功后主进程直接重启，不会走到下一行
    } catch (err) {
      toast('安装失败：' + (err && err.message || err), 'err');
    }
    return;
  }
  updateState.state = 'downloading';
  renderUpdateUI();
  const r = await window.island.invoke('update:install');
  if (!r.ok) {
    updateState.state = 'idle';
    renderUpdateUI();
    notifyUpdateError(r.reason || '未知原因');
  }
});

els.updatePageBtn.addEventListener('click', () => window.island.invoke('update:open-page'));

// 同一版本只提示一次：启动自动检查（main.js 延迟 5s）与用户手动点「检查更新」
// 都会调用 checkNow() 并广播 update:found。若不去重，两次检查落在 toast 的
// 3.2s 存活窗口内，就会叠加出两条一模一样的「发现新版本」提示。
// 关于区块的 UI 状态每次照常刷新（renderUpdateUI 不受去重影响）。
let lastAnnouncedVersion = null;
function announceUpdateFound(info) {
  updateState = { state: 'idle', latest: info.latest, depsChanged: false, hasUpdate: true, packaged: !!info.packaged };
  renderUpdateUI();
  if (!info.latest || info.latest === lastAnnouncedVersion) return;
  lastAnnouncedVersion = info.latest;
  toast(`发现新版本 v${info.latest}，可在「设置 → 关于」中更新`, 'ok');
}
window.island.on('update:found', announceUpdateFound);

window.island.on('update:progress', (p) => {
  updateState.state = p.phase === 'extract' ? 'extract' : 'downloading';
  if (p.phase === 'extract') {
    els.updateStatusText.textContent = '正在解压校验…';
  } else if (p.pct >= 100) {
    // 100% 只是字节下载完成，后面还有 sha512 校验与暂存，给出明确状态避免误以为在重下
    els.updateStatusText.textContent = '下载完成，正在校验…';
  } else {
    els.updateStatusText.textContent = `正在下载新版本… ${p.pct != null ? p.pct + '%' : ''}`;
  }
});

window.island.on('update:staged', (info) => {
  updateState = { state: 'staged', latest: info.latest, depsChanged: !!info.depsChanged, hasUpdate: true };
  renderUpdateUI();
});

window.island.on('update:error', (info) => {
  updateState.state = 'idle';
  renderUpdateUI();
  notifyUpdateError(info && info.message);
});

/* ---------------- 事件同步 ---------------- */

window.island.on('history:changed', () => loadHistory());

// 本批屏蔽新增了映射编码：立即刷新顶部「映射 N 条」，与历史记录同步更新
window.island.on('vault:changed', async () => {
  const st = await window.island.invoke('settings:get');
  renderVaultChip(st);
});

window.island.on('settings:changed', async () => {
  const st = await window.island.invoke('settings:get');
  settingsCache = st.settings;
  renderVaultChip(st);
  renderSettings(st);
  renderAppearance(st);
  renderRoot(st.settings, st.index);
});

window.island.on('index:updated', (stats) => {
  if (settingsCache) renderRoot(settingsCache, stats);
  refreshSearchAfterIndex();
});

/* ---------------- 启动 ---------------- */

(async () => {
  await loadHome();
  const st = await window.island.invoke('settings:get');
  renderSettings(st);
  buildThemeGrid();
  buildAccentRow();
  renderAppearance(st);
  buildChips();
  // 关于区块：当前版本号 + 恢复更新状态（面板重开时 staged/available 不丢）
  try {
    updateCurrentVersion = await window.island.invoke('app:version');
    els.aboutVersion.textContent = `灵屿岛 v${updateCurrentVersion}`;
    const us = await window.island.invoke('update:status');
    updateState = {
      state: us.state === 'staged' ? 'staged' : 'idle',
      latest: us.latest,
      depsChanged: !!us.depsChanged,
      hasUpdate: !!us.hasUpdate,
      packaged: !!us.packaged,
    };
    renderUpdateUI();
  } catch { /* 启动 IPC 竞态时静默，settings:changed 广播会重绘 */ }
})();
