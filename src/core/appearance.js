'use strict';
/**
 * 外观设置规范化（纯函数，主进程为权威：越界钳制 / 非法回退）
 * 所有字段都有安全默认值，旧配置文件缺字段时天然兼容。
 */

const { DEFAULT_THEME, normalizeTheme, normalizeAccent } = require('./themes');
const { normalizePanelSize, sizeFromDensity } = require('./layout');

/** 面板/胶囊底色不透明度：低于 55% 文字可读性明显劣化，钳回 */
const ALPHA_MIN = 0.55, ALPHA_MAX = 1, ALPHA_DEFAULT = 0.97;

/** 面板圆角范围（px）；胶囊圆角 = 面板圆角 + 4，但胶囊本身是胶囊形，上限仍是 22 */
const RADIUS_MIN = 10, RADIUS_MAX = 25, RADIUS_DEFAULT = 18;

/** 字体大小系数：面板内所有文字按此缩放，布局与控件尺寸不动。
 *  外观页是档位选择（小/标准/大/特大），非档位值（如旧滑杆存的中间值）吸附到最近档 */
const FONT_SCALE_MIN = 0.85, FONT_SCALE_MAX = 1.3, FONT_SCALE_DEFAULT = 1;
const FONT_SCALE_STEPS = [0.9, 1, 1.15, 1.3];

/** 灵动岛水平位置：中心相对工作区宽度的比例（0~1，0.5 = 顶部居中）。
 *  拖动换位后持久化；存比例可在换分辨率/缩放后保持相对位置 */
const PILL_X_DEFAULT = 0.5;

/** 旧字段：自定义背景遮罩浓度（0.35~0.95）。
 *  背景可见度已合并到「面板不透明度」一个旋钮，本字段仅为旧存档兼容保留，
 *  渲染层不再读取；遮罩在 CSS 里固定为可读性兜底值。 */
const BG_DIM_MIN = 0.35, BG_DIM_MAX = 0.95, BG_DIM_DEFAULT = 0.62;

/** 背景文件大小预算（字节）：图片 10MB / 视频 20MB */
const BG_IMAGE_MAX = 10 * 1024 * 1024;
const BG_VIDEO_MAX = 20 * 1024 * 1024;

/** 背景类型白名单与扩展名白名单（与 islandbg:// 协议保持一致）
 *  只放进 Chromium 确定能解码的格式：图片 bmp/avif/gif 均可渲染；
 *  视频只认 mp4(H.264)/webm，mov/mkv 无法解码，宁可在选择时就明确拒绝。 */
const BG_TYPES = new Set(['none', 'image', 'video']);
const BG_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);
const BG_VIDEO_EXTS = new Set(['mp4', 'webm']);
const BG_FILE_RE = /^[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|bmp|avif|mp4|webm)$/i;

const GLASS_MODES = new Set(['auto', 'on', 'off']);

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 吸附到最近的字体档位 */
function snapFontScale(v) {
  return FONT_SCALE_STEPS.reduce((best, s) =>
    Math.abs(s - v) < Math.abs(best - v) ? s : best);
}

function normalizeBgType(v) { return BG_TYPES.has(v) ? v : 'none'; }

/** 原始文件名仅作界面展示：去掉路径与目录分隔符，限长 60 */
function normalizeBgName(v, type) {
  if (type === 'none') return '';
  const s = typeof v === 'string' ? v : '';
  const base = s.split(/[\\/]/).pop().slice(0, 60);
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
}

function normalizeBgFile(v, type) {
  const s = typeof v === 'string' ? v : '';
  if (type === 'none' || !BG_FILE_RE.test(s)) return '';
  // 扩展名必须与类型匹配，防止 image 类型挂上 mp4
  const ext = s.split('.').pop().toLowerCase();
  if (type === 'image' && !BG_IMAGE_EXTS.has(ext)) return '';
  if (type === 'video' && !BG_VIDEO_EXTS.has(ext)) return '';
  return s;
}

/**
 * 面板尺寸：宽高独立可调（细长 / 宽扁）。优先取 patch 的 panel，其次沿用 prev，
 * 最后按旧存档的 density 档位映射一次（兼容早期配置）。
 */
function resolvePanelSize(r, p) {
  if (r.panel && typeof r.panel === 'object') return normalizePanelSize(r.panel, p.panel);
  if (p.panel) return normalizePanelSize(null, p.panel);
  return sizeFromDensity(r.density || p.density);
}

/**
 * @param {*} raw 渲染层传来的 appearance patch（可能缺字段 / 非法值）
 * @param {*} [prev] 现有 appearance（缺省字段回退到它，再回退全局默认）
 */
function normalizeAppearance(raw, prev) {
  const p = (prev && typeof prev === 'object') ? prev : {};
  const r = (raw && typeof raw === 'object') ? raw : {};
  // bg 字段逐个回退：patch 只带 type 或只带 file 时，缺省侧沿用 prev。
  // type 有效但文件缺失/非法 → 保留 type 作为「待选文件」状态（渲染层没有
  // 文件就不会显示背景），避免分段控件在选型后又被弹回「无」。
  const bgType = normalizeBgType('bg' in r && r.bg && 'type' in r.bg ? r.bg.type : (p.bg && p.bg.type));
  const bgFile = normalizeBgFile('bg' in r && r.bg && 'file' in r.bg ? r.bg.file : (p.bg && p.bg.file), bgType);
  // 展示名：换文件时以 patch 的 name 为准（主进程写入原始文件名），否则沿用旧值
  const bgNameRaw = 'bg' in r && r.bg && 'name' in r.bg ? r.bg.name : (p.bg && p.bg.name);
  return {
    theme: normalizeTheme(r.theme, p.theme || DEFAULT_THEME),
    accent: normalizeAccent('accent' in r ? r.accent : p.accent),
    alpha: clampNum(r.alpha, ALPHA_MIN, ALPHA_MAX,
      clampNum(p.alpha, ALPHA_MIN, ALPHA_MAX, ALPHA_DEFAULT)),
    radius: Math.round(clampNum(r.radius, RADIUS_MIN, RADIUS_MAX,
      clampNum(p.radius, RADIUS_MIN, RADIUS_MAX, RADIUS_DEFAULT))),
    // 字体大小：钳制后吸附到最近档位（旧滑杆中间值顺带迁移），patch 缺省时沿用 prev
    fontScale: snapFontScale(clampNum(r.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX,
      clampNum(p.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_DEFAULT))),
    // 灵动岛水平位置比例：保留三位小数（≈1~2px 精度），patch 缺省时沿用 prev
    pillX: Math.round(clampNum(r.pillX, 0, 1,
      clampNum(p.pillX, 0, 1, PILL_X_DEFAULT)) * 1000) / 1000,
    // 背景遮罩：patch 缺省时沿用 prev，避免调主题 / 透明度把遮罩重置
    bgDim: clampNum(r.bgDim, BG_DIM_MIN, BG_DIM_MAX,
      clampNum(p.bgDim, BG_DIM_MIN, BG_DIM_MAX, BG_DIM_DEFAULT)),
    glass: GLASS_MODES.has(r.glass) ? r.glass
      : (GLASS_MODES.has(p.glass) ? p.glass : 'off'),
    panel: resolvePanelSize(r, p),
    motion: 'motion' in r ? !!r.motion : (p.motion !== false),
    bg: { type: bgType, file: bgFile, name: bgFile ? normalizeBgName(bgNameRaw, bgType) : '' },
  };
}

module.exports = {
  normalizeAppearance, normalizeBgFile, normalizeBgName,
  ALPHA_MIN, ALPHA_MAX, ALPHA_DEFAULT,
  RADIUS_MIN, RADIUS_MAX, RADIUS_DEFAULT,
  FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_DEFAULT, FONT_SCALE_STEPS,
  PILL_X_DEFAULT,
  BG_DIM_MIN, BG_DIM_MAX, BG_DIM_DEFAULT,
  BG_IMAGE_MAX, BG_VIDEO_MAX, BG_IMAGE_EXTS, BG_VIDEO_EXTS, BG_FILE_RE, BG_TYPES, GLASS_MODES,
};
