require('dotenv').config();
const express = require('express');
const { createManifest } = require('./lib/manifest');
const { AlistClient } = require('./lib/alist');
const { TitleResolver } = require('./lib/resolver');
const { pathMatchType, extractSeason, extractEpisode } = require('./lib/filename');
const log = require('./lib/logger');

const PORT = process.env.PORT || 7070;
const ALIST_URL = process.env.ALIST_URL;
const ALIST_USERNAME = process.env.ALIST_USERNAME;
const ALIST_PASSWORD = process.env.ALIST_PASSWORD;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;

if (!ALIST_URL || !ALIST_USERNAME || !ALIST_PASSWORD) {
  log.error('启动失败: 请在 .env 中配置 ALIST_URL, ALIST_USERNAME, ALIST_PASSWORD');
  process.exit(1);
}

const alist = new AlistClient(ALIST_URL, ALIST_USERNAME, ALIST_PASSWORD);
const resolver = new TitleResolver(TMDB_API_KEY, OMDB_API_KEY);
const app = express();

const VIDEO_EXTS = /\.(mp4|mkv|avi|ts|rmvb|rm|wmv|flv|mov|iso|strm)$/i;

// ── 请求日志中间件 ────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log.access(req, res.statusCode, Date.now() - start, res._logExtra || '');
  });
  next();
});

// ── CORS 中间件（Stremio 跨域需要）────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 简单内存缓存 ─────────────────────────────────────────
const cache = new Map();
const MAX_CACHE_SIZE = 200;
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expire) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data, ttlMs = 5 * 60 * 1000) {
  // 达到上限时清理过期条目，仍超出则淘汰最早条目
  if (cache.size >= MAX_CACHE_SIZE) {
    for (const [k, v] of cache) {
      if (Date.now() > v.expire) cache.delete(k);
    }
    if (cache.size >= MAX_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }
  cache.set(key, { data, expire: Date.now() + ttlMs });
}

// ── 分辨率权重（用于排序）────────────────────────────────
const RESOLUTION_SCORE = { '8k': 5, '4k': 4, '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };

// ── 分类目录映射 ──────────────────────────────────────────
const CATEGORIES = {
  'xiaoya-movie-4kremux':  '/strm/电影/4K REMUX',
  'xiaoya-movie-4k':       '/strm/电影/4K系列',
  'xiaoya-movie-china':    '/strm/电影/中国',
  'xiaoya-movie-japan':    '/strm/电影/日本',
  'xiaoya-movie-korea':    '/strm/电影/韩国',
  'xiaoya-movie-india':    '/strm/电影/印度',
  'xiaoya-movie-thai':     '/strm/电影/泰国',
  'xiaoya-movie-douban':   '/strm/电影/豆瓣 top 1000部',
  'xiaoya-movie-dolby':    '/strm/电影/杜比视界',
  'xiaoya-series-china':   '/strm/电视剧/中国',
  'xiaoya-series-japan':   '/strm/电视剧/日本',
  'xiaoya-series-korea':   '/strm/电视剧/韩国',
  'xiaoya-series-western': '/strm/电视剧/欧美',
  'xiaoya-series-hk':      '/strm/电视剧/港台',
  'xiaoya-anime':          '/strm/动漫',
  'xiaoya-doc':            '/strm/纪录片',
  'xiaoya-variety':        '/strm/综艺',
};

// ── 日志查看页面 ──────────────────────────────────────────
app.get('/logs', (req, res) => {
  const type = req.query.type || 'access';
  const lines = parseInt(req.query.lines) || 200;
  const content = log.readRecent(type, lines);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Xiaoya Alist 日志</title>
<style>
  body { font-family: monospace; background: #1e1e1e; color: #d4d4d4; padding: 16px; }
  h2 { color: #569cd6; }
  .tabs a { color: #9cdcfe; margin-right: 16px; text-decoration: none; }
  .tabs a.active { color: #ce9178; border-bottom: 2px solid #ce9178; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 13px; line-height: 1.5; }
  .error { color: #f44747; }
  .warn { color: #dcdcaa; }
</style></head><body>
<h2>Xiaoya Alist 插件日志</h2>
<div class="tabs">
  <a href="/logs?type=access" class="${type === 'access' ? 'active' : ''}">请求日志</a>
  <a href="/logs?type=app" class="${type === 'app' ? 'active' : ''}">应用日志</a>
</div>
<pre>${content.split('\n').map(l =>
  l.includes('[ERROR]') ? `<span class="error">${esc(l)}</span>` :
  l.includes('[WARN]') ? `<span class="warn">${esc(l)}</span>` : esc(l)
).join('\n')}</pre>
<script>setTimeout(()=>location.reload(), 10000)</script>
</body></html>`);
});

// ── Manifest ─────────────────────────────────────────────
app.get('/manifest.json', (_req, res) => {
  res.json(createManifest());
});

// ── Catalog ──────────────────────────────────────────────
app.get('/catalog/:type/:id.json', async (req, res) => {
  try {
    const { type, id } = req.params;
    const searchQuery = req.query.search;
    const skip = parseInt(req.query.skip) || 0;
    let metas = [];
    let hasMore = false;

    if (searchQuery) {
      log.info(`[搜索] type=${type} keyword="${searchQuery}"`);
      const result = await handleSearch(searchQuery, type);
      metas = result.metas;
      hasMore = result.hasMore;
      log.info(`[搜索] 返回 ${metas.length} 条结果`);
      res._logExtra = `search="${searchQuery}" count=${metas.length} hasMore=${hasMore}`;
    } else if (CATEGORIES[id]) {
      const result = await handleBrowse(CATEGORIES[id], type, skip);
      metas = result.metas;
      hasMore = result.hasMore;
      res._logExtra = `catalog=${id} skip=${skip} count=${metas.length} hasMore=${hasMore}`;
    } else {
      res._logExtra = `catalog=${id} (unknown)`;
    }

    res.json({ metas, hasMore });
  } catch (err) {
    log.error('[Catalog] 请求异常', err);
    res._logExtra = `error=${err.message}`;
    res.json({ metas: [], hasMore: false });
  }
});

// ── Stream ───────────────────────────────────────────────
app.get('/stream/:type/:id.json', async (req, res) => {
  try {
    const rawId = req.params.id;
    const type = req.params.type;
    log.info(`[Stream] type=${type} id=${rawId}`);

    let streams = [];

    if (rawId.startsWith('xiaoya:')) {
      // 解析 xiaoya:path:S:E 格式（来自 meta 端点的视频 ID）
      const afterPrefix = rawId.slice(7);
      const parts = afterPrefix.split(':');
      let filePath, season, episode;
      if (parts.length >= 3) {
        // xiaoya:${encodedPath}:${season}:${episode}
        season = parseInt(parts[parts.length - 2]);
        episode = parseInt(parts[parts.length - 1]);
        filePath = decodeURIComponent(parts.slice(0, -2).join(':'));
        log.info(`[Stream] 路径模式: ${filePath} S${season}E${episode}`);
        res._logExtra = `path=${filePath} S${season}E${episode}`;
      } else {
        filePath = decodeURIComponent(afterPrefix);
        log.info(`[Stream] 路径模式: ${filePath}`);
        res._logExtra = `path=${filePath}`;
      }
      streams = await resolveStreams(filePath, season, episode);
    } else {
      const result = await resolveExternalStream(rawId, type);
      streams = result.streams;
      const r = result.resolved;
      const titleInfo = r ? `"${r.title}" (${r.originalTitle}) ${r.year || ''}` : rawId;
      const seasonEp = r?.season ? ` S${r.season}${r.episode ? 'E'+r.episode : ''}` : '';
      res._logExtra = `resolved=${titleInfo}${seasonEp} count=${streams.length}`;
    }

    log.info(`[Stream] 返回 ${streams.length} 条直链 | type=${type} id=${rawId}`);
    if (streams.length > 0) {
      const firstDesc = streams[0].description || '';
      log.info(`[Stream] 首条: ${firstDesc.split('\n').pop()}`);
      res._logExtra += ` first=${firstDesc.split('\n').pop()}`;
    }
    res.json({ streams });
  } catch (err) {
    log.error(`[Stream] 异常 type=${req.params.type} id=${req.params.id}`, err);
    res._logExtra = `error=${err.message}`;
    res.json({ streams: [] });
  }
});

// ── 搜索 ─────────────────────────────────────────────────
async function handleSearch(keyword, type) {
  const cacheKey = `search:${keyword}:${type}`;
  const cached = cacheGet(cacheKey);
  if (cached) return Array.isArray(cached) ? { metas: cached, hasMore: false } : cached;

  // 构建搜索词列表
  const searchTerms = [];

  // 处理 TMDB/IMDB ID → 解析为标题
  const idMatch = keyword.match(/^(?:tmdb:)?(\d+)$/i) || keyword.match(/^(tt\d+)/i);
  if (idMatch && resolver.enabled) {
    const resolved = await resolver.resolve(keyword, type);
    if (resolved) {
      if (resolved.title) searchTerms.push(resolved.title);
      if (resolved.originalTitle && resolved.originalTitle !== resolved.title) {
        searchTerms.push(resolved.originalTitle);
      }
    }
  }

  // 始终也用原始关键词和数字 ID 搜索
  searchTerms.push(keyword);
  const numId = keyword.match(/(\d{5,})/);
  if (numId && !searchTerms.includes(numId[1])) searchTerms.push(numId[1]);

  // 并行搜索
  const searchResults = await Promise.all(searchTerms.map(term => alist.webSearch(term, 'video')));
  const allResults = searchResults.flat();

  // 按路径去重
  const seen = new Set();
  const unique = allResults.filter(item => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });

  // 按 Stremio 类型过滤路径：电影只搜电影目录，电视剧只搜剧/动漫/综艺目录
  const typeFiltered = unique.filter(item => pathMatchType(item.path, type));

  const filtered = typeFiltered.filter(item => {
    if (VIDEO_EXTS.test(item.name)) return true;
    if (item.is_dir) return true;
    return false;
  });

  const enriched = filtered.map(item => {
    const meta = extractMeta(item.name);
    return { ...item, ...meta };
  });

  const fileItems = enriched.filter(i => !i.is_dir).slice(0, 20);
  if (fileItems.length > 0) {
    const fileInfos = await Promise.all(
      fileItems.map(i => alist.getFileInfo(i.path))
    );
    fileItems.forEach((item, idx) => {
      if (fileInfos[idx]?.size) item.size = fileInfos[idx].size;
    });
  }

  enriched.sort((a, b) => {
    if (a.resolutionScore !== b.resolutionScore) return b.resolutionScore - a.resolutionScore;
    const aIso = a.name.toLowerCase().endsWith('.iso') ? 1 : 0;
    const bIso = b.name.toLowerCase().endsWith('.iso') ? 1 : 0;
    if (aIso !== bIso) return aIso - bIso;
    if (a.size !== b.size) return (b.size || 0) - (a.size || 0);
    const aIsFile = !a.is_dir ? 1 : 0;
    const bIsFile = !b.is_dir ? 1 : 0;
    return bIsFile - aIsFile;
  });

  const metas = enriched.slice(0, 50).map(item => buildMeta(item, type));
  const result = { metas, hasMore: enriched.length > 50 };
  cacheSet(cacheKey, result, 10 * 60 * 1000);
  return result;
}

// ── 分类浏览 ─────────────────────────────────────────────
async function handleBrowse(dirPath, type, skip) {
  const page = Math.floor(skip / 50) + 1;
  const cacheKey = `browse:${dirPath}:${page}`;
  const cached = cacheGet(cacheKey);
  if (cached) return Array.isArray(cached) ? { metas: cached, hasMore: false } : cached;

  const items = await alist.listDir(dirPath, page, 50);
  const metas = items.map(item => buildMeta({ ...item, ...extractMeta(item.name) }, type));
  const result = { metas, hasMore: items.length >= 50 };
  cacheSet(cacheKey, result, 5 * 60 * 1000);
  return result;
}

// ── Stream 解析 ──────────────────────────────────────────
async function resolveStreams(dirPath, targetSeason, targetEpisode) {
  const items = await alist.listDir(dirPath, 1, 200);

  if (!items.length) {
    const info = await alist.getPlayableInfo(dirPath);
    if (!isValidStreamUrl(info.url)) {
      log.error(`[Stream] 无法获取直链或链接异常: ${dirPath}`);
      return [];
    }
    return [buildStream(dirPath, info.url, info.provider, info.size)];
  }

  const dirs = items.filter(i => i.is_dir);
  let videos = items.filter(i => !i.is_dir && VIDEO_EXTS.test(i.name));

  // 指定了季集 → 过滤
  if (targetSeason || targetEpisode) {
    videos = videos.filter(v => {
      if (targetSeason && extractSeason(v.name) !== targetSeason && extractSeason(v.path) !== targetSeason) return false;
      if (targetEpisode && extractEpisode(v.name) !== targetEpisode) return false;
      return true;
    });
  }

  if (videos.length > 0) {
    const infos = await alist.getPlayableInfos(videos.map(v => v.path));
    const streams = videos
      .map((v, i) => isValidStreamUrl(infos[i].url) ? buildStream(v.path, infos[i].url, infos[i].provider, infos[i].size) : null)
      .filter(Boolean);
    return sortStreamsByEpisode(streams);
  }

  // 根目录没有匹配视频 → 查子目录
  if (dirs.length > 0) {
    // 指定了季 → 优先找 Season 子目录
    let targetDirs = dirs;
    if (targetSeason) {
      const seasonDir = dirs.find(d => extractSeason(d.name) === targetSeason);
      if (seasonDir) targetDirs = [seasonDir];
    }

    const limitedDirs = targetDirs.slice(0, 20);
    const subResults = await Promise.all(
      limitedDirs.map(async (d) => {
        const subItems = await alist.listDir(d.path, 1, 200);
        let subVideos = subItems.filter(i => !i.is_dir && VIDEO_EXTS.test(i.name));
        if (targetEpisode) {
          subVideos = subVideos.filter(v => extractEpisode(v.name) === targetEpisode);
        }
        return { dir: d, subVideos };
      })
    );

    const streams = [];
    for (const { dir, subVideos } of subResults) {
      if (subVideos.length > 0) {
        const infos = await alist.getPlayableInfos(subVideos.map(v => v.path));
        for (let i = 0; i < subVideos.length; i++) {
          if (isValidStreamUrl(infos[i].url)) {
            streams.push(buildStream(subVideos[i].path, infos[i].url, infos[i].provider, infos[i].size));
          }
        }
      }
    }
    return sortStreamsByEpisode(streams);
  }

  return [];
}

// ── 外部 ID 解析（TMDB/IMDB ID → 标题 → 搜索 Alist）────
async function resolveExternalStream(rawId, type) {
  // 解析 ID 获取标题
  const resolved = resolver.enabled ? await resolver.resolve(rawId, type) : null;

  // 提取季集：从 rawId 解析（tt12345:2:3 或 tmdb:12345:2:3）
  const idSeasonMatch = rawId.match(/^(?:tt\d+|tmdb:\d+):(\d+)(?::(\d+))?/i);
  const targetSeason = idSeasonMatch ? parseInt(idSeasonMatch[1]) : (resolved?.season || 1);
  const targetEpisode = idSeasonMatch ? (idSeasonMatch[2] ? parseInt(idSeasonMatch[2]) : 0)
    : (resolved?.episode || 0);

  // 提取数字 ID 用于精确匹配
  const numId = rawId.match(/(\d{5,})/)?.[1] || '';
  const imdbId = rawId.match(/(tt\d+)/i)?.[1] || '';

  // 构建搜索词
  const searchTerms = [];
  if (resolved?.title) searchTerms.push(resolved.title);
  if (resolved?.originalTitle && resolved.originalTitle !== resolved.title) {
    searchTerms.push(resolved.originalTitle);
  }
  if (numId) searchTerms.push(numId);
  if (!searchTerms.length) searchTerms.push(rawId);

  const seasonEpStr = targetSeason ? `S${String(targetSeason).padStart(2,'0')}${targetEpisode ? 'E'+String(targetEpisode).padStart(2,'0') : ''}` : '';
  log.info(`[Stream] ${rawId} → "${resolved?.title}" ${seasonEpStr} 搜索: [${searchTerms.join(', ')}]`);

  // ── 缓存：按标题缓存搜索结果，不缓存过滤结果 ─────────
  const searchCacheKey = resolved?.title
    ? `search:${type}:${resolved.title}:${resolved.year || ''}`
    : `search:${type}:${rawId}`;
  let allVideoFiles = cacheGet(searchCacheKey);

  if (!allVideoFiles) {
    const t0 = Date.now();

    // 并行搜索
    const searchResults = await Promise.all(searchTerms.map(term => alist.webSearch(term, 'video')));
    const allResults = searchResults.flat();

    // 去重
    const seen = new Set();
    const unique = allResults.filter(r => {
      if (seen.has(r.path)) return false;
      seen.add(r.path);
      return true;
    });

    // 按类型过滤
    const typeFiltered = unique.filter(r => pathMatchType(r.path, type));
    const searchIn = typeFiltered.length > 0 ? typeFiltered : unique;

    // 构建候选目录列表（按优先级排序）
    const candidates = [];
    const addedPaths = new Set();

    function addCandidate(r) {
      if (r && r.is_dir && !addedPaths.has(r.path)) {
        candidates.push(r);
        addedPaths.add(r.path);
      }
    }

    if (numId) searchIn.filter(r =>
      new RegExp(`\\{tmdb-${numId}\\}`, 'i').test(r.path) &&
      searchTerms.some(t => t.length > 1 && r.path.includes(t))
    ).forEach(addCandidate);
    if (imdbId) searchIn.filter(r => r.path.toLowerCase().includes(imdbId.toLowerCase())).forEach(addCandidate);

    if (resolved?.title) {
      const title = resolved.title;
      const year = resolved.year;
      const exactDirs = searchIn.filter(r => {
        if (!r.is_dir) return false;
        const dirName = cleanName(r.name);
        return dirName === title || dirName.startsWith(`${title} (`) || dirName.startsWith(`${title}（`);
      });
      if (year) exactDirs.filter(r => r.name.includes(year)).forEach(addCandidate);
      exactDirs.forEach(addCandidate);
    }

    const searchWords = searchTerms.filter(t => t.length > 1);
    searchIn.filter(r => r.is_dir && !addedPaths.has(r.path) &&
      searchWords.some(w => {
        const clean = cleanName(r.name);
        return clean === w || clean.startsWith(w + ' ') || clean.startsWith(w + ' (') || clean.startsWith(w + '（');
      })
    ).forEach(addCandidate);
    if (candidates.length === 0 && searchIn.length > 0) addCandidate(searchIn[0]);

    const MAX_CANDIDATES = 8;
    if (candidates.length > MAX_CANDIDATES) {
      log.info(`[Stream] 候选过多(${candidates.length})，限制为 ${MAX_CANDIDATES} 个`);
      candidates.length = MAX_CANDIDATES;
    }

    if (candidates.length === 0) {
      log.error(`[Stream] 未找到匹配: ${rawId} (搜索词: ${searchTerms.join(', ')})`);
      return { streams: [], resolved };
    }

    log.info(`[Stream] ${candidates.length} 个候选: ${candidates.map(c => c.name).join(' | ')}`);

    // 收集所有相关目录（跨候选去重）
    const allDirs = [];
    const seenDirPaths = new Set();
    for (const c of candidates) {
      if (!seenDirPaths.has(c.path)) { allDirs.push(c); seenDirPaths.add(c.path); }
      if (resolved?.title) {
        const titleClean = resolved.title.trim();
        for (const r of searchIn) {
          if (r.is_dir && !seenDirPaths.has(r.path)) {
            const rClean = cleanName(r.name).trim();
            // 严格匹配：要么完全相同，要么以"标题 (年份)"或"标题（年份）"开头
            if (rClean === titleClean ||
                rClean.startsWith(titleClean + ' ') ||
                rClean.startsWith(titleClean + '（') ||
                rClean.startsWith(titleClean + '(')) {
              allDirs.push(r); seenDirPaths.add(r.path);
            }
          }
        }
      }
    }

    // 第 1 轮：并行列出所有目录
    const allContents = await Promise.all(
      allDirs.map(d => alist.listDir(d.path, 1, 200).catch(() => []))
    );
    log.info(`[Stream] 第1轮 listDir ×${allDirs.length} → ${Date.now() - t0}ms`);

    // 收集所有 Season 子目录（所有季，不限目标季）
    const seasonDirs = [];
    const flatItems = [];
    for (let i = 0; i < allDirs.length; i++) {
      const items = allContents[i];
      const sds = items.filter(it => it.is_dir && extractSeason(it.name));
      if (sds.length > 0) seasonDirs.push(...sds);
      else flatItems.push(items);
    }

    // 第 2 轮：并行列出所有 Season 目录
    let seasonContents = [];
    if (seasonDirs.length > 0) {
      seasonContents = await Promise.all(
        seasonDirs.map(sd => alist.listDir(sd.path, 1, 200).catch(() => []))
      );
      log.info(`[Stream] 第2轮 season listDir ×${seasonDirs.length} → ${Date.now() - t0}ms`);
    }

    // 收集所有视频文件（带季集信息）
    const videoMap = new Map();
    for (const items of flatItems) {
      for (const it of items) {
        if (!it.is_dir && VIDEO_EXTS.test(it.name) && !videoMap.has(it.path)) {
          videoMap.set(it.path, {
            path: it.path, name: it.name,
            season: extractSeason(it.name) || extractSeason(it.path.split('/').slice(0, -1).join('/')),
            episode: extractEpisode(it.name)
          });
        }
      }
    }
    for (const items of seasonContents) {
      const s = items.length > 0 ? extractSeason(items[0].path.split('/').slice(-2, -1)[0] || '') : 0;
      for (const it of items) {
        if (!it.is_dir && VIDEO_EXTS.test(it.name) && !videoMap.has(it.path)) {
          videoMap.set(it.path, {
            path: it.path, name: it.name,
            season: s || extractSeason(it.name),
            episode: extractEpisode(it.name)
          });
        }
      }
    }

    allVideoFiles = Array.from(videoMap.values());
    log.info(`[Stream] 收集到 ${allVideoFiles.length} 个视频文件 → ${Date.now() - t0}ms`);
    cacheSet(searchCacheKey, allVideoFiles, 10 * 60 * 1000);
  }

  // ── 按目标季集过滤 ─────────────────────────────────────
  // 提取到的 season/episode 可能为 null，避免 null 值穿透过滤
  let matched = allVideoFiles.filter(f => {
    if (targetSeason && f.season != null && f.season !== targetSeason) return false;
    if (targetEpisode && f.episode != null && f.episode !== targetEpisode) return false;
    // 指定了具体集时，排除无法识别集号的文件（如彩蛋、花絮等）
    if (targetEpisode && f.episode == null) return false;
    return true;
  });

  // 没有精确匹配时的回退策略
  if (matched.length === 0) {
    // 指定了具体集但找不到 → 直接返回空，不回退
    if (targetEpisode) return { streams: [], resolved };
    // 未指定集 → 回退到目标季的第一集
    if (targetSeason) {
      const seasonFiles = allVideoFiles.filter(f => f.season === targetSeason);
      if (seasonFiles.length > 0) {
        const minEp = Math.min(...seasonFiles.map(f => f.episode ?? 999));
        matched = seasonFiles.filter(f => (f.episode ?? 999) === minEp);
      }
    }
    // 还是没有 → 第一个视频文件（电影等）
    if (matched.length === 0 && allVideoFiles.length > 0) {
      matched = [allVideoFiles[0]];
    }
  }

  if (matched.length === 0) return { streams: [], resolved };

  // 未指定具体集时，只返回第一集的直链
  if (!targetEpisode && matched.length > 1) {
    const minEp = Math.min(...matched.map(f => f.episode ?? 999));
    matched = matched.filter(f => (f.episode ?? 999) === minEp);
  }

  // 第 3 轮：并行获取播放信息
  const t0 = Date.now();
  const infos = await alist.getPlayableInfos(matched.map(f => f.path));
  log.info(`[Stream] 第3轮 getPlayableInfo ×${matched.length} → ${Date.now() - t0}ms`);

  const result = sortStreamsByEpisode(
    matched
      .map((f, i) => isValidStreamUrl(infos[i].url) ? buildStream(f.path, infos[i].url, infos[i].provider, infos[i].size) : null)
      .filter(Boolean)
  );

  return { streams: result, resolved };
}

// ── 工具函数 ─────────────────────────────────────────────
function extractMeta(name) {
  const info = { year: null, resolution: null, resolutionScore: 0 };
  const yearMatch = name.match(/[\(（\[](\d{4})[\)）\]]/);
  if (yearMatch) info.year = yearMatch[1];
  const resMatch = name.match(/\b(8K|4K|2160p|1080p|720p|480p)\b/i);
  if (resMatch) {
    const raw = resMatch[1].toLowerCase();
    info.resolution = raw === '2160p' ? '4K' : resMatch[1].toUpperCase();
    info.resolutionScore = RESOLUTION_SCORE[raw] || 0;
  }
  return info;
}

function buildMeta(item, type) {
  const descParts = [];
  if (item.resolution) descParts.push(`分辨率: ${item.resolution}`);
  if (item.year) descParts.push(`年份: ${item.year}`);
  if (item.size > 0) descParts.push(`大小: ${formatSize(item.size)}`);
  descParts.push(`路径: ${item.path}`);
  return {
    id: `xiaoya:${encodeURIComponent(item.path)}`,
    type,
    name: cleanName(item.name),
    description: descParts.join(' | '),
    poster: null,
  };
}

function formatSize(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function cleanName(name) {
  if (!name) return name;
  let s = name.replace(/\.[^.]+$/, '');
  s = s.replace(/[.\-_\s]?(1080p|720p|2160p|4k|uhd|hdr|hevc|x26[45]|h\.?26[45]|aac|dts|flac|web-?dl|bluray|bdrip|hdrip|dvdrip|remux|atmos|truehd)[.\-_\s]?/gi, ' ');
  s = s.replace(/\[.*?\]/g, ' ');
  s = s.replace(/\{.*?\}/g, ' ');
  s = s.replace(/\((\d{4})\)/g, '($1)');
  s = s.replace(/\s+/g, ' ').trim();
  return s || name;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 来源简称映射
function shortProvider(p) {
  if (!p) return '';
  if (p.includes('Aliyun') || p.includes('Aliyundrive')) return '阿里云盘';
  if (p.includes('115')) return '115网盘';
  if (p.includes('Quark')) return '夸克网盘';
  if (p.includes('Baidu')) return '百度网盘';
  if (p.includes('PikPak')) return 'PikPak';
  return p;
}

// 从文件名中提取视频质量信息
function extractQuality(name, filePath) {
  const info = [];
  // 分辨率（先从文件名提取，再从路径补充）
  const res = name.match(/\b(8K|4K|2160p|1080p|720p|480p)\b/i)
    || (filePath && filePath.match(/\b(8K|4K|2160p|1080p|720p|480p)\b/i));
  if (res) {
    const raw = res[1].toLowerCase();
    info.push(raw === '2160p' ? '4K' : raw === '4k' ? '4K' : raw === '8k' ? '8K' : raw);
  }
  // HDR
  if (/\b(HDR10\+?|HDR|DoVi|DV|Dolby.?Vi)\b/i.test(name)) info.push('HDR');
  // 编码
  const codec = name.match(/\b(HEVC|H\.?265|x265|AV1|H\.?264|x264)\b/i);
  if (codec) info.push(codec[1].replace(/x/i, 'H.').toUpperCase());
  // 来源
  const source = name.match(/\b(REMUX|BluRay|BDRip|WEB-?DL|WEBRip|HDTV|DVDRip|CAM)\b/i);
  if (source) info.push(source[1].replace(/-/, ''));
  return info;
}

function buildStreamName(filePath) {
  const fileName = filePath.split('/').pop() || filePath;
  const res = fileName.match(/\b(8K|4K|2160p|1080p|720p|480p)\b/i)
    || filePath.match(/\b(8K|4K|2160p|1080p|720p|480p)\b/i);
  if (!res) return '☁️ Xiaoya Alist';
  const raw = res[1].toLowerCase();
  const resolution = raw === '2160p' ? '4K' : raw === '4k' ? '4K' : raw === '8k' ? '8K' : raw;
  return `☁️ Xiaoya Alist ${resolution}`;
}

function buildStreamDescription(filePath, provider, size) {
  const fileName = filePath.split('/').pop() || filePath;
  const quality = extractQuality(fileName, filePath);
  const prov = shortProvider(provider);
  const lines = [];
  if (quality.length) lines.push(quality.join(' · '));
  if (prov) lines.push(`☁️ ${prov}`);
  if (size > 0) lines.push(`📦 ${formatSize(size)}`);
  lines.push(`📂 ${filePath}`);
  return lines.join('\n');
}

function buildStream(filePath, url, provider, size) {
  const stream = {
    name: buildStreamName(filePath),
    description: buildStreamDescription(filePath, provider, size),
    url,
  };
  if (size > 0) {
    stream.behaviorHints = { videoSize: size };
  }
  return stream;
}

function isValidStreamUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes('abnormal')) return false;
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.webp')) return false;
  return true;
}

// 按季号+集号排序（S01E01, S01E02, ..., S02E01, ...）
function sortStreamsByEpisode(streams) {
  return streams.sort((a, b) => {
    const pathA = (a.description || '').split('\n').pop() || '';
    const pathB = (b.description || '').split('\n').pop() || '';
    const seasonA = extractSeason(pathA) || 0;
    const seasonB = extractSeason(pathB) || 0;
    if (seasonA !== seasonB) return seasonA - seasonB;
    const episodeA = extractEpisode(pathA) || 0;
    const episodeB = extractEpisode(pathB) || 0;
    if (episodeA !== episodeB) return episodeA - episodeB;
    return pathA.localeCompare(pathB);
  });
}

// ── 未捕获异常处理 ───────────────────────────────────────
process.on('uncaughtException', (err) => {
  log.error('未捕获异常', err);
});
process.on('unhandledRejection', (err) => {
  log.error('未处理的 Promise 拒绝', err);
});

// ── 启动 ─────────────────────────────────────────────────
app.listen(PORT, () => {
  log.info(`Stremio Xiaoya Alist 插件已启动 | 端口: ${PORT}`);
  log.info(`Alist: ${ALIST_URL}`);
  log.info(`日志查看: http://localhost:${PORT}/logs`);
  log.info(`Manifest: http://localhost:${PORT}/manifest.json`);
});
