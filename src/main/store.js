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
const { normalizeAppearance, ALPHA_DEFAULT, RADIUS_DEFAULT, FONT_SCALE_DEFAULT, PILL_X_DEFAULT } = require('../core/appearance');

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
    // 固定电话、统一社会信用代码、籍贯默认开启；社交账号仍默认关闭
    // （im 仅在聊天记录场景按需开启，避免误报普通数字串）
    landline: true, im: false, native: true, uscc: true,
  },
  // PDF 不可逆遮盖：dpi 控制清晰度/体积；ocrEngineDir 为空时自动探测本机 OcrFlow 引擎
  pdfRedact: { dpi: 200, ocrEngineDir: '' },
  // 交付前复核闸口：开启后产物复检仍有敏感信息就删除产物并阻断交付
  strictResidual: false,
  clipboardWatch: true,           // 剪贴板自动识别可恢复内容
  autoCollapse: true,             // 灵动岛无操作自动收起为顶部线段
  autoCollapseDelay: DEFAULT_COLLAPSE_SEC, // 自动收起时长（秒），可在设置中自定义
  fullscreenAutoHide: true,       // 其他应用全屏/截图时自动隐藏灵动岛（全屏结束自动恢复）
  launchOnBoot: false,            // 开机自启
  appearance: {                   // 外观：主题 / 强调色 / 透明度 / 圆角 / 毛玻璃 / 面板尺寸 / 动效 / 背景
    theme: 'midnight',
    accent: '',                   // 空串 = 跟随主题默认强调色
    alpha: ALPHA_DEFAULT,         // 面板/胶囊底色不透明度（0.55~1；内容片另有衬底，文字不受影响）
      radius: RADIUS_DEFAULT,       // 面板圆角 px（10~25）
      fontScale: FONT_SCALE_DEFAULT, // 字体大小系数（0.85~1.3，1=100%）：面板内所有文字统一缩放
      pillX: PILL_X_DEFAULT,        // 灵动岛水平位置比例（0~1，0.5=顶部居中）：拖动换位后持久化
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
    this._loadSettings();
    this._loadVault();
    this._loadHistory();
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
        // 港澳台证件检测项已改为籍贯（native）；旧配置的 hkmt 键在末尾置空丢弃
        toggles: { ...DEFAULT_SETTINGS.toggles, ...(raw.toggles || {}), hkmt: undefined },
        pdfRedact: { ...DEFAULT_SETTINGS.pdfRedact, ...(raw.pdfRedact || {}) },
      };
    } catch { /* 首次运行 */ }
    // 缺字段或被外部改写的非法值统一规范化
    this.settings.autoCollapseDelay = normalizeCollapseDelay(this.settings.autoCollapseDelay);
    this.settings.conflictPolicy = normalizeConflictPolicy(this.settings.conflictPolicy);
    // 外观设置逐字段规范化（缺 appearance 字段时走全局默认）
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
    // 脏标记：没有新增映射时跳过全量序列化+加密写盘（每批处理完和退出都会调用），
    // 但旧明文 vault.json → vault.bin 的加密迁移不受脏标记抑制。
    if (!this.vault) return;
    const canEncrypt = safeStorage.isEncryptionAvailable();
    if (!this.vault._dirty && (this.vaultEncrypted || !canEncrypt)) return;
    const json = JSON.stringify(this.vault.toJSON());
    if (canEncrypt) {
      fs.writeFileSync(this.paths.vaultBin, safeStorage.encryptString(json));
      this.vaultEncrypted = true;
      // 清理旧明文
      if (fs.existsSync(this.paths.vaultPlain)) fs.rmSync(this.paths.vaultPlain, { force: true });
    } else {
      fs.writeFileSync(this.paths.vaultPlain, json, 'utf8');
      this.vaultEncrypted = false;
    }
    this.vault._dirty = false;
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
