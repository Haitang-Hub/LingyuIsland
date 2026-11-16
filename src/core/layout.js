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

/** 手动界面大小；'auto' 按工作区自动计算 */
const UI_SCALES = { compact: 0.85, standard: 1, large: 1.2 };
const AUTO_MIN = 0.85, AUTO_MAX = 1.3;
const UI_SCALE_VALUES = new Set(['auto', ...Object.keys(UI_SCALES)]);

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 非法/未知设置值一律回退 'auto' */
function normalizeUiScale(value) {
  return UI_SCALE_VALUES.has(value) ? value : 'auto';
}

/**
 * 自动缩放：以 1920×1040 的逻辑工作区为 1.0，按宽高中较紧的一边温和插值。
 * 不用线性比例（那会让 1366×768 缩到 0.7、字小到看不清），上下限 0.85~1.3。
 */
function autoUiScale(width, height) {
  const raw = Math.min(width / 1920, height / 1040);
  return Math.round(clamp(raw, AUTO_MIN, AUTO_MAX) * 100) / 100;
}

function resolveUiScale(width, height, pref) {
  if (pref && UI_SCALES[pref]) return UI_SCALES[pref];
  return autoUiScale(width, height);
}

/**
 * @param {{x:number,y:number,width:number,height:number}} workArea 主显示器工作区（DIP）
 * @param {{uiScale?:string, collapsed?:boolean}} [opts]
 * @returns {{uiScale:number, pill:{x,y,width,height}, panel:{x,y,width,height}}}
 */
function computeIslandLayout(workArea, opts = {}) {
  const wa = {
    x: Number.isFinite(workArea && workArea.x) ? workArea.x : 0,
    y: Number.isFinite(workArea && workArea.y) ? workArea.y : 0,
    width: Math.max(1, Number.isFinite(workArea && workArea.width) ? workArea.width : 1920),
    height: Math.max(1, Number.isFinite(workArea && workArea.height) ? workArea.height : 1040),
  };

  const scale = resolveUiScale(wa.width, wa.height, opts.uiScale);
  const edge = Math.round(BASE.edge * scale);
  const topInset = Math.round(BASE.topInset * scale);
  const gap = Math.round(BASE.gap * scale);

  const availW = Math.max(1, wa.width - edge * 2);
  const pillW = Math.min(Math.round(BASE.pillW * scale), availW);
  const panelW = Math.min(Math.round(BASE.panelW * scale), availW);
  const pillH = Math.round(BASE.pillH * scale);

  // 面板顶部固定在胶囊下方；高度按剩余空间裁剪，绝不靠「上移窗口」来硬塞
  const panelTopOffset = topInset + pillH + gap;
  const maxPanelH = Math.max(1, wa.height - panelTopOffset - edge);
  const panelH = Math.min(Math.round(BASE.panelH * scale), maxPanelH);

  const pillX = wa.x + Math.round((wa.width - pillW) / 2);
  const panelX = wa.x + Math.round((wa.width - panelW) / 2);

  return {
    uiScale: scale,
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
  BASE, UI_SCALES, AUTO_MIN, AUTO_MAX,
  normalizeUiScale, autoUiScale, computeIslandLayout,
};
