'use strict';
/**
 * 根目录索引与快速查找
 *  - 递归扫描用户配置的根目录（跳过 node_modules/.git/隐藏目录等）
 *  - fs.watch 递归监听变更，防抖后自动重建索引
 *  - 打分搜索：文件名/路径匹配 + 前缀加分 + 近期修改加分
 */

const fs = require('fs');
const path = require('path');
const { categoryOf } = require('../core/imports');
const { isJunkFile } = require('../core/fileproc');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.idea', '.vscode', '__pycache__', '.gradle', 'coverage', '.next',
  '$RECYCLE.BIN', 'System Volume Information', '.Trash-1000',
  // macOS 系统目录
  '__MACOSX', '.Trashes', '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100',
  '.TemporaryItems', '.PKInstallSandboxManagerSystemSoftware',
]);
const MAX_FILES = 20000;
const MAX_DEPTH = 12;
const VALID_CATEGORIES = new Set(['all', 'doc', 'sheet', 'image', 'text', 'other']);

class Indexer {
  constructor() {
    this.root = '';
    this.entries = [];          // {n, p(相对路径), e(扩展名), s(大小), m(修改时间)}
    this.scanning = false;
    this._watcher = null;
    this._debounce = null;
    this._listeners = new Set();
  }

  onUpdate(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }
  _emit() { for (const cb of this._listeners) { try { cb(); } catch { /* ignore */ } } }

  setRoot(rootDir) {
    if (this.root === rootDir) return;
    this.root = rootDir || '';
    this.entries = [];
    this._closeWatch();
    if (!this.root || !fs.existsSync(this.root)) { this._emit(); return; }
    this.rescan();
    try {
      // fs.watch 递归监听：Windows 与 macOS（Node ≥19）均支持；不支持的平台静默降级为手动重建索引
      this._watcher = fs.watch(this.root, { recursive: true, persistent: false }, () => {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this.rescan(), 1500);
      });
      this._watcher.on('error', () => this._closeWatch());
    } catch { /* 部分网络盘不支持 watch */ }
  }

  _closeWatch() {
    clearTimeout(this._debounce);
    if (this._watcher) { try { this._watcher.close(); } catch { /* ignore */ } this._watcher = null; }
  }

  async rescan() {
    // 请求排队：扫描进行中再次请求（如扫描期间切换根目录）→ 完成后自动以最新 root 重扫
    this._scanRequested = true;
    if (this.scanning) return;
    this.scanning = true;
    while (this._scanRequested) {
      this._scanRequested = false;
      const root = this.root;
      if (!root) break;
      const entries = [];
      try {
        await this._walk(root, '', 0, entries);
      } catch { /* ignore */ }
      // 扫描期间根目录被切换则丢弃本轮结果（排队机制会以新 root 重扫）
      if (this.root === root) {
        this.entries = entries;
        this._emit();
      }
    }
    this.scanning = false;
  }

  async _walk(abs, rel, depth, out) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let names;
    try { names = await fs.promises.readdir(abs, { withFileTypes: true }); }
    catch { return; }
    for (const d of names) {
      if (out.length >= MAX_FILES) return;
      const name = d.name;
      // 相对路径统一使用 “/”，跨平台一致（Windows 消费端再做分隔符转换）
      const childRel = rel ? rel + '/' + name : name;
      if (d.isDirectory()) {
        if (name.startsWith('.') || SKIP_DIRS.has(name) || name.startsWith('$')) continue;
        await this._walk(path.join(abs, name), childRel, depth + 1, out);
      } else if (d.isFile()) {
        if (isJunkFile(name)) continue; // ~$ 锁文件、Thumbs.db、.DS_Store 等不显示
        let st = null;
        try { st = await fs.promises.stat(path.join(abs, name)); } catch { continue; }
        out.push({
          n: name,
          p: childRel,
          e: path.extname(name).slice(1).toLowerCase(),
          s: st.size,
          m: st.mtimeMs,
        });
      }
    }
  }

  /** @returns {{root:string, count:number, scanning:boolean}} */
  stats() {
    return { root: this.root, count: this.entries.length, scanning: this.scanning };
  }

  /**
   * 快速查找（支持类别筛选）
   * @param {string} query 关键词，空串表示「最近修改」
   * @param {number} [limit=50] 返回条数上限
   * @param {string} [category='all'] 类别过滤 all/doc/sheet/image/text/other
   * @returns {{items:Array, total:number, root:string, counts:Object, category:string}}
   *   total  当前类别下的命中总数（不受 limit 截断影响）
   *   counts 本次查询在各分类下的命中数（不受当前类别影响，供筛选 chips 显示）
   */
  search(query, limit = 50, category = 'all') {
    const q = (query || '').trim().toLowerCase();
    const cat = VALID_CATEGORIES.has(category) ? category : 'all';
    const lim = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50;
    const counts = emptyCounts();
    if (!this.root) return { items: [], total: 0, root: '', counts, category: cat };

    const tokens = q ? q.split(/\s+/) : null;
    const matched = [];
    for (const it of this.entries) {
      // 空查询按修改时间排序（最近修改），有关键词时按相关性打分
      const score = tokens ? scoreEntry(it, tokens) : (it.m || 0);
      if (score === null) continue;
      const c = categoryOf(it.e);
      counts.all++;
      counts[c]++;
      // 先统计全部分类，再做类别过滤：切换类别时 counts 保持稳定
      if (cat !== 'all' && c !== cat) continue;
      matched.push([score, it]);
    }
    matched.sort((a, b) => b[0] - a[0]);
    return {
      items: matched.slice(0, lim).map(([, it]) => it),
      total: matched.length,
      root: this.root,
      counts,
      category: cat,
    };
  }
}

function emptyCounts() {
  return { all: 0, doc: 0, sheet: 0, image: 0, text: 0, other: 0 };
}

/** 关键词相关性打分；任一 token 未命中返回 null（该文件不参与结果） */
function scoreEntry(it, tokens) {
  const name = (it.n || '').toLowerCase();
  const rel = (it.p || '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    const ni = name.indexOf(t);
    if (ni >= 0) score += 100 - Math.min(ni, 20) + (ni === 0 ? 40 : 0);
    else if (rel.includes(t)) score += 30;
    else if (isSubsequence(t, name)) score += 18;
    else return null;
  }
  return score + Math.min((it.m || 0) / 1e12, 1.8); // 近期修改轻微加权
}

function isSubsequence(q, s) {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

module.exports = { Indexer };
