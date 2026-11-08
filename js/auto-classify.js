/* =========================================================================
 * js/auto-classify.js —— 按提示词文本自动推断分类
 *
 * 设计要点：
 * 1. 关键词表按「二级分类名称」组织，运行时再用分类名到 categories 里查 id。
 *    用户改过分类名、加过新分类、删过分类都不会让本模块报错——找不到对应分类的
 *    规则直接跳过，绝不硬编码分类 id。
 * 2. 纯函数：不依赖 DOM、不读写全局状态，便于单独测试。
 * 3. 打分：某个二级分类命中了多少个「不同」关键词 = 命中数；
 *    得分 = 命中数 × 一级分类权重 + 长词加分（详见 classifyPrompt 的 JSDoc）。
 *    同一关键词在一段文本里只算一次。
 * 4. 阈值：至少命中 1 个关键词才给结论，否则归入未分类，不瞎猜。
 *
 * 选词原则：宁可少而准。单字词（楼 / 草 / 自然）极易误伤（楼梯、草稿、自然光），
 * 一律换成更具体的整词；确实要保留的单字词由「跨分类吸收」兜底。
 * ========================================================================= */

/** 命中数阈值：低于该值视为「未识别」 */
const MIN_HITS = 1;

/** 权重比较的浮点容差 */
const EPS = 1e-9;

/**
 * 排除短语：匹配前先从文本里整段剔除。
 *
 * 这些短语里的单字（马 / 龙）是合法的主体词（「一匹骏马」「一条巨龙」），
 * 不能因为成语就删词；但「车水马龙」里的 马/龙 完全不是主体，
 * 会白送动物 2 分把街道/夜景挤掉。所以按短语剔除是唯一两全的做法。
 */
const PHRASE_EXCLUSIONS = ['车水马龙', '龙套', '龙椅', '水龙头', '腾云驾雾'];

/**
 * 长词加分：命中词里汉字数 ≥3 的（如「自然采光」「树蛙」「人像摄影」），
 * 每个额外 +0.15 分，最多计 3 个，避免长文本靠堆词刷分。
 * 作用：让更具体的长词赢下歧义（「自然光」不该被单字「光/自」类短词稀释）。
 */
const LONG_WORD_MIN_HANZI = 3;
const LONG_WORD_BONUS = 0.15;
const LONG_WORD_MAX = 3;

/**
 * 一级分类权重：命中数相同时按 风格 > 主体 > 场景 择优。
 * 命中数更多的低优先级分类仍可胜出（例如 3 个主体词 vs 1 个风格词），权重只用于打破平局。
 * 场景略低于风格/主体：一张图有明确主体时，「在哪」通常不如「是什么」关键。
 */
const TOP_WEIGHTS = new Map([
  ['风格', 1.25],
  ['主体', 1.25],
  ['场景', 1.1]
]);

/**
 * 命中数计分上限（按一级分类名）。
 *
 * 原本用来压住「画质增强」的长度黑洞：长提示词里 8K / 锐利 / 高细节 这类词
 * 动辄出现 4-8 个，按 hits 线性累加会反超真正的主题词。
 * 移除光照氛围 / 镜头构图 / 画质增强三个修饰类后，已没有分类需要限制，
 * 机制保留为空表，后续若新增「人人都写」的维度可按需启用。
 */
const EFFECTIVE_HIT_CAP = new Map();

/** 一级分类优先级序号（越小越优先），用于得分相同时的稳定排序 */
const TOP_PRIORITY = new Map(
  Array.from(TOP_WEIGHTS.keys()).map((name, index) => [name, index])
);

/** 权重表里没有的一级分类（用户自建）统一按 1.0 计 */
const DEFAULT_WEIGHT = 1.0;

/** 未知一级分类的优先级序号 */
const UNKNOWN_PRIORITY = 99;

/**
 * 关键词表：键为二级分类名称，值为触发词（中英文混排）。
 * 这里只描述「什么样的文本像这个分类」，不关心分类 id。
 */
const SUB_KEYWORDS = {
  /* ------------------------------ 风格 ------------------------------ */
  // 只保留「风格判定词」；摄影行为 / 器材参数（摄影、照片、相机、光圈、快门、iso、
  // 单反、dslr、photography、人像摄影）全部摘掉 —— 它们在提示词里几乎每条都出现，
  // 留着等于给「写实摄影」开无差别外挂，会把场景/主体/构图类全抢走。
  '写实摄影': [
    '写实', '超写实', '实拍', '照片级', '摄影风格',
    '纪实', '纪实摄影', '电影感', 'cinematic',
    'photorealistic', 'realistic', 'raw photo'
  ],
  '动漫插画': [
    '插画', '动漫', '二次元', '漫画', '动画', '卡通', '赛璐璐', '日系',
    'anime', 'illustration', 'manga', 'cartoon', 'cel shading', 'cel shaded'
  ],
  '油画': [
    '油画', '厚涂', '笔触', '古典油画', '油彩', 'impasto',
    'oil painting', 'oil on canvas'
  ],
  '水彩': [
    '水彩', '水彩晕染', '淡彩', '水墨淡彩', 'watercolor', 'watercolour'
  ],
  '3D 渲染': [
    '3d', '渲染', '建模', '三维', '体积光渲染',
    'blender', 'octane', 'c4d', 'cinema 4d', 'unreal', 'ue5', 'render', 'zbrush'
  ],
  '像素风': [
    '像素', '像素风', '点阵', 'pixel art', 'pixelart', '8-bit', '8bit', '16-bit'
  ],
  '赛博朋克': [
    '赛博朋克', '赛博', '全息', '义体', '霓虹', 'cyberpunk', 'cyber', 'hologram', 'holographic'
  ],
  '水墨': [
    '水墨', '国画', '写意', '工笔', '墨韵', 'ink wash', 'ink painting', 'sumi-e'
  ],

  /* ------------------------------ 主体 ------------------------------ */
  '人物': [
    '人物', '少女', '女性', '男性', '角色', '人像', '男孩', '女孩', '少年', '老人',
    '孩子', '肖像', '舞者', '肖像照', '母亲', '婴儿', '儿童', '模特', '男子', '女子',
    '情侣', '战士', '骑士', '精灵',
    'character', 'portrait', 'woman', 'women', 'girl', 'boy', 'lady', 'person'
  ],
  '动物': [
    '动物', '猫', '狗', '鸟', '兽', '孔雀', '马', '鹿', '狼', '龙',
    '巨龙', '飞龙', '神龙', '龙形', '龙鳞', '龙翼',
    '宠物', '白鸟', '飞鸟',
    '蛙', '青蛙', '树蛙', '狐狸', '兔子', '熊', '鱼', '蝴蝶', '鹰', '松鼠',
    'animal', 'cat', 'dog', 'bird', 'horse', 'wolf', 'dragon', 'deer', 'pet'
  ],
  '建筑': [
    '建筑', '城堡', '塔楼', '古堡', '教堂', '宫殿', '桥梁', '摩天', '房屋', '拱窗',
    'architecture', 'castle', 'tower', 'building', 'cathedral', 'palace', 'bridge'
  ],
  '地景': [
    '山脉', '瀑布', '峡谷', '沙漠', '海面', '草原', '雪山', '山峦', '丘陵', '湖面',
    '地平线', '海岸', '海洋', '云海', '风光', '风景', '山景', '海景',
    'landscape', 'mountain', 'waterfall', 'desert', 'canyon', 'ocean', 'beach', 'horizon'
  ],
  '植物': [
    '花', '花束', '玫瑰', '树', '森林', '植被', '藤蔓', '叶子', '花园', '盆栽',
    '草地', '草坪', '青草',
    'plant', 'flower', 'bouquet', 'tree', 'forest', 'leaf', 'leaves', 'garden'
  ],
  '食物': [
    '食物', '料理', '甜点', '咖啡', '美食', '蛋糕', '面包', '水果', '饮品', '餐点', '茶点',
    '拉面', '面条', '寿司', '火锅', '烧烤', '冰淇淋', '甜品',
    'food', 'dessert', 'cake', 'coffee', 'bread', 'fruit', 'drink', 'cuisine'
  ],
  '物品道具': [
    '道具', '器皿', '剑', '武器', '书本', '古籍', '书', '杯子', '花瓶', '蜡烛', '箱子',
    '珠宝', '静物', '书架', '颜料', '画册', '灯具',
    'prop', 'sword', 'weapon', 'book', 'vase', 'candle', 'jewelry', 'still life'
  ],
  '机械载具': [
    '机械', '飞船', '车辆', '机甲', '载具', '机器人', '飞机', '坦克', '摩托', '蒸汽朋克',
    'vehicle', 'mecha', 'robot', 'spaceship', 'aircraft', 'motorcycle', 'tank'
  ],

  /* ------------------------------ 场景 ------------------------------ */
  '室内': [
    '室内', '房间', '屋内', '客厅', '卧室', '书房', '教室', '窗台', '窗景', '内景', '屋檐下',
    'indoor', 'interior', 'room', 'bedroom', 'living room'
  ],
  '街道': [
    '街道', '街景', '马路', '巷', '街头', '人行道', '十字路口',
    'street', 'alley', 'downtown', 'crosswalk', 'roadside'
  ],
  '自然荒野': [
    '荒野', '森林', '山谷', '旷野', '荒原', '草原', '野外',
    '自然风光', '自然景观', '自然风景', '大自然', '苔原',
    'wilderness', 'wild', 'nature', 'valley', 'prairie', 'tundra'
  ],
  '幻想世界': [
    '奇幻', '幻想', '魔法', '魔幻', '异世界', '神话', '精灵', '巨龙', '中世纪', '魔法阵',
    'fantasy', 'magic', 'magical', 'mythical', 'elf', 'wizard', 'medieval'
  ],
  '太空': [
    '太空', '宇宙', '星云', '行星', '星空', '银河', '星际',
    'space', 'galaxy', 'nebula', 'planet', 'cosmic', 'starfield'
  ],
  '水下': [
    '水下', '海底', '潜水', '深潜', '水底', 'underwater', 'undersea', 'diving'
  ]
};

/* ------------------------------------------------------------ 内部工具 */

/** 纯 ASCII 关键词用词边界匹配，避免 "cat" 命中 "delicate" */
const ASCII_RE = /^[\x20-\x7e]+$/;

/** 关键词 → 预编译正则（懒加载缓存，最多几百条） */
const REGEX_CACHE = new Map();

/**
 * 规范化分类名：去首尾空白、转小写、去掉所有空白字符。
 * 这样「3D 渲染」与「3d渲染」被视为同一个分类。
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, '');
}

/** 转义正则元字符 */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 取关键词对应的匹配正则（英文按词边界，中文按子串）。
 * @param {string} keyword 已转小写的关键词
 * @returns {RegExp}
 */
function keywordRegex(keyword) {
  let cached = REGEX_CACHE.get(keyword);
  if (cached) return cached;
  cached = new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}([^a-z0-9]|$)`, 'i');
  REGEX_CACHE.set(keyword, cached);
  return cached;
}

/**
 * 判断关键词是否命中（文本需已转小写）。
 * @param {string} lowerText
 * @param {string} keyword
 * @returns {boolean}
 */
function matchKeyword(lowerText, keyword) {
  if (!keyword) return false;
  if (ASCII_RE.test(keyword)) return keywordRegex(keyword).test(lowerText);
  return lowerText.includes(keyword);
}

/**
 * 统计字符串里的汉字个数（用于长词加分）。
 * @param {string} str
 * @returns {number}
 */
function hanziCount(str) {
  const found = String(str == null ? '' : str).match(/[\u4e00-\u9fa5]/g);
  return found ? found.length : 0;
}

/**
 * 一级分类权重。
 * @param {object|null} parent 一级分类对象
 * @returns {number}
 */
function weightOf(parent) {
  if (!parent) return DEFAULT_WEIGHT;
  const weight = TOP_WEIGHTS.get(normalizeName(parent.name));
  return typeof weight === 'number' ? weight : DEFAULT_WEIGHT;
}

/**
 * 一级分类优先级序号（越小越优先）。
 * @param {object|null} parent
 * @returns {number}
 */
function priorityOf(parent) {
  if (!parent) return UNKNOWN_PRIORITY;
  const index = TOP_PRIORITY.get(normalizeName(parent.name));
  return typeof index === 'number' ? index : UNKNOWN_PRIORITY;
}

/** 规则表（模块加载时规范化一次，后续零开销） */
const SUB_RULES = Object.keys(SUB_KEYWORDS).map((name) => ({
  name,
  key: normalizeName(name),
  keywords: SUB_KEYWORDS[name].map((kw) => String(kw).toLowerCase())
}));

/**
 * 全部内置规则（只读快照，供调试 / 测试查看覆盖面）。
 * @type {ReadonlyArray<{name:string, keywords:string[]}>}
 */
export const AUTO_CLASSIFY_RULES = Object.freeze(
  SUB_RULES.map((rule) => Object.freeze({ name: rule.name, keywords: Object.freeze(rule.keywords.slice()) }))
);

/* ------------------------------------------------------------ 对外接口 */

/**
 * 根据提示词文本推断分类。
 *
 * 打分规则：
 *   0. 匹配前先剔除 PHRASE_EXCLUSIONS 里的成语/固定搭配（车水马龙、龙套、龙椅、水龙头），
 *      避免其中的「马 / 龙」被当成主体。
 *   1. hits = 该二级分类命中的「不同关键词个数」。
 *   2. 同分类去重：被同分类里更长命中词包含的词不重复计分（「塔楼」⊃「楼」）。
 *   3. 跨分类吸收：单字词若被别处命中的更长整词包含，则不单独计分
 *      （马路 → 只算街道、不算「马」；鸟瞰 → 只算俯视、不算「鸟」；树蛙 → 只算动物、不算「树」）。
 *   4. 得分 = 有效命中数 × 一级分类权重 + 长词加分。
 *      - 有效命中数：一般等于 hits（EFFECTIVE_HIT_CAP 为空表，当前不截断）。
 *      - 长词加分：汉字数 ≥3 的命中词每个 +0.15，最多计 3 个（让更具体的长词赢下歧义）。
 *   5. 取最高分；平分时依次比较：一级分类优先级（风格 > 主体 > 场景）→ 命中数
 *      → 二级分类的 order（用户可调顺序）→ 名称。
 *   6. hits < 1（阈值）时返回未分类，不瞎猜。
 *
 * @param {string} text 提示词正文（正向提示词即可）
 * @param {Array<{id:string, name:string, level:number, parentId:string|null, order?:number}>} categories
 *        store.state.categories；允许为空数组 / undefined（此时无法映射到 id，返回 null）
 * @returns {{categoryId:string|null, subCategoryId:string|null, label:string,
 *            score:number, hits:string[]}}
 */
/**
 * 比较两个候选，返回 <0 表示 a 更优。
 *
 * 规则顺序：得分 → 一级分类优先级 → 命中数 → 分类排序（用户可调） → 名称。
 */
function compareCandidate(a, b) {
  if (a.score > b.score + EPS) return -1;
  if (a.score < b.score - EPS) return 1;
  if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
  if (a.hitCount !== b.hitCount) return a.hitCount > b.hitCount ? -1 : 1;
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return String(a.sub.name).localeCompare(String(b.sub.name), 'zh-Hans-CN');
}

function classifyInternal(text, categories, multi) {
  const raw = String(text == null ? '' : text);
  const list = Array.isArray(categories) ? categories : [];
  const empty = { categoryId: null, subCategoryId: null, label: '', score: 0, hits: [] };
  // 多分类模式失败时返回空数组，单分类返回空对象
  const fail = () => (multi ? [] : empty);
  if (!raw.trim()) return fail();

  // 建立索引：id → 分类；规范化名称 → 二级分类
  const byId = new Map();
  const subByKey = new Map();
  for (const category of list) {
    if (!category || !category.id) continue;
    byId.set(category.id, category);
    if (category.level !== 2) continue;
    const key = normalizeName(category.name);
    if (!key) continue;
    if (!subByKey.has(key)) subByKey.set(key, category);
  }
  if (!subByKey.size) return fail();

  // 匹配前先剔除排除短语（成语里的「马 / 龙」不是主体，见 PHRASE_EXCLUSIONS）
  let lowerText = raw.toLowerCase();
  for (const phrase of PHRASE_EXCLUSIONS) {
    if (lowerText.includes(phrase)) lowerText = lowerText.split(phrase).join('');
  }

  /* --- 第一轮：收集每条规则命中的原始关键词 --- */
  const candidates = [];
  /** 全文本里所有命中词（跨分类），用于判断单字词是否被更长的整词吸收 */
  const allMatched = new Set();

  for (const rule of SUB_RULES) {
    const sub = subByKey.get(rule.key);
    if (!sub) continue; // 用户删掉了这个二级分类，跳过该规则

    const matched = [];
    for (const keyword of rule.keywords) {
      if (matchKeyword(lowerText, keyword)) matched.push(keyword);
    }
    if (!matched.length) continue;

    matched.forEach((keyword) => allMatched.add(keyword));
    candidates.push({ sub, matched });
  }
  if (!candidates.length) return fail();

  /** 所有长度 ≥2 的命中词（可能是「吸收者」） */
  const longMatched = Array.from(allMatched).filter((keyword) => keyword.length > 1);

  let best = null;
  /** 按一级分类分组的最优候选 —— 多分类模式下每个大类各取一个 */
  const bestByParent = new Map();

  /* --- 第二轮：去重、打分、择优 --- */
  for (const { sub, matched } of candidates) {
    const hits = [];
    // 先长后短：长词优先占位，短词若被它包含就不再单独计分
    for (const keyword of matched.slice().sort((a, b) => b.length - a.length)) {
      // 同分类去重：「塔楼」已计分，「楼」不再计分
      if (hits.some((kept) => kept.includes(keyword))) continue;
      // 跨分类吸收：单字词最容易被误伤（马路→马、鸟瞰→鸟、花瓶→花、树蛙→树），
      // 若它被别处命中的更长整词包含，就不再单独计分。
      if (hanziCount(keyword) === 1
        && longMatched.some((other) => other !== keyword
          && other.includes(keyword)
          && !matched.includes(other))) {
        continue;
      }
      hits.push(keyword);
    }
    if (!hits.length) continue;

    const parent = sub.parentId ? (byId.get(sub.parentId) || null) : null;
    const weight = weightOf(parent);
    // 命中数计分上限：当前 EFFECTIVE_HIT_CAP 为空表（没有分类受约束），机制保留供后续启用。
    // hits 本身保持完整（用于展示命中词），只有计分用的 effective 可能被截断。
    const cap = EFFECTIVE_HIT_CAP.get(normalizeName(parent ? parent.name : '')) || Infinity;
    const effective = hits.length > cap ? hits.slice(0, cap) : hits;
    // 长词加分：汉字数 ≥3 的命中词每个 +0.15，最多计 3 个（同样只看参与计分的词）
    const longHits = effective.filter((keyword) => hanziCount(keyword) >= LONG_WORD_MIN_HANZI).length;
    const bonus = Math.min(longHits, LONG_WORD_MAX) * LONG_WORD_BONUS;
    const candidate = {
      sub,
      parent,
      hits,
      hitCount: effective.length,
      score: effective.length * weight + bonus,
      priority: priorityOf(parent),
      order: Number(sub.order) || 0
    };

    // 多分类：同一个一级分类下只留一个最优二级分类
    const pid = candidate.parent ? candidate.parent.id : '__none__';
    const current = bestByParent.get(pid);
    if (!current || compareCandidate(candidate, current) < 0) {
      bestByParent.set(pid, candidate);
    }

    if (!best) { best = candidate; continue; }
    if (candidate.score > best.score + EPS) { best = candidate; continue; }
    if (candidate.score < best.score - EPS) continue;
    // 得分相同：一级分类优先级 → 命中数 → 分类排序（用户可调） → 名称
    if (candidate.priority !== best.priority) {
      if (candidate.priority < best.priority) best = candidate;
      continue;
    }
    if (candidate.hitCount !== best.hitCount) {
      if (candidate.hitCount > best.hitCount) best = candidate;
      continue;
    }
    if (candidate.order !== best.order) {
      if (candidate.order < best.order) best = candidate;
      continue;
    }
    if (String(candidate.sub.name).localeCompare(String(best.sub.name), 'zh-Hans-CN') < 0) {
      best = candidate;
    }
  }

  if (!best) return fail();

  const score = Math.round(best.score * 100) / 100;

  // 多分类：每个一级分类各返回一个最优二级分类
  if (multi) {
    const out = [];
    for (const c of bestByParent.values()) {
      if (c.hits.length < MIN_HITS) continue;
      out.push({
        categoryId: c.parent ? c.parent.id : null,
        subCategoryId: c.sub.id,
        label: [c.parent ? c.parent.name : '', c.sub.name].filter(Boolean).join(' / '),
        score: Math.round(c.score * 100) / 100,
        hits: c.hits
      });
    }
    // 按得分降序：第一个就是最强的那条，写库时作为主分类
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  if (best.hits.length < MIN_HITS) {
    return { categoryId: null, subCategoryId: null, label: '', score, hits: best.hits };
  }

  const label = [best.parent ? best.parent.name : '', best.sub.name].filter(Boolean).join(' / ');
  return {
    categoryId: best.parent ? best.parent.id : null,
    subCategoryId: best.sub.id,
    label,
    score,
    hits: best.hits
  };
}

/** 单个最佳分类（兼容旧调用：导入时只取最匹配的那一个） */
export function classifyPrompt(text, categories) {
  return classifyInternal(text, categories, false);
}

/**
 * 多分类：一张图可以同时属于多个一级大类（风格 + 主体 + 场景…），
 * 每个大类各取一个最优二级分类 —— 同一大类下不会出现两个。
 *
 * 用于「重新自动分类」：把提示词里能识别出的所有属性都挂上，
 * 而不是只留一个总分最高的。
 *
 * @returns {{categoryId:string|null, subCategoryId:string, label:string, score:number, hits:string[]}[]}
 */
export function classifyPromptMulti(text, categories) {
  return classifyInternal(text, categories, true);
}
