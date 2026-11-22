'use strict';
/**
 * 灵动岛窗口管理
 *  - 胶囊窗口：置顶小型悬浮条，不抢焦点，可拖放文件
 *      - 展开态：完整胶囊
 *      - 收起态：屏幕顶边一条细线（窗口点击穿透，鼠标悬停线段自动展开）
 *  - 面板窗口：胶囊下方展开的主面板（概览/查找/恢复/设置）
 *  - 面板始终为「点击面板外任意位置即收起」模式（blur → 隐藏）
 *  - 收起/展开的过渡动画由渲染端 CSS 完成，主进程只负责状态切换与命中区域
 *  - 置顶看门狗：Windows 偶发把置顶窗踢出顶层带，心跳检查发现丢失立即补回
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

// 悬停纠偏看门狗轮询间隔（按状态分档，见 startPillHoverWatch 注释）：
// 收起态唤回按停留判定（约一拍 60ms，快速扫过不触发）；展开态仅兜底丢
// mouseleave；窗口不可见时 1Hz 心跳（启动加载期），可见性恢复自动换挡。
const HOVER_POLL_COLLAPSED_MS = 60;
const HOVER_POLL_EXPANDED_MS = 200;
const HOVER_POLL_HIDDEN_MS = 1000;

class Island {
  constructor() {
    this.pill = null;
    this.panel = null;
    this.dialogOpen = false;
    this._pillVisible = true;     // true=展开显示 | false=收起为顶部线段（供托盘菜单判断）
    this.pillCollapsed = false;   // 当前是否处于线段收起态
    // 托盘菜单重建钩子（createTray 注入），状态切换后同步「隐藏/显示灵动岛」文案
    this.onPillStateChange = null;
    // 灵动岛水平位置（中心相对工作区宽度的比例）；main.js 启动时从外观设置注入
    this.pillX = 0.5;
    // 字体档位（0.85~1.3）：胶囊宽度按其等比伸缩；ipc.js 设置变更时同步
    this.fontScale = 1;
    // 收起态兜底唤回：光标进入命中区的停留计时起点（离开命中区即清零）
    this._peekEnterAt = 0;
    // 收起瞬间光标就停在命中区（自动收起/右键隐藏时光标未动）→ 抑制兜底展开，
    // 直到光标离开命中区才解除；否则会形成「原地开合」循环
    this._peekHold = false;
    // 最近一次 layout() 算出的胶囊缩放（DIP/CSS px），供命中区判定免重复布局计算
    this._pillScale = null;
    // 悬停纠偏看门狗（自适应轮询）：当前定时器句柄与生效间隔
    this._hoverWatch = null;
    this._hoverMs = null;
    // 拖动换位结束后的持久化钩子（main.js 注入：写设置 + 广播）
    this.onPillOffsetChange = null;
    this.panelSize = { w: BASE.panelW, h: BASE.panelH }; // 面板 CSS 视口尺寸（宽高独立，可细长 / 宽扁）
  }

  /** 按当前主显示器工作区算出胶囊/面板的尺寸、位置与 UI 缩放 */
  _plan() {
    const display = screen.getPrimaryDisplay();
    return computeIslandLayout(display.workArea, {
      panelW: this.panelSize.w,
      panelH: this.panelSize.h,
      collapsed: this.pillCollapsed,
      pillX: this.pillX,
      fontScale: this.fontScale,
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
    // 置顶看门狗：Windows 偶发踢掉置顶，发现丢失立即补回（见 ensureTopmost 注释）
    this.startTopmostWatch();
  }

  /** 面板尺寸变化 → 立即重新布局（宽高独立：可细长 / 宽扁） */
  /** 收起过渡进行中（窗口仍可见但正在淡出） */
  _closing = false;

  setPanelSize(size) {
    this.panelSize = normalizePanelSize(size, this.panelSize);
    this.layout();
  }

  /** 字体档位变化 → 胶囊宽度按档位等比伸缩并立即重排（0.85~1.3，非法值回退 1） */
  setPillFontScale(v) {
    const n = Number(v);
    this.fontScale = Number.isFinite(n) ? Math.min(1.3, Math.max(0.85, n)) : 1;
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
    this._pillScale = plan.pillScale;
    this._apply(this.pill, plan.pill, plan.pillScale);
    this._apply(this.panel, plan.panel, plan.panelScale);
    this.ensureTopmost(); // 尺寸/位置调整会惊动 z 序，顺手补一次置顶
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
    this.ensureTopmost();    // 激活面板会带动前后台切换，补一次置顶
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
    if (this._dragMoved) { this._dragMoved = false; return; } // 拖动结束的误触不算点击
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
    this._restartHoverWatch(); // 换挡到收起态 60ms（唤回判定需要）
    // 收起瞬间光标若就停在命中区（自动收起/右键隐藏时光标未动）→ 抑制兜底展开，
    // 防止「光标停在原地 → 自动收起 → 立刻自动展开」的原地开合循环
    this._peekHold = this._cursorInPeekZone();
    this._notify();
  }

  /** 由线段展开为完整胶囊（悬停线段或托盘「显示灵动岛」触发） */
  expandPill() {
    if (!this.pill || this.pill.isDestroyed() || !this.pillCollapsed) return;
    this.pillCollapsed = false;
    this._pillVisible = true;
    this._peekEnterAt = 0;
    this._peekHold = false;
    try { this.pill.setIgnoreMouseEvents(false); } catch { /* ignore */ }
    this.layout();
    if (!this.pill.isVisible()) this.pill.showInactive();
    this.pill.webContents.send('pill:state', 'expanded');
    this._restartHoverWatch(); // 换挡到展开态 200ms（仅兜底丢 mouseleave）
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

  /* 悬停纠偏看门狗（自适应轮询，模式切换在 tick 内自动换挡）：
     Windows 上透明无边框窗口指针快速移出时 WM_MOUSELEAVE 偶发丢失，
     渲染端拿不到 mouseleave，:hover 悬停效果会一直挂着。
     轮询光标位置，发现光标从胶囊窗口内→外就发 pill:hover-sync(false)，
     由渲染端强制清除悬停态（仅在跳变瞬间发一次，不重复刷 IPC）。

     收起态兜底：setIgnoreMouseEvents(forward:true) 的鼠标转发对前台窗口敏感
     （官方文档：前台窗口完整性级别更高时临时停发；实测点选桌面、焦点切换也会断），
     转发一断渲染端收不到 mousemove，线段永远唤不回。因此收起时改为光标轮询
     （60ms 间隔）：光标进入命中区停留约 60ms 才展开，快速扫过不触发；收起瞬间
     指针就停在命中区（自动收起/右键隐藏）则先离开再回来才允许展开，避免原地开合
     循环；右键隐藏后光标不离开线段区就绝不重新打开，与渲染端 hideGuard 同语义。

     后台开销：这是灵动岛常驻期间唯一的密集定时器，按状态分档——
     收起态 60ms（唤回判定需要）、展开态 200ms（仅兜底丢事件，正常悬停
     由渲染端 DOM 事件覆盖）；胶囊窗口不可见（启动加载期）降为 1Hz 心跳，
     只探测可见性恢复，恢复后自动换挡——不做完全停表，免得 show 路径
     漏挂重启钩子导致看门狗永久停摆。 */
  startPillHoverWatch() {
    this._cursorInPill = false;
    this._restartHoverWatch();
  }

  /** 当前应有的轮询间隔（不可见时 1Hz 心跳，仅探测恢复） */
  _hoverPollMs() {
    const w = this.pill;
    try {
      if (!w || w.isDestroyed() || !w.isVisible()) return HOVER_POLL_HIDDEN_MS;
    } catch { return HOVER_POLL_HIDDEN_MS; }
    return this.pillCollapsed ? HOVER_POLL_COLLAPSED_MS : HOVER_POLL_EXPANDED_MS;
  }

  /** 按当前状态换挡；间隔不变则什么都不做 */
  _restartHoverWatch() {
    const ms = this._hoverPollMs();
    if (this._hoverWatch && this._hoverMs === ms) return;
    if (this._hoverWatch) { clearInterval(this._hoverWatch); this._hoverWatch = null; }
    this._hoverMs = ms;
    this._hoverWatch = setInterval(() => {
      if (this._hoverPollMs() !== this._hoverMs) return this._restartHoverWatch(); // 状态切换：换挡
      this._hoverTick();
    }, ms);
  }

  _hoverTick() {
    const w = this.pill;
    if (!w || w.isDestroyed() || !w.isVisible()) return; // 下一 tick 由换挡检查接管
    if (this.pillCollapsed) {
      const inZone = this._cursorInPeekZone();
      if (!inZone) {
        this._peekEnterAt = 0;      // 离开命中区 → 停留计时清零，重新进入重新计时
        this._peekHold = false;     // 指针离开命中区 → 「收起时指针就在区内」保护解除
      } else if (this._peekHold) {
        // 收起瞬间指针就停在区内（自动收起/右键隐藏时光标未动）：必须先离开
        // 再回来才允许兜底展开，否则光标停在原地会形成「收起→展开→收起」循环
      } else if (!this._cursorInPill) {
        this._peekEnterAt = Date.now(); // 刚进入命中区，开始停留计时
      } else if (this._peekEnterAt && Date.now() - this._peekEnterAt >= 28) {
        this.expandPill();
      }
      this._cursorInPill = inZone;
      return;
    }
    let c, b;
    try {
      c = screen.getCursorScreenPoint();
      b = w.getContentBounds();
    } catch { return; }
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    if (inside !== this._cursorInPill) {
      this._cursorInPill = inside;
      if (!inside) {
        try { w.webContents.send('pill:hover-sync', false); } catch { /* ignore */ }
      }
    }
  }

  /** 光标是否处于收起态线段命中区（与渲染端 peek 区一致：窗口中心 ±60、y≤6 CSS px，
   *  即可见线段 120×4 的范围；窗口 DIP 尺寸 = CSS × pillScale） */
  _cursorInPeekZone() {
    const w = this.pill;
    if (!w || w.isDestroyed() || !w.isVisible()) return false;
    try {
      const c = screen.getCursorScreenPoint();
      const b = w.getContentBounds();
      const s = this._pillScale != null ? this._pillScale : this._plan().pillScale;
      return Math.abs(c.x - (b.x + b.width / 2)) <= 60 * s
        && c.y >= b.y && c.y <= b.y + 6 * s;
    } catch { return false; }
  }

  /* ---------------- 置顶看门狗 ----------------
   * Win11（24H2/25H2 实测）会冲乱置顶窗的 z 序，有两种坏法：
   *   1. 样式位被踢：WS_EX_TOPMOST 丢失 → isAlwaysOnTop() 为 false，可检测，
   *      setAlwaysOnTop 补回即可（原生对话框关闭、前后台切换等时机高发）；
   *   2. 样式位还在、z 序却被压到后激活的窗口（哪怕是普通窗）之下——胶囊
   *      focusable:false 无法靠被激活爬回来，且 isAlwaysOnTop() 对此是盲的。
   *   隔离实验验证：moveTop() 能把被压的置顶窗抬回带顶，不改样式位、不抢
   *   焦点，效果稳定；「先摘再戴 setAlwaysOnTop(false→true)」反而引起带内
   *   扰动。应用自身只在 create() 设置过一次置顶，不存在「故意关掉」的路径，
   *   所以无脑补抬总是正确的。
   * 心跳 600ms：实测沉底在窗口激活后 ~1s 内发生，600ms 保证最坏被压半秒级；
   * moveTop 每窗每次一条原生 SetWindowPos，两窗合计 ~3 次/秒，远低于收起态
   * 60ms 悬停轮询，开销可忽略。 */

  /** 补回置顶：样式位丢了 → setAlwaysOnTop 重设（顺带抬回带顶）；
   *  样式位在 → moveTop 把 z 序抬回带顶（不动样式、不抢焦点） */
  ensureTopmost() {
    for (const w of [this.pill, this.panel]) {
      if (!w || isGone(w) || typeof w.isAlwaysOnTop !== 'function') continue;
      try {
        if (!w.isVisible()) continue;
        if (!w.isAlwaysOnTop()) {
          w.setAlwaysOnTop(true, 'screen-saver');
        } else if (typeof w.moveTop === 'function') {
          w.moveTop();
        }
      } catch { /* ignore */ }
    }
  }

  /** 心跳兜底：覆盖无明确时机的偶发沉底（前后台切换 / DPI 事件 / 全屏进出等） */
  startTopmostWatch() {
    if (this._topmostWatch) return;
    this._topmostWatch = setInterval(() => this.ensureTopmost(), 600);
  }

  /* ---------------- 灵动岛拖动换位 ----------------
   * 渲染端 mousedown → startPillDrag()：主进程 16ms 轮询光标并 setPosition，
   * 窗口跟随光标水平移动（Y 恒贴屏幕顶边）。mouseup → stopPillDrag()：
   * 停轮询、把最终比例经 onPillOffsetChange 持久化，并让面板跟随到新位置。
   * 拖动过的下一次 onPillClick 会被吞掉，避免松手误开面板。 */

  /** 拖动中实时更新的水平比例（0~1），layout() / _plan() 都用它定位 */
  _dragStep() {
    const d = this._drag;
    const w = this.pill;
    if (!d || !w || w.isDestroyed()) return this.stopPillDrag();
    // 兜底：渲染端 mouseup 丢失（如指针被系统弹窗截走）时 15s 后自动结束拖动
    if (Date.now() - d.startedAt > 15000) return this.stopPillDrag();
    try {
      const c = screen.getCursorScreenPoint();
      if (Math.abs(c.x - d.startCursorX) > 4) d.moved = true;
      const wa = screen.getPrimaryDisplay().workArea;
      const b = w.getBounds();
      const nx = Math.min(wa.x + wa.width - b.width,
        Math.max(wa.x, c.x - d.offsetX));
      if (nx !== b.x) w.setPosition(nx, b.y);
      // 比例按「钳制后的中心」计算：贴边时比例就是 0/1，持久化与布局严格一致
      this.pillX = Math.round(((nx + b.width / 2 - wa.x) / wa.width) * 1000) / 1000;
    } catch { this.stopPillDrag(); }
  }

  startPillDrag() {
    if (!this.pill || this.pill.isDestroyed() || this.pillCollapsed) return false;
    try {
      const c = screen.getCursorScreenPoint();
      const b = this.pill.getBounds();
      this._drag = {
        offsetX: c.x - b.x,       // 光标相对胶囊左缘的偏移：拖动中保持不跳变
        startCursorX: c.x,
        moved: false,
        startedAt: Date.now(),
      };
      if (!this._dragTimer) this._dragTimer = setInterval(() => this._dragStep(), 16);
      return true;
    } catch { return false; }
  }

  stopPillDrag() {
    if (this._dragTimer) { clearInterval(this._dragTimer); this._dragTimer = null; }
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (d.moved) {
      this._dragMoved = true; // 下一次 onPillClick 吞掉（400ms 内没来也自动清）
      setTimeout(() => { this._dragMoved = false; }, 400);
      this.layout();          // 面板跟随到新位置（比例已在 _dragStep 实时更新）
      if (typeof this.onPillOffsetChange === 'function') {
        try { this.onPillOffsetChange(this.pillX); } catch { /* ignore */ }
      }
    }
  }

  /** 恢复默认位置（顶部居中）：托盘菜单与外观页按钮共用入口 */
  resetPillPosition() {
    this.pillX = 0.5;
    if (!this.pill || this.pill.isDestroyed() || this.pillCollapsed) return;
    this.layout();
    if (typeof this.onPillOffsetChange === 'function') {
      try { this.onPillOffsetChange(0.5); } catch { /* ignore */ }
    }
  }

  broadcast(channel, payload) {
    for (const w of [this.pill, this.panel]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }
}

module.exports = { Island, PILL_W, PILL_H, PANEL_W, PANEL_H };
