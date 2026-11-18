'use strict';
/**
 * 智能处理流程（不生成工作副本）
 *  1. 直接读取拖入/选择的文件内容，按内容判断屏蔽或还原
 *  2. 只在根目录写出结果文件：「文件名_屏蔽.ext」或「文件名_还原.ext」
 *     —— 不再复制一份明文工作副本到根目录，根目录里只保留处理结果
 *  3. 「同名文件」设置作用于结果文件：保留两份（自动加序号）或覆盖同名
 *  4. 拖入的原位置文件永不改动；设置「移入回收站」时，处理完成后把根目录外的
 *     原位置文件移入系统回收站（可找回）
 */

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const {
  collectPaths, maskFile, restoreFile,
  maskedPathOf, restoredPathOf, outputNameOf, detectFileIntent, readFileText,
  LEGACY_EXTS, PDF_EXTS, isPdf, detectPdfIntent, maskPdfFile, restorePdfFile, readPdfText,
} = require('../core/fileproc');
const { preconvert } = require('../core/docconvert');
const { collectEntities, createEntities } = require('../core/entities');
const { isInsideRoot, resolveConflictName } = require('../core/imports');
const { TYPE_LABEL } = require('../core/masker');

function summarize(counts) {
  return Object.entries(counts || {})
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${TYPE_LABEL[t] || t}×${n}`)
    .join('、');
}

/**
 * 依同名策略算出结果文件路径。
 * virtual 只是沿用原有命名规则的「虚拟目标」，不会在磁盘上创建工作副本。
 */
function resolveOutputPath(root, src, intent, policy) {
  // .doc 的结果以 .docx 落地，冲突检测也必须按 .docx 名字计算
  const virtual = path.join(root, outputNameOf(path.basename(src)));
  const base = intent === 'restore' ? restoredPathOf(virtual) : maskedPathOf(virtual);
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const name = path.basename(base, ext);
  const resolved = resolveConflictName(dir, name, ext, policy);
  return { out: path.join(dir, resolved.name), base, action: resolved.action };
}

/**
 * @param {string[]} inputPaths 拖入/选择的原始路径（可含目录）
 * @param {{store, island}} ctx
 * @param {Electron.WebContents} [sender] 用于进度事件
 */
async function importAndMask(inputPaths, ctx, sender) {
  const { store, island } = ctx;
  const root = (store.settings.rootDir || '').trim();
  if (!root || !fs.existsSync(root)) {
    const done = {
      error: 'no-root', results: [], total: 0,
      masked: 0, restored: 0, restoredTotal: 0, restoreMissing: 0,
      alreadyMasked: 0, noPii: 0, skipped: 0, convertFailed: 0, convertReason: '',
      totalPII: 0, trashed: 0, importedCount: 0, overwritten: 0,
    };
    island.broadcast('mask:done', done);
    return done;
  }

  const rootNorm = /[\\/]$/.test(root) ? root.slice(0, -1) : root;
  const discard = store.settings.importBehavior === 'discard';
  const conflictPolicy = store.settings.conflictPolicy || 'keep';
  const files = collectPaths(inputPaths);
  const results = [];
  let totalPII = 0, vaultDirty = false, trashed = 0, overwritten = 0;

  // 老式 .doc（OLE2 二进制）批量预转换：一次启动转换器，结果缓存供后续
  // 内容读取、姓名预扫、屏蔽/还原共用。失败不中断其它文件，由 maskFile 给出明确提示。
  const legacyCount = files.filter((f) => LEGACY_EXTS.has(path.extname(f).slice(1).toLowerCase())).length;
  if (legacyCount > 0) island.broadcast('mask:converting', { count: legacyCount });
  const conversion = await preconvert(files);

  // 第一遍只看结构并收集实体，第二遍把同一张实体表套用到全案卷。
  // 文件间放入分隔块，避免上一文件的表头误配下一文件的首个单元格。
  const scanBlocks = [];
  let scanBudget = 8 * 1024 * 1024;
  for (const f of files) {
    if (scanBudget <= 0) break;
    try {
      const size = fs.statSync(f).size;
      if (size > 512 * 1024) continue;
      const text = isPdf(f) ? await readPdfText(f) : readFileText(f);
      if (!text) continue;
      scanBudget -= size;
      scanBlocks.push(...text.split(/\r?\n/), '\u0000');
    } catch { /* 读不出就跳过，不影响主流程 */ }
  }
  const knownEntities = scanBlocks.length
    ? collectEntities(scanBlocks, { toggles: store.settings.toggles })
    : createEntities();

  for (let i = 0; i < files.length; i++) {
    const src = files[i];
    if (sender && !sender.isDestroyed()) {
      sender.send('mask:progress', { i: i + 1, total: files.length, path: src });
    }
    let r;
    try {
      const pdf = isPdf(src);
      const intent = pdf ? await detectPdfIntent(src) : detectFileIntent(src);
      const { out, base, action } = resolveOutputPath(rootNorm, src, intent, conflictPolicy);

      // 结果路径恰好等于源文件（如根目录里名为 xxx_屏蔽 却无编码的文件）：
      // 既不覆盖源文件，也不重复屏蔽
      if (path.resolve(out) === path.resolve(src) || path.resolve(base) === path.resolve(src)) {
        r = { ok: false, path: src, action: intent, skipped: 'already-masked' };
      } else {
        if (action === 'overwrite') overwritten++;
        if (pdf) {
          r = intent === 'restore'
            ? await restorePdfFile(src, store.vault, out)
            : await maskPdfFile(src, store.vault, store.settings.toggles, out,
              { knownEntities, namesFile: store.paths.knownNames });
        } else if (intent === 'restore') {
          r = restoreFile(src, store.vault, out);
        } else {
          r = maskFile(src, store.vault, store.settings.toggles, out, undefined,
            { knownEntities, namesFile: store.paths.knownNames });
        }
        r.action = intent;
      }
      r.origPath = src;
      r.outputPath = out;

      // 丢弃模式只作用于根目录外的原位置文件；根目录里用户自己的文件绝不动。
      // 处理失败（含 .doc 转换失败、格式不支持、读取出错）时绝不移动原文件。
      if (discard && !isInsideRoot(src, rootNorm) && r.ok === true && r.skipped !== 'already-masked') {
        try {
          await shell.trashItem(src);
          r.trashed = true;
          trashed++;
        } catch { r.trashed = false; }
      }
    } catch (err) {
      r = { ok: false, path: src, skipped: 'error', reason: String((err && err.message) || err) };
    }

    if (r.ok && r.count > 0) {
      totalPII += r.count;
      vaultDirty = true;
      store.addHistory({
        origPath: r.origPath,
        maskedPath: r.maskedPath,
        count: r.count,
        counts: r.counts || {},
        summary: summarize(r.counts),
      });
      island.broadcast('history:changed');
    }
    results.push(r);
  }
  if (vaultDirty) {
    store.persistVault();
    // 本批新增了映射编码 → 通知界面刷新「映射 N 条」，无需重启才能看到
    island.broadcast('vault:changed', { size: store.vault.size });
  }

  const restoreResults = results.filter((r) => r.action === 'restore');
  const done = {
    results,
    total: files.length,
    masked: results.filter((r) => r.ok && r.action === 'mask' && r.count > 0).length,
    restored: restoreResults.filter((r) => r.ok && r.resolved > 0).length,
    restoredTotal: restoreResults.reduce((n, r) => n + (r.ok ? (r.resolved || 0) : 0), 0),
    restoreMissing: restoreResults.reduce((n, r) => n + ((r.missing && r.missing.length) || 0), 0),
    alreadyMasked: results.filter((r) => r.skipped === 'already-masked').length,
    noPii: results.filter((r) => r.ok && r.skipped === 'no-pii').length,
    skipped: results.filter((r) => r.skipped && !['no-pii', 'already-masked'].includes(r.skipped)).length,
    convertFailed: results.filter((r) => r.skipped === 'legacy-convert').length,
    convertReason: (conversion.failed[0] && conversion.failed[0].reason) || '',
    totalPII,
    trashed,
    importedCount: 0, // 不再生成工作副本；保留字段兼容渲染层
    overwritten,
  };
  island.broadcast('mask:done', done);
  return done;
}

module.exports = { importAndMask, summarize, resolveOutputPath };
