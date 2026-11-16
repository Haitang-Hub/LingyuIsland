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

  // 8 款主题：ID 保持稳定，旧存档不会失效；霜雪（冷白）收尾。
  const THEMES = [
    { id: 'obsidian', name: '黑金', group: 'dark', swatch: ['#070605', '#1e1811', '#d9b658'] },
    { id: 'graphite', name: '墨砚', group: 'dark', swatch: ['#141618', '#202328', '#8fa8c0'] },
    { id: 'midnight', name: '曜夜', group: 'dark', swatch: ['#0a0d18', '#1a2338', '#7ba3f2'] },
    { id: 'teal',     name: '青黛', group: 'dark', swatch: ['#0a1418', '#1a2f36', '#64c0cb'] },
    { id: 'lavender', name: '雾紫', group: 'light', swatch: ['#b9aed6', '#e6dff5', '#6f52b8'] },
    { id: 'mauve',    name: '晨雾', group: 'light', swatch: ['#f0e6d6', '#faf4e9', '#b8823a'] },
    { id: 'sakura',   name: '樱落', group: 'light', swatch: ['#fbeaf0', '#ffffff', '#c94670'] },
    { id: 'cloud',    name: '霜雪', group: 'light', swatch: ['#eaf1f8', '#ffffff', '#3970c9'] },
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
  // 强调色预设：8 款通透悦目的低饱和色，避开各主题强调色；首项为空 = 跟随主题
  const ACCENT_PRESETS = [
    '',          // 跟随主题
    '#6e9bc4',   // 晴空蓝
    '#62a8a2',   // 湖水青
    '#7fa86b',   // 嫩叶绿
    '#c4a34e',   // 暖金黄
    '#d08355',   // 赤陶橙
    '#c4708e',   // 莓果粉
    '#9a86c2',   // 薰衣草紫
    '#a29083',   // 暖岩灰
  ];

  return { THEMES, THEME_IDS, DEFAULT_THEME, ACCENT_RE, ACCENT_PRESETS, normalizeTheme, normalizeAccent };
});
