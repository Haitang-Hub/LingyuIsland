'use strict';
/* 灵屿岛胶囊逻辑：状态切换、拖放屏蔽、剪贴板一键恢复 */

const pill = document.getElementById('pill');
const dot = document.getElementById('dot');
const labelIdle = document.getElementById('labelIdle');
const labelHover = document.getElementById('labelHover');
const clipChip = document.getElementById('clipChip');
const clipClose = document.getElementById('clipClose');
const clipText = document.getElementById('clipText');

let mode = 'idle'; // idle | clip | busy
let maskedCount = 0;

function setState(next) {
  mode = next;
  pill.classList.remove('clip', 'busy', 'ok', 'err');
  if (next === 'clip') pill.classList.add('clip');
  if (next === 'busy') pill.classList.add('busy');
  if (next !== 'busy') stopBusyHints(); // 离开忙碌 → 轮换提示立即停止
  resetIdleTimer(); // 状态变化视为一次活动，空闲计时重新开始
  updateFace();
}

/* ---------------- 右侧小家伙（极简双眼 · 会走动会看人会挤边） ---------------- */

const face = document.getElementById('face');
const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
let cheering = false;   // 成功欢呼期间，状态表情让位给 happy
let hovering = false;   // 光标是否停在胶囊上

/** 当前情绪：状态优先，空闲时按文案内容给表情（聊天感：读完一句话给出反应） */
function faceMood() {
  if (cheering) return 'happy';
  if (mode === 'busy') return 'busy';
  if (pill.classList.contains('drag')) return 'press';
  if (mode === 'clip') return 'surprise';
  const t = labelIdle.textContent || '';
  // 关键词顺序即优先级：困倦 > 好奇 > 害羞 > 惬意 > 沉思 > 温暖 > 默认。
  // 改文案池时保证每组文案带上本组关键词，且不要撞上更高优先级的词。
  if (/夜深|困|眯一会儿|睡|晚安|放心睡|打盹|熬夜|没睡/.test(t)) return 'sleepy';
  if (hovering) return 'curious'; // 光标来了 → 好奇地歪头看
  if (/摸摸头|可爱|夸我|很好|第一顺位|认真生活|自责|尽力|做得够多|偏爱/.test(t)) return 'shy';   // 被夸 / 被偏爱而害羞
  if (/阳光|晒|发呆|安静|晚霞|惬意|有光/.test(t)) return 'content';                        // 惬意眯起
  if (/别急|一件一件|深呼吸|烦恼|想不通|思路|最难|寄存|放一放/.test(t)) return 'think';  // 低头沉思
  if (/辛苦|撑|扛|一个人|不催|歇|关照|安心|明天|机会|喝水|陪/.test(t)) return 'warm';    // 被温柔关照
  return 'idle';
}

function setMood(mood) {
  if (face.dataset.mood === mood) return;
  face.dataset.mood = mood;
}

function updateFace() {
  setMood(faceMood());
}

/* 聊天式反应：文案变化前先「瞟向文字」，读完再按内容换表情 */
let glanceTimer = null;
function glanceAtText() {
  if (reduceMotion) { updateFace(); return; }
  face.style.setProperty('--face-x', '-11px'); // 走向左边看新消息
  face.style.setProperty('--face-y', '-1.5px'); // 微微抬头
  clearTimeout(glanceTimer);
  glanceTimer = setTimeout(() => {
    face.style.setProperty('--face-x', '0px'); // 回到房间中央
    face.style.setProperty('--face-y', '0px');
    updateFace();
  }, 560);
}

/** 单次类名动画（表情层）：强制重排以便同一动画可连续触发 */
function faceOnce(cls, ms) {
  face.classList.remove(cls);
  void face.offsetWidth;
  face.classList.add(cls);
  setTimeout(() => face.classList.remove(cls), ms);
}

/** 点头「收到」 */
function faceNod() {
  if (!reduceMotion) faceOnce('nod', 500);
}

/** 摇头「不行哦」 */
function faceShake() {
  if (!reduceMotion) faceOnce('shake', 480);
}

/* 眨眼循环：2.6–5.2 秒随机一次；happy/sleepy 本身闭眼不眨 */
(function blinkLoop() {
  setTimeout(() => {
    const mood = face.dataset.mood;
    if (!reduceMotion && mood !== 'happy' && mood !== 'sleepy') {
      face.classList.add('blink');
      setTimeout(() => face.classList.remove('blink'), 150);
    }
    blinkLoop();
  }, 2600 + Math.random() * 2600);
})();

/* 走动循环：空闲时在右侧房间里二维溜达（上下左右 + 偶尔歪头），有光标时不抢戏 */
(function wanderLoop() {
  setTimeout(() => {
    const mood = face.dataset.mood;
    if (!reduceMotion && !hovering
        && (mood === 'idle' || mood === 'warm' || mood === 'content' || mood === 'think')) {
      face.style.setProperty('--face-x', (Math.random() * 13 - 8).toFixed(1) + 'px');
      face.style.setProperty('--face-y', (Math.random() * 3.4 - 1.7).toFixed(1) + 'px');
      face.style.setProperty('--tilt', (Math.random() * 8 - 4).toFixed(1) + 'deg');
    }
    wanderLoop();
  }, 5200 + Math.random() * 4200);
})();

/* 单眼 wink：每隔 7–14 秒调皮地眨一只眼 */
(function winkLoop() {
  setTimeout(() => {
    const mood = face.dataset.mood;
    if (!reduceMotion
        && (mood === 'idle' || mood === 'warm' || mood === 'curious' || mood === 'content')) {
      faceOnce(Math.random() < 0.5 ? 'wink-l' : 'wink-r', 190);
    }
    winkLoop();
  }, 7000 + Math.random() * 7000);
})();

/* 空闲文案池：随机轮换的「情绪价值」文案
   基调是「有梗、有料、贫嘴」——冷知识 / 小吐槽 / 桌宠式互动为主，温柔话只做点缀。
   每行控制在 16 个全角字位内（会被 clampText 截断，超宽即丢字）；
   每行末尾是它触发的表情情绪：改文案时保证带上本组关键词，且不要撞上更高优先级的词
   （困/睡→sleepy，可爱/夸/摸摸头→shy，晒/光→content，别急/寄存/烦恼→think，歇/喝水/撑→warm）。 */
const MOOD_LINES = [
  // 桌宠式贫嘴：像住在屏幕顶上的小家伙
  '戳一下，灵感 +1',
  '小本本记着呢：今天已被戳 3 次',
  '再戳我就更可爱给你看',        // shy（可爱）
  '今日可爱指标已超标',          // shy（可爱）
  '夸我一句就忘掉你的小秘密',    // shy（夸）
  '点我不会变有钱，但会有我',
  // 冷知识：有趣有料，顺带劝睡劝晒
  '章鱼三个心脏，省着点用',
  '蜂蜜不会过期，困意会',        // sleepy（困）
  '猫一天睡16小时，你欠的觉呢',  // sleepy（睡）
  '海獭睡觉会牵手，怕漂散',      // sleepy（睡）
  '香蕉是浆果，草莓不是',
  '晒太阳补维 D，比咖啡温柔',    // content（晒）
  // 小机灵 / 伪哲学
  '我不内耗，我只耗电',
  '进度条没动，在攒大招',
  '拖延是给灵感让路',
  '摸鱼是战略性喘气',
  '我不焦虑，只焦虑别人',
  // 打工人吐槽：扎心但轻
  '这个会，本可以是一封邮件',
  '屏幕时间太长？它管得真宽',
  '周报文学：稳步推进',
  '元气满满地……先歇十分钟',      // warm（歇）
  // 温柔点缀：保留少数，配比「有趣为主、偶尔软一下」
  '摸摸头，今天也辛苦了',        // shy
  '记得喝水，顺便看看远处',      // warm（喝水）
  '窗前有光，就去晒一会儿',      // content（晒）
  '困了就眯一会儿，天塌不了',    // sleepy
  '别急，一件一件来',            // think
  '烦恼先寄存在我这儿',          // think
];

/** 按当前时段挑一句应景的话（每个时段多条，随机取一） */
function timeMoodLine() {
  const h = new Date().getHours();
  let pool;
  if (h >= 5 && h < 9) {
    pool = ['早安，虫就留给别人吧', '起床成功，难度已调至简单', '闹钟阵亡，你从被窝凯旋'];
  } else if (h < 11) {
    pool = ['上午适合攻坚，也适合摸鱼', '上午的咖啡，下班前才生效', '开机成功，假装努力加载中'];
  } else if (h < 13) {
    pool = ['干饭要紧，KPI 不会跑', '午饭选难吃的，下午不恋战', '干饭人干饭魂，先吃再说'];
  } else if (h < 16) {
    pool = ['下午三点，人体电量不足', '困意常驻，请它眯会儿', '这个点撑住，下班还有很久'];
  } else if (h < 19) {
    pool = ['摸鱼额度即将清零', '傍晚的风免费，错过再等', '收工前最后一战：假装很忙'];
  } else if (h < 22) {
    pool = ['晚上适合复盘，也适合摆烂', '「马上就好」是最大谎言', '晚上的你效率惊人——点外卖'];
  } else if (h < 24) {
    pool = ['熬夜冠军是你，奖品黑眼圈', '手机该睡了，它比你累', '再刷五分钟——第五遍了'];
  } else {
    pool = ['凌晨，你和被窝总有一个硬撑', '这个点醒着的，都是叛逆者'];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/* 周末彩蛋：周六日随机追加一句 */
const WEEKEND_LINES = [
  '周末的快乐，从不起床开始',
  '今日目标：把沙发坐出包浆',
  '周末不谈工作，谈饭',
  '躺平进行时，请勿打扰',
  '周末机密：其实啥也没打算干',
];

const IDLE_LINES = () => {
  const lines = [...MOOD_LINES, timeMoodLine()];
  const day = new Date().getDay();
  if (day === 0 || day === 6) {
    lines.push(WEEKEND_LINES[Math.floor(Math.random() * WEEKEND_LINES.length)]);
  }
  if (maskedCount > 0) lines.push(`悄悄守护着 ${maskedCount} 份文件`);
  // 保留一句功能提示，避免新用户不知道可以拖文件进来
  lines.push('把文件丢给我，我来屏蔽');
  return lines;
};

let lastLine = '';
function pickIdleLine() {
  const pool = IDLE_LINES();
  let line = pool[Math.floor(Math.random() * pool.length)];
  let guard = 0;
  while (line === lastLine && pool.length > 1 && guard++ < 8) {
    line = pool[Math.floor(Math.random() * pool.length)];
  }
  lastLine = line;
  return line;
}

function refreshIdleLabel() {
  if (mode === 'busy') return;
  if (!clipChip.hidden) return;
  // 反馈文案持有期内：只回显持有内容，绝不让闲聊文案/悬停文案顶掉
  if (holdActive()) {
    if (feedbackHold.cls) pill.classList.add(feedbackHold.cls);
    labelIdle.textContent = feedbackHold.text;
    return;
  }
  const applyLine = () => {
    labelIdle.textContent = clampText(pickIdleLine());
    fxOnce('swap', 420); // 轻轻浮入，避免生硬跳变
    updateFace();        // 读完新消息 → 按内容给出表情反应
    faceNod();           // 轻轻点头「收到」
  };
  if (reduceMotion) { applyLine(); return; }
  // 聊天感：小家伙先凑到文字边上看，消息浮现，然后回到房间中央并给反应
  face.style.setProperty('--face-x', '-11px');
  clearTimeout(glanceTimer);
  glanceTimer = setTimeout(() => {
    applyLine();
    face.style.setProperty('--face-x', '0px');
  }, 420);
}

/* 空闲时随机轮换文案（12–20 秒一次），忙碌/剪贴板提示/反馈期间不打扰 */
function scheduleIdleRotate() {
  setTimeout(() => {
    if (mode === 'idle' && clipChip.hidden
        && !document.body.classList.contains('collapsed')
        && !holdActive()
        && !pill.classList.contains('hover')) {
      refreshIdleLabel();
    }
    scheduleIdleRotate();
  }, 12000 + Math.floor(Math.random() * 8000));
}
scheduleIdleRotate();

/* ---------------- 外观：主题 / 强调色 / 透明度 / 圆角 / 动效 ---------------- */

const THEMES_API = window.IslandThemes || { normalizeTheme: (v) => v || 'midnight' };

/** 浅色主题：自定义强调色的派生文字色往黑调（与 pill.css 各浅色主题块一致） */
const LIGHT_THEMES = new Set(['mauve', 'lavender', 'cloud', 'sakura']);

/** 与面板同一套 CSS 变量（胶囊侧只用到其中与胶囊相关的部分） */
function applyPillAppearance(a) {
  if (!a) return;
  const root = document.documentElement;
  const themeId = THEMES_API.normalizeTheme(a.theme);
  root.dataset.theme = themeId;
  // 面板的动效开关不作用于胶囊：表情与呼吸属于岛自己的状态反馈
  root.style.setProperty('--island-alpha', String(Math.min(1, Math.max(0.55, Number(a.alpha) || 1))));
  const r = Math.round(Math.min(22, Math.max(10, Number(a.radius) || 18)));
  root.style.setProperty('--pill-radius', Math.min(22, r + 4) + 'px');
  // 字体大小：与面板同一策略——标准及以上只缩文字（--font-scale），
  // 「小」档整面 zoom 等比压缩（zoom 已含文字缩放，--font-scale 固定 1 防双重缩放）
  const fs = Math.min(1.3, Math.max(0.85, Number(a.fontScale) || 1));
  if (fs < 1) {
    root.style.zoom = String(fs);
    root.style.setProperty('--font-scale', '1');
  } else {
    root.style.removeProperty('zoom');
    root.style.setProperty('--font-scale', String(fs));
  }
  // 自定义强调色：文字色与表情眼色从强调色派生（面板的 --accent-text 同款公式）。
  // 深色主题往白调、浅色主题往黑调，保证任何自定义色都读得清。
  if (a.accent) {
    const tint = LIGHT_THEMES.has(themeId) ? '#000000' : '#ffffff';
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--accent-text', `color-mix(in srgb, ${a.accent} 68%, ${tint})`);
    root.style.setProperty('--accent-text-strong', `color-mix(in srgb, ${a.accent} 45%, ${tint})`);
    root.style.setProperty('--face', a.accent);
  } else {
    // 未自定义时交还给主题覆盖块的颜色
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-text');
    root.style.removeProperty('--accent-text-strong');
    root.style.removeProperty('--face');
  }
  // 磨砂质感（界面内模拟，与面板同源）
  root.classList.toggle('glass-weak', a.glass === 'auto');
  root.classList.toggle('glass-on', a.glass === 'on');
}

/* ---------------- 设置变更：主题 / 强调色 / 透明度 / 自动收起实时同步 ---------------- */
window.island.on('settings:changed', async () => {
  try {
    const st = await window.island.invoke('settings:get');
    autoCollapse = !!st.settings.autoCollapse;
    collapseDelaySec = Number(st.settings.autoCollapseDelay) || 20;
    applyPillAppearance(st.settings.appearance);
    refreshIdleLabel();
    resetIdleTimer();
  } catch { /* 启动竞态时下一次广播会补上 */ }
});

/* ---------------- 初始化 ---------------- */

(async () => {
  try {
    const hist = await window.island.invoke('history:list');
    maskedCount = hist.length;
    refreshIdleLabel();
  } catch { /* ignore */ }
  try {
    const st = await window.island.invoke('settings:get');
    autoCollapse = !!st.settings.autoCollapse;
    collapseDelaySec = Number(st.settings.autoCollapseDelay) || 20;
    applyPillAppearance(st.settings.appearance);
    // 主进程已处于收起态（如启动前托盘隐藏）→ 直接渲染线段
    if (st.pillCollapsed) applyPillState('collapsed');
    resetIdleTimer();
  } catch { /* ignore */ }
  updateFace();
})();

/* ---------------- 点击 ---------------- */

// 胶囊本身只负责展开面板；还原操作只由右侧「还原文本」按钮触发
pill.addEventListener('click', () => {
  window.island.invoke('pill:expand');
});

/* ---------------- 拖动换位 ----------------
 * 按住胶囊水平拖动（始终贴屏幕顶边）：mousedown 请求主进程开始光标跟随，
 * mouseup 结束并持久化位置。窗口跟着光标走，位移判定在主进程；
 * 拖动结束的那次 click 会被主进程吞掉，不会误开面板。 */

let pillDragging = false; // 拖动进行中：抑制磁吸跟随，光标换成「抓手」

pill.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;                                  // 只响应左键
  if (document.body.classList.contains('collapsed')) return;   // 收起态不可拖
  // 「还原文本」chip 与关闭按钮上不启动拖动，保证点击可用
  if (!clipChip.hidden && (e.target === clipChip || clipChip.contains(e.target))) return;
  if (e.target === clipClose || clipClose.contains(e.target)) return;
  pillDragging = true;
  pill.classList.add('dragging');
  window.island.invoke('pill:drag-start');
});

window.addEventListener('mouseup', () => {
  if (!pillDragging) return;
  pillDragging = false;
  pill.classList.remove('dragging');
  window.island.invoke('pill:drag-end');
});

/* ---------------- 右键隐藏 ---------------- */

// 右键 = 收起为顶部线段（与托盘「隐藏灵动岛」一致），并阻止 Chromium 原生右键菜单。
// 隐藏瞬间指针往往还停在胶囊原位置（可能落在线段命中区）；设右键隐藏保护：
// 指针离开线段命中区一次后才允许「悬停唤回」，避免隐藏后原地又弹开。
let hideGuard = false;

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (document.body.classList.contains('collapsed')) return; // 已隐藏，不重复请求
  hideGuard = true;
  window.island.invoke('pill:hide');
});

function leaveClip() {
  clipChip.hidden = true;
  clipChip.disabled = false;
  clipClose.hidden = true;
  dot.classList.remove('clip');
}

/* 取消还原提示：回到空闲状态（并不清除剪贴板，只是关闭这次提醒） */
function dismissClip() {
  leaveClip();
  setState('idle');
  refreshIdleLabel();
}

/* ---------------- 文字宽度预算 ----------------
 * 胶囊文字区实测容量：标准字号约 18.7 个全角字（窗口 372 − 内边距/点/表情 138，
 * 字号 12.5px；大小字号档位经 zoom/窗口同步缩放后容量基本不变，小字档略紧）。
 * 统一预算 16 个全角位（半角字母/数字算半个）留出字体度量余量，
 * 超出一律在此截断加「…」，避免出现截图里「（产物为 _屏蔽，不」式硬裁。 */

const LABEL_MAX_UNITS = 16;

/** 显示宽度估算：全角/宽字符 = 1，ASCII 半角 = 0.5 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += ch.codePointAt(0) >= 0x80 ? 1 : 0.5;
  }
  return w;
}

/** 超预算截断（含 1 位省略号） */
function clampText(text, maxUnits = LABEL_MAX_UNITS) {
  const s = String(text);
  if (dispWidth(s) <= maxUnits) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = ch.codePointAt(0) >= 0x80 ? 1 : 0.5;
    if (w + cw > maxUnits - 1) return out + '…';
    w += cw;
    out += ch;
  }
  return s;
}

function setBusy(text, poolKey) {
  if (mode !== 'busy') busySince = Date.now(); // 用时从本轮忙碌开始累计
  setState('busy');
  stopBusyHints();
  labelIdle.textContent = clampText(text);
  glanceAtText(); // 看向进度文字
  // 用时每秒跳一次；阶段文案（带文件名）不带后缀，避免把进度信息挤出胶囊
  busyTickTimer = setInterval(renderBusyHint, 1000);
  // 同一提示停留超过 4 秒（单文件内部 OCR/逐页重绘等静默长耗时）→ 开始轮换安抚提示
  busyTimer = setTimeout(() => rotateBusyHint(poolKey || 'generic'), BUSY_HOLD_MS);
}

/* ---------------- 忙碌状态：防卡住的轮换提示 ----------------
 * 主进程只在阶段切换时广播（识别/转换/逐文件），单个文件内部的
 * OCR、逐页重绘等长耗时阶段是静默的。同一提示停留超过 BUSY_HOLD_MS
 * 就开始轮换阶段相关的安抚提示（附带累计用时），让人知道没有卡住。 */

const BUSY_HOLD_MS = 4000;   // 停留多久后开始轮换
const BUSY_ROTATE_MS = 3500; // 轮换间隔

let busySince = 0;  // 本轮忙碌开始时刻（「已用 X 秒」按它累计）
let busyTimer = 0;  // 文案轮换定时器
let busyTickTimer = 0; // 用时每秒刷新定时器（文案不换，只跳秒）
let currentHintLine = ''; // 当前轮换到的正文，供每秒重绘后缀
let lastHint = '';

/* 忙碌提示是小家伙「边干活边自言自语」：正文 ≤10 字位，
   加上「（已 X 秒）」后缀 ≈6 字位，整行卡进 16 位预算 */
const BUSY_HINTS = {
  identify: [
    '让我先翻一翻',
    '嗅嗅哪里有敏感信息',
    '一份一份来，不急',
  ],
  convert: [
    '老 .doc 要先变身',
    '借 Word 的力转换中',
  ],
  scan: [
    '逐段排查敏感信息',
    'OCR 认字中，稍慢',
    '一页一页认真看',
  ],
  restore: [
    '按编码找回原文',
    '对上号就能复原',
  ],
  generic: [
    '在呢在呢，没卡住',
    '这步急不来，值当',
    '快了，在收尾了',
  ],
};

function elapsedText() {
  const s = Math.max(0, Math.floor((Date.now() - busySince) / 1000));
  // 始终按秒累计，不切分钟档：秒数每秒都在跳，一眼能看出还在干活。
  // 「（已 N 秒）」后缀最多约 6.5 个全角字位（N 到四位数时），仍在预算内。
  return `${s} 秒`;
}

/** 统一渲染轮换提示：正文每秒不变，只把用时后缀往前推 */
function renderBusyHint() {
  if (!currentHintLine) return;
  labelIdle.textContent = clampText(`${currentHintLine}（已 ${elapsedText()}）`);
}

/** 文案轻滑浮入（与空闲轮换同款动画） */
function swapLabel() {
  pill.classList.remove('swap');
  void pill.offsetWidth;
  pill.classList.add('swap');
  setTimeout(() => pill.classList.remove('swap'), 460);
}

function rotateBusyHint(poolKey) {
  const pool = [...(BUSY_HINTS[poolKey] || []), ...BUSY_HINTS.generic];
  let line = pool[Math.floor(Math.random() * pool.length)];
  let guard = 0;
  while (line === lastHint && pool.length > 1 && guard++ < 8) {
    line = pool[Math.floor(Math.random() * pool.length)];
  }
  lastHint = line;
  currentHintLine = line;
  // 正文 ≤10 字位 + 后缀按秒累计（最多约 6.5 字位），卡进 16 位预算（超了也会被 clampText 兜底）
  renderBusyHint();
  swapLabel();
  glanceAtText();
  busyTimer = setTimeout(() => rotateBusyHint(poolKey), BUSY_ROTATE_MS);
}

function stopBusyHints() {
  clearTimeout(busyTimer);
  clearInterval(busyTickTimer);
  busyTimer = 0;
  busyTickTimer = 0;
  currentHintLine = '';
  lastHint = '';
}

/* ---------------- 冲击波速度：随实际进度加速 ----------------
 * 绿色光波；不定长阶段固定 2s 一波；逐文件阶段按 i/total 缩短周期
   （2s → 1.1s），越接近完成冲击越快，给人「正在冲向终点」的推进感 */

function setWaveSpeed(pct) {
  if (pct == null) {
    pill.style.setProperty('--wave-dur', '2s');
  } else {
    const p = Math.min(1, Math.max(0, Number(pct) || 0));
    pill.style.setProperty('--wave-dur', (2 - p * 0.9).toFixed(2) + 's');
  }
}

/** 取文件名并截断，供进度行展示（路径分隔符兼容 \ 与 /） */
function shortName(p) {
  const base = String(p || '').split(/[\\/]/).pop().trim();
  if (!base) return '';
  return base.length > 16 ? base.slice(0, 15) + '…' : base;
}

// 结果反馈持有期：悬停/轮换/主进程广播都不抢；批量结果按行轮播。
let feedbackHold = null; // { lines, index, until, timer, rotateTimer, fadeTimer, text, cls }

function clearFeedbackTimers() {
  if (!feedbackHold) return;
  clearTimeout(feedbackHold.timer);
  if (feedbackHold.rotateTimer) clearInterval(feedbackHold.rotateTimer);
  if (feedbackHold.fadeTimer) clearTimeout(feedbackHold.fadeTimer);
  feedbackHold = null;
}

function holdActive() { return !!(feedbackHold && Date.now() < feedbackHold.until); }

/** 应用一行反馈：颜色、文案（超预算截断）、轻滑动画 */
function applyHoldLine(line) {
  pill.classList.remove('ok', 'err');
  if (line.tone) pill.classList.add(line.tone);
  labelIdle.textContent = clampText(line.text);
  if (feedbackHold && feedbackHold.fadeTimer) clearTimeout(feedbackHold.fadeTimer);
  pill.classList.remove('swap');
  void pill.offsetWidth; // 强制重排：连续轮播时动画可重复触发
  pill.classList.add('swap');
  if (feedbackHold) {
    feedbackHold.fadeTimer = setTimeout(() => pill.classList.remove('swap'), 460);
  }
  updateFace();
}

/**
 * 按行轮播结果。单行时退化为原来的 showHold 行为。
 * 不用 native title：悬停弹窗会挡住胶囊，信息全部放在轮播行里。
 */
function showHoldSequence(lines, ms) {
  clearFeedbackTimers();
  if (!lines || !lines.length) return;
  const state = {
    lines, index: 0, until: Date.now() + ms,
    text: lines[0].text, cls: lines[0].tone,
    timer: 0, rotateTimer: 0, fadeTimer: 0,
  };
  feedbackHold = state;
  resetIdleTimer();
  applyHoldLine(lines[0]);
  if (lines.length > 1) {
    const step = Math.max(900, Math.floor(ms / lines.length));
    state.rotateTimer = setInterval(() => {
      if (!holdActive()) return;
      state.index = (state.index + 1) % state.lines.length;
      const line = state.lines[state.index];
      state.text = line.text;
      state.cls = line.tone;
      applyHoldLine(line);
    }, step);
  }
  state.timer = setTimeout(() => {
    clearFeedbackTimers();
    pill.classList.remove('ok', 'err', 'swap');
    refreshIdleLabel();
  }, ms);
}

function showHold(text, cls, ms) {
  showHoldSequence([{ text, tone: cls }], ms);
}

function showFeedback(text, ok = false) {
  if (ok) celebrate();
  else faceShake(); // 没成功 → 轻轻摇头
  // 两色方案：绿色正常 6 秒；红色是出错，多停留一会儿让人看清原因
  showHold(text, ok ? 'ok' : 'err', ok ? 6000 : 10000);
}

async function restoreClipText() {
  if (mode === 'busy' || clipChip.hidden) return;
  clipChip.disabled = true;
  clipClose.disabled = true; // 还原进行中不允许取消，避免打断状态机
  setBusy('正在找回原文…', 'restore');
  let r;
  try {
    r = await window.island.invoke('clip:restore');
  } catch (err) {
    r = { ok: false, error: String(err && err.message || err) };
  }
  leaveClip();
  setState('idle');
  if (r.ok) {
    showFeedback(`找回来了！已还原 ${r.resolved} 处`, true); // happy 欢呼配「找回来了」
  } else if (r.stale) {
    showFeedback('剪贴板内容已变化，未执行还原');
  } else if (r.missing && r.missing.length) {
    showFeedback('编码已被修改，无法还原');
  } else {
    showFeedback(r.error || '没有可还原的内容');
  }
}

clipChip.addEventListener('click', (e) => {
  e.stopPropagation(); // 不冒泡到胶囊，避免同时展开面板
  restoreClipText();
});

clipClose.addEventListener('click', (e) => {
  e.stopPropagation();
  dismissClip();
});

/* ---------------- 剪贴板事件 ---------------- */

window.island.on('clip:found', (info) => {
  if (!info || !info.count) {
    leaveClip();
    refreshIdleLabel();
    return;
  }
  clearFeedbackTimers(); // 新的剪贴板提示优先于未过期的反馈文案
  setState('clip');
  dot.classList.add('clip');
  clipChip.hidden = false;
  clipChip.disabled = false;
  clipClose.hidden = false;
  clipClose.disabled = false;
  clipText.textContent = '还原文本';
  clipChip.title = `还原当前复制文本中的 ${info.count} 处屏蔽信息`;
  labelIdle.textContent = '咦，嗅到敏感信息'; // surprise 表情配「嗅到」的惊讶感
  labelHover.textContent = '点击展开操作面板';
  glanceAtText(); // 惊讶地看向新消息
});

// 剪贴板换成别的内容 / 监听被关闭 → 旧提示立即失效
window.island.on('clip:cleared', () => {
  leaveClip();
  if (holdActive()) return;
  setState('idle');
  refreshIdleLabel();
});

/* ---------------- 屏蔽进度 ---------------- */

window.island.on('mask:converting', ({ count }) => {
  setBusy(`正在转换 ${count} 份 .doc…`, 'convert');
});
window.island.on('mask:progress', ({ i, total, path }) => {
  const name = shortName(path);
  // 带上当前文件名：长批次时用户能看清卡在哪一份上（「屏蔽中」比「正在屏蔽」短，给文件名腾字位）
  setBusy(name
    ? `屏蔽中 ${i}/${total} · ${name}`
    : `屏蔽中 ${i}/${total}…`, 'scan');
  setWaveSpeed(Number(i) / Number(total || 1)); // 越接近完成冲击越快
});
window.island.on('mask:done', (done) => {
  stopBusyHints();
  setWaveSpeed(null);
  if (done.error === 'no-root') {
    setState('idle');
    // 未配置根目录是拖入失败的主因：必须让用户明确看见，红色多停留一会儿
    showHold('未配置根目录，正在为你打开设置…', 'err', 10000);
    // 直接弹出面板的设置页（面板内同步有 toast 提示），省得用户去找入口
    window.island.invoke('panel:show-tab', 'settings');
    return;
  }
  if (done.masked > 0) maskedCount += done.masked;
  setState('idle');
  if (done.total > 0) {
    const summary = window.BatchSummary.buildBatchSummary(done);
    if (summary.celebrate) celebrate(); // 有实际成果 → 弹跳 + 高光
    // 批量结果按行轮播；总时长随行数增加，保证每行都能读完。
    // 含红色（未完成/出错）时放慢轮播并保底 10 秒，让人来得及读原因。
    const holdMs = summary.hasUnfinished
      ? Math.max(10000, 1600 * summary.lines.length)
      : (summary.lines.length > 1 ? 1200 * summary.lines.length : 6000);
    showHoldSequence(summary.lines, holdMs);
  } else {
    refreshIdleLabel();
  }
});

/* ---------------- 历史变更：胶囊统计同步 ---------------- */

window.island.on('history:changed', async () => {
  try {
    const hist = await window.island.invoke('history:list');
    if (hist.length > maskedCount) fxOnce('bump', 480); // 数量增加 → 文案轻跳一下
    maskedCount = hist.length;
    if (mode !== 'busy' && clipChip.hidden) refreshIdleLabel();
  } catch { /* ignore */ }
});

/* ---------------- 收起/展开：顶部线段 ----------------
 * 开启「灵动岛自动收起」后：只在无操作时计时，到期收起为屏幕顶边的线段；
 * 关闭则一直显示（仍可从托盘隐藏）。收起后鼠标悬停线段即可流畅展开。 */

let autoCollapse = true;
let collapseDelaySec = 20;
let panelOpen = false; // 面板打开期间不计时
let idleTimer = null;
let peekSent = false; // 一次收起周期内只请求一次悬停展开

function resetIdleTimer() {
  clearTimeout(idleTimer);
  // 收起态或面板打开时不计时；关闭自动收起则一直显示
  if (!autoCollapse || panelOpen || document.body.classList.contains('collapsed')) return;
  idleTimer = setTimeout(() => {
    window.island.invoke('pill:collapse');
  }, collapseDelaySec * 1000);
}

function applyPillState(state) {
  document.body.classList.toggle('collapsed', state === 'collapsed');
  if (state === 'collapsed') {
    clearHover(); // 收起前若悬停态因丢事件残留，随收起一并清除
    clearTimeout(idleTimer);
    peekSent = false;
    peekEnterAt = 0;
  } else {
    peekSent = false;
    resetIdleTimer();
  }
}

window.island.on('pill:state', applyPillState);

// 主进程光标看门狗：光标已离开胶囊窗口但渲染端悬停态未清（mouseleave 丢失）→ 强制清除
window.island.on('pill:hover-sync', (inside) => {
  if (!inside) clearHover();
});

// 面板打开 → 暂停空闲计时；面板关闭 → 恢复计时
window.island.on('panel:state', (open) => {
  panelOpen = !!open;
  resetIdleTimer();
});

// 收起后窗口已点击穿透，mousemove 由系统转发进来；移入线段命中区 → 请求展开。
// 命中区与可见线段对齐：中心 ±60（线段半宽 60）、y≤6（线段高 4px + 2px 余量），
// 已是「不超出线段」的最窄可用范围；且需连续停留 ≥50ms 才请求展开，
// 快速扫过顶边不会触发，移出即重新计时。
const inPeekZone = (e) =>
  Math.abs(e.clientX - window.innerWidth / 2) <= 60 && e.clientY <= 6;

let peekEnterAt = 0; // 进入命中区的时刻；移出即清零，重新进入重新计时

window.addEventListener('mousemove', (e) => {
  const zone = inPeekZone(e);
  // 指针离开线段区 → 解除右键隐藏保护，此后移入即可正常唤回
  if (hideGuard && !zone) hideGuard = false;
  if (!document.body.classList.contains('collapsed') || peekSent) {
    peekEnterAt = 0;
    return;
  }
  if (!zone) { peekEnterAt = 0; return; }
  if (!peekEnterAt) { peekEnterAt = Date.now(); return; }
  if (!hideGuard && Date.now() - peekEnterAt >= 50) {
    peekSent = true;
    window.island.invoke('pill:peek');
  }
}, { passive: true });

// 无操作（鼠标移动/点击/滚轮/拖放）即重新计时；收起态由 pill:state 清零
for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel', 'dragenter', 'drop']) {
  window.addEventListener(ev, resetIdleTimer, { passive: true });
}

// 设置变化（开关或时长）→ 立即按新配置重新计时；外观字段同步换肤
window.island.on('settings:changed', (s) => {
  autoCollapse = !!s.autoCollapse;
  collapseDelaySec = Number(s.autoCollapseDelay) || collapseDelaySec;
  applyPillAppearance(s.appearance);
  resetIdleTimer();
});

/* ---------------- 趣味微交互（情绪价值） ---------------- */

/** 单次类名动画：强制重排以便同一动画可连续触发 */
function fxOnce(cls, ms) {
  pill.classList.remove(cls);
  void pill.offsetWidth;
  pill.classList.add(cls);
  setTimeout(() => pill.classList.remove(cls), ms);
}

/** 成功时刻：弹跳 + 一道高光扫过 + 小家伙蹦跳欢呼 */
function celebrate() {
  fxOnce('pop', 560);
  fxOnce('shine', 950);
  cheering = true;
  face.classList.remove('cheer');
  void face.offsetWidth;
  face.classList.add('cheer');
  setTimeout(() => {
    cheering = false;
    face.classList.remove('cheer');
    updateFace();
  }, 1500);
}

// 磁性跟随：胶囊轻微靠向光标，柔光落在光标位置；小家伙的眼睛看向光标
pill.addEventListener('mousemove', (e) => {
  if (pillDragging) return; // 拖动换位中：窗口随光标整体移动，不做磁吸偏移
  const r = pill.getBoundingClientRect();
  const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  pill.style.setProperty('--gx', (px * 100).toFixed(1) + '%');
  pill.style.setProperty('--gy', (py * 100).toFixed(1) + '%');
  pill.style.setProperty('--mx', ((px - 0.5) * 5).toFixed(1) + 'px');
  pill.style.setProperty('--my', ((py - 0.5) * 3).toFixed(1) + 'px');

  // 二维跟随：眼球看光标，身体轻微漂移（视差），头朝光标微微偏
  const fc = face.getBoundingClientRect();
  const dx = e.clientX - (fc.left + fc.width / 2);
  const dy = e.clientY - (fc.top + fc.height / 2);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  face.style.setProperty('--look-x', clamp(dx / 5, -6, 7).toFixed(1) + 'px');
  face.style.setProperty('--look-y', clamp(dy / 7, -3.5, 3.5).toFixed(1) + 'px');
  face.style.setProperty('--face-x', clamp(dx / 15, -6, 6).toFixed(1) + 'px');
  face.style.setProperty('--face-y', clamp(dy / 22, -2.4, 2.4).toFixed(1) + 'px');
  face.style.setProperty('--tilt', clamp(dx / 9, -7, 7).toFixed(1) + 'deg');
});
/** 清除悬停态：Windows 透明置顶窗偶发丢 mouseleave，悬停视觉改由 .hover 类驱动，
    这样除了事件路径，还能被看门狗（pill:hover-sync）与收起逻辑强制清除 */
function clearHover() {
  pill.classList.remove('hover');
  hovering = false;
  pill.style.setProperty('--mx', '0px');
  pill.style.setProperty('--my', '0px');
  pill.style.setProperty('--gx', '50%');
  pill.style.setProperty('--gy', '50%');
  // 目光与身体归位
  for (const p of ['--look-x', '--look-y', '--face-x', '--face-y']) {
    face.style.setProperty(p, '0px');
  }
  face.style.setProperty('--tilt', '0deg');
  updateFace();
}

pill.addEventListener('mouseenter', () => { hovering = true; pill.classList.add('hover'); updateFace(); });
pill.addEventListener('mouseleave', clearHover);

/* ---------------- 拖放 ---------------- */

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  pill.classList.add('drag');
  updateFace();
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) { pill.classList.remove('drag'); updateFace(); }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  pill.classList.remove('drag');
  updateFace();
  if (mode === 'busy') return;
  const paths = [...(e.dataTransfer.files || [])]
    .map((f) => window.island.filePath(f))
    .filter(Boolean);
  if (paths.length === 0) return;
  setBusy(paths.length === 1
    ? '先让我看看这份文件…'
    : `${paths.length} 份文件排队中，逐份检查…`, 'identify');
  try {
    await window.island.invoke('mask:files', paths);
  } catch (err) {
    // invoke 层面的异常（如 IPC 竞态）也不能静默，否则胶囊永远卡在忙碌态
    stopBusyHints();
    setWaveSpeed(null);
    setState('idle');
    showHold('处理失败：' + String(err && err.message || err).slice(0, 30), 'err', 10000);
  }
});
