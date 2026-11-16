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
  pill.classList.remove('clip', 'busy', 'ok', 'warn');
  if (next === 'clip') pill.classList.add('clip');
  if (next === 'busy') pill.classList.add('busy');
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
  if (/摸摸头|很好|第一顺位|认真生活|自责|尽力|做得够多|偏爱/.test(t)) return 'shy';   // 被夸 / 被偏爱而害羞
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

/* 空闲文案池：随机轮换的「情绪价值」文案（多数与功能无关，只负责让人心情好一点）
   主线是「先接住情绪，再轻轻提议」——不说教、不施压、不贩卖焦虑，像一个懂分寸的朋友。
   每行末尾是它触发的表情情绪；改文案时留意关键词是否仍匹配 faceMood() 的正则。 */
const MOOD_LINES = [
  // 允许慢下来：先把压力接住，不急着讲道理
  '慢一点也没关系，你已经很好',      // shy
  '累了就歇一歇，不赶这一时',        // warm
  '今天没状态，也完全说得过去',      // idle
  '偶尔走神，是大脑在给自己放假',    // idle
  '不必时刻满分，及格也值得高兴',    // idle
  '你已经很努力了，这事儿我作证',    // idle
  '做不到就先放着，天不会塌',        // idle
  // 被夸会害羞：夸得具体一点，才不显得敷衍
  '今天也有在认真生活呀',            // shy
  '能坚持到现在，真的很了不起',      // idle
  '你比自己以为的，要靠谱得多',      // idle
  '摸摸头，今天也辛苦了',            // shy
  '你是自己的第一顺位，别忘了',      // shy
  '悄悄说，你今天状态很好',          // shy
  // 起身舒展：把命令换成邀请，把"应该"换成"可以"
  '伸个懒腰吧，肩颈会谢谢你',        // idle
  '坐久了，起来够一够天花板',        // idle
  '站起来看看远处，眼睛会感谢你',    // idle
  '肩膀松一松，别替世界扛着',        // warm
  // 喝水 / 放松：给理由，但不絮叨
  '记得喝水，顺便看看远处',          // warm
  '先喝口水，很多事没那么急',        // idle
  '杯子空了，顺便给它续一点',        // idle
  // 沉思：承认卡住很正常，再陪着捋
  '深呼吸三次，烦恼先放一边',        // think
  '别急，一件一件来',                // think
  '先把最难的那件啃掉',              // think
  '想不通的事，先放一放也没关系',    // think
  '烦恼先寄存在我这儿吧',            // think
  '卡住了就歇一歇，思路常在半路来',  // think（"思路"优先于"歇"）
  // 阳光惬意
  '窗前有光，就去晒一会儿',          // content
  '找个阳光位，坐下发会儿呆',        // content
  '晒晒太阳，比硬撑管用',            // content
  '世界很吵，这里很安静',            // content
  // 小憩：把"该睡了"说成"可以放心交给我"
  '困了就眯一会儿，天不会塌',        // sleepy
  '打盹五分钟，精神一小时',          // sleepy
  '放心睡吧，剩下的明天再说',        // sleepy
  // 安慰：承认情绪的正当性，不给"你要坚强"的压力
  '做不完的事，明天还有机会',        // warm
  '今天做得够多了，别自责',          // shy
  '别跟自己较劲，你已经尽力了',      // shy
  '不开心也可以，不必急着好起来',    // idle
  '这事换谁都为难，你不用一个人扛',  // warm
];

/** 按当前时段挑一句应景的话（每个时段多条，随机取一） */
function timeMoodLine() {
  const h = new Date().getHours();
  let pool;
  if (h >= 5 && h < 9) {
    pool = ['早上好，今天也请多关照', '别急着起床，先给自己一个懒腰', '新的一天，慢一点开工也没关系'];
  } else if (h < 11) {
    pool = ['上午的光最提神，记得开窗', '思路卡住时，先收拾一下桌面', '状态不错的话，就先做那件最重要的'];
  } else if (h < 13) {
    pool = ['午饭时间到，别对着屏幕吃', '饭后晒五分钟太阳，下午不困', '中午了，给胃一点发言权'];
  } else if (h < 16) {
    pool = ['下午容易困，起来走两步', '困意上头？先喝口水试试', '三点多了，撑不住就眯一小会儿'];
  } else if (h < 19) {
    pool = ['快下班了，收尾的事慢慢来', '窗外的晚霞，值得抬头看一眼', '傍晚的风，最适合透口气'];
  } else if (h < 22) {
    pool = ['忙完这阵，就好好歇一歇吧', '晚上的事，留给晚上的你，不急', '今天已经做得很好了，收工吧'];
  } else if (h < 24) {
    pool = ['夜深了，早点睡，明天见', '屏幕调暗一点，眼睛谢谢你', '别熬了，天亮的事交给天亮的你'];
  } else {
    pool = ['这个点了还醒着呀，辛苦了', '天快亮了，先躺一会儿也好'];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/* 周末彩蛋：周六日随机追加一句 */
const WEEKEND_LINES = [
  '周末就该理直气壮地慢下来',
  '今天不赶进度，只赶阳光',
  '周末快乐，工作的事先放我这儿',
  '难得两天，允许自己什么都不做',
];

const IDLE_LINES = () => {
  const lines = [...MOOD_LINES, timeMoodLine()];
  const day = new Date().getDay();
  if (day === 0 || day === 6) {
    lines.push(WEEKEND_LINES[Math.floor(Math.random() * WEEKEND_LINES.length)]);
  }
  if (maskedCount > 0) lines.push(`${maskedCount} 份文件已被悄悄守护`);
  // 保留一句功能提示，避免新用户不知道可以拖文件进来
  lines.push('拖入文件，即可一键屏蔽');
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
    labelIdle.textContent = pickIdleLine();
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

/** 与面板同一套 CSS 变量（胶囊侧只用到其中与胶囊相关的部分） */
function applyPillAppearance(a) {
  if (!a) return;
  const root = document.documentElement;
  root.dataset.theme = THEMES_API.normalizeTheme(a.theme);
  // 面板的动效开关不作用于胶囊：表情与呼吸属于岛自己的状态反馈
  root.style.setProperty('--island-alpha', String(Math.min(1, Math.max(0.55, Number(a.alpha) || 1))));
  const r = Math.round(Math.min(22, Math.max(10, Number(a.radius) || 18)));
  root.style.setProperty('--pill-radius', Math.min(22, r + 4) + 'px');
  if (a.accent) root.style.setProperty('--accent', a.accent);
  else root.style.removeProperty('--accent');
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
// 隐藏瞬间指针往往还停在胶囊原位置，收起后可能恰好落在线段命中区；设一个短暂
// 保护期，避免刚隐藏就被「悬停唤回」逻辑立刻展开。指针移出线段区即提前解除。
const HIDE_GUARD_MS = 1200;
let hideGuardUntil = 0;

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (document.body.classList.contains('collapsed')) return; // 已隐藏，不重复请求
  hideGuardUntil = Date.now() + HIDE_GUARD_MS;
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

function setBusy(text) {
  setState('busy');
  labelIdle.textContent = text;
  glanceAtText(); // 看向进度文字
}

// 还原结果展示期间忽略主进程的 cleared 广播，避免反馈文案被立刻覆盖
let feedbackHold = null; // { text, cls, until, timer } —— 反馈文案持有期：悬停/轮换/广播都不抢

function holdActive() { return !!(feedbackHold && Date.now() < feedbackHold.until); }

function showHold(text, cls, ms) {
  if (feedbackHold) clearTimeout(feedbackHold.timer);
  feedbackHold = { text, cls, until: Date.now() + ms, timer: 0 };
  pill.classList.remove('ok', 'warn');
  if (cls) pill.classList.add(cls);
  labelIdle.textContent = text;
  resetIdleTimer();
  feedbackHold.timer = setTimeout(() => {
    feedbackHold = null;
    pill.classList.remove('ok', 'warn');
    refreshIdleLabel();
  }, ms);
}

function showFeedback(text, ok = false) {
  if (ok) celebrate();
  else faceShake(); // 没成功 → 轻轻摇头
  showHold(text, ok ? 'ok' : '', 6000);
}

async function restoreClipText() {
  if (mode === 'busy' || clipChip.hidden) return;
  clipChip.disabled = true;
  clipClose.disabled = true; // 还原进行中不允许取消，避免打断状态机
  setBusy('正在还原文本…');
  let r;
  try {
    r = await window.island.invoke('clip:restore');
  } catch (err) {
    r = { ok: false, error: String(err && err.message || err) };
  }
  leaveClip();
  setState('idle');
  if (r.ok) {
    showFeedback(`已还原 ${r.resolved} 处，写回剪贴板`, true);
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
  feedbackHold = null; // 新的剪贴板提示优先于未过期的反馈文案
  setState('clip');
  dot.classList.add('clip');
  clipChip.hidden = false;
  clipChip.disabled = false;
  clipClose.hidden = false;
  clipClose.disabled = false;
  clipText.textContent = '还原文本';
  clipChip.title = `还原当前复制文本中的 ${info.count} 处屏蔽信息`;
  labelIdle.textContent = '识别到含屏蔽信息';
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
  setState('busy');
  labelIdle.textContent = `正在转换 ${count} 份 .doc…`;
});
window.island.on('mask:progress', ({ i, total }) => {
  setState('busy');
  labelIdle.textContent = `正在屏蔽 ${i}/${total}…`;
});
window.island.on('mask:done', (done) => {
  if (done.error === 'no-root') {
    setState('idle');
    // 未配置根目录是拖入失败的主因：必须让用户明确看见，而不是 3 秒一闪而过
    showHold('未配置根目录，正在为你打开设置…', 'warn', 8000);
    // 直接弹出面板的设置页（面板内同步有 toast 提示），省得用户去找入口
    window.island.invoke('panel:show-tab', 'settings');
    return;
  }
  if (done.masked > 0) maskedCount += done.masked;
  setState('idle');
  if (done.total > 0) {
    const parts = [];
    if (done.masked > 0) parts.push(`屏蔽 ${done.masked} 份`);
    if (done.restored > 0) parts.push(`还原 ${done.restored} 份`);
    if (done.overwritten > 0) parts.push(`覆盖同名 ${done.overwritten} 份`);
    if (parts.length) celebrate(); // 有实际成果 → 弹跳 + 高光
    const line = parts.length
      ? `已完成：${parts.join(' · ')}，副本已生成`
      : (done.restoreMissing > 0 ? '编码无法识别，未还原'
        : done.alreadyMasked > 0 ? '未找到可还原编码'
        : done.noPii > 0 ? '未检出敏感信息' : '处理完成');
    // 完成/结果提示持有 6 秒：期间悬停、闲聊轮换都不会顶掉它
    showHold(line, 'ok', 6000);
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

// 收起后窗口已点击穿透，mousemove 由系统转发进来；移入线段命中区 → 请求展开
const inPeekZone = (e) =>
  Math.abs(e.clientX - window.innerWidth / 2) <= 100 && e.clientY <= 18;

window.addEventListener('mousemove', (e) => {
  const zone = inPeekZone(e);
  // 指针离开线段区即解除右键保护；把鼠标挪开后随时可以重新唤回
  if (hideGuardUntil && !zone) hideGuardUntil = 0;
  if (!document.body.classList.contains('collapsed') || peekSent) return;
  if (zone && Date.now() >= hideGuardUntil) {
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
  setBusy(`正在识别并处理 ${paths.length} 个文件…`);
  try {
    await window.island.invoke('mask:files', paths);
  } catch (err) {
    // invoke 层面的异常（如 IPC 竞态）也不能静默，否则胶囊永远卡在忙碌态
    setState('idle');
    showHold('处理失败：' + String(err && err.message || err).slice(0, 30), '', 6000);
  }
});
