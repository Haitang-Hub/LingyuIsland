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

const PILL_W = 372, PILL_H = 52;
const PANEL_W = 560, PANEL_H = 700;

class Island {
  constructor() {
    this.pill = null;
    this.panel = null;
    this.dialogOpen = false;
    this._pillVisible = true;     // true=展开显示 | false=收起为顶部线段（供托盘菜单判断）
    this.pillCollapsed = false;   // 当前是否处于线段收起态
    // 托盘菜单重建钩子（createTray 注入），状态切换后同步「隐藏/显示灵动岛」文案
    this.onPillStateChange = null;
  }

  create() {
    const { workArea } = screen.getPrimaryDisplay();

    this.pill = new BrowserWindow({
      width: PILL_W, height: PILL_H,
      x: Math.round(workArea.x + (workArea.width - PILL_W) / 2),
      y: workArea.y + 6,
      frame: false, transparent: true, resizable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false,
      hasShadow: false, show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    this.pill.setAlwaysOnTop(true, 'screen-saver');
    this.pill.loadFile(path.join(__dirname, '..', 'renderer', 'pill.html'));

    this.panel = new BrowserWindow({
      width: PANEL_W, height: PANEL_H,
      x: Math.round(workArea.x + (workArea.width - PANEL_W) / 2),
      y: workArea.y + 6 + PILL_H + 4,
      frame: false, transparent: true, resizable: false,
      alwaysOnTop: true, skipTaskbar: true,
      hasShadow: false, show: false,
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
    }

    // 显示器/任务栏变化时重新布局
    screen.on('display-metrics-changed', () => this.layout());
    // macOS：灵动岛跨所有桌面空间与全屏应用可见
    if (process.platform === 'darwin') {
      for (const w of [this.pill, this.panel]) {
        w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
    }
  }

  /** 胶囊窗口的 y 坐标：展开态留 6px 给阴影；收起态线段贴住屏幕顶边 */
  _pillY() {
    const { workArea } = screen.getPrimaryDisplay();
    return this.pillCollapsed ? workArea.y : workArea.y + 6;
  }

  layout() {
    const { workArea } = screen.getPrimaryDisplay();
    if (this.pill && !this.pill.isDestroyed()) {
      this.pill.setPosition(Math.round(workArea.x + (workArea.width - PILL_W) / 2), this._pillY());
    }
    if (this.panel && !this.panel.isDestroyed()) {
      this.panel.setPosition(
        Math.round(workArea.x + (workArea.width - PANEL_W) / 2),
        Math.min(workArea.y + 6 + PILL_H + 4, workArea.y + workArea.height - PANEL_H)
      );
    }
  }

  showPanel(tab) {
    if (!this.panel) return;
    this.layout();
    if (tab) this.panel.webContents.send('panel:show-tab', tab);
    // 面板始终为「点击外部即收起」模式：必须激活窗口，blur 才会触发
    this.panel.show();
    this.panel.focus();
    this._notifyPanel(true); // 面板打开期间胶囊暂停空闲收起计时
  }

  /** 胶囊在面板之外，点击它也应视为「点击外部」而收起 */
  onPillClick(tab) {
    if (this.panel && this.panel.isVisible()) this.hidePanel();
    else this.showPanel(tab);
  }

  hidePanel() {
    if (this.panel && this.panel.isVisible()) {
      this.panel.hide();
      this._notifyPanel(false); // 面板关闭后胶囊恢复空闲计时
    }
  }

  togglePanel(tab) {
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

  /** 向胶囊同步面板开关状态：面板打开时不进行空闲收起计时 */
  _notifyPanel(open) {
    if (this.pill && !this.pill.isDestroyed()) {
      this.pill.webContents.send('panel:state', !!open);
    }
  }

  broadcast(channel, payload) {
    for (const w of [this.pill, this.panel]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }
}

module.exports = { Island, PILL_W, PILL_H, PANEL_W, PANEL_H };
