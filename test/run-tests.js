'use strict';
/**
 * 核心测试编排器：node test/run-tests.js（或 npm run test:core）
 *
 * 套件划分：
 *  - test/detector.test.js   检测规则（强 PII / 姓名语境 / 地址-机构 / 负例成对）
 *  - test/entities.test.js   中文实体结构规则与负例
 *  - test/two-pass.test.js   案卷级实体确认、传播与文件往返
 *  - test/masker.test.js     屏蔽引擎（编码格式 / 保留位 / 还原 / Office XML 映射）
 *  - test/fileproc.test.js   文件管道（编码识别 / txt-docx / 老式 .doc / PDF）
 *  - test/pdfflow.test.js    PDF 文本流规范化（段落拼接 / 空格剥除 / 字符级框）
 *  - test/image.test.js      图片 OCR 不可逆遮盖
 *  - test/app-units.test.js  应用单元（导入 / 索引 / 设置 / 剪贴板 / 灵动岛 / 布局 / 更新）
 *  - test/batch-summary.test.js 批量结果摘要（仅胶囊轮播文案）
 *  - test/regression.test.js 回归锁定（R-001..R-006 / 泄漏断言 / 一致性 / 门禁）
 *
 * 真实案卷套件（test/real-files.test.js）与 E2E（test/e2e.js）单独运行：
 *  - npm run test:real（门控：LINGYU_SAMPLES 或默认案卷目录存在）
 *  - npm run test:e2e
 */

const helpers = require('./helpers');
const { runAll, report } = helpers;

require('./detector.test.js');
require('./entities.test.js');
require('./two-pass.test.js');
require('./masker.test.js');
const registerPdfTests = require('./fileproc.test.js');
const registerImageTests = require('./image.test.js');
require('./pdfflow.test.js');
require('./app-units.test.js');
require('./batch-summary.test.js');
require('./regression.test.js');
require('./leakage-fixes.test.js');
require('./xmltext-entities.test.js');
require('./mask-style.test.js');

(async () => {
  try {
    await registerPdfTests(); // PDF 管道为异步：先注册，再统一执行
    await registerImageTests(); // 图片 OCR 管道同样异步注册
    const results = await runAll();
    const failed = report(results);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('测试编排异常:', e.stack || e);
    process.exit(1);
  }
})();
