/**
 * 从文件名/目录名中提取元信息
 */

// 内容类型 → Alist 目录关键词映射
const TYPE_KEYWORDS = {
  movie:  ['电影', 'movie', 'film'],
  series: ['电视剧', '剧', 'series', 'tv'],
  anime:  ['动漫', '动画', 'anime', 'comics'],
  variety: ['综艺', 'variety', 'reality'],
};

/**
 * 根据路径判断内容类型
 */
function detectTypeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(`/${kw}/`) || lower.includes(`/${kw}`) || lower.startsWith(`${kw}/`))) {
      return type;
    }
  }
  return null;
}

/**
 * 按 Stremio 类型过滤搜索路径
 * movie → 只搜电影目录, series → 只搜电视剧/动漫/综艺目录
 */
function getAllowedPaths(stremioType) {
  if (stremioType === 'movie') {
    return ['/电影/', '电影/'];
  }
  if (stremioType === 'series') {
    return ['/电视剧/', '电视剧/', '/动漫/', '动漫/', '/综艺/', '综艺/'];
  }
  return null; // 不过滤
}

/**
 * 检查路径是否匹配指定类型（路径中包含关键词即可）
 * /每日更新/电视剧/美剧/xxx → 包含 /电视剧/ → 匹配 series
 * /strm/电影/中国/xxx → 包含 /电影/ → 匹配 movie
 */
function pathMatchType(filePath, stremioType) {
  const allowed = getAllowedPaths(stremioType);
  if (!allowed) return true;
  return allowed.some(p => filePath.includes(p));
}

/**
 * 从文件名中提取季号
 * 匹配: S01, Season 1, 第1季, 第一季
 */
function extractSeason(name) {
  let m = name.match(/[Ss](\d{1,2})/);
  if (m) return parseInt(m[1]);
  m = name.match(/Season\s*(\d+)/i);
  if (m) return parseInt(m[1]);
  m = name.match(/第(\d+|[一二三四五六七八九十]+)季/);
  if (m) return chineseNumToInt(m[1]);
  return null;
}

/**
 * 从文件名中提取集号
 * 匹配: E01, EP01, 第1集, 第一集, 01.mkv, 独立数字
 */
function extractEpisode(name) {
  // S01E02 格式
  let m = name.match(/[Ss]\d{1,2}[Ee](\d{1,3})/);
  if (m) return parseInt(m[1]);

  // EP01 / Ep01
  m = name.match(/[Ee][Pp]?\s*(\d{1,3})/);
  if (m) return parseInt(m[1]);

  // 第1集 / 第一集
  m = name.match(/第(\d+|[一二三四五六七八九十]+)集/);
  if (m) return chineseNumToInt(m[1]);

  // 文件名末尾的数字：如 "剧名.01.mkv" 或 "剧名 02.mp4"
  m = name.match(/[.\-_\s](\d{1,3})\.(?:mp4|mkv|avi|ts|rmvb|strm)$/i);
  if (m) return parseInt(m[1]);

  // 纯数字文件名 "01.strm"
  m = name.match(/^(\d{1,3})\./);
  if (m) return parseInt(m[1]);

  return null;
}

/**
 * 中文数字转阿拉伯数字
 */
function chineseNumToInt(str) {
  if (/^\d+$/.test(str)) return parseInt(str);
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  if (str.length === 1) return map[str] || 0;
  if (str.startsWith('十')) return 10 + (map[str[1]] || 0);
  if (str.endsWith('十')) return (map[str[0]] || 0) * 10;
  if (str.includes('十')) return (map[str[0]] || 0) * 10 + (map[str[2]] || 0);
  return parseInt(str) || 0;
}

module.exports = { detectTypeFromPath, getAllowedPaths, pathMatchType, extractSeason, extractEpisode };
