'use strict';
/**
 * PDF 不可逆遮盖（redaction）
 *
 * 设计要点：
 *  - 不复用 maskText 的可还原编码，也不写 vault：PDF 分支一次性涂黑，无法还原。
 *  - 文本 PDF：pdfjs 取文本层与字形坐标，detect() 命中后映射到页面矩形。
 *  - 图片 / 扫描 PDF：pdfjs 渲染成位图，调用 RapidOCR-json 得到文字块与像素框，
 *    再用同一套 detect() 定位敏感块。OCR 引擎随应用分发（resources/engine），
 *    进程常驻复用（见 OcrEngine），避免逐页重复加载模型。
 *  - 遮盖方式：命中页在渲染后的画布上画不透明黑框，再把该页作为图片嵌入新 PDF；
 *    未命中的页面直接复制原页（不渲染、不重编码），因此输出里只有命中页失去文本层。
 *  - 不做重复检测：每次拖入都重新执行遮盖。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { detect } = require('./detector');
const { collectEntities, mergeEntities, createEntities } = require('./entities');
const { residualCheckDetailed } = require('./residual');
const pdfflow = require('./pdfflow');

// 命名与全项目统一：屏蔽产物一律 _屏蔽，还原产物一律 _还原（PDF/图片不可还原）
const REDACTED_SUFFIX = '_屏蔽';
const REDACTED_SUFFIX_RE = new RegExp(`${REDACTED_SUFFIX}(?:_\\d{1,3})?$`);
const READY_MARK = 'OCR init completed.';
const OCR_ARGS = [
  '--models=models',
  '--det=ch_PP-OCRv4_det_infer.onnx',
  '--cls=ch_ppocr_mobile_v2.0_cls_infer.onnx',
  '--rec=rec_ch_PP-OCRv4_infer.onnx',
  '--keys=dict_chinese.txt',
  '--numThread=2',
  '--maxSideLen=2880',
  '--doAngle=0',
  '--mostAngle=0',
  '--ensureAscii=0',
];

let _pdfjsPromise = null;
function loadPdfjs() {
  if (!_pdfjsPromise) {
    if (!Promise.withResolvers) {
      Promise.withResolvers = function () {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      };
    }
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
      // Electron utility 进程（遮盖任务池）里 pdfjs 不再命中 Node 兜底路径：
      //  1) 不指定 worker 会在 getDocument 时抛
      //     「No "GlobalWorkerOptions.workerSrc" specified」；
      //  2) 渲染所需的 DOMMatrix/ImageData/Path2D 全局不会被 pdfjs 自补；
      //  3) 默认 DOM 画布/过滤器工厂需要 document。
      // 三处都在这里补齐（isNodeJS 检查显式排除了 Electron 非 browser 进程），
      // 主进程 / 纯 node 下这些步骤幂等无副作用。
      pdfflow.ensurePdfjsCanvasGlobals();
      try {
        const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
      } catch { /* worker 文件缺失时维持原状（主进程/Node 有兜底路径） */ }
      return pdfjs;
    });
  }
  return _pdfjsPromise;
}

function standardFontDataUrl() {
  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    const dir = path.join(path.dirname(pkg), 'standard_fonts');
    if (fs.existsSync(dir)) return pathToFileURL(dir + path.sep).href;
  } catch { /* ignore */ }
  return undefined;
}

async function openPdf(data) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
    isEvalSupported: false,
    standardFontDataUrl: standardFontDataUrl(),
    // utility 进程里 pdfjs 的 isNodeJS 判定为 false → 默认 DOM 工厂需要
    // document（无 DOM 即崩，渲染扫描页抛 createElement 错）。显式传
    // @napi-rs/canvas 画布工厂 + 无 DOM 过滤器工厂，与进程类型无关。
    CanvasFactory: pdfflow.NapiCanvasFactory,
    FilterFactory: pdfflow.NapiFilterFactory,
    // 非 Node 判定环境下 pdfjs 走 FontFace/CSS 字体名路线渲染字形，
    // @napi-rs/canvas 解析不了那些字体族名 → 整页文字静默画空（只剩黑框，
    // 实测 Electron utility 进程产物从 1.9MB 掉到 67KB）。强制字形路径绘制。
    disableFontFace: true,
  }).promise;
}

/** PDF 不可逆遮盖结果路径：xxx_屏蔽.pdf（命名与全项目统一） */
function redactedPathOf(p) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext).replace(REDACTED_SUFFIX_RE, '');
  return path.join(dir, `${base}${REDACTED_SUFFIX}${ext}`);
}

/* ---------------- 文本层定位 ---------------- */

/**
 * 把 pdfjs 文本项规范化成检测流（pdfflow）：视觉行拼成段落流（跨行实体可匹配）、
 * 剥除中西文间隙空格，并保留「字符 → 字形框」映射。
 * 字符框由 pdfflow 按字符序号在基线方向内插（旧实现整项共用一个框，
 * 命中几个字会把一整项涂黑）。
 */
async function pageTextWithBoxes(page) {
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    items.push({ str: it.str, transform: it.transform, width: it.width, height: it.height });
  }
  return pdfflow.buildFlowFromItems(items);
}

/** 命中区间 → 涂黑区域：pdfflow 统一实现，跨行命中按行拆分（并集会横盖整行） */
function boxesFromHits(hits, chars) {
  return pdfflow.boxesFromHits(hits, chars);
}

/**
 * 命中区域绘制：矩形组走 mergeBoxes 合并后填充；quad 组（倾斜 OCR 文字）按
 * 扫掠四边形外扩 padding 后以多边形填充——轴对齐矩形会在倾斜行的低端吃进相邻行。
 */
function drawRedactBoxes(ctx, groups, padding) {
  const rects = [];
  const quads = [];
  for (const g of groups || []) {
    if (Array.isArray(g.quad)) quads.push(g.quad);
    else rects.push(g);
  }
  ctx.fillStyle = '#000000';
  for (const b of mergeBoxes(rects, padding)) {
    ctx.fillRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
  }
  for (const q of quads) {
    const poly = pdfflow.expandQuad(q, padding);
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * 按 padding 扩展并合并重叠框，避免重复填充和拼接缝隙。
 * 仅合并同一行的框：行距常小于扩展后的框高，若按「边缘接触即合并」会逐行
 * 连锁成整页黑块，把大量无关正文一起涂掉。判定同行的条件是两个框的垂直
 * 重叠超过较矮框的 60%，且水平方向重叠或仅隔很小的缝隙。
 */
function mergeBoxes(boxes, padding) {
  const padded = boxes.map((b) => ({
    x1: b.x1 - padding, y1: b.y1 - padding,
    x2: b.x2 + padding, y2: b.y2 + padding,
  }));
  const out = [];
  for (const b of padded) {
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const hA = a.y2 - a.y1, hB = b.y2 - b.y1;
      const yOverlap = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      const xOverlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const sameLine = yOverlap > Math.min(hA, hB) * 0.6;
      const nearOnX = xOverlap >= -padding * 2;
      if (sameLine && nearOnX) {
        out[i] = {
          x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
          x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2),
        };
        merged = true;
        break;
      }
    }
    if (!merged) out.push(b);
  }
  return out;
}

/* ---------------- 页面渲染 ---------------- */

async function renderPage(page, dpi) {
  const { createCanvas } = require('@napi-rs/canvas');
  const scale = dpi / 72;
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, ctx, vp, vp1, scale };
}

/** PDF 用户空间坐标（y 向上）→ 画布像素坐标（y 向下），兼容页面旋转 */
function pdfBoxesToPixels(boxes, vp) {
  return boxes.map((b) => {
    const r = vp.convertToViewportRectangle([b.x1, b.y1, b.x2, b.y2]);
    return {
      x1: Math.min(r[0], r[2]), y1: Math.min(r[1], r[3]),
      x2: Math.max(r[0], r[2]), y2: Math.max(r[1], r[3]),
    };
  });
}

/* ---------------- RapidOCR-json 子进程（常驻复用） ---------------- */

/**
 * 引擎进程复用：RapidOCR-json 每次冷启动都要加载 16MB 可执行文件与 onnx 模型
 * （实测 0.5~1.7s）。逐页 spawn 会让扫描件 PDF 的耗时随页数线性膨胀，
 * 因此这里维护一个常驻进程，识别请求串行复用同一实例；空闲超时后自动退出。
 */
const OCR_IDLE_MS = 5 * 60 * 1000;
/**
 * 有界复用：RapidOCR-json 连续识别大图会累积退化（实测同一进程第 1 次 2.2s、
 * 第 2 次 5s、第 3 次起 6~7s，而重启进程每次稳定 2.2s）。小图复用收益明显
 * （0.6s 冷启动 → 0.2s/张），因此按累计工作量设上限，超了就回收重启。
 */
const OCR_MAX_CALLS = 8;
/** 单次识别超过这个耗时（不含启动）说明是大图，本进程直接回收，下次冷启动更划算 */
const OCR_SLOW_CALL_MS = 900;

function resolveEngineDir(configured) {
  // 显式配置优先且不降级：配置错路径时应明确报「引擎不可用」，而不是悄悄用另一套引擎
  if (configured) {
    try {
      return fs.existsSync(path.join(configured, 'RapidOCR-json.exe')) ? configured : null;
    } catch { return null; }
  }
  const candidates = [];
  // 打包态：electron-builder 的 extraResources 把 assets/engine 放到 resources/engine。
  // 引擎是原生 exe，必须放在 asar 外，否则 spawn 无法执行。
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'engine'));
  // 开发态：项目内 assets/engine（已随仓库分发）
  candidates.push(path.join(__dirname, '..', '..', 'assets', 'engine'));
  // 兼容旧开发机：同工作区 OcrFlow 从 Umi-OCR Rapid 发行包提取的引擎
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'Umi-OCR', 'OcrFlow', 'resources', 'engine'));
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'RapidOCR-json.exe'))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

/** 解析引擎返回的一行 JSON，得到带像素框的文字块（保留四点 quad 供去斜/字符框内插） */
function parseOcrResponse(res) {
  if (res.code === 100) {
    return (Array.isArray(res.data) ? res.data : []).map((d) => {
      const pts = (Array.isArray(d.box) ? d.box : [])
        .map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return {
        text: String(d.text || ''),
        score: Number(d.score || 0),
        box: {
          x1: Math.min(...xs), y1: Math.min(...ys),
          x2: Math.max(...xs), y2: Math.max(...ys),
        },
        // RapidOCR 四点序：左上/右上/右下/左下；图片 PDF 页面常带数度倾斜，
        // bbox 会膨胀数倍（单行块高跨 2~3 行）， quad 才能还原基线方向。
        pts: pts.length === 4 ? pts : null,
      };
    }).filter((b) => b.text && b.box.x2 > b.box.x1 && b.box.y2 > b.box.y1);
  }
  if (res.code === 101) return []; // 未识别到文字
  throw new Error(`OCR 引擎返回错误码 ${res.code}`);
}

class OcrEngine {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.exe = path.join(dir, 'RapidOCR-json.exe');
    this.opts = { ...opts };
    this.child = null;
    this.ready = false;
    this.buf = '';
    this.waiters = [];
    this.pending = null;
    this.chain = Promise.resolve();
    this.idleTimer = null;
    this.spawnCount = 0;
    this.calls = 0;
    this.totalMs = 0;
  }

  get running() {
    return !!(this.child && this.child.exitCode === null && !this.child.killed);
  }

  _clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /** 空闲回收：模型常驻占内存，长时间无任务时退出，下次识别再懒启动 */
  _touchIdle() {
    this._clearIdle();
    this.idleTimer = setTimeout(() => this._stop(), OCR_IDLE_MS);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  _spawn() {
    this.spawnCount++;
    this.buf = '';
    this.ready = false;
    this.calls = 0;
    this.totalMs = 0;
    const child = spawn(this.exe, OCR_ARGS, {
      cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    // 回收旧引擎后它还会异步吐出 exit/error 事件；必须确认事件来自当前实例，
    // 否则会把新引擎正在处理的请求误判为失败。
    const current = () => this.child === child;
    child.stdout.on('data', (chunk) => { if (current()) this._onData(chunk.toString('utf8')); });
    // 引擎的诊断输出不参与协议；不消费会让 stderr 管道填满而阻塞子进程
    child.stderr.on('data', () => { /* drain */ });
    child.stdin.on('error', () => { /* 写失败由 exit/error 兜底 */ });
    child.on('error', (e) => { if (current()) this._fail(e); });
    child.on('exit', () => { if (current()) this._fail(new Error('OCR 引擎进程提前退出')); });
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      if (!this.ready) {
        if (line.includes(READY_MARK)) { this.ready = true; this._flushReady(); }
        continue;
      }
      if (line.charCodeAt(0) !== 123) continue; // 非 JSON 行（日志）忽略
      let res;
      try { res = JSON.parse(line); } catch { continue; }
      if (this.pending) this._settle(res, null);
    }
  }

  _flushReady() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(); }
    this._touchIdle();
  }

  _fail(err) {
    this._clearIdle();
    this.ready = false;
    this.child = null;
    this.buf = '';
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) { clearTimeout(w.timer); w.reject(err); }
    if (this.pending) this._settle(null, err);
  }

  _settle(res, err) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) { p.reject(err); return; }
    let blocks;
    try { blocks = parseOcrResponse(res); } catch (e) { p.reject(e); return; }
    const cost = Math.max(0, Date.now() - p.started);
    this.calls++;
    this.totalMs += cost;
    p.resolve(blocks);
    this._touchIdle();
    this._maybeRecycle(cost);
  }

  /** 达到复用上限或识别本身很慢时主动重启，避免引擎在大图上越跑越慢 */
  _maybeRecycle(cost) {
    if (this.calls >= OCR_MAX_CALLS || cost >= OCR_SLOW_CALL_MS) this._stop();
  }

  _ensureReady() {
    if (this.ready && this.running) return Promise.resolve();
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._stop(new Error('OCR 引擎初始化超时'));
      }, this.opts.ocrInitTimeout || 30000);
      this.waiters.push({ resolve, reject, timer });
    });
    if (!this.running) this._spawn();
    return p;
  }

  _stop(err) {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.buf = '';
    this._clearIdle();
    if (child && child.exitCode === null) {
      try { child.stdin.write(JSON.stringify({ exit: '' }) + '\n'); } catch { /* ignore */ }
      const t = setTimeout(() => { try { if (child.exitCode === null) child.kill(); } catch { /* ignore */ } }, 500);
      if (typeof t.unref === 'function') t.unref();
    }
    const reason = err || new Error('OCR 引擎已关闭');
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) { clearTimeout(w.timer); w.reject(reason); }
    if (this.pending) this._settle(null, reason);
  }

  recognize(imageBuffer) {
    const run = () => this._recognizeOnce(imageBuffer);
    const p = this.chain.then(run, run);
    this.chain = p.then(() => undefined, () => undefined);
    return p;
  }

  async _recognizeOnce(imageBuffer) {
    await this._ensureReady();
    this._clearIdle();
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 单张识别超时：引擎可能已卡死，杀掉进程，下次调用重新加载
        this._publish(new Error('OCR 识别超时'));
        this._stop(new Error('OCR 识别超时'));
      }, this.opts.ocrTimeout || 120000);
      this.pending = { resolve, reject, timer, started };
      try {
        this.child.stdin.write(JSON.stringify({ image_base64: imageBuffer.toString('base64') }) + '\n');
      } catch (e) {
        this._settle(null, e);
      }
    });
  }

  /** 仅拒绝当前请求，不改变进程状态（超时场景随后会 _stop） */
  _publish(err) { this._settle(null, err); }
}

let _engine = null;

function getEngine(dir, opts = {}) {
  if (_engine && _engine.dir !== dir) {
    try { _engine._stop(); } catch { /* ignore */ }
    _engine = null;
  }
  if (!_engine) _engine = new OcrEngine(dir, opts);
  else Object.assign(_engine.opts, { ocrInitTimeout: opts.ocrInitTimeout, ocrTimeout: opts.ocrTimeout });
  return _engine;
}

/** 对一张位图跑 OCR，返回带像素框的文字块（引擎进程常驻复用） */
async function runOcr(imageBuffer, opts = {}) {
  const dir = resolveEngineDir(opts.ocrEngineDir);
  if (!dir) {
    const err = new Error('未找到 RapidOCR-json 引擎，无法识别图片 PDF');
    err.code = 'OCR_ENGINE_NOT_FOUND';
    throw err;
  }
  return getEngine(dir, opts).recognize(imageBuffer);
}

/** 诊断用：引擎是否在运行、累计启动了几次（测试锁定「不重复冷启动」） */
function ocrEngineStats() {
  return {
    running: !!(_engine && _engine.running),
    spawnCount: _engine ? _engine.spawnCount : 0,
  };
}

/** 退出时释放常驻引擎（长时间不用也由空闲定时器自动回收） */
function disposeOcrEngine() {
  if (_engine) {
    try { _engine._stop(); } catch { /* ignore */ }
  }
  _engine = null;
}

/** OCR 文字块 → 检测流：块内剥空格、块间按行距启发式拼段，字符框块内等宽内插 */
function ocrTextWithBoxes(blocks) {
  return pdfflow.buildFlowFromBlocks(blocks);
}

/**
 * 产物复核：重新渲染涂黑页 → OCR → 用同一实体表检测。
 * 用于发现「黑框与文字错位」这类仅靠编辑坐标无法察觉的泄漏。
 */
async function verifyRedactedPages(outBytes, pages, detectOpts, dpi, ocrOpts = {}) {
  const doc = await openPdf(outBytes);
  const findings = [];
  try {
    for (const pn of [...pages].sort((a, b) => a - b)) {
      const page = await doc.getPage(pn);
      const r = await renderPage(page, dpi);
      const blocks = await runOcr(r.canvas.toBuffer('image/png'), ocrOpts);
      if (!blocks.length) continue;
      const info = ocrTextWithBoxes(blocks);
      const report = residualCheckDetailed(info.text, detectOpts.toggles,
        undefined, detectOpts.knownEntities);
      for (const it of report ? report.items : []) findings.push({ page: pn, ...it });
    }
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
  return findings;
}

/* ---------------- 主流程 ---------------- */

/**
 * PDF 不可逆遮盖。
 * 两遍处理（与 DOCX 通道「先收集再屏蔽」语义对齐）：
 *  1. 只收集不检测：文本页取检测流；扫描页渲染 + OCR（块暂存）。
 *     全文档段落语料收集实体表——紧连式身份候选（「申请人王铁柱」）要靠
 *     案卷级复现统计确认，导入预扫对图片/扫描件读不出文本，必须在这里补齐。
 *  2. 逐页检测（套用全文档实体表）：命中页渲染 + 涂黑 + 以图片嵌入；
 *     未命中页直接复制原页。输出体积与耗时只跟「命中页数」相关。
 * @returns {Promise<object>} 与 maskFile 同风格的结果对象
 */
async function redactPdfFile(filePath, toggles, outPath, opts = {}) {
  let pdf = null;
  try {
    const bytes = fs.readFileSync(filePath);
    const dpi = Math.max(96, Math.min(400, Number(opts.dpi) || 200));
    const padding = Number(opts.padding) || 2;
    // 文件独立：只从本 PDF 自身预扫确认实体；不读账本、缓存或其他文件的实体。
    const knownIn = createEntities();
    const detectOptionsRef = { toggles, knownEntities: knownIn };
    pdf = await openPdf(bytes);
    const total = pdf.numPages;

    const counts = {};
    const hitPages = new Set();
    let count = 0;
    let usedOcr = false;
    const pageFlows = new Map(); // 页号 → 文本层检测流
    const ocrBlocks = new Map(); // 页号 → 扫描页 OCR 文字块
    const corpus = []; // 全文档段落语料（两遍式第一遍）

    // ── 第一遍：收集（文本层流 + 扫描页 OCR），不检测 ──
    for (let pn = 1; pn <= total; pn++) {
      const page = await pdf.getPage(pn);
      const info = await pageTextWithBoxes(page);
      if (info.text.trim()) {
        pageFlows.set(pn, info);
        corpus.push(...info.text.split('\n'));
        continue;
      }
      // 无文本层：渲染 + OCR，块暂存（第二遍检测时用），不在此处出结果
      const r = await renderPage(page, dpi);
      let blocks;
      try {
        blocks = await runOcr(r.canvas.toBuffer('image/png'), opts);
      } catch (err) {
        await pdf.destroy();
        pdf = null;
        if (err.code === 'OCR_ENGINE_NOT_FOUND') {
          return { ok: false, path: filePath, skipped: 'pdf-no-text', reason: err.message };
        }
        throw err;
      }
      usedOcr = true;
      ocrBlocks.set(pn, blocks);
      const ocrInfo = ocrTextWithBoxes(blocks);
      corpus.push(...ocrInfo.text.split('\n'));
    }

    if (pageFlows.size === 0 && ocrBlocks.size === 0) {
      await pdf.destroy();
      pdf = null;
      return { ok: true, path: filePath, count: 0, skipped: 'no-pii' };
    }

    // 全文档实体表 = 本 PDF 自身语料自收集
    const selfKnown = corpus.some((s) => s.trim())
      ? collectEntities(corpus, { toggles })
      : null;
    const known = mergeEntities(knownIn, selfKnown);
    detectOptionsRef.knownEntities = known;

    // ── 第二遍：按命中情况逐页组装 ──
    const { PDFDocument } = require('pdf-lib');
    let outDoc = null;
    let srcLib = null;
    let copyUnavailable = false; // pdf-lib 读不了源文件时退化为整页栅格化
    const pendingCopies = []; // 首个命中页之前的干净页，延后补进输出（保持页序）

    const embedRendered = async (pn) => {
      const page = await pdf.getPage(pn);
      const r = await renderPage(page, dpi);
      const png = r.canvas.toBuffer('image/png');
      const img = await outDoc.embedPng(png);
      const outPage = outDoc.addPage([r.vp1.width, r.vp1.height]);
      outPage.drawImage(img, { x: 0, y: 0, width: r.vp1.width, height: r.vp1.height });
    };

    const ensureOut = async () => {
      if (outDoc) return;
      outDoc = await PDFDocument.create();
      try {
        srcLib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      } catch {
        srcLib = null;
        copyUnavailable = true;
      }
      while (pendingCopies.length) {
        const idx = pendingCopies.shift();
        if (copyUnavailable) {
          await embedRendered(idx + 1);
        } else {
          const [copied] = await outDoc.copyPages(srcLib, [idx]);
          outDoc.addPage(copied);
        }
      }
    };

    /** 未命中的页：原样复制（不可复制时退化为栅格化，与旧行为一致） */
    const copyPage = async (idx) => {
      if (!outDoc) { pendingCopies.push(idx); return; }
      if (copyUnavailable) { await embedRendered(idx + 1); return; }
      const [copied] = await outDoc.copyPages(srcLib, [idx]);
      outDoc.addPage(copied);
    };

    for (let pn = 1; pn <= total; pn++) {
      const idx = pn - 1;
      const flow = pageFlows.get(pn);
      const blocks = ocrBlocks.get(pn);
      if (!flow && !blocks) { await copyPage(idx); continue; }

      // 先检测（不渲染）：命中才光栅化，未命中页照抄原页
      let boxes = [];
      if (flow) {
        const res = detect(flow.text, detectOptionsRef);
        if (res.items.length) {
          hitPages.add(pn);
          const page = await pdf.getPage(pn);
          const vp = page.getViewport({ scale: dpi / 72 });
          boxes = pdfBoxesToPixels(boxesFromHits(res.items, flow.chars), vp);
          count += res.items.length;
          for (const it of res.items) counts[it.type] = (counts[it.type] || 0) + 1;
        }
      } else {
        const ocrInfo = ocrTextWithBoxes(blocks);
        const res = blocks.length
          ? detect(ocrInfo.text, detectOptionsRef)
          : { items: [] };
        if (res.items.length) {
          hitPages.add(pn);
          boxes = boxesFromHits(res.items, ocrInfo.chars);
          count += res.items.length;
          for (const it of res.items) counts[it.type] = (counts[it.type] || 0) + 1;
        }
      }
      if (!boxes.length) { await copyPage(idx); continue; } // 未命中 → 照抄原页

      // 命中页：渲染 + 涂黑 + 以图片嵌入
      const page = await pdf.getPage(pn);
      const r = await renderPage(page, dpi);
      await ensureOut();
      drawRedactBoxes(r.ctx, boxes, padding * r.scale);

      const png = r.canvas.toBuffer('image/png');
      const img = await outDoc.embedPng(png);
      const outPage = outDoc.addPage([r.vp1.width, r.vp1.height]);
      outPage.drawImage(img, { x: 0, y: 0, width: r.vp1.width, height: r.vp1.height });
    }

    await pdf.destroy();
    pdf = null;

    if (!outDoc || count === 0) {
      return { ok: true, path: filePath, count: 0, skipped: 'no-pii' };
    }

    // 清掉元数据：产物里不留作者 / 主题 / 关键词 / XMP 线索
    try {
      outDoc.setTitle(''); outDoc.setAuthor(''); outDoc.setSubject('');
      outDoc.setKeywords(['']); outDoc.setCreator(''); outDoc.setProducer('');
    } catch { /* ignore */ }

    const outBytes = Buffer.from(await outDoc.save());
    const out = outPath || redactedPathOf(filePath);
    fs.writeFileSync(out, outBytes);
    const result = {
      ok: true, path: filePath, redactedPath: out, count, counts,
      irreversible: true, ocr: usedOcr,
    };
    // 交付前复核：只对涂黑页重新 OCR，检查黑框是否真的盖住文字
    if (opts.verifyOutput !== false && hitPages.size) {
      try {
        // 复核只需判定「有没有残留文字」，150dpi 足够且比 200dpi 快近一半
        const findings = await verifyRedactedPages(
          outBytes, hitPages, detectOptionsRef, Math.min(dpi, 150), opts,
        );
        if (findings.length) {
          const report = { code: 'residual-pii', count: findings.length, items: findings.slice(0, 20) };
          if (opts.strictResidual) {
            try { fs.rmSync(out, { force: true }); } catch { /* 锁定时仅阻断 */ }
            return {
              ok: false, path: filePath, skipped: 'residual-pii',
              reason: 'PDF 产物复核仍检出敏感信息，已阻断交付',
              warning: report.code, residual: report,
            };
          }
          result.warning = report.code;
          result.residual = report;
        }
      } catch (err) {
        result.verification = 'unavailable';
        result.verificationReason = String((err && err.message) || err);
      }
    }
    return result;
  } catch (err) {
    if (pdf) { try { await pdf.destroy(); } catch { /* ignore */ } }
    return {
      ok: false,
      path: filePath,
      skipped: err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES' ? 'locked' : 'error',
      reason: String((err && err.message) || err),
    };
  }
}

module.exports = {
  redactedPathOf, resolveEngineDir, runOcr, redactPdfFile,
  ocrEngineStats, disposeOcrEngine, ocrTextWithBoxes,
  REDACTED_SUFFIX, REDACTED_SUFFIX_RE,
};
