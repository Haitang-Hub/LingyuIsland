'use strict';
/**
 * 老式 Word 二进制文档（.doc / .dot，OLE2 复合文档）自动转换
 *
 * 为什么需要转换：
 *  - 屏蔽值形如「138****5678〔手机号·a3f2b1〕」，长度大于原文；老 .doc 的文本按
 *    WordDocument 流 + piece table(CLX) 分段存储，变长替换必须重建 CLX、FIB
 *    偏移、FAT 扇区链，极易损坏文档，因此不改写原二进制。
 *  - 项目现有的 Office 管道基于 adm-zip 解 OOXML zip 内 XML，只认 docx/xlsx/pptx。
 *  - 折中：导入时把 .doc 本地转换（不联网、不上传）为临时 .docx，之后完全复用
 *    成熟管道；产物为 .docx，原 .doc 永不改动。
 *
 * 转换器优先级：LibreOffice(soffice) → Windows Word COM（PowerShell，无额外依赖）。
 * 两者都不可用时返回明确错误，由上层提示用户「请另存为 .docx」。
 *
 * 中文路径处理：先把源文件复制成临时目录下的 ASCII 名 job_<hash>.doc，
 * 再让转换器处理；PowerShell 脚本经 -EncodedCommand(UTF-16LE) 传入，
 * 全程不依赖控制台代码页，中文路径不会乱码。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const LEGACY_EXTS = new Set(['doc', 'dot']);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const TMP_DIR = path.join(os.tmpdir(), 'lingyu-island-docx');

/** abs 源路径 -> { tmp, mtimeMs, size }；同一文件在一次运行内只转换一次 */
const cache = new Map();

function extOf(p) {
  return path.extname(p).slice(1).toLowerCase();
}

function isLegacyName(p) {
  return LEGACY_EXTS.has(extOf(p));
}

/** 文件头判断：真·Word 97-2003 二进制（区分「.doc 后缀但实际是 docx/txt」的情况） */
function isOle2(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(8);
      const n = fs.readSync(fd, buf, 0, 8, 0);
      return n === 8 && buf.equals(OLE_MAGIC);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

function isLegacyDoc(p) {
  // 以文件头为准；兼容把老 Word 二进制错命名为 .docx 的案卷文件。
  return (isLegacyName(p) || extOf(p) === 'docx') && isOle2(p);
}

function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function jobNameFor(src) {
  const h = crypto.createHash('sha1').update(path.resolve(src)).digest('hex').slice(0, 12);
  return `job_${h}`;
}

/** 缓存命中且源文件未变化 → 直接复用转换结果 */
function cached(src) {
  const hit = cache.get(path.resolve(src));
  if (!hit || !fs.existsSync(hit.tmp)) return null;
  try {
    const st = fs.statSync(src);
    if (st.mtimeMs === hit.mtimeMs && st.size === hit.size) return hit.tmp;
  } catch { /* 源文件已消失 */ }
  return null;
}

function remember(src, tmp) {
  try {
    const st = fs.statSync(src);
    cache.set(path.resolve(src), { tmp, mtimeMs: st.mtimeMs, size: st.size });
  } catch { /* ignore */ }
}

/* ---------------- 转换器探测 ---------------- */

function findSoffice() {
  const candidates = [
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    '/usr/bin/soffice', '/usr/local/bin/soffice', '/usr/bin/libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/* ---------------- PowerShell + Word COM ---------------- */

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 生成脚本：转换一批 job，结果以无 BOM UTF-8 JSON 写入 resultPath */
function buildWordScript(jobs, resultPath) {
  // 直接生成 PowerShell 数组字面量：PowerShell 5.1 的 ConvertFrom-Json 对多元素
  // JSON 数组不会自动拆包，会把整个数组当成一个对象，导致 COM 参数收到数组而报错。
  const jobLines = jobs.map((j) => `  [pscustomobject]@{ src = ${psQuote(j.src)}; dst = ${psQuote(j.dst)} }`);
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$jobs = @(',
    ...jobLines.join(',\n').split('\n'),
    ')',
    `$resultPath = ${psQuote(resultPath)}`,
    '$out = @()',
    '$w = $null',
    'try {',
    '  $w = New-Object -ComObject Word.Application',
    '  $w.Visible = $false',
    '  $w.DisplayAlerts = 0',
    '  try { $w.AutomationSecurity = 3 } catch { }',
    '  foreach ($j in $jobs) {',
    '    $d = $null',
    '    try {',
    '      $d = $w.Documents.Open([string]$j.src, $false, $true)',
    '      $d.SaveAs2([string]$j.dst, 12)',
    '      $out += [pscustomobject]@{ src = $j.src; dst = $j.dst; ok = $true; err = "" }',
    '    } catch {',
    '      $out += [pscustomobject]@{ src = $j.src; dst = $j.dst; ok = $false; err = [string]$_.Exception.Message }',
    '    } finally {',
    '      if ($d) {',
    '        try { $d.Close(0) } catch { }',
    '        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($d) } catch { }',
    '      }',
    '    }',
    '  }',
    '} catch {',
    '  $msg = [string]$_.Exception.Message',
    '  foreach ($j in $jobs) {',
    '    $out += [pscustomobject]@{ src = $j.src; dst = $j.dst; ok = $false; err = $msg }',
    '  }',
    '} finally {',
    '  if ($w) {',
    '    try { $w.Quit() } catch { }',
    '    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) } catch { }',
    '  }',
    '  [GC]::Collect(); [GC]::WaitForPendingFinalizers()',
    '}',
    '$json = ConvertTo-Json -InputObject @($out) -Depth 4 -Compress',
    'if (-not $json) { $json = "[]" }',
    '[IO.File]::WriteAllText($resultPath, $json, (New-Object System.Text.UTF8Encoding($false)))',
  ];
  return lines.join('\n');
}

function readResults(resultPath) {
  try {
    const raw = fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return null; }
}

function runWord(jobs, sync) {
  const resultPath = path.join(TMP_DIR, `result_${crypto.randomBytes(4).toString('hex')}.json`);
  const script = buildWordScript(jobs, resultPath);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  const timeout = Math.min(300000, 60000 + jobs.length * 5000);
  const fallback = () => jobs.map((j) => ({
    src: j.src, dst: j.dst, ok: false, err: '转换进程未返回结果（Word 启动失败或已超时）',
  }));
  if (sync) {
    try {
      execFileSync('powershell.exe', args, { timeout, windowsHide: true, stdio: 'ignore' });
      return readResults(resultPath) || fallback();
    } catch {
      return readResults(resultPath) || fallback();
    } finally {
      try { fs.unlinkSync(resultPath); } catch { /* ignore */ }
    }
  }
  return new Promise((resolve) => {
    execFile('powershell.exe', args, { timeout, windowsHide: true }, () => {
      const r = readResults(resultPath) || fallback();
      try { fs.unlinkSync(resultPath); } catch { /* ignore */ }
      resolve(r);
    });
  });
}

function runSoffice(jobs, sync) {
  const exe = findSoffice();
  if (!exe) return null;
  const args = [
    '--headless', '--nologo', '--nofirststartwizard',
    '--convert-to', 'docx:MS Word 2007 XML', '--outdir', TMP_DIR,
    ...jobs.map((j) => j.src),
  ];
  const timeout = Math.min(300000, 60000 + jobs.length * 5000);
  try {
    if (sync) execFileSync(exe, args, { timeout, windowsHide: true, stdio: 'ignore' });
    else {
      return new Promise((resolve) => {
        execFile(exe, args, { timeout, windowsHide: true }, () => resolve(jobs.map((j) => ({
          src: j.src, dst: j.dst, ok: fs.existsSync(j.dst), err: fs.existsSync(j.dst) ? '' : 'LibreOffice 未生成目标文件',
        }))));
      });
    }
    return jobs.map((j) => ({
      src: j.src, dst: j.dst, ok: fs.existsSync(j.dst), err: fs.existsSync(j.dst) ? '' : 'LibreOffice 未生成目标文件',
    }));
  } catch (err) {
    return jobs.map((j) => ({ src: j.src, dst: j.dst, ok: false, err: String((err && err.message) || err) }));
  }
}

/** 执行一批转换（同步）；返回 Map<原路径, {ok, tmp, err}> */
function convertJobsSync(jobs) {
  const out = new Map();
  if (!jobs.length) return out;
  if (findSoffice()) {
    const r = runSoffice(jobs, true);
    if (r && r.some((x) => x.ok)) return finish(jobs, r, out);
  }
  return finish(jobs, runWord(jobs, true) || [], out);
}

/** 执行一批转换（异步，不阻塞 Electron 主进程）；返回 Promise<Map> */
async function convertJobsAsync(jobs) {
  const out = new Map();
  if (!jobs.length) return out;
  if (findSoffice()) {
    const r = await runSoffice(jobs, false);
    if (r && r.some((x) => x.ok)) return finish(jobs, r, out);
  }
  return finish(jobs, (await runWord(jobs, false)) || [], out);
}

function finish(jobs, results, out) {
  const bySrc = new Map((results || []).map((x) => [x.src, x]));
  for (const j of jobs) {
    const r = bySrc.get(j.src);
    // 目标 docx 在 prepareJobs 时已清空：文件真实存在即为转换成功，
    // 即使结果 JSON 因 PowerShell 版本差异解析失败也不会误判。
    const ok = fs.existsSync(j.dst);
    out.set(j.abs, {
      ok,
      tmp: ok ? j.dst : null,
      err: ok ? '' : String((r && r.err) || '未检测到可用的 Word / LibreOffice 转换器'),
    });
    if (ok) remember(j.abs, j.dst);
  }
  return out;
}

/** 为待转换文件准备 ASCII 临时路径（源文件只读复制，绝不改动原件） */
function prepareJobs(srcPaths) {
  ensureTmpDir();
  const jobs = [];
  for (const abs of srcPaths) {
    const hit = cached(abs);
    if (hit) continue;
    try {
      const base = jobNameFor(abs);
      const src = path.join(TMP_DIR, `${base}.doc`);
      const dst = path.join(TMP_DIR, `${base}.docx`);
      fs.copyFileSync(abs, src);
      try { fs.unlinkSync(dst); } catch { /* ignore */ }
      jobs.push({ abs, src, dst });
    } catch (err) {
      jobs.push({ abs, src: null, dst: null, err: String((err && err.message) || err) });
    }
  }
  return jobs;
}

/**
 * 批量预转换（在导入流程开始时异步调用一次，只启动一次转换器）
 * @param {string[]} paths 待处理文件路径（内部自行筛出真 .doc）
 * @returns {Promise<{ok:string[], failed:{path:string,reason:string}[]}>}
 */
async function preconvert(paths) {
  const targets = [];
  const seen = new Set();
  for (const p of paths || []) {
    const abs = path.resolve(p);
    if (seen.has(abs) || !isLegacyDoc(abs)) continue;
    seen.add(abs);
    targets.push(abs);
  }
  if (!targets.length) return { ok: [], failed: [] };

  const prepared = prepareJobs(targets);
  const copyErrors = new Map(prepared.filter((j) => j.err).map((j) => [j.abs, j.err]));
  const results = await convertJobsAsync(prepared.filter((j) => j.src));
  const ok = [], failed = [];
  for (const abs of targets) {
    if (cached(abs)) { ok.push(abs); continue; }
    const r = results.get(abs);
    if (r && r.ok) ok.push(abs);
    else failed.push({ path: abs, reason: copyErrors.get(abs) || (r && r.err) || '转换失败' });
  }
  return { ok, failed };
}

/**
 * 同步取得转换后的 .docx 路径；缓存未命中时同步转换兜底
 * （正常导入路径已由 preconvert 预热，这里主要服务于直接调用 maskFile 的场景）
 * @returns {string|null}
 */
function getConverted(filePath) {
  const abs = path.resolve(filePath);
  if (!isLegacyDoc(abs)) return null;
  const hit = cached(abs);
  if (hit) return hit;
  const jobs = prepareJobs([abs]).filter((j) => j.src);
  if (!jobs.length) return null;
  const results = convertJobsSync(jobs);
  const r = results.get(abs);
  return r && r.ok ? r.tmp : null;
}

/** 供 UI 展示的可读原因 */
function converterHint() {
  return findSoffice() ? 'LibreOffice 转换失败' : '未检测到 Microsoft Word / LibreOffice，无法自动转换 .doc';
}

module.exports = {
  LEGACY_EXTS, isLegacyName, isLegacyDoc, isOle2,
  preconvert, getConverted, converterHint,
};
