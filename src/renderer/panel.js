'use strict';
/* 灵屿岛主面板逻辑：概览 / 快速查找 / 文本恢复 / 设置 */

const $ = (sel) => document.querySelector(sel);

const els = {
  vaultChip: $('#vaultChip'),
  closeBtn: $('#closeBtn'),
  tabs: [...document.querySelectorAll('.tab')],
  views: {
    home: $('#view-home'), search: $('#view-search'),
    restore: $('#view-restore'), settings: $('#view-settings'),
  },
  dropzone: $('#dropzone'),
  pickBtn: $('#pickBtn'),
  rootPath: $('#rootPath'), rootCount: $('#rootCount'), rootBtn: $('#rootBtn'),
  histList: $('#histList'), histEmpty: $('#histEmpty'), histTotal: $('#histTotal'),
  histClearBtn: $('#histClearBtn'),
  searchInput: $('#searchInput'), rescanBtn: $('#rescanBtn'),
  catChips: $('#catChips'), importSeg: $('#importSeg'), conflictSeg: $('#conflictSeg'),
  uiScaleSeg: $('#uiScaleSeg'),
  searchList: $('#searchList'), searchEmpty: $('#searchEmpty'),
  searchMeta: $('#searchMeta'), searchHint: $('#searchHint'),
  restoreInput: $('#restoreInput'), restoreOut: $('#restoreOut'),
  restoreResultField: $('#restoreResultField'), restoreEmpty: $('#restoreEmpty'),
  restoreWarn: $('#restoreWarn'), copyRestoreBtn: $('#copyRestoreBtn'),
  clearRestoreBtn: $('#clearRestoreBtn'),
  toggleList: $('#toggleList'), behaviorList: $('#behaviorList'),
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
  ['text', '文本'], ['code', '代码'], ['other', '其他'],
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
        <button class="icon-btn" data-act="open" title="打开屏蔽文件">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 3.5H3A1.5 1.5 0 0 0 1.5 5v8A1.5 1.5 0 0 0 3 14.5h8A1.5 1.5 0 0 0 12.5 13V9.5M9.5 1.5h5v5M14 2L7.5 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        </button>
        <button class="icon-btn" data-act="reveal" title="在文件夹中显示">
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
  const otherSkipped = (done.skipped || 0) - convertFailed;
  if (otherSkipped > 0) problems.push(`${otherSkipped} 份文件无法处理（格式不支持或过大）`);

  const hasError = done.restoreMissing > 0 || done.alreadyMasked > 0 || (done.skipped || 0) > 0;
  if (okParts.length) {
    toast(okParts.join('，'), 'ok');
    loadHistory();
  }
  if (problems.length) toast(problems.join('；'), hasError ? 'err' : '');
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
        <button class="icon-btn" data-act="open" title="打开">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 3.5H3A1.5 1.5 0 0 0 1.5 5v8A1.5 1.5 0 0 0 3 14.5h8A1.5 1.5 0 0 0 12.5 13V9.5M9.5 1.5h5v5M14 2L7.5 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        </button>
        <button class="icon-btn" data-act="reveal" title="定位到文件夹">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2h6A1.5 1.5 0 0 1 15 6v6a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 2 12V4z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
        </button>
      </div>`;
    li.querySelector('[data-act="open"]').addEventListener('click', () =>
      window.island.invoke('app:open-path', fullPath));
    li.querySelector('[data-act="reveal"]').addEventListener('click', () =>
      window.island.invoke('app:reveal-path', fullPath));
    li.addEventListener('click', () => window.island.invoke('app:open-path', fullPath));
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
    b.dataset.label = label;
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
    chip.title = `${chip.dataset.label}：${n} 个文件（←→ 切换类别）`;
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
    /〔([0-9a-f]{6,12})〕/g,
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

function renderUiScaleSeg(s) {
  const v = s.uiScale || 'auto';
  for (const b of els.uiScaleSeg.children) {
    const active = b.dataset.v === v;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-checked', String(active));
  }
}

function renderSettings(st) {
  const s = st.settings;
  renderImportSeg(s);
  renderConflictSeg(s);
  renderUiScaleSeg(s);
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

function renderVaultChip(st) {
  const n = st.vaultSize;
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

for (const b of els.uiScaleSeg.children) {
  b.addEventListener('click', async () => {
    if (b.dataset.v === ((settingsCache && settingsCache.uiScale) || 'auto')) return;
    const s = await window.island.invoke('settings:set', { uiScale: b.dataset.v });
    settingsCache = s;
    renderUiScaleSeg(s);
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
    toast('更新失败：' + (r.reason || '未知原因'), 'err');
  }
});

els.updatePageBtn.addEventListener('click', () => window.island.invoke('update:open-page'));

window.island.on('update:found', (info) => {
  // 启动时自动检查命中 → 提示 + 展开关于区块状态
  updateState = { state: 'idle', latest: info.latest, depsChanged: false, hasUpdate: true, packaged: !!info.packaged };
  renderUpdateUI();
  toast(`发现新版本 v${info.latest}，可在「设置 → 关于」中更新`, 'ok');
});

window.island.on('update:progress', (p) => {
  updateState.state = p.phase === 'extract' ? 'extract' : 'downloading';
  els.updateStatusText.textContent = p.phase === 'extract'
    ? '正在解压校验…'
    : `正在下载新版本… ${p.pct != null ? p.pct + '%' : ''}`;
});

window.island.on('update:staged', (info) => {
  updateState = { state: 'staged', latest: info.latest, depsChanged: !!info.depsChanged, hasUpdate: true };
  renderUpdateUI();
});

window.island.on('update:error', (info) => {
  updateState.state = 'idle';
  renderUpdateUI();
  toast('更新失败：' + (info && info.message || '未知原因'), 'err');
});

/* ---------------- 事件同步 ---------------- */

window.island.on('history:changed', () => loadHistory());

window.island.on('settings:changed', async () => {
  const st = await window.island.invoke('settings:get');
  settingsCache = st.settings;
  renderVaultChip(st);
  renderSettings(st);
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
