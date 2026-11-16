'use strict';
/**
 * 主题注册表（主进程与渲染层共用，UMD：require / <script> 双通道）
 *
 * 主题只换 CSS 变量（颜色 / 面板 RGB / 边框 / 阴影 / 明暗方案），
 * 不触碰任何布局与功能逻辑。swatch 供外观页色板卡片预览。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandThemes = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const THEMES = [
    { id: 'midnight', name: '星夜蓝', group: 'dark', swatch: ['#0e1014', '#1b1f27', '#0a84ff'] },
    { id: 'graphite', name: '石墨',   group: 'dark', swatch: ['#101214', '#1d2126', '#7d95b5'] },
    { id: 'forest',   name: '松林',   group: 'dark', swatch: ['#0c120e', '#15201a', '#34c77b'] },
    { id: 'sunset',   name: '落日',   group: 'dark', swatch: ['#14100b', '#221a12', '#ff8c42'] },
    { id: 'lavender', name: '薰衣草', group: 'dark', swatch: ['#0f0d16', '#1c1826', '#a78bfa'] },
    { id: 'cloud',    name: '云白',   group: 'light', swatch: ['#f2f5f9', '#ffffff', '#2563eb'] },
    { id: 'sakura',   name: '樱粉',   group: 'light', swatch: ['#fdf2f5', '#ffffff', '#d94f7d'] },
  ];

  const DEFAULT_THEME = 'midnight';
  const THEME_IDS = new Set(THEMES.map((t) => t.id));

  /** 强调色：6 位 hex；空串 = 跟随主题默认 */
  const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

  /** 非法/未知主题 id 回退默认（或指定的 fallback） */
  function normalizeTheme(value, fallback) {
    const fb = THEME_IDS.has(fallback) ? fallback : DEFAULT_THEME;
    return THEME_IDS.has(value) ? value : fb;
  }

  /** 非法强调色一律回退空串（跟随主题） */
  function normalizeAccent(value) {
    return (typeof value === 'string' && ACCENT_RE.test(value)) ? value.toLowerCase() : '';
  }

  /** 强调色预设（外观页色点）；首项为空 = 跟随主题 */
  const ACCENT_PRESETS = ['', '#0a84ff', '#34c77b', '#ff8c42', '#a78bfa', '#38bdf8', '#f472b6'];

  return { THEMES, THEME_IDS, DEFAULT_THEME, ACCENT_RE, ACCENT_PRESETS, normalizeTheme, normalizeAccent };
});
