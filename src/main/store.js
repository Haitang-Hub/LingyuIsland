'use strict';
/**
 * 数据持久化：设置 / 映射库（加密）/ 历史记录
 * 映射库（编码↔原文）含敏感原文，使用 Electron safeStorage（Windows DPAPI）加密落盘
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { Vault } = require('../core/masker');
const { normalizeConflictPolicy } = require('../core/imports');
const { BASE } = require('../core/layout');
const { normalizeAppearance, ALPHA_DEFAULT, RADIUS_DEFAULT, FONT_SCALE_DEFAULT, BG_DIM_DEFAULT } = require('../core/appearance');

/** 面板自动收起时长（秒）的合法范围与默认值 */
const COLLAPSE_MIN_SEC = 5;
const COLLAPSE_MAX_SEC = 3600;
const DEFAULT_COLLAPSE_SEC = 20;

/**
 * 规范化自动收起时长：限定为 5~3600 秒的整数。
 * 非法值（非数字、NaN、Infinity）回退到 fallback，避免 setTimeout 立即触发或永不触发。
 */
function normalizeCollapseDelay(value, fallback = DEFAULT_COLLAPSE_SEC) {
  const n = Number(value);
  if (!Number.isFinite(n)) return normalizeFallback(fallback);
  return Math.min(COLLAPSE_MAX_SEC, Math.max(COLLAPSE_MIN_SEC, Math.round(n)));
}

function normalizeFallback(fallback) {
  const n = Number(fallback);
  return Number.isFinite(n)
    ? Math.min(COLLAPSE_MAX_SEC, Math.max(COLLAPSE_MIN_SEC, Math.round(n)))
    : DEFAULT_COLLAPSE_SEC;
}

const DEFAULT_SETTINGS = {
  rootDir: '',                    // 用户配置的文件根目录（工作区：导入副本与屏蔽产物都在这里）
  importBehavior: 'keep',         // 导入方式：keep=保留原位置文件 | discard=处理后移入系统回收站
  conflictPolicy: 'keep',         // 根目录同名文件：keep=加序号保留两份 | overwrite=覆盖同名文件
  toggles: {
    phone: true, idCard: true, bank: true, email: true,
    name: true, address: true, passport: true, plate: true,
    caseNo: true, license: true, org: true,
    // 可选检测项：默认关闭，用户在设置中勾选开启
    landline: false, im: false, hkmt: false, uscc: false,
  },
  clipboardWatch: true,           // 剪贴板自动识别可恢复内容
  autoCollapse: true,             // 灵动岛无操作自动收起为顶部线段
  autoCollapseDelay: DEFAULT_COLLAPSE_SEC, // 自动收起时长（秒），可在设置中自定义
  uiScale: 'auto',                // 旧字段：界面缩放恒为自适应，实际面板尺寸由 appearance.panel 控制
  launchOnBoot: false,            // 开机自启
  appearance: {                   // 外观：主题 / 强调色 / 透明度 / 圆角 / 毛玻璃 / 面板尺寸 / 动效 / 背景
    theme: 'midnight',
    accent: '',                   // 空串 = 跟随主题默认强调色
    alpha: ALPHA_DEFAULT,         // 面板/胶囊底色不透明度（0.55~1；内容片另有衬底，文字不受影响）
      radius: RADIUS_DEFAULT,       // 面板圆角 px（10~25）
      fontScale: FONT_SCALE_DEFAULT, // 字体大小系数（0.85~1.3，1=100%）：面板内所有文字统一缩放
    bgDim: BG_DIM_DEFAULT,        // 旧字段：背景遮罩已合并进 alpha，仅保留以兼容旧存档
    glass: 'off',                 // 磨砂质感：off=实色 | auto=轻磨砂 | on=强磨砂（界面内模拟，非窗体级系统材质）
    panel: { w: BASE.panelW, h: BASE.panelH }, // 面板 CSS 视口尺寸（宽高独立，可细长 / 宽扁）
    motion: true,                 // 界面动效
    bg: { type: 'none', file: '', name: '' }, // 背景：none | image | video（file=islandbg:// 文件名，name=原始文件名，仅展示）
  },
};

class Store {
  constructor() {
    this.dir = null;
    this.settings = { ...DEFAULT_SETTINGS, toggles: { ...DEFAULT_SETTINGS.toggles } };
    this.vault = new Vault();
    this.history = [];
    this.vaultEncrypted = true;
  }

  init() {
    this.dir = app.getPath('userData');
    fs.mkdirSync(this.dir, { recursive: true });
    this._migrateFromOldAppName();
    this._loadSettings();
    this._loadVault();
    this._loadHistory();
  }

  /**
   * 旧版应用名数据目录迁移：「灵屿 · 隐私灵动岛」→「灵屿岛」（productName 变更会改变 userData 路径）。
   * 仅当新目录里没有任何数据文件而旧目录存在时才整份拷入，避免覆盖新数据。
   */
  _migrateFromOldAppName() {
    const LEGACY_DIRS = ['灵屿 · 隐私灵动岛', '灵屿-隐私灵动岛'];
    const dataFiles = ['settings.json', 'vault.bin', 'vault.bin.sig', 'vault.json', 'history.json'];
    try {
      const hasData = dataFiles.some((f) => fs.existsSync(path.join(this.dir, f)));
      if (hasData) return;
      const base = path.dirname(this.dir);
      for (const legacy of LEGACY_DIRS) {
        const legacyDir = path.join(base, legacy);
        if (!fs.existsSync(legacyDir)) continue;
        let copied = 0;
        for (const f of dataFiles) {
          const src = path.join(legacyDir, f);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(this.dir, f));
            copied++;
          }
        }
        if (copied > 0) console.log(`[store] 已从旧目录迁移 ${copied} 个数据文件: ${legacy}`);
        break;
      }
    } catch (e) {
      console.warn('[store] 旧数据目录迁移失败（忽略，按全新安装处理）:', e && e.message || e);
    }
  }

  get paths() {
    return {
      settings: path.join(this.dir, 'settings.json'),
      vaultBin: path.join(this.dir, 'vault.bin'),
      vaultPlain: path.join(this.dir, 'vault.json'),
      history: path.join(this.dir, 'history.json'),
      appearanceDir: path.join(this.dir, 'appearance'), // 自定义背景文件（islandbg:// 协议映射到这里）
    };
  }

  /* ---------------- 设置 ---------------- */

  _loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.paths.settings, 'utf8'));
      this.settings = {
        ...DEFAULT_SETTINGS, ...raw,
        toggles: { ...DEFAULT_SETTINGS.toggles, ...(raw.toggles || {}) },
      };
    } catch { /* 首次运行 */ }
    // 兼容旧配置文件（无此字段）或被外部改写的非法值
    this.settings.autoCollapseDelay = normalizeCollapseDelay(this.settings.autoCollapseDelay);
    this.settings.conflictPolicy = normalizeConflictPolicy(this.settings.conflictPolicy);
    // 界面大小手动档位入口已移除：旧存档里的 compact/standard/large 一律回到自适应，
    // 保证窗口始终按分辨率/DPI 完整落在屏幕内。
    this.settings.uiScale = 'auto';
    // 外观设置逐字段规范化（旧配置缺 appearance 字段时走全局默认）
    this.settings.appearance = normalizeAppearance(this.settings.appearance, null);
  }

  saveSettings(patch) {
    patch = patch || {};
    const next = {
      ...this.settings, ...patch,
      toggles: { ...this.settings.toggles, ...(patch.toggles || {}) },
    };
    // 以主进程为权威：渲染层传来的值统一在这里裁剪，返回值即为界面应显示的值
    if ('autoCollapseDelay' in patch) {
      next.autoCollapseDelay = normalizeCollapseDelay(patch.autoCollapseDelay, this.settings.autoCollapseDelay);
    }
    if ('conflictPolicy' in patch) {
      next.conflictPolicy = normalizeConflictPolicy(patch.conflictPolicy);
    }
    // 界面大小不再接受手动档位：即使外部传入也强制回到自适应
    next.uiScale = 'auto';
    // 外观设置以主进程规范化结果为准（越界钳制 / 非法回退）
    if ('appearance' in patch) {
      next.appearance = normalizeAppearance(patch.appearance, this.settings.appearance);
    }
    this.settings = next;
    fs.writeFileSync(this.paths.settings, JSON.stringify(this.settings, null, 2), 'utf8');
    return this.settings;
  }

  /* ---------------- 映射库（加密） ---------------- */

  _loadVault() {
    const { vaultBin, vaultPlain } = this.paths;
    try {
      if (fs.existsSync(vaultBin)) {
        const raw = fs.readFileSync(vaultBin);
        if (safeStorage.isEncryptionAvailable()) {
          const json = safeStorage.decryptString(raw);
          this.vault = Vault.fromJSON(JSON.parse(json));
          this.vaultEncrypted = true;
          return;
        }
      }
      // 降级：明文（首次在加密不可用时写入）
      if (fs.existsSync(vaultPlain)) {
        this.vault = Vault.fromJSON(JSON.parse(fs.readFileSync(vaultPlain, 'utf8')));
        this.vaultEncrypted = false;
        return;
      }
    } catch (err) {
      // 解密失败（如换了系统账户）：备份后重建，避免阻塞启动
      try { fs.renameSync(vaultBin, vaultBin + '.corrupt'); } catch { /* ignore */ }
      this.vault = new Vault();
    }
  }

  persistVault() {
    const json = JSON.stringify(this.vault.toJSON());
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(this.paths.vaultBin, safeStorage.encryptString(json));
      this.vaultEncrypted = true;
      // 清理旧明文
      if (fs.existsSync(this.paths.vaultPlain)) fs.rmSync(this.paths.vaultPlain, { force: true });
    } else {
      fs.writeFileSync(this.paths.vaultPlain, json, 'utf8');
      this.vaultEncrypted = false;
    }
  }

  /* ---------------- 历史 ---------------- */

  _loadHistory() {
    try { this.history = JSON.parse(fs.readFileSync(this.paths.history, 'utf8')); }
    catch { this.history = []; }
  }

  addHistory(item) {
    this.history.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      ts: Date.now(),
      ...item,
    });
    if (this.history.length > 200) this.history.length = 200;
    this._saveHistory();
  }

  removeHistory(id) {
    this.history = this.history.filter((h) => h.id !== id);
    this._saveHistory();
  }

  clearHistory() {
    this.history = [];
    this._saveHistory();
  }

  _saveHistory() {
    fs.writeFileSync(this.paths.history, JSON.stringify(this.history), 'utf8');
  }
}

module.exports = {
  Store, DEFAULT_SETTINGS, normalizeCollapseDelay,
  COLLAPSE_MIN_SEC, COLLAPSE_MAX_SEC, DEFAULT_COLLAPSE_SEC,
};
