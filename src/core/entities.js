'use strict';
/**
 * 中文实体检测：只使用结构，不使用具体实体黑白名单。
 *
 * 1. 姓名只由身份字段、人称前缀、人口学属性、表格相邻块、冒号字段行
 *    嵌套职务名词（封闭角色表）确认；锚点后 + 案卷叙述动词/罪名等后边界
 *    也可闭合（无需标点）。普通名词/职业泛称有封闭守卫表，不误判为姓名；
 * 2. 自由语境的人称候选至少复现两次，且左右上下文均不唯一，才可确认；
 * 3. 地址必须含道路、门牌、楼栋、村组等居住要素；
 * 4. 机构必须有机构后缀、至少 6 字且不超过 18 字，并含 省/市/县/区/镇/村
 *    层级信息（或命中固定省市词典）；无层级信息的机构不再屏蔽；
 *    仅排除数量泛指（一家宾馆/某公司），不再排除公权力机关等类别。
 * 5. 已确认实体按原值传播，未确认候选不猜测、不屏蔽。
 */

const crypto = require('crypto');

const ORG_SUFFIXES = [
  '律师事务所', '会计师事务所', '税务师事务所', '事务所',
  '有限责任公司', '股份有限公司', '有限公司', '股份公司', '集团公司',
  '师资培训中心', '职业培训学校', '职业技能培训学校', '技术学校',
  '人民检察院', '人民法院', '村民委员会', '居民委员会',
  '社区卫生服务中心', '服务中心', '培训中心', '人民政府',
  '检察院', '法院', '公安局', '派出所', '司法所', '法庭',
  '公司', '集团', '合作社', '学校', '中学', '小学', '大学', '幼儿园',
  '工作室', '门市部', '支行', '宾馆', '酒店', '超市', '工厂',
  '银行', '医院', '中心', '村委会', '理事会', '委员会', '工会',
  '协会', '商会', '研究院', '研究所', '管理处', '管理局',
  // 常见后缀补充：行政机关 / 文教卫生 / 生活服务 / 生产场所
  '农业农村局', '市场监管局', '管理委员会', '管委会', '办事处',
  '居委会', '村委会', '疾控中心', '服务站', '供电所',
  '卫生院', '门诊部', '诊所', '药房', '药店', '福利院', '敬老院', '养老院',
  '学院', '党校', '出版社', '报社', '书社', '书店',
  '文化馆', '图书馆', '博物馆', '纪念馆', '展览馆', '体育馆',
  '旅行社', '供销社', '信用社', '基金会', '商行', '分行',
  '农场', '林场', '牧场', '印刷厂', '汽修厂', '总厂',
  '加油站', '收费站', '车管所', '汽车站', '火车站',
  '税务局', '财政局', '教育局', '民政局', '人社局', '住建局',
  '审计局', '水务局', '烟草局', '邮政局', '海关',
  '饭店', '酒楼', '餐厅', '影院', '剧院', '设计院',
].sort((a, b) => b.length - a.length);

const ORG_SUFFIX_RE = new RegExp(ORG_SUFFIXES.join('|'), 'g');
const ORG_TAIL_RE = new RegExp(`(?:${ORG_SUFFIXES.join('|')})$`);

/* ---------------- 机构行政层级：统一「某X……后缀」屏蔽的前提 ---------------- */

// 按后缀表取最长命中（表已按长度降序），供层级判定剥出字号。
function findOrgSuffixOf(value) {
  return ORG_SUFFIXES.find((s) => value.endsWith(s)) || '';
}

// 层级字：字号里出现 省/市/县/区/镇/村 即按该层级屏蔽（取最末次出现，
// 「江苏省淮安市涟水县…」取县）；不含层级字时按固定词典兜底：
// 直辖市/省会/主要城市 → 某市（南京），省份全名 → 某省（江西）；
// 两者皆无的机构不再按机构屏蔽。
const ORG_LEVEL_SCAN_RE = /[省市县区镇村]/g;
const ORG_CITY_RE = /(?:北京|天津|上海|重庆|石家庄|太原|呼和浩特|沈阳|长春|哈尔滨|南京|杭州|合肥|福州|南昌|济南|郑州|武汉|长沙|广州|南宁|海口|成都|贵阳|昆明|拉萨|西安|兰州|西宁|银川|乌鲁木齐|深圳|苏州|青岛|大连|厦门|宁波|无锡|佛山|东莞|珠海|温州|常州|南通|烟台|潍坊|泉州|漳州|绍兴|嘉兴|金华|台州|中山|惠州|汕头|湛江|江门|湖州|洛阳|襄阳|宜昌|唐山|保定|徐州|扬州|镇江|盐城|淮安|连云港|临沂|济宁|淄博|威海|九江|赣州|宜春|衡阳|株洲|岳阳|常德)/;
const ORG_PROVINCE_RE = /(?:河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|香港|澳门|台湾)/;

function orgLevelOf(value) {
  const s = String(value || '');
  const suffix = findOrgSuffixOf(s);
  const brand = suffix ? s.slice(0, s.length - suffix.length) : s;
  ORG_LEVEL_SCAN_RE.lastIndex = 0;
  let m;
  let level = '';
  while ((m = ORG_LEVEL_SCAN_RE.exec(brand)) !== null) level = m[0];
  if (level) return level;
  if (ORG_CITY_RE.test(brand)) return '市';
  if (ORG_PROVINCE_RE.test(brand)) return '省';
  return '';
}
const HAN_RE = /^[\u4e00-\u9fa5]+$/;
const NAME_RE = /^[\u4e00-\u9fa5]{2,8}(?:·[\u4e00-\u9fa5]{2,8})?$/;
const NAME_BAD_CHAR_RE = /[的了吗呢吧啊呀嘛了着过不没]/;
const NAME_ROLE_TAIL_RE = /[人员者师长犯告象方罪]$/;
const ADMIN_TAIL_RE = /(?:省|自治区|自治州|地区|市|区|县|旗|盟|镇|乡|街道|苏木|村|社区)$/;
// 单字虚词（介词/连词/副词）作尾：三字以上的姓名不会这样收尾，命中即不是姓名。
// 只作用于 ≥3 字候选，2 字姓名（张和、李向）不受影响。
const NAME_TAIL_PARTICLE_RE = /[因由被系向对经从给替把将并而则就都也还又再已未没不很更最]$/;
const ADMIN_FOLLOW_RE = /^(?:省|自治区|自治州|地区|市|区|县|旗|盟|镇|乡|街道|苏木|村|社区)/;
const PHYSICAL_END_RE = /[，,。；;、：:（）()\s]/;
const VERB_USE_AFTER_RE = /[了着过]/;

// 非人物名词守卫：这些词在「角色词 + 名词」结构里是字段值、职业或泛称，
// 不是姓名（负责人：经理 / 证人：证言 / 婴儿，男）。用封闭词表而非词尾形态，
// 避免误伤真实姓名（王芳、陈阿满、李长顺等均不在表内）。
const NON_PERSON_NOUNS = new Set([
  '经理', '总经理', '董事长', '主管', '主任', '组长', '队长', '校长', '院长', '局长', '处长', '科长',
  '法官', '检察官', '律师', '医生', '医师', '教师', '老师', '学生', '警察', '司机', '会计', '出纳',
  '书记', '秘书', '代表', '委员', '专家', '学者', '工人', '农民', '干部', '领导', '同事', '朋友',
  '家人', '亲属', '亲戚', '妻子', '丈夫', '儿子', '女儿', '孩子', '儿童', '婴儿', '老人', '病人',
  '患者', '乘客', '旅客', '顾客', '客户', '用户', '人员', '员工', '职工', '会员', '股东', '法人',
  '情况', '意见', '主张', '职务', '身份', '地址', '电话', '姓名', '名字', '性别', '年龄', '民族',
  '证言', '证词', '笔录', '材料', '证据', '结论', '结果', '理由', '事实', '问题', '事项', '内容',
  '名单', '名册', '记录', '登记', '签名', '盖章', '表示', '同意', '反对', '申请', '说明',
  // 时间/指代词：冒号字段后常见（「被告人：现在，……」），一旦被确认为姓名
  // 会经原值/哈希在全案卷传播（「检察院现在给你做不起诉」→ 现*）。
  '现在', '当时', '目前', '如今', '今日', '昨日', '当日', '当天', '当场', '当庭', '当年',
  '近日', '近期', '立即', '同时', '此前', '之前', '以后', '之后', '今后', '本案', '该案', '本次',
  // 语法虚词 / 言语行为词：作为冒号字段值出现时一律不是姓名。
  // 这里是**语义封闭类**（连词、副词、介词、情态词、言语动词），不是姓名或
  // 姓氏清单——它们的共同点是「不能指称某个人」，因此可以穷举，也不会误伤真名。
  '应当', '应到', '应负', '尚需', '尚无', '尚未', '包括', '包含', '查明', '查询',
  '同意', '同案', '能否', '会议', '要求', '需要', '有权', '无权',
  '依法', '依据', '根据', '按照', '经查', '另查', '此外', '另外', '随即', '为证',
  '属实', '在逃', '未到', '供述', '辩解', '陈述', '认罪', '自愿', '如实', '必须',
  '可以', '已经', '属于', '作为', '认为', '上述', '如下', '及其', '其中', '故此',
  '但是', '仍需', '还需', '均有', '均已', '皆系', '均系', '有待', '待查', '不详', '是否', '有无',
  // 文书对象名词：是案件/卷宗本身，不能指称自然人。
  '案件', '案卷', '案情', '卷宗',
  // 状态副词：修饰后面的谓语（「辩护人详细查阅卷宗」），不能指称自然人。
  '详细', '仔细', '认真', '逐一', '反复', '多次', '亲自', '主动', '积极', '及时', '按时', '共同', '分别',
  // 序数/时间副词：属于封闭的语法副词类，不能指称某个人
  // （「被告人最后陈述」曾被确认为姓名「最后」）。
  '最后', '首先', '其次', '再次', '起初', '最初', '之后', '之前', '以后', '以前',
]);
function isNonPersonNoun(value) {
  return NON_PERSON_NOUNS.has(String(value || ''));
}

// 「冒号后是一句话还是字段值」——替代姓氏表/姓名白名单的核心判据。
// 真实身份字段（「被会见人：裴钱」「原告：张三，南检刑诉〔2026〕1号」）在值之后
// 只剩字段续接；而「审判长：现在，你可以走了」「被害人：有权，请记录在案」的
// 冒号后其实是一整句话，句首那两三个字是句子成分，不是姓名。
// 判据只依赖标点切分后的结构：话语里会出现人称代词、情态助动词、请求语。
// 这是封闭的语法类（代词/助动词），不是姓名或姓氏清单。
const SPEECH_MARK_RE = /(?:你|我(?!方)|他(?!人)|她|您|咱|请|是否|能否|可以|应当|应该|必须|需要|同意|如实|自愿)/;

/** 姓名之后、本句之内剩下的内容；句子已结束则返回空串 */
function clauseRest(text, end) {
  const next = text[end] || '';
  if (!next || /[。；;\n]/.test(next)) return '';
  let i = end;
  if (/[，,、：:]/.test(next)) i++;
  const rest = text.slice(i);
  const stop = rest.search(/[。；;\n]/);
  return (stop < 0 ? rest : rest.slice(0, stop)).trim();
}

/** 冒号引出的是「一句话」（话语/告知）还是「字段值」 */
function isSpeechClause(text, end) {
  const rest = clauseRest(text, end);
  return !!rest && SPEECH_MARK_RE.test(rest);
}

// 字段/日期/身份类词：出现在姓名候选里基本一定是误判（「日出生」「出生日期」
// 「身份证号」）。这是按语义类别判断，不是姓名清单——实测旧缓存里的「日出生」
// 种子会把「2010年02月08日出生」遮成「日*生」。
const FIELD_WORD_RE = /(?:出生|日期|年月|民族|籍贯|住址|地址|年龄|性别|号码|证号|身份|电话|单位|职务|学历)/;
function isFieldPhrase(value) {
  return FIELD_WORD_RE.test(String(value || ''));
}

function validName(value) {
  const s = String(value || '');
  return NAME_RE.test(s)
    && !NAME_BAD_CHAR_RE.test(s)
    && !NAME_ROLE_TAIL_RE.test(s)
    && !ADMIN_TAIL_RE.test(s)
    && !ORG_TAIL_RE.test(s)
    // 单字虚词不能收尾：三字以上的姓名不会以介词/连词/副词结尾。
    // 「受援人因涉嫌犯盗窃罪」的「受援人因」（角色词+介词）曾被子句锚点确认。
    && !(s.length >= 3 && NAME_TAIL_PARTICLE_RE.test(s));
}

function item(type, start, end, value, confident) {
  return { type, start, end, value, confident: confident !== false };
}

function createEntities() {
  return { name: new Set(), org: new Set(), address: new Set() };
}

function copyInto(target, source) {
  for (const type of ['name', 'org', 'address']) {
    const values = source && source[type];
    if (!values) continue;
    for (const value of values) if (value) target[type].add(value);
  }
  return target;
}

function mergeEntities(...sources) {
  const out = createEntities();
  for (const source of sources) copyInto(out, source);
  return out;
}

function knownFromOptions(options = {}) {
  const known = mergeEntities(options.knownEntities);
  if (options.knownNames) for (const v of options.knownNames) known.name.add(v);
  if (options.knownPlaces) for (const v of options.knownPlaces) known.address.add(v);
  return known;
}

function hashName(name) {
  return crypto.createHash('sha256').update('maskname\x00' + String(name || '')).digest('hex');
}

/* ---------------- 姓名：三种身份结构位 ---------------- */

// 人称前缀只按词尾形态识别，不枚举具体角色。前缀内部允许空白，
// 以兼容「审　判　长　张三」这类排版；角色后的序号和括注不属于姓名。
const ROLE_PREFIX_RE = /[\u4e00-\u9fa5](?:[\t \u3000]*[\u4e00-\u9fa5]){0,10}[\t \u3000]*(?<![他她它其该本众各每这那])(?:人|员|者|师|长|告|象)[\t \u3000]*(?:[一二三四五六七八九十\d]{1,2})?[\t \u3000]*(?:[（(][^）)\n]{0,10}[）)])?[\t \u3000]*[:：]?[\t \u3000]*/g;
// 角色词尾字（人/员/者/师/长/告/象）与虚词末字同形：连词「或者」的「者」曾被
// 当成角色尾，把「对记载有遗漏或者差错提出补充」的「差错」确认成姓名并经哈希
// 传播到全案卷。这组虚词是封闭的语法类，命中即不当锚点（「记者/作者/患者」等
// 实词不受影响）。
const ROLE_TAIL_FUNCTION_RE = /(?:或者|接着|随着|沿着|当着|照着|本着|为着|乃者|庶几)$/;
// 「告」结尾的动词同样与角色词尾同形，但不是身份名词：
// 「应当宣告缓刑：」曾把「缓刑」当姓名确认（宣告 + 缓刑 + 冒号）。
// 「被告/原告/控告人」等真实角色词不受影响（只排除这些动词本身）。
const ROLE_TAIL_VERB_RE = /(?:宣告|报告|控告|通告|公告|布告|函告|警告|禀告|上报|转告|告知)$/;
// 角色词后直接跟「作/进行/予以…」这类**只带动作宾语**的谓语时，其后是动作短语
// 而不是姓名（「现在由被告人作最后陈述」→「作最后」曾被确认）。这些动词的宾语位
// 只会是行为（陈述/辩解/回答），因此整段放弃；与「担任/接受」不同——那两个的
// 宾语位可以是人，所以跳过谓语继续取（「本律师担任裴钱」）。封闭谓词类，不查姓名表。
const ACTION_VERB_HEAD_RE = /^(?:作|作出|进行|予以|给予|加以|参与|协助|配合|陪同|提出|表示|发表|宣读|回答|答复|陈述|辩解|拒绝|申请|核对|查阅|听取|补充|说明|供述|承认|否认|同意)/;
// 姓名字段的变体：既可能是「姓名：张三」，也可能是行文里的
// 「姓名为王东」「客户名称为“王东”」「户名王五」——后三种没有冒号，
// 值后通常跟「的」或引号，属于弱字段（见 fieldLoose）。
const NAME_FIELD_RE = /(?:姓名|名字|户名|开户名|账户名称|客户名称|账户名)\s*(?:[:：]|为|是)\s*[“"‘']?\s*/g;
// 头衔/关系名词锚点：尾字不在「人/员/者/师/长/告/象」里的职务与关系词
// （总经理/经理/主任/总裁/总监/学生/医生…）同样是身份结构，是封闭的职务词类，
// 不是姓名清单。没有这类锚点，「总经理刘星」「我学生王东」会整段漏遮。
const TITLE_ANCHOR_RE = /(?:副总经理|总经理|客户经理|项目经理|部门经理|业务经理|经理|副董事长|董事长|董事|主任|副总裁|总裁|总监|主管|会计|出纳|学生|同学|同事|朋友|徒弟|邻居|医生|护士|法人代表|员工)\s*[:：]?\s*/g;
const DEMOGRAPHIC_RE = /(?:^|[\s，,。；;、：:（）()【】\[\]])([\u4e00-\u9fa5]{2,4})(?=\s*[，,]\s*(?:男|女|\d{1,3}\s*岁|\d{2,4}\s*年[^，,。]{0,20}出生|公民身份号码|居民身份号码|身份号码|身份证号码))/g;
// 少数民族长名/带间隔号姓名：仅人口学闭合路径允许 5~8 字与「·」，
// 且必须以分隔符或开头锚定，避免吞进「当事人李四」这类角色词+姓名。
const DEMOGRAPHIC_LONG_RE = /(?:^|[\s，,。；;、：:（）()【】\[\]])([\u4e00-\u9fa5]{5,8}|[\u4e00-\u9fa5]{2,8}·[\u4e00-\u9fa5]{2,8})(?=\s*[，,]\s*(?:男|女|\d{1,3}\s*岁|公民身份号码|居民身份号码|身份号码|身份证号码))/g;
const CLOSED_NAME_LIST_RE = /^、[\u4e00-\u9fa5]{2,3}(?:、[\u4e00-\u9fa5]{2,3})*(?:等人|[二两三四五六七八九十\d]{1,2}人)/;
// 姓名后紧跟叙述动词时视为行为人姓名，长短候选均可确认：
// 「负责人张罗贿赂14万元」的「张罗」只能是姓名（动词「张罗」不可能带贿赂宾语+金额）。
// 扩展为案卷高频罪名/叙述动词，修复「审判长张三宣布开庭」「被告人欧阳明盗窃财物」
// 这类无边界句子——它们原本因 wholeRun 整段汉字超长而整段放弃。
// 严格排除庭审动作/状态词（到庭、出庭、开庭、休庭、在场、签字…）：
// 「原告欧阳明到庭」「村医周济世到场」「张三同意」仍是负例，动作词是句子的谓语而非姓名后叙述。
const CRIME_FOLLOW_RE = /^(?:贿赂|受贿|行贿|索贿|贪污|挪用|侵占|私分|诈骗|盗窃|抢劫|抢夺|敲诈|勒索|故意伤害|过失致|非法拘禁|绑架|强奸|猥亵|非法吸收|集资诈骗|职务侵占|渎职|滥用职权|徇私舞弊|报复陷害|刑讯逼供|涉嫌|伙同|纠集|结伙|窜至|途经|翻墙|入户|盗走|窃得|骗取|销赃|分赃|退赔|退还|到案|归案|抓获|羁押|逮捕|移送|侦查|立案|取保|担任|接受|指派|承办|办理|会见|查阅|复制|通知|告知|决定|批准|审理|审查|核实|确认|宣布|判处|辩称|供述|陈述|声称|主张|要求|拒绝|承认|否认|指认|辨认|证实|作证|提起诉讼|提出异议|提出|表示同意|作最后|作陈述|作无罪|作有罪)/;

/* ---------------- 字段行嵌套角色词：「合议庭成员：审判员李舟」 ---------------- */

// 冒号字段行内、嵌套角色词后的短姓名与主扫描共用一组防误遮守卫：
// 审判员出庭/书记员记录/证人：到庭是动词短语，附：证人名单是名册短语，
// 在记录/已到庭以句首功能字开头——它们与「角色词+姓名」结构同形，一律不确认。
const PHRASE_HEAD_BAD_RE = /^[在已正将要该各均皆无每某]/;
const PHRASE_VERB_BAD_RE = /(?:出庭|入庭|开庭|休庭|闭庭|退庭|复庭|到庭|提审|宣判|宣布|传唤|起立|坐下|落座|肃静|安静|候审|带到|带入|记录|回避|缺席|签名|告知|会见|述职|值庭|阅卷|参与|参加|陪同|陈述|答辩|举证|质证|宣读|讯问|发问|作证|签字|盖章|捺印|到场|到案|在逃|出示|出具|展示|提供|提交|调取|负责|担任|主管|分管|兼任|任职|调任|主持|主抓|名单|名册|花名|登记|签到|表明|说明|发表|举行|召开)$/;
const PHRASE_TAIL_BAD_RE = /[册表簿单页栏]$/;

// 嵌套角色词用封闭职务名词表精确匹配。纯词尾形态会把庭审叙述拆出伪姓名：
// 「请公诉人及其他诉讼参与人入庭」→「入庭」、「核对被告人身份」→「身份」
// （2026-11-20 开庭笔录审计两轮实证，毒哈希曾入缓存）。角色词是文书封闭
// 词汇，与 ADDRESS_GUIDE_RE 同理按表识别；仅限本嵌套路径，主扫描词尾形态不变。
const NEST_ROLES = new Set([
  '审判长', '审判员', '人民陪审员', '陪审员', '书记员', '公诉人', '检察员', '检察官',
  '原告', '原告人', '被告', '被告人', '原审原告', '原审原告人', '原审被告', '原审被告人',
  '上诉人', '被上诉人', '申诉人', '被申诉人', '申请执行人', '被执行人',
  '申请人', '被申请人', '复议申请人', '第三人', '诉讼代理人',
  '法定代表人', '法定代理人', '代表人', '负责人', '代理人',
  '委托代理人', '委托诉讼代理人', '辩护人', '被害人', '自诉人', '监护人',
  '证人', '鉴定人', '翻译人', '附带民事诉讼原告人', '附带民事诉讼被告人',
]);

// 字段作用域止于句末标点/换行；段间以顿号、逗号、空白分隔
//（「审判员李舟、人民陪审员王五」「审判员李舟 审判员王五」）。
const NEST_SCOPE_END = '。？！；\n\r';
const NEST_SEG_BREAK = new Set(['、', '，', ',', ' ', '\t', '\u3000']);

/** 在冒号字段作用域内按「嵌套角色词（≥2 字）+ 2~3 字整段姓名」成对解析 */
function scanNestedPairs(text, from, confirmed) {
  let end = from;
  while (end < text.length && !NEST_SCOPE_END.includes(text[end])) end++;
  let i = from;
  while (i < end) {
    while (i < end && NEST_SEG_BREAK.has(text[i])) i++;
    const segStart = i;
    while (i < end && !NEST_SEG_BREAK.has(text[i])) i++;
    // 角色词=段首起、精确命中职务名词表的紧凑名词；余段 2~3 字整段为姓名候选。
    // 守卫失败即止（更靠前的尾字只会得到更长的余段），避免「带被告人入庭」
    // 在「入庭」被拦后退而确认伪姓名「人入庭」。
    for (let j = i - 1; j >= segStart + 2; j--) {
      if (!NEST_ROLES.has(text.slice(segStart, j))) continue;
      const value = text.slice(j, i);
      if (value.length < 2) continue;
      if (value.length > 3) break;
      if (!validName(value) || value === '姓名' || value === '名字') break;
      if (isNonPersonNoun(value) || isFieldPhrase(value)) break;
      if (PHRASE_HEAD_BAD_RE.test(value)) break;
      if (value.length === 2 && PHRASE_VERB_BAD_RE.test(value)) break;
      if (value.length === 3 && PHRASE_TAIL_BAD_RE.test(value)) break;
      confirmed.push({ start: j, end: i, value, raw: value });
      break;
    }
  }
}

function roleCandidates(text) {
  const confirmed = [];
  const ambiguous = [];
  const scan = (re, field) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const prefix = m[0];
      const compact = prefix.replace(/[\s：:（）()]/g, '');
      // 「或者/接着/随着」的末字与角色词尾同形，不是身份锚点。
      // 告尾动词要看下一个字：「…义务告知你」的锚点只截到「告」，
      // 补上后一个字才看得出这是「告知」而不是角色词。
      const tailOne = compact + (text[m.index + m[0].length] || '');
      if (ROLE_TAIL_FUNCTION_RE.test(compact)
        || ROLE_TAIL_VERB_RE.test(compact) || ROLE_TAIL_VERB_RE.test(tailOne)) continue;
      // 「原告方 / 被告方」是集合指代，不是等待填写姓名的字段。
      if (/(?:告|人|犯|象|双|各|一|二|两|三|四|五|六|七|八|九|十|多)方(?:[一二三四五六七八九十\d]{1,2})?$/.test(compact)) continue;
      let start = m.index + prefix.length;
      // 连续汉字串；少数民族姓名允许一个间隔号（阿依古丽·买买提）。
      let run = /^[\u4e00-\u9fa5]+(?:·[\u4e00-\u9fa5]+)?/.exec(text.slice(start));
      if (!run) continue;
      // 身份类谓语：角色词后先接谓语、姓名落在宾语位
      // （「本律师担任裴钱涉嫌盗窃罪一案」）。跳过谓语再取，锚点仍然有效；
      // 允许多个连续谓语（「接受委托担任…」「接受指派担任…」），
      // 不在谓词表里的连续串一律不跳，避免把叙述句里的词语当姓名。
      for (let hop = 0; hop < 4; hop++) {
        const vs = /^(?:担任|接受|指派|委托|聘请|承办|办理|会见)/.exec(run[0]);
        if (!vs) break;
        start += vs[0].length;
        run = /^[\u4e00-\u9fa5]+(?:·[\u4e00-\u9fa5]+)?/.exec(text.slice(start));
        if (!run) break;
      }
      if (!run) continue;
      const raw = run[0];
      // 角色词后直接是「作/进行/予以/提出…」：宾语位是行为而非人
      //（「被告人作最后陈述」「被告人提出异议」），整段没有姓名。
      if (!field && ACTION_VERB_HEAD_RE.test(raw)) continue;
      const colon = field || /[:：]/.test(prefix);
      // 弱字段（「姓名为王东」「客户名称为“王东”」）没有冒号排版，值后必须
      // 紧跟「的」/引号/标点/段末，且不超过 4 字——否则会把「王东的中国建设银行
      // 银行卡」整段当成一个姓名。
      const fieldLoose = field && !/[:：]/.test(prefix);
      const formatted = /[\t \u3000]/.test(prefix.replace(/[:：]/g, ''));
      const personMarked = /被[\u4e00-\u9fa5]{0,4}人$/.test(compact);
      const colon2 = colon;
      const formatted2 = formatted;
      // 候选长度上限按锚点强度区分：
      //  - 「姓名：」字段是强锚点，允许 2~6 字（含复姓/少数民族长名），
      //    才能确认「姓名：审判员李长顺」「姓名：阿依古丽买买提」；
      //  - 普通人称角色词前缀保持 2~4 字，避免把「公诉人：被告人王五」
      //    整体吞成「被告人王五」而盖掉嵌套路径的「王五」。
      const maxLen = fieldLoose ? 4 : (field || raw.includes('·') ? 12 : 4);
      // 「连续汉字串里最先出现的叙述动词」就是姓名的右边界上限：
      // 「裴钱涉嫌盗窃罪一案」中「涉嫌」起点是 2，姓名不得越过它，否则会把
      // 谓语吞进姓名（实测遮成「裴*嫌」）。含间隔号的长名结构明确，不收敛。
      // 只做收敛不做放宽，不引入任何姓氏/姓名清单。
      let verbAt = raw.length;
      if (!raw.includes('·')) {
        for (let i = 0; i < raw.length; i++) {
          if (CRIME_FOLLOW_RE.test(raw.slice(i))) { verbAt = i; break; }
        }
      }
      const limitLen = Math.min(maxLen, verbAt);
      const accepted = [];
      for (let len = 2; len <= Math.min(limitLen, raw.length); len++) {
        const value = raw.slice(0, len);
        if (!validName(value) || value === '姓名' || value === '名字') continue;
        if (isNonPersonNoun(value)) continue; // 经理/证言/意见/婴儿等泛称不是姓名
        if (isFieldPhrase(value)) continue; // 日出生/出生日期/身份证号等字段词
        // 姓名不以连词收尾：「杨素侠与被申请人」的 4 字候选会借 passiveClosed
        // 闭合（下一字恰是「被」），「X与被Y」是并列结构信号，姓名止于连字之前。
        if (/[与和及或同跟]$/.test(value)) continue;
        // 否定副词/诉讼负面词开头不是姓名：「被申请人未足额支付」曾借 personMarked
        // 进入两遍式候选，再因子串复现凑齐统计被误确认成姓名「未足额」。
        if (NEGATIVE_HEAD_RE.test(value)) continue;
        // 「姓名：审判员李长顺」：字段值以嵌套角色词开头时，角色词本身及其
        // 片段都不是姓名（否则会把「审判」遮掉）；整段交给 scanNestedPairs
        // 按「角色词 + 姓名」精确剥出「李长顺」。
        if (field) {
          const role = [...NEST_ROLES].find((r) => raw.startsWith(r));
          if (role) continue;
        }
        const end = start + len;
        const after = text[end] || '';
        if (VERB_USE_AFTER_RE.test(after) || ADMIN_FOLLOW_RE.test(text.slice(end))) continue;
        // 庭审指令/名册短语在任何闭合路径下都不算姓名。此前只有「排版/字段」
        // 闭合检查这两张表，「审判长开庭审理本案」因后随动词「审理」走叙述闭合，
        // 把「开庭」确认成了姓名。
        if (PHRASE_VERB_BAD_RE.test(value) || PHRASE_TAIL_BAD_RE.test(value)) continue;
        // 冒号锚点：值后是否还跟着一句「话语/描述」而非字段续接内容。
        // 「被会见人：裴钱」「原告：张三，南检刑诉〔2026〕1号」→ 字段值；
        // 「审判长：现在，你可以走了」「被害人：有权，请记录在案」→ 冒号后是
        // 句子（代词/助动词/请求语），冒号处的两字只是句子成分，不是姓名。
        const speechLike = colon2 && (isSpeechClause(text, end) || SPEECH_MARK_RE.test(value));
        const wholeRun = len === raw.length;
        const demographicClosed = wholeRun && /^\s*[，,]\s*(?:男|女|\d{1,3}\s*岁|\d{2,4}\s*年[^，,。]{0,20}出生|公民身份号码|居民身份号码|身份号码|身份证号码)/.test(text.slice(end));
        // 后随案卷叙述动词/罪名即确认（锚点 + 后边界，无需整段吃掉）：
        // 「审判长张三宣布开庭」「被告人欧阳明盗窃他人财物」。
        const narrationClosed = CRIME_FOLLOW_RE.test(text.slice(end));
        // 「姓名 + 的 + 身份/亲属名词」是文书里的所有格结构
        // （「本律师担任张三的辩护人」）：「的」紧贴姓名即为右边界。
        // 「杨素侠的委托」同样是强结构（委托人是当事人），代理词高频句式；
        // 后接必须是身份/亲属/权属类名词，「原告肖像的照片」这类普通名词组合不算。
        const possessiveClosed = len <= 3 && after === '的'
          && /^的(?:辩护人|代理人|诉讼代理人|委托代理人|律师|家属|亲属|监护人|法定代表人|代表人|近亲属|意见|陈述|供述|辩解|行为|身份|账户|卡|卡号|账号|银行卡|存折|工资卡|社保卡|手机号|身份证|财产|住所|联系方式|授权|委托|[\u4e00-\u9fa5]{0,6}(?:卡号|银行卡|工资卡|社保卡|存折|账号))/.test(text.slice(end));
        // 「姓名 + 逗号 + 叙述动词」（「本律师会见裴钱，了解案件情况」）。
        const commaClosed = len <= 3
          && /^[，,]\s*(?:了解|询问|核实|听取|查阅|复制|会见|提出|要求|表示|陈述|辩称|供述|承认|否认|交代)/.test(text.slice(end));
        // 「姓名 + 因 + 涉嫌/罪名」是案卷高频句式（「受援人王芳因涉嫌犯盗窃罪」）：
        // 「因」本身是介词，不能作为姓名结尾，它后面紧跟的才是谓语。
        const causeClosed = len <= 3 && after === '因'
          && CRIME_FOLLOW_RE.test(text.slice(end + 1));
        // 「姓名 + 被 + 谓语」：校长沙悟净被组织留置 → 沙悟净是承受动作的人。
        const passiveClosed = len <= 4 && after === '被';
        // 普通角色字段：默认 2~3 字；4 字以上须有字段/人口学/后随动词支撑。
        const lengthClosed = len <= 3 || field || demographicClosed || narrationClosed;
        const listClosed = lengthClosed && wholeRun && after === '、'
          && (colon2 || CLOSED_NAME_LIST_RE.test(text.slice(end)));
        // 原 physicallyClosed 保留（标点/排版边界），但放宽 wholeRun 约束：
        // 角色词 + 姓名 + 标点 即可闭合，不要求姓名吃掉后面整段汉字——
        // 「原告：张三，南检刑诉…」里张三后接逗号也确认。
        // 姓名后跟冒号也是字段式右边界（「审判长张三：现在核对身份」）；
        // 冒号在前缀里（「审判长：现在…」）时仍走 speechLike 判定。
        const nameColon = after === '：' || after === ':';
        const physicallyClosed = lengthClosed && (colon2 || formatted2 || nameColon)
          && (PHYSICAL_END_RE.test(after) || !after)
          && !PHRASE_HEAD_BAD_RE.test(value)
          && !(value.length === 2 && PHRASE_VERB_BAD_RE.test(value))
          && !(value.length === 3 && PHRASE_TAIL_BAD_RE.test(value));
        // 「姓名：审判员李长顺」这类字段后半段无标点时，字段锚点本身即强证据。
        const fieldLooseClosed = fieldLoose
          && (/^的/.test(text.slice(end)) || !after || after === '”' || after === '"' || after === '’'
            || PHYSICAL_END_RE.test(after));
        const fieldClosed = field && lengthClosed && !PHRASE_HEAD_BAD_RE.test(value)
          && !(value.length === 2 && PHRASE_VERB_BAD_RE.test(value))
          && (!fieldLoose || fieldLooseClosed);
        const candidate = { start, end, value, raw };
        const closed = listClosed || physicallyClosed || demographicClosed || narrationClosed
          || fieldClosed || possessiveClosed || commaClosed || causeClosed || passiveClosed;
        // 冒号后是句子（而非字段值）时，冒号处的字词一律不当姓名——
        // 例外是「姓名：」显式字段，它是排版声明，不参与该判定。
        if (closed && !(speechLike && !field)) {
          accepted.push(candidate);
        } else if (!colon2 && len === 3 && personMarked) ambiguous.push(candidate);
      }
      // 字段值/含间隔号长名有唯一解：取最长的那一个，避免「姓名：阿依古丽·买买提」
      // 同时把「阿依」「阿依古」等前缀都当姓名（区间互相嵌套，屏蔽会打架）。
      if (accepted.length && (field || raw.includes('·'))) {
        confirmed.push(accepted.reduce((a, b) => (b.end > a.end ? b : a)));
        accepted.length = 0;
      }
      confirmed.push(...accepted);
      // 冒号字段行的嵌套角色词（「合议庭成员：审判员李舟」）：嵌套处无排版边界，
      // 主扫描候选被角色尾字拒绝；在字段作用域内按「角色词+短姓名」成对解析。
      if (colon2) scanNestedPairs(text, m.index + prefix.length, confirmed);
    }
  };
  scan(ROLE_PREFIX_RE, false);
  scan(TITLE_ANCHOR_RE, false);
  scan(NAME_FIELD_RE, true);
  return { confirmed, ambiguous };
}

function demographicNames(text) {
  const out = [];
  for (const re of [DEMOGRAPHIC_RE, DEMOGRAPHIC_LONG_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[1];
      if (!validName(value) || isNonPersonNoun(value)
        || isFieldPhrase(value)) continue;
      // 长名正则排除以人称角色词开头的捕获（「当事人李四」「被告人王五」
      // 是角色词+姓名，不是 5 字姓名本身）。
      if (value.length >= 5 && /^[\u4e00-\u9fa5]{1,3}(?:人|员|者|师|长|告|象)/.test(value)
        && !value.includes('·')) continue;
      const start = m.index + m[0].length - value.length;
      out.push({ start, end: start + value.length, value });
    }
  }
  return out;
}

/* ---------------- 「姓名 + 涉嫌」结构锚点 ---------------- */

// 「裴钱涉嫌盗窃罪一案」是法律文书里的固定结构：姓名后面直接跟「涉嫌 + 罪名」。
// 角色词/字段锚点缺席时（独立句、句首叙述），这条结构本身就是姓名边界。
// 只认**句首或标点/空白之后**的候选，因此不会把前一个词的后半截当姓名
// （「雷阳中学裴钱涉嫌」不会切出「学裴钱」）；也不依赖任何姓氏/姓名清单。
const SUSPECT_ANCHOR_RE = /(?:^|[\s，,。；;、：:（）()【】\[\]“”"'‘’])([\u4e00-\u9fa5]{2,4}(?:·[\u4e00-\u9fa5]{2,8})?)(?=\s*涉嫌)/g;
// 指示/称代开头一定不是姓名本身（该公司/本案/上述人员/其他人）。
const ANAPHOR_HEAD_RE = /^(?:该|本|此|其|我|你|他|她|咱|各|每|全|同|前|上|另|双|两|三|四|五|六|七|八|九|十|多|若|如|以|所|据|按|依|凡|诸|均|皆)/;
// 方位/范围收尾（以上/以下/其中/此外）与否定评价语素（非法/违法/未遂）都不会
// 是姓名本身的组成部分，按封闭语法类拒绝，不引入姓名单。
const ANAPHOR_TAIL_RE = /(?:上|下|前|后|内|外|中|间)$/;
const NEGATIVE_HEAD_RE = /^(?:非|未|无|不|没|违|涉嫌|犯罪)/;

function suspicionNames(text) {
  const out = [];
  SUSPECT_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = SUSPECT_ANCHOR_RE.exec(text)) !== null) {
    const value = m[1];
    if (!validName(value) || isNonPersonNoun(value) || isFieldPhrase(value)) continue;
    if (ANAPHOR_HEAD_RE.test(value)) continue;
    if (ANAPHOR_TAIL_RE.test(value)) continue;
    if (NEGATIVE_HEAD_RE.test(value)) continue;
    const start = m.index + m[0].length - value.length;
    out.push(item('name', start, start + value.length, value, true));
  }
  return out;
}

/* ---------------- 「姓名 + 的 + 身份名词」所有格锚点 ---------------- */

// 「本律师担任张三的辩护人」里角色词正则会从「本律师」一路贪心到句尾的
// 「辩护人」，姓名不在前缀之后，主扫描取不到。这条锚点直接按
// 「（谓词）+ 姓名 + 的 + 身份名词」定位，结构封闭、不查姓氏表。
// 「杨素侠的委托」同构（委托人是当事人），代理词/委托书高频句式。
const POSSESSIVE_ANCHOR_RE = /(?:^|[\s，,。；;、：:（）()【】\[\]“”"'‘’]|担任|指派|委托|聘请|接受|系)([\u4e00-\u9fa5]{2,4})的((?:辩护人|诉讼代理人|委托代理人|代理人|律师|家属|亲属|监护人|法定代表人|代表人|近亲属|委托))/g;

function possessiveNames(text) {
  const out = [];
  POSSESSIVE_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = POSSESSIVE_ANCHOR_RE.exec(text)) !== null) {
    let value = m[1];
    // 介词/动词首字会混进捕获（「受王东的委托」贪心成「受王东」——X 与 的 同为
    // 汉字，{2,4} 贪婪把受字吃进去），剥离后才是真姓名位。
    const stripped = value.replace(/^[受给让被把将向从为和与及或在由对当以了]+/, '');
    if (stripped && stripped !== value) {
      value = stripped;
    }
    if (value.length < 2) continue;
    if (!validName(value) || isNonPersonNoun(value) || isFieldPhrase(value)) continue;
    if (ANAPHOR_HEAD_RE.test(value) || NEGATIVE_HEAD_RE.test(value)) continue;
    const start = m.index + m[0].length - m[2].length - 1 - value.length;
    out.push(item('name', start, start + value.length, value, true));
  }
  return out;
}

function detectLocalNames(text) {
  const role = roleCandidates(text);
  const items = [
    ...role.confirmed,
    ...demographicNames(text),
    ...suspicionNames(text),
    ...possessiveNames(text),
  ].map((c) => item('name', c.start, c.end, c.value, true));
  return { items, ambiguous: role.ambiguous };
}

function isPersonTableLabel(value) {
  const compact = String(value || '').replace(/[\s：:（）()]/g, '')
    .replace(/[一二三四五六七八九十\d]{1,2}$/, '');
  return compact === '姓名' || compact === '名字'
    || (/^[\u4e00-\u9fa5]{2,16}(?:人|员|者|师|长|犯|告|象|方)$/.test(compact)
      && !/(?:告|人|犯|象)方$/.test(compact));
}

/* ---------------- 简历版式锚点 ---------------- */

// 简历没有角色词/字段锚点，靠版式闭合：块首顶格 2~3 字姓名候选，
// 同行剩余部分或紧随其后的块须有人口学证据（性别/出生年开头），二者齐备才确认。
const RESUME_DEMOGRAPHIC_RE = /^(?:[男女](?:[\t \u3000]*[·｜|│，,])|\d{4}\s*(?:[.\-/年]|年?月))/;
const RESUME_HEADER_SPLIT_RE = /^([\u4e00-\u9fa5]{2,3})(?:[\t \u3000]+|[｜|│])/;

function resumeHeaderName(blocks, known) {
  for (let i = 0; i < blocks.length; i++) {
    const cur = blocks[i].trim();
    const m = RESUME_HEADER_SPLIT_RE.exec(cur);
    if (!m) continue;
    const name = m[1];
    if (!validName(name) || isNonPersonNoun(name) || isFieldPhrase(name)
      || PHRASE_VERB_BAD_RE.test(name) || PHRASE_TAIL_BAD_RE.test(name)) continue;
    const rest = cur.slice(name.length).trim();
    const next = i + 1 < blocks.length ? blocks[i + 1].trim() : '';
    if (!RESUME_DEMOGRAPHIC_RE.test(rest) && !RESUME_DEMOGRAPHIC_RE.test(next)) continue;
    known.name.add(name);
  }
}

/* ---------------- 地址：居民身份证格式（行政区划链 + 落点要素） ---------------- */

const ADDRESS_GUIDE_RE = /(?:户籍所在地及住址|户籍所在地|经常居住地|户籍地址|户籍地|住所地|居住地|暂住地|现住址|通讯地址|联系地址|家庭住址|详细地址|办公地址|家庭地址|注册地|所在地|住址|地址|籍贯|原籍|祖籍|出生地|户籍|现住|暂住|居住|家住|住于|住在|位于|坐落于|住|案发地点|案发地|发案地|现场位于|前往|途经|到达|抵达)\s*[:：]?\s*/g;

// 行政区划链：按 省 → 市 → 县/区 → 乡镇/街道 → 村/社区 顺序逐级可选解析。
// 名称段须为 1~8 位纯汉字且不含行政区划后缀字与泛指代词，
// 防止叙述前缀（「其在浙江」「全村共有」）被当成地名组成部分。
const ADMIN_TIERS = [
  { suffixes: ['自治区', '省'], level: '省' },
  { suffixes: ['自治州', '地区', '盟', '市'], level: '市' },
  { suffixes: ['区', '县', '旗'], level: '' },
  { suffixes: ['街道', '苏木', '镇', '乡'], level: '' },
  { suffixes: ['社区', '嘎查', '村'], level: '' },
];
const ADMIN_NAME_RE = /^[\u4e00-\u9fa5]{1,8}$/;
const ADMIN_NAME_BAD_RE = /[省市县区旗盟镇乡村全本我你该各每这那某]/;
// 落点要素：小区/道路/村组类为自由单位；门牌楼栋类须紧邻数字（防「括号、办公室」）。
const ADDR_LEAF_RE = /(?:小区|花园|公寓|大厦|广场|家园|庭院|山庄|宿舍|大院|新村|车库|胡同|大道|大街|路|街|巷|弄|组|队|单元|号楼|栋|幢|座|楼|号|室|层|户|院)/g;
const ADDR_DOOR_RE = /(?:单元|号楼|栋|幢|座|楼|号|室|层|户|院)/;
const ADMIN_SUFFIX_SEARCH_RE = /(?:自治区|自治州|街道|社区|地区|省|市|盟|县|区|旗|苏木|镇|乡|嘎查|村)/;
const ADDRESS_BAD_CHAR_RE = /[的了吗呢吧啊呀嘛了着过]/;
const GENERIC_ADDRESS_RE = /(?:^|[\s，,。；;、：:（）()【】\[\]在到从于往至去回])((?![在到从于往至去回])[\u4e00-\u9fa5A-Za-z0-9#-]{3,60})/g;

/** 解析行政区划链：返回链尾位置、最高层级与末级所在档位；level 为空表示无层级 */
function scanAdminChain(raw) {
  let i = 0;
  let level = '';
  let lastTier = -1;
  for (let t = 0; t < ADMIN_TIERS.length; t++) {
    const tier = ADMIN_TIERS[t];
    let bestEnd = -1;
    let bestLevel = '';
    for (const suf of tier.suffixes) {
      const idx = raw.indexOf(suf, i);
      if (idx < 0 || idx - i > 8) continue;
      const name = raw.slice(i, idx);
      if (!ADMIN_NAME_RE.test(name) || ADMIN_NAME_BAD_RE.test(name)) continue;
      const end = idx + suf.length;
      if (bestEnd < 0 || end <= bestEnd) { bestEnd = end; bestLevel = tier.level || suf; }
    }
    if (bestEnd >= 0) { i = bestEnd; if (!level) level = bestLevel; lastTier = t; }
  }
  return { i, level, lastTier };
}

/** 落点要素右边界：最后一个合法落点单位（门牌类须紧邻数字）的结束位置 */
function leafEndAt(raw, from) {
  const rest = raw.slice(from);
  if (!rest) return -1;
  let end = -1;
  ADDR_LEAF_RE.lastIndex = 0;
  let m;
  while ((m = ADDR_LEAF_RE.exec(rest)) !== null) {
    if (ADDR_DOOR_RE.test(m[0]) && !/[0-9]/.test(rest[m.index - 1] || '')) continue;
    end = m.index + m[0].length;
  }
  return end;
}

/** 「地址值 → 最高行政层级」：屏蔽形态「某X……尾1」与还原修饰共用 */
function addressLevelOf(value) {
  return scanAdminChain(String(value || '')).level;
}

function addressAt(text, start) {
  const run = /^[\u4e00-\u9fa5A-Za-z0-9#-]+/.exec(text.slice(start));
  if (!run) return null;
  let raw = run[0];
  const bad = ADDRESS_BAD_CHAR_RE.exec(raw);
  if (bad) raw = raw.slice(0, bad.index);
  const chain = scanAdminChain(raw);
  if (!chain.level) return null;
  // 落点要素：链后须有道路/门牌/小区等单位；
  // 仅当链止于村/社区档位时允许以村/社区收尾（如「雷州市北和镇石牌垌村」）。
  let end = leafEndAt(raw, chain.i);
  if (end >= 0) end += chain.i;
  else if (chain.lastTier === 4) end = chain.i;
  if (end < 3) return null;
  return item('address', start, start + end, raw.slice(0, end), true);
}

function detectAddresses(text) {
  const out = [];
  const guides = [];
  ADDRESS_GUIDE_RE.lastIndex = 0;
  let m;
  while ((m = ADDRESS_GUIDE_RE.exec(text)) !== null) {
    const start = m.index + m[0].length;
    guides.push({ from: m.index, to: start });
    const hit = addressAt(text, start);
    if (hit) out.push(hit);
  }
  GENERIC_ADDRESS_RE.lastIndex = 0;
  while ((m = GENERIC_ADDRESS_RE.exec(text)) !== null) {
    let value = m[1];
    let start = m.index + m[0].length - value.length;
    // 引导路径已经识别；通用路径若包含同一引导词，跳过这个更长候选。
    if (guides.some((g) => start <= g.from && g.from < start + value.length)) continue;
    // 正则从最左侧起配时可能带入叙述；首个行政区划前的最后位置字才是左边界。
    const admin = ADMIN_SUFFIX_SEARCH_RE.exec(value);
    if (admin && admin.index > 0) {
      const prefix = value.slice(0, admin.index);
      let cut = -1;
      for (const ch of '在到从于往至去回') cut = Math.max(cut, prefix.lastIndexOf(ch));
      if (cut >= 0) { start += cut + 1; value = value.slice(cut + 1); }
    }
    const hit = addressAt(text, start);
    if (hit) out.push(hit);
  }
  return out;
}

/* ---------------- 机构：后缀 + 长度 + 非泛指 ---------------- */

// 只含功能字/介词的断点；不把「和、同、也、交」等可能属于字号的字当断点。
const ORG_LEFT_BREAK = new Set([...'的了着过是在于以由向从为即给我你他她它您咱月初底旬收受送赠']);
// 双字句首介词是结构断点，不能吞进机构字号（「根据红日建材公司」
// 应得到「红日建材公司」，介词不进字号）。
const ORG_PREP_RE = /(?:根据|依据|按照|依照)$/;
// 「经/和」既可能是介词/连接词，也可能是字号（经纬/和平县），只在前方已是一个
// 完整主体、或右侧带行政区划时才当断点；否则保留在字号里，避免把机构切坏。
const PROVINCE_HEAD_RE = /北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|香港|澳门|台湾/;
const ORG_SUFFIX_TEST = new RegExp(ORG_SUFFIXES.join('|'));
const GENERIC_ORG_RE = /(?:[一二两三四五六七八九十几数多每各某这那该]家|[某该这那])$/;
const ADMIN_UNIT_RE = /(?:自治区|省|市|县|区|旗|盟|镇|乡|街道|村|社区)/;

// 职务动词紧跟机构名是案卷高频句式（「仍实际负责涟水县师资培训中心」），
// 动词不切断就会吞进字号；单字断点表覆盖不了双字动词，这里按结尾窗口判断。
const ORG_ROLE_VERB_RE = /(?:负责|担任|主管|分管|兼任|任职|调任|主持|主抓)$/;
// 出示/出具类叙述动词同样不能吞进字号（「出示红日建材有限公司」曾整体入字号，
// 前2取到「出示」而显示为「出示****公司」）。这些词只作动作，不作机构字号。
const ORG_NARRATION_VERB_RE = /(?:出示|出具|展示|提供|提交|调取)$/;
// 角色人称词的「人」同样不能吞进字号（「负责人李太白银行转账」曾得「人李太白银行」，
// 还会在重叠消解时盖掉真姓名）。「人民银行/人民医院」的「人」前面是机构专名而非角色词，不受影响。
const ORG_ROLE_PERSON_RE = /(?:被会见|会见|受援|委托诉讼代理|委托代理|法定代表|实际负责|委托|辩护|代理|被上诉|上诉|申诉|申请执行|被执行|申请|复议|被处罚|违法行为|行为|行贿|受贿|报案|被侵害|被害|被侵权|当事|同案|涉案|在场|主持|记录|调查|陪同|到庭|公诉|见证|负责|第三|证)人$/;

/** 机构左边界断点：介词「经」、连接词「和」需额外语境，不能一律吞掉或一律截断 */
function isOrgLeftBreak(text, ch, start, brandEnd, suffixEnd) {
  if (ORG_ROLE_VERB_RE.test(text.slice(Math.max(0, start - 4), start))) return true;
  if (ORG_NARRATION_VERB_RE.test(text.slice(Math.max(0, start - 4), start))) return true;
  if (ORG_PREP_RE.test(text.slice(Math.max(0, start - 4), start))) return true;
  // 「负责人/辩护人/证人…」的人后紧跟的只能是姓名或叙述，不是机构字号；
  // 窗口取 14 字覆盖「委托诉讼代理人/申请执行人」等长角色词
  if (ch === '人' && ORG_ROLE_PERSON_RE.test(text.slice(Math.max(0, start - 14), start))) return true;
  // 「2021年中小学…」的年份前缀不是字号；「年例/年夜」这类字号前一字是汉字，不受影响
  if (ch === '年' && /[0-9]/.test(text[start - 2] || '')) return true;
  if (ORG_LEFT_BREAK.has(ch) || (ch === '系' && text[start] !== '统')) return true;
  const rightBrand = text.slice(start, brandEnd);
  if (ch === '经') {
    // 「经××局/经江苏…」是介词；「经纬/经济/经开区」是字号或地名缩写，不能断。
    if (/^开[发区]|^纬|^济|^贸|^技/.test(rightBrand)) return false;
    return PROVINCE_HEAD_RE.test(rightBrand) || ADMIN_UNIT_RE.test(rightBrand);
  }
  if (ch === '和' || ch === '与') {
    // 「A公司和B公司」是连接词；「和平/和顺/和县/北和镇」是地名或字号，不能断。
    if (/^[平县顺田]/.test(rightBrand)) return false;
    const left = text.slice(Math.max(0, start - 14), start);
    if (/[\u4e00-\u9fa5]$/.test(left) && !ORG_SUFFIX_TEST.test(left)) return false;
    // 右侧须是一段完整主体（≥6 字）才断开；「北和镇卫生院」的「和」只是
    // 地名用字，右侧残段（镇卫生院）过短，继续向前回溯到真正的边界。
    if (text.slice(start, suffixEnd).length < 6) return false;
    return ADMIN_UNIT_RE.test(rightBrand)
      || PROVINCE_HEAD_RE.test(rightBrand)
      || ORG_SUFFIX_TEST.test(text.slice(start + 1, suffixEnd));
  }
  return false;
}

function suffixEndingAt(text, end) {
  for (const suffix of ORG_SUFFIXES) {
    if (end >= suffix.length && text.slice(end - suffix.length, end) === suffix) return true;
  }
  return false;
}

// // 字号段整体由泛称学校字组成（「中小学」是并列泛称）——不再单独排除，
// 由「须含省/市/县/区/镇/村层级信息」这条统一前提兜住。

function detectOrgs(text) {
  const out = [];
  const shortAliases = new Set();
  const aliasRe = /[（(]\s*以下简称\s*([\u4e00-\u9fa5]{2,12})\s*[）)]/g;
  let aliasMatch;
  while ((aliasMatch = aliasRe.exec(text)) !== null) {
    const alias = aliasMatch[1];
    if (alias.length < 6 && ORG_SUFFIXES.some((s) => alias.endsWith(s))) shortAliases.add(alias);
  }
  ORG_SUFFIX_RE.lastIndex = 0;
  let m;
  while ((m = ORG_SUFFIX_RE.exec(text)) !== null) {
    const suffix = m[0];
    const brandEnd = m.index;
    let start = brandEnd;
    let adjacentToOrg = false;
    const min = Math.max(0, brandEnd - 24);
    while (start > min) {
      const ch = text[start - 1];
      // 短括注（「盛景（南京）智能装备股份有限公司」）是字号组成部分：
      // 括注内为 ≤8 字纯专名时跨过后继续回溯；「（以下简称××）」不跨。
      if (ch === '）' || ch === ')') {
        const open = ch === '）' ? '（' : '(';
        const openIdx = text.lastIndexOf(open, start - 1);
        if (openIdx >= min) {
          const inner = text.slice(openIdx + 1, start - 1);
          if (inner.length >= 1 && inner.length <= 8
            && /^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(inner)
            && !/简称|以下/.test(inner)) {
            start = openIdx;
            continue;
          }
        }
        break;
      }
      // 「系」可作系动词，但「系统」是常见字号组成部分；经/和需语境判断。
      if (!/[\u4e00-\u9fa5]/.test(ch) || isOrgLeftBreak(text, ch, start, brandEnd, m.index + suffix.length)) break;
      if (suffix === '公司' && suffixEndingAt(text, start)) { adjacentToOrg = true; break; }
      start--;
    }
    // 前一个主体后的短「公司」通常是简称；银行→支行、法院→法庭则是层级机构。
    if (adjacentToOrg && suffix === '公司') continue;
    let brand = text.slice(start, brandEnd);
    // 若首个行政区划单元前混入长叙述，只从该单元稳定的二字地名核心重新起头。
    // 正常「江苏省淮安市…」首单元已经很短，不会被裁切。
    const admin = ADMIN_UNIT_RE.exec(brand);
    if (admin && admin.index > 4) {
      start += admin.index - 2;
      brand = text.slice(start, brandEnd);
    }
    const value = brand + suffix;
    const end = m.index + suffix.length;
    // 已声明的短简称不因前面连带叙述字而扩展成新机构；带行政区划的完整名称除外。
    const narrativeAlias = [...shortAliases].some((alias) => {
      if (!alias.endsWith(suffix) || !value.endsWith(alias) || value === alias) return false;
      return !ADMIN_UNIT_RE.test(value.slice(0, -alias.length));
    });
    if (narrativeAlias) continue;
    if (value.length < 6 || brand.length < 2) continue;
    if (value.length > 18) continue; // 机构全名一般不超过 18 字
    // 数量泛指（一家宾馆/某公司）仍不是具体主体；其余类别（公权力机关、
    // 知名银行、并列泛称等）不再排除——有层级信息就按机构屏蔽。
    if (GENERIC_ORG_RE.test(brand)) continue;
    // 统一形态前提：字号须含 省/市/县/区/镇/村（或命中固定省市词典）。
    // 该前提同时兜住了「危害法庭安全」这类叙述残段——它们不含层级信息。
    if (!orgLevelOf(value)) continue;
    out.push(item('org', start, end, value, true));
  }
  return out;
}

/* ---------------- 确认实体传播 ---------------- */

function addLiteralHits(out, text, type, value) {
  if (!value || !text.includes(value)) return;
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(value, from);
    if (start < 0) break;
    out.push(item(type, start, start + value.length, value, false));
    from = start + value.length;
  }
}

function addHashNames(out, text, hashes) {
  if (!hashes || !hashes.size) return;
  // 最长优先：从每个起点尝试 8→2 字，命中后跳过整段，避免「张三丰」被
  // 已知姓名「张三」截成「张三」+「丰」造成屏蔽形态与还原不一致。
  const COVERED = new Set();
  for (let start = 0; start < text.length; start++) {
    if (COVERED.has(start) || !/[\u4e00-\u9fa5]/.test(text[start])) continue;
    for (let len = Math.min(8, text.length - start); len >= 2; len--) {
      const value = text.slice(start, start + len);
      if (!HAN_RE.test(value) || !hashes.has(hashName(value))) continue;
      // 传播层同样做姓名形状/守卫校验：缓存可能来自旧版检测器（毒哈希），
      // 只凭哈希命中就遮会让「日出生」「现在」「有权」这类字段词/功能词复活。
      if (!validName(value) || isNonPersonNoun(value) || isFieldPhrase(value)) continue;
      out.push(item('name', start, start + len, value, false));
      for (let k = start; k < start + len; k++) COVERED.add(k);
      break;
    }
  }
}

const LEGACY_PLACE_LEFT_BREAK = new Set([...'的在位于到从往至去回住及与和']);
function addLegacyPlaceHits(out, text, value) {
  if (!value || !text.includes(value)) return;
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(value, from);
    if (start < 0) break;
    const before = text[start - 1] || '';
    if (!before || !/[\u4e00-\u9fa5]/.test(before) || LEGACY_PLACE_LEFT_BREAK.has(before)) {
      out.push(item('address', start, start + value.length, value, false));
    }
    from = start + value.length;
  }
}

function detectEntities(text, options = {}) {
  const source = String(text || '');
  const toggles = options.toggles || {};
  const out = [];
  if (toggles.name !== false) out.push(...detectLocalNames(source).items);
  if (toggles.address !== false) out.push(...detectAddresses(source));
  if (toggles.org !== false) out.push(...detectOrgs(source));

  // 新实体表按完整原值传播；旧 knownPlaces 仅走带左边界的兼容路径。
  const known = mergeEntities(options.knownEntities);
  if (options.knownNames) for (const v of options.knownNames) known.name.add(v);
  for (const type of ['name', 'org', 'address']) {
    if (toggles[type] === false) continue;
    for (const value of known[type]) addLiteralHits(out, source, type, value);
  }
  if (toggles.address !== false && options.knownPlaces) {
    for (const value of options.knownPlaces) addLegacyPlaceHits(out, source, value);
  }
  if (toggles.name !== false) addHashNames(out, source, options.knownNameHashes);
  // 全案卷传播会放大「和江苏…公司」这类吞了连接词的伪机构：
  // 机构名以经/和开头且紧跟省级地名时，几乎必为边界错误，直接丢弃（含传播项）。
  return out.filter((it) => !(
    it.type === 'org'
      && /^[和经]/.test(it.value) && PROVINCE_HEAD_RE.test(it.value.slice(1))
  ));
}

function candidateStats(corpus, value) {
  const previous = new Set();
  const next = new Set();
  let count = 0;
  let from = 0;
  while (from <= corpus.length) {
    const index = corpus.indexOf(value, from);
    if (index < 0) break;
    count++;
    previous.add(corpus[index - 1] || '\n');
    next.add(corpus[index + value.length] || '\n');
    from = index + value.length;
  }
  return { count, previous, next };
}

function confirmCoordinatedNames(blocks, known) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      for (const name of [...known.name]) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
          new RegExp(`${escaped}[、与和]([\\u4e00-\\u9fa5]{2,3})(?=[二两三四五六七八九十\\d]{1,2}人|等(?:人)?|[，,。；;、：:\\s（）()]|$)`, 'g'),
          new RegExp(`(?:^|[\\s，,。；;、：:（）()])([\\u4e00-\\u9fa5]{2,3})[、与和]${escaped}(?=[二两三四五六七八九十\\d]{1,2}人|等(?:人)?|[，,。；;、：:\\s（）()]|$)`, 'g'),
        ];
        for (const re of patterns) {
          let m;
          while ((m = re.exec(block)) !== null) {
            const value = m[1];
            if (!validName(value) || known.name.has(value)) continue;
            known.name.add(value);
            changed = true;
          }
        }
      }
    }
  }
}

/**
 * 第一遍：从一组逻辑块（段落/单元格/文件文本）收集全案卷实体。
 * 相邻块用于「受援人」→「李贺」这类表格结构；歧义候选必须复现且
 * 右侧上下文至少两种，避免把「张罗商议」整体误当姓名。
 */
function collectEntities(input, options = {}) {
  const blocks = (Array.isArray(input) ? input : String(input || '').split(/\r?\n/))
    .map((v) => String(v || '')).filter((v) => v.trim());
  const known = knownFromOptions(options);
  const ambiguous = [];

  for (const block of blocks) {
    const local = detectLocalNames(block);
    for (const it of local.items) known.name.add(it.value);
    ambiguous.push(...local.ambiguous);
    for (const hit of detectAddresses(block)) known.address.add(hit.value);
    for (const hit of detectOrgs(block)) known.org.add(hit.value);
  }

  for (let i = 1; i < blocks.length; i++) {
    const value = blocks[i].trim();
    // 表格相邻块：标签后是姓名才收；动作词（宣布/记录）与泛称（证言/经理）
    // 不是姓名，避免「审判长 / 宣布」被误收。
    const tableValue = blocks[i].trim();
    if (isPersonTableLabel(blocks[i - 1]) && validName(tableValue)
      && !isNonPersonNoun(tableValue) && !isFieldPhrase(tableValue)
      && !PHRASE_VERB_BAD_RE.test(tableValue)) known.name.add(tableValue);
  }

  // 简历版式锚点：姓名行 + 人口学证据行（性别/出生年）。
  resumeHeaderName(blocks, known);

  // 先展开闭合并列名单，再用已知姓名排除「李贺作」这类向右扩展的伪候选。
  confirmCoordinatedNames(blocks, known);

  const corpus = blocks.join('\n');
  const stats = new Map();
  for (const c of ambiguous) {
    if (!stats.has(c.value)) stats.set(c.value, candidateStats(corpus, c.value));
  }
  const eligible = new Set();
  for (const c of ambiguous) {
    const s = stats.get(c.value);
    // 自由语境接受至少两次复现、左右上下文均不唯一的三字候选。
    if (c.value.length !== 3 || !s || s.count < 2 || s.previous.size < 2 || s.next.size < 2) continue;
    if ([...known.name].some((name) => name !== c.value
      && (name.startsWith(c.value) || c.value.startsWith(name)))) continue;
    eligible.add(c.value);
  }
  // 同一位置若有多个候选，保留右侧上下文最丰富者；仍并列则不猜。
  const byPosition = new Map();
  for (const c of ambiguous) {
    if (!eligible.has(c.value)) continue;
    const key = `${c.start}:${c.raw}`;
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(c.value);
  }
  for (const values of byPosition.values()) {
    const unique = [...new Set(values)].sort((a, b) => {
      const diversity = stats.get(b).next.size - stats.get(a).next.size;
      return diversity || b.length - a.length;
    });
    if (unique.length > 1) {
      const a = stats.get(unique[0]);
      const b = stats.get(unique[1]);
      if (a.next.size === b.next.size && unique[0].length === unique[1].length) continue;
    }
    known.name.add(unique[0]);
  }

  return known;
}

module.exports = {
  ORG_SUFFIXES,
  orgLevelOf,
  addressLevelOf,
  createEntities,
  mergeEntities,
  detectEntities,
  collectEntities,
  hashName,
  validName,
};
