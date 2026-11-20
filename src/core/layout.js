'use strict';
/**
 * 多分辨率 / 多 DPI 窗口布局（纯函数，不依赖 Electron，便于单元测试）
 *
 * 设计基准：1920×1080 @100% 系统缩放（workArea 约 1920×1040）→ uiScale = 1。
 * Electron 的窗口坐标与尺寸都是 DIP，系统缩放已由 Chromium 换算，因此这里只按
 * workArea 的逻辑尺寸做温和的等比缩放，并按可用空间裁剪，保证：
 *   1. 面板永远完整落在工作区内，且始终在胶囊下方、不与胶囊重叠；
 *   2. 低分辨率/高缩放（可用 DIP 变小）时窗口自动缩小，不再被顶出屏幕；
 *   3. 4K/高分屏（可用 DIP 变大）时 UI 等比放大，不至于小得看不清；
 *   4. 窗口 DIP 尺寸 = 设计尺寸 × uiScale，渲染层 zoomFactor 同步为 uiScale，
 *      于是 CSS 视口恒等于设计尺寸，弹性布局无需为每种屏幕单独适配。
 */

/** 设计基准尺寸（CSS 像素） */
const BASE = {
  pillW: 372, pillH: 52,
  panelW: 560, panelH: 700,
  topInset: 6,   // 展开态胶囊距工作区顶部，给阴影留白
  gap: 4,        // 胶囊与面板间距
  edge: 8,       // 左右/底部安全留白
};

/**
 * 面板尺寸不再用「等比缩放档位」，而是直接给出 CSS 视口的宽 × 高。
 * 宽高独立，于是可以「细长」（窄而高，适合长列表）或「宽扁」（宽而矮，
 * 适合表格 / 并排文本），而不是整体倍率放大到占满全屏。
 */
const PANEL_LIMITS = { minW: 360, maxW: 1040, minH: 360, maxH: 1000 };

/** 快捷预设（面板 CSS 视口尺寸） */
const PANEL_PRESETS = {
  narrow: { id: 'narrow', label: '细长', w: 470, h: 820 },
  standard: { id: 'standard', label: '标准', w: 560, h: 700 },
  wide: { id: 'wide', label: '宽扁', w: 820, h: 620 },
};

const AUTO_MIN = 0.85, AUTO_MAX = 1.3;

/** 胶囊宽度跟随字体档位的系数范围（与外观页 fontScale 档位一致：0.9/1/1.15/1.3） */
const PILL_FONT_MIN = 0.85, PILL_FONT_MAX = 1.3;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 面板尺寸规范化：宽高各自钳制，非法值回退到上一次的有效值 / 基准尺寸 */
function normalizePanelSize(raw, prev) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const p = (prev && typeof prev === 'object') ? prev : {};
  const num = (v, lo, hi, fb) => {
    const n = Number(v);
    // null / '' / NaN 都视为「未提供」，回退到上一次的有效值
    return Math.round(clamp(v === null || v === '' || !Number.isFinite(n) ? fb : n, lo, hi));
  };
  return {
    w: num(r.w, PANEL_LIMITS.minW, PANEL_LIMITS.maxW, num(p.w, PANEL_LIMITS.minW, PANEL_LIMITS.maxW, BASE.panelW)),
    h: num(r.h, PANEL_LIMITS.minH, PANEL_LIMITS.maxH, num(p.h, PANEL_LIMITS.minH, PANEL_LIMITS.maxH, BASE.panelH)),
  };
}

/** 命中的预设 id（宽高与预设完全一致时返回，供渲染层高亮） */
function matchPreset(size) {
  if (!size) return '';
  for (const key of Object.keys(PANEL_PRESETS)) {
    const p = PANEL_PRESETS[key];
    if (size.w === p.w && size.h === p.h) return key;
  }
  return '';
}

/**
 * 自动缩放：以 1920×1040 的逻辑工作区为 1.0，按宽高中较紧的一边温和插值。
 * 不用线性比例（那会让 1366×768 缩到 0.7、字小到看不清），上下限 0.85~1.3。
 */
function autoUiScale(width, height) {
  const raw = Math.min(width / 1920, height / 1040);
  return Math.round(clamp(raw, AUTO_MIN, AUTO_MAX) * 100) / 100;
}

/**
 * @param {{x:number,y:number,width:number,height:number}} workArea 主显示器工作区（DIP）
 * @param {{panelW?:number, panelH?:number, collapsed?:boolean, pillX?:number, fontScale?:number}} [opts]
 *   panelW/panelH = 面板 CSS 视口尺寸（宽高独立，可细长可宽扁）；
 *   pillX = 灵动岛中心相对工作区宽度的比例（0~1，默认 0.5 居中），拖动换位后持久化的值；
 *   fontScale = 字体档位（0.85~1.3），胶囊宽度按其等比伸缩
 * @returns {{pillScale:number, panelScale:number, pill:{x,y,width,height}, panel:{x,y,width,height}}}
 */
function computeIslandLayout(workArea, opts = {}) {
  const wa = {
    x: Number.isFinite(workArea && workArea.x) ? workArea.x : 0,
    y: Number.isFinite(workArea && workArea.y) ? workArea.y : 0,
    width: Math.max(1, Number.isFinite(workArea && workArea.width) ? workArea.width : 1920),
    height: Math.max(1, Number.isFinite(workArea && workArea.height) ? workArea.height : 1040),
  };

  const sys = autoUiScale(wa.width, wa.height); // 系统/屏幕系数：DPI 与分辨率适配
  const edge = Math.round(BASE.edge * sys);
  const topInset = Math.round(BASE.topInset * sys);
  const gap = Math.round(BASE.gap * sys);

  const availW = Math.max(1, wa.width - edge * 2);

  // 胶囊固定比例，只跟随系统系数与字体档位：面板拉宽压扁时胶囊不应跟着变形；
  // 字体档位改变胶囊目标宽度——标准档保持基准宽度不变，「小」档按平方收缩（比
  // 线性更紧凑），「大/特大」按线性放宽；仍按可用空间钳制，窄屏下不会被撑出屏幕
  const fontScale = clamp(Number(opts.fontScale) || 1, PILL_FONT_MIN, PILL_FONT_MAX);
  const pillFontFactor = fontScale < 1 ? fontScale * fontScale : fontScale;
  const pillTargetW = Math.max(1, BASE.pillW * pillFontFactor);
  const pillScale = Math.min(sys, availW / pillTargetW);
  const pillW = Math.round(pillTargetW * pillScale);
  const pillH = Math.round(BASE.pillH * pillScale);

  // 面板：目标 CSS 视口宽高 × 统一系数（该系数同时作为渲染层 zoom），
  // 系数被工作区钳制，空间不足时整体（含字号）一起缩小，绝不越出屏幕
  const target = normalizePanelSize({ w: opts.panelW, h: opts.panelH });
  // 面板顶部固定在胶囊下方；高度按剩余空间裁剪，绝不靠「上移窗口」来硬塞
  const panelTopOffset = topInset + pillH + gap;
  const maxPanelH = Math.max(1, wa.height - panelTopOffset - edge);
  const scale = clamp(Math.min(sys, availW / target.w, maxPanelH / target.h), AUTO_MIN, AUTO_MAX);
  const panelW = Math.round(Math.min(target.w * scale, availW));
  const panelH = Math.round(Math.min(target.h * scale, maxPanelH));

  // 灵动岛水平位置：中心相对工作区宽度的比例（拖动换位），钳在安全留白内；
  // 面板以胶囊中心为锚随动，同样钳在屏内。比例缺省 0.5 时与旧的纯居中完全一致。
  // 注意 0 是合法值（最左），不能用 || 兜底
  const pillXRaw = Number(opts.pillX);
  const pillXRatio = clamp(Number.isFinite(pillXRaw) ? pillXRaw : 0.5, 0, 1);
  const pillCenterX = wa.x + wa.width * pillXRatio;
  const minXPill = wa.x + edge, maxXPill = wa.x + wa.width - edge - pillW;
  const pillX = Math.round(Math.min(Math.max(pillCenterX - pillW / 2, minXPill), Math.max(minXPill, maxXPill)));
  const minXPanel = wa.x + edge, maxXPanel = wa.x + wa.width - edge - panelW;
  const panelX = Math.round(Math.min(Math.max(pillCenterX - panelW / 2, minXPanel), Math.max(minXPanel, maxXPanel)));

  return {
    pillScale,
    panelScale: scale,
    target,
    pill: {
      x: pillX,
      y: wa.y + (opts.collapsed ? 0 : topInset),
      width: pillW,
      height: pillH,
    },
    panel: {
      x: panelX,
      y: wa.y + panelTopOffset,
      width: panelW,
      height: panelH,
    },
  };
}

module.exports = {
  BASE, PANEL_LIMITS, PANEL_PRESETS, AUTO_MIN, AUTO_MAX, PILL_FONT_MIN, PILL_FONT_MAX,
  normalizePanelSize, matchPreset, autoUiScale, computeIslandLayout,
};
