'use strict';
/**
 * 敏感信息检测器（纯 JS，无 Electron 依赖，可在主进程与测试中直接使用）
 *
 * 检测范围：手机号 / 身份证号 / 银行卡号 / 电子邮箱 / 中文姓名 / 家庭住址 / 护照号 / 车牌号
 * 明确排除（依法不作为敏感信息处理）：性别、年龄、出生日期、民族
 */

/* ------------------------------------------------------------------ */
/* 姓名识别基础数据                                                     */
/* ------------------------------------------------------------------ */

// 单姓表：覆盖《百家姓》常用姓 + 文书里高频出现的中低频姓。
// 扩大姓氏表不会直接增加误报 —— 姓名判定仍要求「语境证据」，姓氏只是必要条件；
// 但能避免「查/鲍/冼/岑/靳」等真实姓氏被整片漏掉的硬伤。
const SURNAMES_1 = new Set((
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董潘袁蔡蒋余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦傅方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌涂盛柴丘穆佟房景古缪卓屈' +
  '查鲍岑仇单窦费盖勾广归贵桂过哈海杭衡弘红后呼忽户怀宦皇回稽汲计季加嘉坚简蹇靳经井敬静君亢匡旷奎赖蓝郎劳乐冷里利连练蔺令留隆娄禄路律洛骆麻买满茅冒门蒙弥米苗闵明牟母木牧那纳南年念农侬偶盘裴皮平蒲朴浦普祁岂千强青卿瞿权全泉阙冉饶仁荣容茹芮赛桑沙山商佘生师时寿疏束帅双水顺斯松宿粟隋索锁台邰泰谈滕铁土危维伟卫闻翁沃乌巫奚席习先鲜线相项辛新信幸修胥须续轩宣荀言阎晏仰羊阳衣依阴应英雍尤由游于虞鱼宇禹尉元原源远云郧运宰臧早湛长照折真甄之支直执郅终仲诸竹专子紫宗祖佐' +
  '麦冼邝植揭招竺柒'
).split(''));

// 复姓
const SURNAMES_2 = new Set([
  '欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '长孙', '慕容',
  '司徒', '端木', '申屠', '夏侯', '令狐', '宇文', '轩辕', '公冶', '太叔', '东郭',
  '南宫', '百里', '东门', '左丘', '西门', '第五', '独孤', '呼延', '拓跋', '鲜于',
]);

// 常见非姓名词（以姓氏字开头的易混淆词），命中即跳过
const NAME_BLACKLIST = new Set([
  '上下', '上面', '上午', '上台', '上网', '下山', '下马', '下车', '下降', '下文',
  '下次', '下午', '下旬', '下级', '下方', '方面', '方向', '方式', '方法', '方便',
  '方才', '东方', '东边', '东面', '东门', '东风', '东西', '东山', '东营', '手工',
  '手术', '手机', '手腕', '手掌', '首先', '首都', '首长', '马上', '马路', '马丁',
  '万物', '万事', '万元', '万众', '万人', '四方', '四面', '四周', '三方', '三天',
  '三年', '三月', '三点', '三号', '三次', '三十', '三百', '山东', '山西', '广东',
  '广西', '河北', '河南', '湖北', '湖南', '海南', '云南', '王国', '王后', '王子',
  '王牌', '王府', '王朝', '王宫', '王法', '里程', '李子', '工程', '工厂', '工具',
  '工地', '工业', '工艺', '功劳', '功率', '功课', '工匠', '攻击', '公园', '公主',
  '公开', '公司', '公文', '公寓', '功臣', '叶子', '叶片', '叶脉', '唐人', '宋体',
  '宋代', '元代', '黄山', '黄河', '马匹', '白马', '田野', '田地', '田园', '水田',
  '水稻', '胡子', '胡乱', '胡说', '胡椒', '林立', '林业', '林木', '林场', '山林',
  '竹林', '树林', '高铁', '高级', '高兴', '高度', '高大', '高中', '高山', '高校',
  '高温', '高速', '高档', '高价', '扬子', '扬州', '徐州', '常州', '苏州', '杭州',
  '温州', '福州', '兰州', '郑州', '沧州', '柳州', '荆州', '贵阳', '成都', '武汉',
  '宁波', '唐山', '许诺', '许愿', '许多', '谢谢', '感谢', '感想', '感受', '沈阳',
  '情况', '情绪', '心情', '心态', '态度', '全面', '全部', '全体', '安全', '平安',
  '平时', '公平', '平方', '水平', '平台', '地面', '地步', '地方', '地位', '场地',
  '基地', '地址', '余地', '白天', '白色', '白菜', '白云', '江山', '江南', '江北',
  '江边', '江水', '江河', '沿江', '黄金', '黄色', '黄瓜', '黄豆', '金黄', '杨柳',
  '杨树', '柳树', '严冬', '严重', '严禁', '严谨', '严肃', '严厉', '温度', '温泉',
  '温暖', '武断', '武装', '武术', '威武', '习气', '习惯', '学习', '石子', '石头',
  '石油', '结石', '钻石', '基石', '金色', '金属', '金钱', '金额', '钱财', '价钱',
  '钱包', '存款', '库存', '包围', '周围', '周期', '周到', '气氛', '气候', '气泡',
  '财务', '财政', '职务', '职责', '职工', '职员', '职业', '营业', '商业', '商店',
  '商场', '市场', '城市', '城镇', '城乡', '市长', '县城', '村镇', '村民', '农田',
  '农民', '农业', '刘海', '成绩', '成就', '成功', '成长', '成熟', '成倍', '许配',
  '说明', '详细', '细节', '细致', '营养', '营房', '营救', '经营', '国营', '营运',
  '此类', '此外', '另外', '其余', '其中', '之内', '之外', '之间', '之后', '之前',
  '之中', '同时', '同一', '统一', '同样', '同类', '同事', '同情', '同意', '透气',
  '透明', '透支', '透露', '延续', '延长', '延伸', '扩展', '扩充', '扩张', '扩散',
  '散步', '散布', '分散', '散开', '散文', '散装', '数字', '数学', '数值', '数据',
  '数量', '数目', '数次', '次数', '中国', '中间', '中心', '中央', '中立', '中型',
  '中文', '中等', '中断', '中华', '中学', '小学', '大学', '学校', '学员', '学分',
  '学生', '学问', '学位', '学徒', '学院', '工程师', '技术员', '大学生', '中学生',
  '小学生', '企业家', '事实上', '实际上', '历史上', '基本上', '根本上', '本质上',
  '三角形', '第三次', '第二次', '第一次', '工作量', '工作日', '工作室', '工作证',
  '工业品', '工艺品', '工具箱', '白皮书', '白石桥', '黑板报', '空白处', '金庸',
  '金石滩', '水泥厂', '石灰石', '石头城', '马路牙子', '马路旁', '万人坑', '万事达',
  '万户侯', '三下乡', '三环路', '三十岁', '第三方', '三角洲', '山东人', '山西省',
  '广东省', '广西区', '河北省', '河南省', '湖北省', '湖南省', '海南省', '云南省',
  '王老吉', '王中王', '里程表', '李时珍', '说明书', '杜甫草堂', '营业执照',
  '营业厅', '商业银行', '工商局', '工业园', '工程车', '公园里', '公安局',
  '公主号', '公交卡', '公文包', '白日梦', '存款人', '金石缘',
  // 罕见姓扩展表的同名常见词
  '麦田', '麦子', '麦收', '麦片', '麦芽', '麦苗', '植物', '种植', '揭发', '揭示',
  '招工', '招标', '招生', '招呼', '招聘', '措施',
  // 新增姓氏带来的易混淆常用词（尤以「查」开头的一组最常见）
  '查看', '查询', '查明', '查获', '查证', '查找', '查阅', '查实', '查处', '查封',
  '查封', '查清', '查对', '查账', '查办', '查收', '抽查', '检查', '调查', '审查',
  '核查', '排查', '追查', '复查', '清查', '侦查', '查验', '查勘', '查访', '查问',
  '经理', '总经理', '法定', '代表', '负责', '责任', '现任', '任职', '担任', '任职',
  '时间', '时候', '时期', '事实', '事情', '证据', '证人', '证言', '证明', '证书',
  '全部', '全民', '全局', '全年', '全新', '新生', '新闻', '新疆', '信号', '信任',
  '同意', '同学', '同时', '同事', '原告', '被告', '本院', '本县', '本市', '本案',
  '于是', '于是', '由此', '由于', '为此', '为人', '为我', '所在', '所属', '所有',
  '文明', '文化', '文书', '文字', '文档', '文章', '万元', '万块', '万元', '万象',
  '生平', '生产', '生活', '生日', '师生', '师资', '师范', '师长', '师傅', '时事',
  // 法律文书固定用语，容易被单字姓 + 语境证据误判成姓名
  '开庭', '许可', '司总', '司副总', '出庭', '到庭', '庭前', '闭庭', '休庭',
  '回族', '汉族', '满族', '藏族', '壮族', '苗族', '彝族', '侗族', '白族', '傣族',
]);

// 称呼词：紧随姓名（高置信）或直接跟在姓氏后（本身已是屏蔽表述）
const TITLES = ['先生', '女士', '小姐', '同学', '老师', '医生', '大夫', '经理', '律师', '教授', '主任', '护士', '总裁', '老板', '师傅', '董事', '局长', '科长', '处长', '队长', '院长', '校长', '园长', '部长', '会计', '出纳'];
const TITLES_SET = new Set(TITLES);

/* ---------------- 语境词表：机构 / 地名 / 角色 ---------------- */

// 机构名词尾：候选名后（或所在分句内）出现即视为机构名，不按个人姓名处理
const ORG_WORDS = [
  '律师事务所', '事务所', '有限公司', '股份公司', '公司', '集团', '村民委员会', '居民委员会',
  '委员会', '居委会', '村委会', '理事会', '合作社', '协会', '基金会', '研究院', '研究所',
  '工作室', '服务中心', '卫生院', '医院', '人民法院', '法院', '人民检察院', '检察院',
  '公安局', '派出所', '管理局', '管理处', '人民政府', '政府', '小学', '中学', '大学', '学校',
  '幼儿园', '银行', '支行', '信用社', '酒店', '宾馆', '饭店', '超市', '工厂', '门市部',
];

// 地名尾字：以这些字结尾、或其后紧跟这些字 → 判为地名（「雷州市」「广东省雷州」）
const PLACE_TAIL = new Set([...'省市区县镇乡街路巷号州岛山河湖江湾港桥苑园场站屯堡寨庄']);

const CLAUSE_END_RE = /[，,。；;、\n\r\t（）()：:]/;

// 诉讼当事人标签：其后若接「方/各/双/本…」是「被告方」这类指代，不是姓名
const PARTY_LABELS = ['反诉原告', '反诉被告', '原审原告', '原审被告', '再审申请人', '被再审申请人', '被答辩人', '答辩人', '原告', '被告', '第三人', '上诉人', '被上诉人', '申请人', '被申请人'];
const PARTY_LABELS_SORTED = PARTY_LABELS.slice().sort((a, b) => b.length - a.length);

// 角色标签：法律文书里「原告：陈X」「被告一：陈X」「负责人陈X」是最高置信的姓名语境
const ROLE_LABELS = [
  '委托诉讼代理人', '法定代理人', '诉讼代理人', '委托代理人', '法定代表人', '人民陪审员',
  '原审原告', '原审被告', '再审申请人', '被再审申请人', '被答辩人', '答辩人',
  '原告', '被告', '第三人', '上诉人', '被上诉人', '申请人', '被申请人', '起诉人', '具状人',
  '反诉原告', '反诉被告', '代理人', '负责人', '辩护人', '证人', '被害人', '受害人',
  '犯罪嫌疑人', '被告人', '审判长', '审判员', '书记员', '执行人', '被执行人', '报案人',
  '姓名', '名字', '联系人', '紧急联系人', '委托人', '受托人', '监护人', '家属', '家长',
  '客户', '患者', '病人', '业主', '租客', '承租人', '户主', '房主', '车主', '驾驶员', '司机',
  '收款人', '付款人', '领款人', '报销人', '报修人', '签单人', '收件人', '寄件人', '发货人',
  '经办人', '经手人', '复核人', '审核人', '审批人', '投保人', '被保险人', '受益人', '持卡人', '员工',
  // 职务名（「总经理陈阿满」「法定代表人王芳」这类无冒号的紧邻语境）
  '法定代表人', '总经理', '副总经理', '董事长', '执行董事', '负责人', '校长', '院长',
  '庭长', '检察长', '警长', '厂长', '站长', '所长', '社长', '馆长', '总监', '主管',
  '答', '问',
];

// 角色标签 + 可选序号（原告/被告一/被告2）+ 可选括注（受托人（签名）：）+ 可选冒号 + 姓名
// 标签内部允许空白：法律文书常见「审　　判　　长　　　郑怀瑾」
// 必须按长度降序：否则「被告」会抢在「被告人」前匹配，把「人」吃进候选
// （「被告人陈阿满在…」→ 捕获「人陈阿满」→ 姓名整片漏检）。
const ROLE_PATTERN = ROLE_LABELS.slice()
  .sort((a, b) => b.length - a.length)
  .map((l) => l.split('').join('\\s*')).join('|');
const ROLE_RE = new RegExp(
  `(?:${ROLE_PATTERN})\\s*(?:[一二三四五六七八九十\\d]{1,2})?\\s*(?:[（(][^）)\\n]{0,10}[）)])?\\s*[:：]?\\s*([\\u4e00-\\u9fa5]{2,4})`,
  'g'
);

// 姓名后紧跟的连词/谓语字：`原告陈阿满与被告…` 这类不能把「与」吃进名字
const NAME_TAIL_STOP = /[与和及等的系为在住于将已均也都还又再并对向从因被由至到后前同亦曾按依就才则而]/;

/**
 * 姓名「末字」黑名单：这些字几乎不会是人名最后一字，而是紧跟在人名后的谓语/宾语。
 * 角色标签后的姓名不再要求「后接标点/连词」边界（法律文书里常见
 * 「负责人李四贿赂14万元」「法定代表人王芳银行转账」，后面直接跟动词），
 * 改为从长到短试候选，末字命中本表就缩短一位，避免把「李四贿」当名字。
 */
// 仅用于「3 字及以上候选」的末字判定：2 字真名（李刚 / 李元 / 张心）不能因此被拒。
// 「王芳刚大学毕业」「李四送给我」「李四上述」「张伟出庭」都是把谓语首字吃进名字，
// 命中本表就缩短一位。注意「元 / 心」等常见人名末字**不能**放进来（陈阿元会被切成陈阿）。
const NAME_TAIL_BAD = new Set([...'贿赂银账转同表示称述供在担任先后与和及的是为向从对被将已均也都还又再并而则就才等受收给请辩诉商议签字负人于年月日时分起经买卖付领取办交货款项万族行位门构筑织团院校府所队局站厂店馆部室处司社送上刚按正便即把被说出问答陈称供担开，,。；;、：:（）()《》「」 　']);

// 任何长度的姓名都不该以这些机构/职务泛称字收尾（「教务处」「回族」）。
const NAME_ORG_TAIL = new Set([...'公位门构筑织团院校府所队局站厂店馆部室处司社族']);

// 姓名之后允许出现的字（标点 / 连词 / 常见谓语）；不在此列说明是普通词，不是姓名
const AFTER_NAME_RE = /[\s，,。；;、：:（）()《》「」与和及等的系为在住将已均也都还又再并对向从因被由至到后前同亦曾按依就才则而诉称辩表请述]/;

// 跟在角色标签后、但不是姓名的常见词
const ROLE_FALSE_NAMES = new Set([
  '肖像', '陈述', '陈诉', '安排', '关于', '一方', '双方', '各方', '本案', '该案', '证据', '起诉',
  '办公', '公司', '单位', '部门', '机构', '组织', '当事', '全体', '上述', '前述', '相关', '有关',
  '其他', '本人', '本院', '法院', '医院', '学校', '政府',
]);

/** 从 4 字候选里剥掉尾部连词/谓词（「陈阿满与」→「陈阿满」） */
function trimNameTail(g) {
  let out = g;
  while (out.length > 2 && NAME_TAIL_STOP.test(out[out.length - 1])) out = out.slice(0, -1);
  return out;
}

/* ---------------- 角色标签后的「非表内姓氏」宽容通道 ---------------- */

// 姓名里绝不会出现的功能字（判断罕见姓时用）
const NAME_FUNC_CHARS = new Set([...'的了着过是不没无未在要能与和及由从对为向至到等该本此其各我你他她它们将已均也都还又再并而则就才被把给让同亦曾按依第号年月日时分说称辩请表诉判决书条款项']);

// 罕见但真实的姓氏（不在 SURNAMES_1 里，出现频率低、误伤面小）
const SURNAMES_EXTRA = new Set([...'麦冼邝岑植揭禤訾隗逯郗阚殳钭竺柒招']);

// 候选的第二个字若是机构泛称字，几乎一定不是人名（办公室、公司、银行…）
const ORG_GENERIC_TAIL = new Set([...'公位门构筑织团行院校府会所心队局站厂店馆部室处司社']);

/**
 * 罕见姓氏（麦、冼、邝…）不在 SURNAMES_1 里，但角色标签后接的短词往往就是姓名。
 * 这里**只认扩展姓氏表**，不放开到任意汉字 —— 否则「受托人作出…」「委托人身体…」
 * 这类标签后紧跟动词/名词的句子会被整片误判成人名。
 */
function looseNameOk(cand) {
  if (cand.length < 2 || cand.length > 3) return false;
  if (!SURNAMES_EXTRA.has(cand[0])) return false;
  if (ORG_GENERIC_TAIL.has(cand[cand.length - 1])) return false;
  for (const ch of cand) if (NAME_FUNC_CHARS.has(ch)) return false;
  return true;
}

/**
 * 角色标签后的姓名：从长到短试长度，要求「姓氏合法 + 后接边界 + 不是机构/地名」
 *  - 「陈阿满与」→ 陈阿满（与 是边界）
 *  - 「安排于」  → 拒绝（后接「神」，不是边界）
 *  - 「受托人：麦穗，」→ 麦穗（罕见姓走宽容通道）
 */
function roleNameAt(text, raw, start) {
  const maxLen = SURNAMES_2.has(raw.slice(0, 2)) ? 4 : 3;
  for (let len = Math.min(maxLen, raw.length); len >= 2; len--) {
    const cand = trimNameTail(raw.slice(0, len));
    if (cand.length < 2) continue;
    const end = start + cand.length;
    if (NAME_BLACKLIST.has(cand) || ROLE_FALSE_NAMES.has(cand)) continue;
    const last = cand[cand.length - 1];
    if (NAME_ORG_TAIL.has(last)) continue;
    if (cand.length >= 3 && NAME_TAIL_BAD.has(last)) continue;
    if ([...cand].some((ch) => NAME_FUNC_CHARS.has(ch))) continue;
    if (looksLikeOrgOrPlace(text, start, end)) continue;
    if (!hasSurname(cand) && !looseNameOk(cand)) continue;
    return { value: cand, end };
  }
  return null;
}

// 姓名后紧跟的明确谓语：「与李四商议」「李四同意」「王芳供述」。
// 只认这一类强动作词，不把「张伟开会」这类普通叙述放进证据，避免误报。
const NAME_ACTION_WORDS = [
  '同意', '商议', '商定', '约定', '协商', '洽谈', '表示', '供述', '陈述', '辩称', '供称',
  '签字', '确认', '承认', '否认', '提出', '要求', '告知', '答复', '答复', '经办', '出具',
  '提供', '收受', '收取', '支付', '转账', '汇款', '联系', '安排', '指派', '委托',
];

// 职业/身份前缀 + 姓名（「村医周济世」「米婆梁月娇」「村民吴阿琴」）
const OCCUPATIONS = [
  '米婆', '村医', '村民', '村长', '村支书', '支书', '村主任', '童身', '医生', '大夫', '护士',
  '老师', '师傅', '老板', '经理', '律师', '法官', '警官', '警察', '司机', '会计', '出纳',
  '工头', '主任', '组长', '厂长', '店长', '房东', '租客', '学生', '家长', '家属', '亲友', '邻居',
];


/* ------------------------------------------------------------------ */
/* 主体正则                                                             */
/* ------------------------------------------------------------------ */

const RE = {
  // 手机号（13-19 号段；允许 138-1234-5678 / 138 1234 5678 分隔格式；边界断言避免命中更长数字串/身份证片段）
  phone: /(?<![\dXx])(?:\+?86[-\s·]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g,
  // 身份证 18 位（结构校验 + 校验码验算在代码中完成）
  idCard: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
  // 银行卡（常见 BIN 前缀 + Luhn 验算在代码中完成）
  bank: /(?<!\d)(?:62|60|4\d|5[1-5]|3[47]|35(?:2[89]|[3-8]))\d{11,17}(?!\d)/g,
  email: /[\u4e00-\u9fa5A-Za-z0-9._%+-]+@[\u4e00-\u9fa5A-Za-z0-9-]+(?:\.[\u4e00-\u9fa5A-Za-z0-9-]+)+/g,
  // 护照（字母 + 8 位数字）
  passport: /(?<![A-Za-z0-9])[EGSPD][0-9]{8}(?![0-9A-Za-z])/g,
  // 车牌（普通 + 新能源）
  plate: /(?<![\u4e00-\u9fa5A-Za-z0-9])[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵青藏川宁琼使领][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳](?![\u4e00-\u9fa5A-Za-z0-9])/g,
  // 案号：（2020）粤0882民特47号 / （2019）最高法民终1234号（允许文书里的空格）
  caseNo: /[（(]\s*(?:19|20)\d{2}\s*[）)]\s*[\u4e00-\u9fa5]{1,8}\s*\d{0,6}\s*[\u4e00-\u9fa5]{1,6}\s*\d{1,6}\s*号(?:之[一二三四五六七八九十]+)?/g,
  // 固定电话/传真（0 区号 + 7/8 位；允许分隔符），总长 10-12 位
  landline: /(?<!\d)0\d{2,3}[-—\s]?\d{7,8}(?!\d)/g,
  // 400/800 企业热线
  hotline: /(?<!\d)(?:400|800)[-—\s]?\d{3}[-—\s]?\d{4}(?!\d)/g,
  // 社交账号（关键词引导，仿身份证宽松模式）
  imWechat: /(?:微信号|微信账号|WX号|wx号|vx号|VX号|威信号|WeChat号)\s*[:：]?\s*([A-Za-z][-_A-Za-z0-9]{5,19})/g,
  imQQ: /(?:QQ号|QQ账号|QQ)\s*[:：]?\s*([1-9]\d{4,10})(?!\d)/g,
  // 港澳居民来往内地通行证（回乡证）：H/M + 8 位数字
  hkmtPermit: /(?<![A-Za-z0-9])[HM]\d{8}(?![0-9A-Za-z])/g,
  // 台湾居民来往大陆通行证（台胞证）：关键词引导
  hkmtTaiwan: /台胞证\s*[:：]?\s*([1-9]\d{7})(?!\d)/g,
  // 统一社会信用代码（18 位，结构 + 校验码验算在代码中完成）
  uscc: /(?<![0-9A-Z])[159Y][1239]\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])/g,
};

// 执业证号（律师/会计师/公证员…）：关键词 + 15~20 位编号，可带字母前缀
const RE_LICENSE = /(?:律师执业证号|执业证号|执业证书号|执业证|资格证号|法律职业资格证号|公证员执业证号)\s*[:：]?\s*第?\s*([A-Za-z]?\d{15,20})/g;

// 带关键词前缀的宽松匹配（有语境，可放宽校验；覆盖「公民身份号码」「居民身份号码」等法律文书表述）
const RE_IDCARD_LOOSE = /(?:公民身份号码|居民身份号码|身份号码|身份证号码|身份证号|身份证|证件号码|证件号)\s*[:：]?\s*([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])/g;
const RE_BANK_KEYWORD = /(?:银行卡号|银行账号|卡号|账号|储蓄卡|借记卡|信用卡)\s*[:：]?\s*(\d{13,19})/g;

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

// 统一社会信用代码校验（GB 32100-2015）
const USCC_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/** 统一社会信用代码校验码验算 */
function isValidUscc(s) {
  if (!/^[159Y][1239]\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ci = USCC_CHARSET.indexOf(s[i]);
    if (ci < 0) return false;
    sum += ci * USCC_WEIGHTS[i];
  }
  return USCC_CHARSET[(31 - (sum % 31)) % 31] === s[17];
}

function isValidIdCard(s) {
  if (!s || s.length !== 18) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === s[17].toUpperCase();
}

function luhnValid(s) {
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (Number.isNaN(d)) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

/* ---------------- 地址 / 位置信息 ---------------- */

// 地址引导词（长词在前，避免单字「住」抢先于「户籍所在地」）
const ADDR_KEYWORDS = [
  '户籍所在地', '经常居住地', '户籍地址', '户籍地', '住所地', '居住地', '暂住地',
  '现住址', '通讯地址', '联系地址', '家庭住址', '详细地址', '办公地址', '家庭地址',
  '注册地', '所在地', '住址', '地址', '籍贯', '原籍', '祖籍', '出生地', '户籍',
  '现住', '暂住', '居住', '家住', '住于', '住在', '位于', '坐落于', '住',
].join('|');
const ADDR_KEY_RE = new RegExp(`(?:${ADDR_KEYWORDS})\\s*[:：]?\\s*`, 'g');

// 至少一个地址要素才算地址（防止「住」后面跟普通叙述被整句吞掉）
const ADDR_FEATURE_RE = /(?:省|自治区|市|自治州|地区|盟|区|县|镇|乡|街道|村|路|街|大道|大街|巷|弄|号|栋|幢|座|单元|室|楼|层|户|组|队|屯|堡|寨|庄|苑|园|府|小区|花园|公寓|大厦|广场|家园|庭院|山庄|宿舍|大院|新村|社区)/;

// 行政区划链：连续 ≥2 个层级（浙江省 / 杭州市 / 西湖区 / 文三路）
const ADMIN_ATOM = /[\u4e00-\u9fa5]{1,8}?(?:省|自治区|自治州|地区|市|区|县|旗|盟|镇|乡|街道|苏木|村|社区|屯|寨|堡|庄|组|队|路|街|大道|大街|巷|弄)/;
const ADMIN_CHAIN_RE = new RegExp(`(?:${ADMIN_ATOM.source}){2,6}`, 'g');

// 行政区划串里不会出现功能字 / 动词 / 代词。扫描链时若混入这些字，
// 说明是把一整句叙述当成了地名（「我今天要向组织我分别收受雷阳中学南校区」）。
const PLACE_FORBIDDEN_RE = /[我你他她们的了着过是不没无未在要能与和及由从对为向至到等该本此其各将已均也都还又再并而则就才被把给让同亦曾按依说称辩请表诉判决书条款项收受问答供述担任食责员训验检执纪监组职]/;
const PLACE_CORE_RE = /(?:省|自治区|自治州|地区|市|县|区|旗|盟|镇|乡|街道|苏木|村|社区|屯|寨|堡|庄)/;

// 地址串的「最后一个地址要素」：门牌 / 楼栋 / 单元 / 室 / 村组等。
// 「位于…701室的住处抓获归案」必须裁到「…701室」为止，不能把后续叙述一起屏蔽。
const ADDR_TAIL_RE = /(?:[\u4e00-\u9fa5]{0,6}(?:路|街|大道|大街|巷|弄|村|镇|乡|区|县|市|省|苑|园|府|小区|花园|公寓|大厦|广场|家园|山庄|宿舍|大院|社区|号楼|楼|栋|幢|座|单元|室|层|户|组|队|屯|寨|堡|庄|号)[\s　]*\d{0,6}(?:室|号|栋|幢|座|单元|楼|层|户|组|队|屯|寨|堡|庄|村|苑|园|府|号楼)?)/g;

function trimAddressTail(raw) {
  ADDR_TAIL_RE.lastIndex = 0;
  let lastEnd = 0;
  let m;
  while ((m = ADDR_TAIL_RE.exec(raw)) !== null) {
    lastEnd = m.index + m[0].length;
    if (m.index === ADDR_TAIL_RE.lastIndex) ADDR_TAIL_RE.lastIndex++;
  }
  return lastEnd > 0 && lastEnd < raw.length ? raw.slice(0, lastEnd) : raw;
}

// 籍贯 / 出生地表述：「，浙江杭州人，」「回族，浙江杭州人」
const ORIGIN_RE = /(?:^|[,，、；;。\s（(])([\u4e00-\u9fa5]{2,12}(?:省|自治区|市|县|区|镇|乡|村|旗|盟|州)[\u4e00-\u9fa5]{0,6})人(?=[,，。；;、\s）)]|$)/g;

// 国家机关 / 学校 / 医院等：地名链后面若紧跟这些词，说明是机构名称的一部分，
// 屏蔽掉会让文书失去可读性（「杭州市人民检察院」→「……人民检察院」）
const PUBLIC_BODY_WORDS = [
  '人民法院', '人民检察院', '人民政府', '公安局', '派出所', '司法局', '监察委员会',
  '管理委员会', '委员会', '村民委员会', '居民委员会', '中学', '小学', '大学', '学校',
  '学院', '医院', '卫生院', '检察院', '法院', '政府', '公安局', '财政局', '教育局',
  '税务局', '市场监管局', '自然资源局', '培训中心', '实验中学', '律师事务所',
];

function endsAtPublicBody(text, end) {
  // 链尾可能停在「浙江省杭州市」，后面还有「市人民法院」，故用包含判断
  const ahead = text.slice(end, end + 12);
  return PUBLIC_BODY_WORDS.some((w) => ahead.includes(w));
}

/**
 * 地址 / 位置信息检测（四路合并，统一产出 address 类型）
 *  1. 引导词 + 整串地址：一条到句读为止，省市区县镇乡村 / 路街巷 / 门牌 / 楼栋单元室全部纳入
 *  2. 连续行政区划链：即使没有引导词、没有门牌号，多层级地名本身也是位置信息
 *  3. 籍贯「XX县人」「XX省XX市人」
 *  4. 旧有的保守组合模式（兜底，覆盖「幸福路 123 号」这类空格排版）
 */
function detectAddress(text) {
  const out = [];
  const push = (start, end, value) => {
    const v = value.trim();
    if (!v || v.length < 4 || v.length > 60) return;
    out.push({ type: 'address', start, end, value: v });
  };

  // 1) 引导词整串
  ADDR_KEY_RE.lastIndex = 0;
  let m;
  while ((m = ADDR_KEY_RE.exec(text)) !== null) {
    const from = m.index + m[0].length;
    let stop = from;
    const limit = Math.min(text.length, from + 60);
    while (stop < limit && !CLAUSE_END_RE.test(text[stop])) stop++;
    let raw = text.slice(from, stop);
    if (!ADDR_FEATURE_RE.test(raw)) continue;
    // 裁掉地址之后的叙述（「…701室的住处抓获归案」→「…701室」）
    raw = trimAddressTail(raw);
    const lead = raw.length - raw.replace(/^[\s　]+/, '').length;
    const trimmed = raw.trim();
    push(from + lead, from + lead + trimmed.length, trimmed);
  }

  // 2) 连续行政区划链
  ADMIN_CHAIN_RE.lastIndex = 0;
  while ((m = ADMIN_CHAIN_RE.exec(text)) !== null) {
    if (m.index === ADMIN_CHAIN_RE.lastIndex) { ADMIN_CHAIN_RE.lastIndex++; continue; }
    const v = m[0];
    if (v.length > 30 || PLACE_FORBIDDEN_RE.test(v) || !PLACE_CORE_RE.test(v)) continue;
    if (endsAtPublicBody(text, m.index + v.length)) continue;
    push(m.index, m.index + v.length, v);
  }

  // 3) 籍贯 / 出生地
  ORIGIN_RE.lastIndex = 0;
  while ((m = ORIGIN_RE.exec(text)) !== null) {
    const v = m[1];
    const start = m.index + m[0].lastIndexOf(v);
    // 「…县人」本身已是强语境，且 lookahead 要求紧跟标点，
    // 不会误吃「杭州市人民法院」；这里不再套用机关名排除（以免「，大学文化」误伤）。
    push(start, start + v.length, v);
  }

  // 4) 保守组合模式（兜底）
  const C = '[\\u4e00-\\u9fa5]';
  const W = '[\\u4e00-\\u9fa50-9A-Za-z \\t\\u3000]';
  const SP = '[ \\t\\u3000]*';
  const UNIT = `(?:${SP}(?:室|栋|幢|座|单元|号楼|楼))?`;
  const patterns = [
    new RegExp(`${C}{2,8}(?:省|自治区)${SP}${C}{1,12}(?:市|自治州|地区|盟)${W}{0,30}?\\d{1,6}${SP}号${UNIT}`, 'g'),
    new RegExp(`${C}{1,8}(?:市|县|区)${SP}${W}{0,18}?${C}{1,8}(?:区|县|镇|乡)${W}{0,20}?\\d{1,6}${SP}号${UNIT}`, 'g'),
    new RegExp(`${W}{2,20}?(?:路|街|大道|大街|巷|弄|村)${W}{0,12}\\d{1,6}${SP}号${UNIT}`, 'g'),
    new RegExp(`${C}{2,12}(?:小区|花园|公寓|大厦|广场|家园|庭院|山庄|宿舍|大院|苑)${W}{0,6}(?:\\d{1,4}${SP}(?:号|期|幢|栋|单元|室)|${C}{0,4}(?:栋|幢|号楼|单元|室))`, 'g'),
  ];
  for (const re of patterns) {
    while ((m = re.exec(text)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      const raw = m[0];
      const lead = raw.length - raw.replace(new RegExp(`^${SP}`), '').length;
      const v = raw.trim();
      if (v.length > 48 || v.length < 6) continue;
      out.push({ type: 'address', start: m.index + lead, end: m.index + lead + v.length, value: v });
    }
  }
  return out;
}

/* ---------------- 机构名（民商事主体） ---------------- */

/**
 * 需要屏蔽的主体后缀：律所、事务所、公司、集团、合作社
 * 注意：人民法院 / 人民检察院 / 公安局 / 人民政府 等国家机关**不在**此列 ——
 * 文书来源机关是文书效力的一部分，脱掉反而不可用
 */
const ORG_SUFFIXES = [
  '律师事务所', '会计师事务所', '税务师事务所', '专利代理事务所', '商标代理事务所',
  '事务所', '有限责任公司', '股份有限公司', '有限公司', '股份公司', '集团公司',
  '公司', '集团', '合作社',
];
// 后缀按长度降序，保证「股份有限公司」不会被短后缀「公司」截断
const ORG_SUFFIX_RE = new RegExp(
  `(?:${ORG_SUFFIXES.slice().sort((a, b) => b.length - a.length).join('|')})`, 'g'
);

/**
 * 向左取字号时的「断点字」：动词 / 虚词 / 时间词 / 数词 / 标点。
 * 旧实现用 `[汉字]{2,14}(后缀)` 贪婪回退，只裁前导虚词，
 * 于是「陈阿满是广东雷阳律师事务所」中的人名、系动词、时间词
 * 「2022年9月初」全被吃进字号，屏蔽后残留「陈阿……律师事务所」。
 */
// 注意：地名字号里常见的「上海 / 前海 / 同仁 / 中国」等字不能设为断点，
// 否则「上海XX有限公司」会被切成「海XX有限公司」。
const ORG_BREAK = new Set([...'的了在是与和及由从对为向至到等该本此其各我你他她它将已均也都还又再并而则就才被把给让同亦曾按依第号年月日时分初底旬份于说称辩请委托聘诉收受问答供述担任零○〇一二三四五六七八九十：:，,。；;、（）()《》「」 　']);

// 泛指主体，不是具体机构名
const ORG_FALSE_PREFIX = ['上述', '前述', '相关', '关联', '多家', '一家', '两家', '三家', '其他', '有关', '任何', '部分', '所有', '全部', '中小', '小微'];

/**
 * 机构名检测：从主体后缀向左回退取字号（≤14 汉字），遇断点字立即停。
 *  - 「收受广东雷阳律师事务所」→ 广东雷阳律师事务所
 *  - 「答：陈阿满是广东雷阳律师事务所」→ 广东雷阳律师事务所
 *  - 「该公司 / 分公司 / 上述公司」→ 字号不足或泛指，跳过
 */
function detectOrgs(text) {
  const out = [];
  ORG_SUFFIX_RE.lastIndex = 0;
  let m;
  while ((m = ORG_SUFFIX_RE.exec(text)) !== null) {
    const suffix = m[0];
    const brandEnd = m.index;
    let i = brandEnd;
    const min = Math.max(0, brandEnd - 14);
    while (i > min) {
      const ch = text[i - 1];
      if (!/[\u4e00-\u9fa5]/.test(ch)) break;
      if (ORG_BREAK.has(ch)) break;
      i--;
    }
    const brand = text.slice(i, brandEnd);
    if (brand.length < 2) continue;
    if (ORG_FALSE_PREFIX.some((p) => brand.startsWith(p))) continue;
    const prev = text[i - 1] || '';
    if (prev === '《' || prev === '〈') continue;
    const end = brandEnd + suffix.length;
    out.push({ type: 'org', start: i, end, value: text.slice(i, end) });
  }
  return out;
}

/* ---------------- 姓名（语境驱动） ---------------- */

/** 是否以常见姓氏开头（单姓取首字，复姓取前两字） */
function hasSurname(v) {
  if (!v || !/^[\u4e00-\u9fa5]/.test(v)) return false;
  if (SURNAMES_2.has(v.slice(0, 2))) return true;
  return SURNAMES_1.has(v[0]);
}

/** 从 start 到最近的标点为止（限制 40 字，避免长句扫描） */
function clauseStop(text, start, end) {
  const limit = Math.min(text.length, end + 40);
  for (let i = start; i < limit; i++) if (CLAUSE_END_RE.test(text[i])) return i;
  return limit;
}

/**
 * 候选本身是不是地名 / 机构名的一部分？只做**紧邻的局部判断**。
 *
 * 旧实现会扫描「所在分句里是否出现任何机构词」，结果法律文书里
 * 「被告人陈阿满在先后担任雷阳中学主任」「负责人李四…有限公司」
 * 整句含「中学/公司」，人名被整片否掉 —— 这正是大量漏检的主因。
 * 姓名是否成立由语境证据把关，这里只排除「候选自己就是地名/机构名」的情形。
 */
function looksLikeOrgOrPlace(text, start, end) {
  const value = text.slice(start, end);
  if (!value) return true;
  if (PLACE_TAIL.has(value[value.length - 1])) return true;
  const next = text[end] || '';
  if (next && PLACE_TAIL.has(next)) return true;
  // 只有「候选 + 真正的机构后缀」才说明候选是字号（广东海田律师事务所）。
  // 用泛机构词会把「王芳银行转账」的「银行」当成机构名，把姓名切成两字。
  if (ORG_SUFFIXES.some((s) => text.startsWith(s, end))) return true;
  return false;
}

const isPunct = (c) => c === '，' || c === ',' || c === '。' || c === '；' || c === ';';

/**
 * 姓名检测：以「语境证据」为准，不做无证据的全文猜名
 * 证据（任一即可）：角色标签 / 称呼后缀 / 「，男｜女」结构 / 职业前缀 /
 * 紧邻强 PII（身份证、手机号…）/ 同文档已确认姓名
 */
function detectNames(text, strongItems, knownNames) {
  const out = [];
  const seen = new Set();

  const push = (start, end, confident) => {
    if (start < 0 || end > text.length || end - start < 2) return false;
    const value = text.slice(start, end);
    if (!/^[\u4e00-\u9fa5]{2,4}$/.test(value)) return false;
    if (NAME_BLACKLIST.has(value)) return false;
    // 统一兜底：机构/职务泛称字结尾、或 3 字以上候选以谓语字收尾的都不是人名
    const last = value[value.length - 1];
    if (NAME_ORG_TAIL.has(last)) return false;
    if (value.length >= 3 && NAME_TAIL_BAD.has(last)) return false;
    if ([...value].some((ch) => NAME_FUNC_CHARS.has(ch))) return false;
    const key = start + ':' + value;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({ type: 'name', start, end, value, confident: !!confident });
    return true;
  };

  // 1) 角色标签 + 姓名（最高置信：「原告：陈阿满」「被告一：陈德寿」「负责人陈兆坤」）
  let m;
  ROLE_RE.lastIndex = 0;
  while ((m = ROLE_RE.exec(text)) !== null) {
    const raw = m[1] || '';
    const start = m.index + m[0].length - raw.length;
    const hit = roleNameAt(text, raw, start);
    if (!hit) {
      // 标签本身可能被更外层标签「吃掉」（如「原告法定代理人陈X」里的「原告」），
      // 回退一格重新扫描，保证内层标签仍能匹配
      ROLE_RE.lastIndex = m.index + 1;
      continue;
    }
    const { value, end } = hit;
    const flat = m[0].replace(/\s+/g, '');
    const label = PARTY_LABELS_SORTED.find((l) => flat.startsWith(l)) || '';
    // 「被告方」「各方当事人」：指代而非姓名
    if (label && '方各双本该其此全另'.includes(value[0])) continue;
    push(start, end, true);

    // 「陈建平、吴秀莲」「陈建平（之父）、吴秀莲」：同一列表里的后续姓名
    let p = end;
    for (let n = 0; n < 6; n++) {
      let q = p;
      // 先跳过括注：陈建平（之父）、吴秀莲
      const par = /^[（(][^）)]{1,16}[）)]/.exec(text.slice(q, q + 24));
      if (par) q += par[0].length;
      const sep = /^[、　\s]{1,4}/.exec(text.slice(q, q + 6));
      if (sep) q += sep[0].length;
      if (q === p) break;
      let next = null;
      for (const len of [3, 2]) {
        const cand = text.slice(q, q + len);
        if (cand.length < len || !/^[\u4e00-\u9fa5]+$/.test(cand)) continue;
        if (NAME_BLACKLIST.has(cand) || ROLE_FALSE_NAMES.has(cand)) continue;
        const last = cand[cand.length - 1];
        if (NAME_ORG_TAIL.has(last)) continue;
        if (cand.length >= 3 && NAME_TAIL_BAD.has(last)) continue;
        if ([...cand].some((ch) => NAME_FUNC_CHARS.has(ch))) continue;
        if (!hasSurname(cand) && !looseNameOk(cand)) continue;
        if (looksLikeOrgOrPlace(text, q, q + len)) continue;
        next = len;
        break;
      }
      if (!next) break;
      if (!push(q, q + next, true)) break;
      p = q + next;
    }
  }

  // 2) 无标签处：必须有语境证据才判为姓名
  const evidence = (start, end) => {
    const value = text.slice(start, end);
    if (knownNames && knownNames.has(value)) return true;
    // 称呼后缀：张三先生 / 王芳女士
    // 「该公司总经理」的「司总 / 司副总」也紧邻称呼词，用前文机构泛称字排除
    if (TITLES_SET.has(text.substr(end, 2))) {
      const prev = text[start - 1] || '';
      if (!ORG_GENERIC_TAIL.has(prev)) return true;
    }
    // 「陈德寿，男，1962年…」法律文书固定结构
    if (isPunct(text[end]) && (text[end + 1] === '男' || text[end + 1] === '女')
      && (end + 2 >= text.length || isPunct(text[end + 2]) || text[end + 2] === '\n')) return true;
    // 紧邻强 PII（≤2 字）
    if (strongItems && strongItems.some((s) =>
      (start >= s.end ? start - s.end : s.start - end) <= 2)) return true;
    // 职业/身份前缀：村医周济世 / 米婆梁月娇 / 村民吴阿琴
    const before = text.slice(Math.max(0, start - 4), start);
    if (OCCUPATIONS.some((o) => before.endsWith(o))) return true;
    // 前有分隔符（或句首）、后接明确谓语：「与李四商议」「李四同意」
    const prevCh = text[start - 1] || '';
    if (!prevCh || /[，,、；;：:。\s（(与和及]/.test(prevCh)) {
      if (NAME_ACTION_WORDS.some((w) => text.startsWith(w, end))) return true;
    }
    return false;
  };

  for (let i = 0; i < text.length - 1; i++) {
    if (!SURNAMES_1.has(text[i]) && !SURNAMES_EXTRA.has(text[i])) continue;
    // 「王女士」这类表述本身就是屏蔽写法，不再处理
    if (TITLES_SET.has(text.substr(i + 1, 2))) continue;
    // 优先 3 字，证据不足时回落 2 字（「周砚，广东…」不能被切成「周砚广」）
    for (const len of [3, 2]) {
      const end = i + len;
      if (end > text.length) continue;
      const value = text.slice(i, end);
      if (!/^[\u4e00-\u9fa5]+$/.test(value)) continue;
      if (NAME_BLACKLIST.has(value)) continue;
      // 「王芳女士」不能切成「王芳女」：末字与后一字凑成称呼词时退回短长度
      if (len === 3 && TITLES_SET.has(value[value.length - 1] + (text[end] || ''))) continue;
      if (!evidence(i, end)) continue;
      if (looksLikeOrgOrPlace(text, i, end)) continue;
      // push 可能因功能字 / 机构泛称字拒绝候选；此时必须继续试更短的长度，
      // 否则「李四也同意」的 3 字候选被拒后，2 字真名「李四」也会被跳过。
      if (push(i, end, true)) break;
    }
  }

  return out;
}

/* ---------------- 强 PII 扫描 ---------------- */

function detectStrong(text, opts) {
  const out = [];
  const scan = (re, type, validate) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      const v = m[0];
      if (validate && !validate(v)) continue;
      out.push({ type, start: m.index, end: m.index + v.length, value: v });
    }
  };
  const scanGrouped = (re, type) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1] == null) continue;
      const start = m.index + m[0].lastIndexOf(m[1]);
      out.push({ type, start, end: start + m[1].length, value: m[1] });
    }
  };
  if (opts.idCard !== false) {
    // 法律文书里的身份证号常是虚构/演示值，校验码未必合法
    //（如 330106199001015670）。正则已限制地区码 + 合法出生日期 + 顺序码，
    // 结构足够判定，不再强制校验和；否则整类号码会被静默漏掉。
    scan(RE.idCard, 'idCard');
    scanGrouped(RE_IDCARD_LOOSE, 'idCard'); // 有语境 → 同样免校验和
  }
  if (opts.license !== false) scanGrouped(RE_LICENSE, 'license'); // 执业证号：有「执业证号」语境即可
  if (opts.caseNo !== false) scan(RE.caseNo, 'caseNo');
  if (opts.bank !== false) {
    scan(RE.bank, 'bank', luhnValid);
    scanGrouped(RE_BANK_KEYWORD, 'bank'); // 有语境 → 免 Luhn
  }
  if (opts.phone !== false) scan(RE.phone, 'phone');
  if (opts.email !== false) scan(RE.email, 'email');
  if (opts.passport !== false) scan(RE.passport, 'passport');
  if (opts.plate !== false) scan(RE.plate, 'plate');
  // 以下为默认关闭的可选检测项（settings toggles 显式开启才生效）
  if (opts.landline === true) { scan(RE.landline, 'landline'); scan(RE.hotline, 'landline'); }
  if (opts.im === true) { scanGrouped(RE.imWechat, 'im'); scanGrouped(RE.imQQ, 'im'); }
  if (opts.hkmt === true) { scan(RE.hkmtPermit, 'hkmt'); scanGrouped(RE.hkmtTaiwan, 'hkmt'); }
  if (opts.uscc === true) scan(RE.uscc, 'uscc', isValidUscc);
  return out;
}

/* ---------------- 依法排除：性别/年龄/出生日期/民族 ---------------- */

const EXCLUSION_RE = [
  /(?:性别|gender)\s*[:：]?\s*(?:男|女|男性|女性|其它|其他)/gi,
  /(?:年龄|age|岁数)\s*[:：]?\s*\d{1,3}(?:\.\d+)?\s*(?:岁|周岁|岁半)?/gi,
  /\d{1,3}\s*(?:周岁|岁半|岁)/g,
  /(?:出生日期|生日|出生|birth(?:day|date)?)\s*[:：]?\s*\d{2,4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/gi,
  /民族\s*[:：]?\s*[\u4e00-\u9fa5]{1,8}/g,
];

function exclusionRanges(text) {
  const out = [];
  for (const re of EXCLUSION_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

const isContained = (item, ranges) =>
  ranges.some(([a, b]) => item.start >= a && item.end <= b);

/* ---------------- 优先级与去重 ---------------- */

const PRIORITY = {
  caseNo: 0, idCard: 1, license: 2, bank: 3, phone: 4,
  passport: 5, email: 6, plate: 7, org: 8, address: 9, name: 10,
  landline: 4, im: 6, hkmt: 5, uscc: 2,
};

function dedupe(items) {
  items.sort((a, b) => (a.start - b.start) || (PRIORITY[a.type] - PRIORITY[b.type]));
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && it.start < last.end) {
      // 重叠：保留优先级更高者；同级取更长者
      const better =
        PRIORITY[it.type] < PRIORITY[last.type] ||
        (PRIORITY[it.type] === PRIORITY[last.type] && (it.end - it.start) > (last.end - last.start));
      if (better) out[out.length - 1] = it;
    } else {
      out.push(it);
    }
  }
  return out;
}

/* ---------------- 对外主入口 ---------------- */

/**
 * @param {string} text
 * @param {{toggles?:Record<string,boolean>, knownNames?:Set<string>}} [options]
 *   knownNames：同一文档中已确认的姓名，用于跨段落传播（首次出现在无语境处也能命中）
 * @returns {{items:Array<{type,start,end,value,confident?:boolean}>, counts:Record<string,number>}}
 */
function detect(text, options = {}) {
  const toggles = {
    phone: true, idCard: true, bank: true, email: true,
    passport: true, name: true, address: true, plate: true,
    caseNo: true, license: true, org: true,
    // 可选检测项：默认关闭（用户在设置中显式开启）
    landline: false, im: false, hkmt: false, uscc: false,
    ...(options.toggles || {}),
  };

  const strong = detectStrong(text, toggles);
  const items = [...strong];

  if (toggles.address) items.push(...detectAddress(text));
  if (toggles.org) items.push(...detectOrgs(text));
  if (toggles.name) items.push(...detectNames(text, strong, options.knownNames));

  // 排除依法不屏蔽的内容（仅当检测项“完全落在”排除区间内时丢弃）
  const excl = exclusionRanges(text);
  const filtered = items.filter((it) => !isContained(it, excl));

  const deduped = dedupe(filtered);
  const counts = {};
  for (const it of deduped) counts[it.type] = (counts[it.type] || 0) + 1;
  return { items: deduped, counts };
}

module.exports = {
  detect, isValidIdCard, isValidUscc, luhnValid, SURNAMES_1, SURNAMES_2, NAME_BLACKLIST, ORG_SUFFIXES,
};
