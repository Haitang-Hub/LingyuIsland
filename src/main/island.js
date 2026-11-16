'use strict';
/**
 * 灵动岛窗口管理
 *  - 胶囊窗口：置顶小型悬浮条，不抢焦点，可拖放文件
 *      - 展开态：完整胶囊
 *      - 收起态：屏幕顶边一条细线（窗口点击穿透，鼠标悬停线段自动展开）
 *  - 面板窗口：胶囊下方展开的主面板（概览/查找/恢复/设置）
 *  - 面板始终为「点击面板外任意位置即收起」模式（blur → 隐藏）
 *  - 收起/展开的过渡动画由渲染端 CSS 完成，主进程只负责状态切换与命中区域
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { computeIslandLayout, normalizePanelSize, BASE } = require('../core/layout');

/** 窗口是否已销毁：单元测试用轻量替身，不一定实现 isDestroyed */
function isGone(win) {
  if (!win) return true;
  if (typeof win.isDestroyed !== 'function') return false;
  try { return win.isDestroyed(); } catch { return true; }
}

// 设计基准尺寸（实际窗口尺寸由 computeIslandLayout 按当前工作区动态计算）
const PILL_W = BASE.pillW, PILL_H = BASE.pillH;
const PANEL_W = BASE.panelW, PANEL_H = BASE.panelH;

class Island {
  constructor() {
    this.pill = null;
    this.panel = null;
    this.dialogOpen = false;
    this._pillVisible = true;     // true=展开显示 | false=收起为顶部线段（供托盘菜单判断）
    this.pillCollapsed = false;   // 当前是否处于线段收起态
    // 托盘菜单重建钩子（createTray 注入），状态切换后同步「隐藏/显示灵动岛」文案
    this.onPillStateChange = null;
    this.panelSize = { w: BASE.panelW, h: BASE.panelH }; // 面板 CSS 视口尺寸（宽高独立，可细长 / 宽扁）
  }

  /** 按当前主显示器工作区算出胶囊/面板的尺寸、位置与 UI 缩放 */
  _plan() {
    const display = screen.getPrimaryDisplay();
    return computeIslandLayout(display.workArea, {
      panelW: this.panelSize.w,
      panelH: this.panelSize.h,
      collapsed: this.pillCollapsed,
    });
  }

  create() {
    const plan = this._plan();
    const appIcon = path.join(__dirname, '..', '..', 'assets', 'icon.png');

    this.pill = new BrowserWindow({
      width: plan.pill.width, height: plan.pill.height,
      x: plan.pill.x, y: plan.pill.y,
      frame: false, transparent: true, resizable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false,
      hasShadow: false, show: false,
      icon: appIcon,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    this.pill.setAlwaysOnTop(true, 'screen-saver');
    this.pill.loadFile(path.join(__dirname, '..', 'renderer', 'pill.html'));

    this.panel = new BrowserWindow({
      width: plan.panel.width, height: plan.panel.height,
      x: plan.panel.x, y: plan.panel.y,
      frame: false, transparent: true, resizable: false,
      alwaysOnTop: true, skipTaskbar: true,
      hasShadow: false, show: false,
      icon: appIcon,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    this.panel.setAlwaysOnTop(true, 'screen-saver');
    this.panel.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));

    // 面板失焦 = 鼠标点到了面板外任意位置 → 收起（打开文件对话框时不隐藏）
    this.panel.on('blur', () => {
      if (this.dialogOpen) return;
      setTimeout(() => {
        if (!this.panel.isFocused() && !this.dialogOpen && this.panel.isVisible()) {
          this.hidePanel();
        }
      }, 180);
    });

    // 渲染端 JS 错误转发到主进程 stdout（诊断用）
    for (const w of [this.pill, this.panel]) {
      w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        if (level >= 2) {
          console.error(`[renderer:${w === this.panel ? 'panel' : 'pill'}] ${message} (${sourceId}:${line})`);
        }
      });
      // loadFile 会重置 zoomFactor，加载完成后强制刷新一次缩放与布局
      w.webContents.on('did-finish-load', () => {
        if (w.isDestroyed()) return;
        w._islandZoom = null;
        this.layout();
      });
    }

    // 分辨率 / 系统缩放 / 外接显示器 / 主屏切换 → 重算尺寸、位置与缩放
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) {
      screen.on(ev, () => this.layout());
    }
    // macOS：灵动岛跨所有桌面空间与全屏应用可见
    if (process.platform === 'darwin') {
      for (const w of [this.pill, this.panel]) {
        w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
    }

    // Windows 透明置顶窗偶发丢 mouseleave → 渲染端悬停态卡住，主进程轮询兜底
    this.startPillHoverWatch();
  }

  /** 面板尺寸变化 → 立即重新布局（宽高独立：可细长 / 宽扁） */
  /** 收起过渡进行中（窗口仍可见但正在淡出） */
  _closing = false;

  setPanelSize(size) {
    this.panelSize = normalizePanelSize(size, this.panelSize);
    this.layout();
  }

  /** 应用尺寸、缩放与位置；只有真正变化时才动窗口，避免透明窗重绘闪烁 */
  _apply(win, bounds, scale) {
    if (!win || win.isDestroyed()) return;
    const before = win.getBounds();
    if (before.width !== bounds.width || before.height !== bounds.height) {
      // Windows 上 resizable:false 的窗口会被系统把「可调尺寸范围」钳在当前尺寸，
      // setSize 只能变大不能变小：密度档位从大往小切时尺寸被忽略，CSS 视口随之错乱。
      // 临时放开 resizable 再改尺寸，随即恢复，双向切换才都生效。
      let unlocked = false;
      try {
        if (!win.isResizable()) { win.setResizable(true); unlocked = true; }
      } catch { /* ignore */ }
      win.setSize(bounds.width, bounds.height);
      if (unlocked) {
        try { win.setResizable(false); } catch { /* ignore */ }
      }
    }
    // 窗口 DIP 尺寸 = 设计尺寸 × scale，渲染层同步缩放 → CSS 视口恒为设计尺寸
    if (win._islandZoom !== scale) {
      try {
        win.webContents.setZoomFactor(scale);
        win._islandZoom = scale;
      } catch { /* ignore */ }
    }
    // 尺寸变化后重新取位置：setSize 可能带来系统侧 1px 修正，用旧值比较会漏掉补正
    const after = win.getBounds();
    if (after.x !== bounds.x || after.y !== bounds.y) win.setPosition(bounds.x, bounds.y);
  }

  layout() {
    if (!this.pill || !this.panel) return;
    const plan = this._plan();
    this._apply(this.pill, plan.pill, plan.pillScale);
    this._apply(this.panel, plan.panel, plan.panelScale);
  }

  showPanel(tab) {
    if (!this.panel) return;
    this.layout();
    if (tab) this.panel.webContents.send('panel:show-tab', tab);
    // 正处在收起过渡里再点开：直接反向，别让窗口停在半透明状态
    const reopening = this._closing;
    this._cancelClose();
    // 面板始终为「点击外部即收起」模式：必须激活窗口，blur 才会触发
    const wasVisible = this.panel.isVisible();
    if (!wasVisible) {
      // 先以 0 透明度拉起，避开透明窗口显示瞬间的首帧闪动，再做淡入过渡
      try { this.panel.setOpacity(0); } catch { /* ignore */ }
    }
    this.panel.show();
    this.panel.focus();
    // 收起途中被打断时不再从头淡入（_cancelClose 已把透明度拉回 1），否则会暗闪一下
    if (!reopening) this._sendPanelPhase('enter');
    if (!wasVisible) this._fadeIn();
    this._notifyPanel(true); // 面板打开期间胶囊暂停空闲收起计时
  }

  /** 通知渲染层播放开合动画（面板内的缩放/位移由 CSS 负责，窗口透明度由主进程负责） */
  _sendPanelPhase(phase) {
    const w = this.panel;
    if (isGone(w)) return;
    try { w.webContents.send('panel:' + phase); } catch { /* ignore */ }
  }

  _fadeIn() {
    this._stopFade();
    const w = this.panel;
    let o = 0;
    this._fadeTimer = setInterval(() => {
      if (isGone(w)) return this._stopFade();
      // 指数逼近 1：起步快、收尾柔，比等差步进更像真实的“浮现”
      o = Math.min(1, o + (1 - o) * 0.34 + 0.04);
      try { w.setOpacity(o); } catch { /* ignore */ }
      if (o >= 0.995) this._stopFade();
    }, 16); // 约 150ms 淡入
  }

  _stopFade() {
    if (this._fadeTimer) { clearInterval(this._fadeTimer); this._fadeTimer = null; }
  }

  /** 取消进行中的收起过渡（窗口仍在，只是透明度在降） */
  _cancelClose() {
    if (!this._closing) return;
    this._stopFade();
    this._closing = false;
    try { this.panel.setOpacity(1); } catch { /* ignore */ }
  }

  /** 胶囊在面板之外，点击它也应视为「点击外部」而收起 */
  onPillClick(tab) {
    if (this._closing) { this.showPanel(tab); return; } // 收起中再点 = 重新打开
    if (this.panel && this.panel.isVisible()) this.hidePanel();
    else this.showPanel(tab);
  }

  /**
   * 收起：先播 140ms 淡出（窗口透明度 + 渲染层缩小），再真正 hide。
   * 过渡期间 isVisible() 仍为真，用 _closing 标记避免重复收起 / 误判点击。
   */
  hidePanel() {
    const w = this.panel;
    if (isGone(w) || !w.isVisible() || this._closing) return;
    this._stopFade();
    // 降级：没有 setOpacity 的环境（单元测试替身 / 极端平台）直接隐藏
    if (typeof w.setOpacity !== 'function') {
      w.hide();
      this._notifyPanel(false);
      return;
    }
    this._closing = true;
    this._sendPanelPhase('exit');
    this._notifyPanel(false); // 立即让胶囊恢复空闲计时，不等动画结束
    let o = 1;
    this._fadeTimer = setInterval(() => {
      if (isGone(w)) { this._stopFade(); this._closing = false; return; }
      o -= 0.13;
      if (o <= 0.02) {
        this._stopFade();
        try { w.setOpacity(1); } catch { /* 下次打开时重新从 0 淡入 */ }
        w.hide();
        this._closing = false;
        return;
      }
      try { w.setOpacity(o); } catch { /* ignore */ }
    }, 16); // 约 120ms 淡出
  }

  togglePanel(tab) {
    if (this._closing) { this.showPanel(tab); return; }
    if (this.panel && this.panel.isVisible()) this.hidePanel();
    else this.showPanel(tab);
  }

  /* ---------------- 灵动岛收起（顶部线段）/ 展开 ---------------- */

  /** 收起为屏幕顶边的细线：窗口点击穿透，渲染端播放收起动画 */
  collapsePill() {
    if (!this.pill || this.pill.isDestroyed() || this.pillCollapsed) return;
    this.pillCollapsed = true;
    this._pillVisible = false;
    this.hidePanel(); // 胶囊收起时面板一并收起
    this.layout();    // 窗口贴到屏幕顶边
    try { this.pill.setIgnoreMouseEvents(true, { forward: true }); } catch { /* ignore */ }
    this.pill.webContents.send('pill:state', 'collapsed');
    this._notify();
  }

  /** 由线段展开为完整胶囊（悬停线段或托盘「显示灵动岛」触发） */
  expandPill() {
    if (!this.pill || this.pill.isDestroyed() || !this.pillCollapsed) return;
    this.pillCollapsed = false;
    this._pillVisible = true;
    try { this.pill.setIgnoreMouseEvents(false); } catch { /* ignore */ }
    this.layout();
    if (!this.pill.isVisible()) this.pill.showInactive();
    this.pill.webContents.send('pill:state', 'expanded');
    this._notify();
  }

  /** 托盘入口：true=显示（展开），false=隐藏（收起为线段） */
  setPillVisible(v) {
    if (v) this.expandPill();
    else this.collapsePill();
  }

  _notify() {
    if (typeof this.onPillStateChange === 'function') {
      try { this.onPillStateChange(); } catch { /* ignore */ }
    }
  }

  /** 向胶囊同步面板开关状态：面板打开时不进行空闲收起计时。
   *  面板窗口也接收同一事件：隐藏时暂停自定义背景视频（省 GPU/电量）。 */
  _notifyPanel(open) {
    for (const w of [this.pill, this.panel]) {
      if (!w) continue;
      try {
        if (!w.isDestroyed()) w.webContents.send('panel:state', !!open);
      } catch { /* ignore */ }
    }
  }

  /* 悬停纠偏看门狗：Windows 上透明无边框窗口指针快速移出时 WM_MOUSELEAVE 偶发丢失，
     渲染端拿不到 mouseleave，:hover 悬停效果会一直挂着。
     这里轮询光标位置，发现光标从胶囊窗口内→外就发 pill:hover-sync(false)，
     由渲染端强制清除悬停态（仅在跳变瞬间发一次，不重复刷 IPC）。 */
  startPillHoverWatch() {
    if (this._hoverWatch) return;
    this._cursorInPill = false;
    this._hoverWatch = setInterval(() => {
      const w = this.pill;
      if (!w || w.isDestroyed() || this.pillCollapsed || !w.isVisible()) return;
      const c = screen.getCursorScreenPoint();
      const b = w.getContentBounds();
      const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
      if (inside !== this._cursorInPill) {
        this._cursorInPill = inside;
        if (!inside) {
          try { w.webContents.send('pill:hover-sync', false); } catch { /* ignore */ }
        }
      }
    }, 300);
  }

  broadcast(channel, payload) {
    for (const w of [this.pill, this.panel]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }
}

module.exports = { Island, PILL_W, PILL_H, PANEL_W, PANEL_H };
