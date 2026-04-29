const axios = require('axios');
const log = require('./logger');

const TMDB_API = 'https://api.tmdb.org/3';
const OMDB_API = 'https://www.omdbapi.com/';

class TitleResolver {
  constructor(tmdbKey, omdbKey) {
    this.tmdbKey = tmdbKey;
    this.omdbKey = omdbKey;
    this.cache = new Map();
    this.cacheTTL = 24 * 60 * 60 * 1000;
  }

  get enabled() {
    return !!(this.tmdbKey || this.omdbKey);
  }

  async resolve(rawId, type = null) {
    if (!this.enabled) return null;

    let tmdbId = null;
    let imdbId = null;
    let season = null;
    let episode = null;

    const imdbMatch = rawId.match(/^(tt\d+)(?::(\d+)(?::(\d+))?)?$/i);
    const tmdbMatch = rawId.match(/^(?:tmdb:)?(\d+)(?::(\d+)(?::(\d+))?)?$/i);

    if (imdbMatch) {
      imdbId = imdbMatch[1];
      if (imdbMatch[2]) season = parseInt(imdbMatch[2]);
      if (imdbMatch[3]) episode = parseInt(imdbMatch[3]);
    } else if (tmdbMatch) {
      tmdbId = tmdbMatch[1];
      if (tmdbMatch[2]) season = parseInt(tmdbMatch[2]);
      if (tmdbMatch[3]) episode = parseInt(tmdbMatch[3]);
    } else {
      return null;
    }

    const cacheKey = imdbId || `tmdb:${tmdbId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheTTL) {
      return { ...cached.data, season, episode };
    }

    let data = null;

    // 方式 1: TMDB API（优先）
    if (this.tmdbKey) {
      data = await this.resolveTMDB(tmdbId, imdbId, type);
    }

    // 方式 2: OMDB API（降级）
    if (!data && this.omdbKey && (imdbId || tmdbId)) {
      data = await this.resolveOMDB(imdbId || tmdbId);
    }

    if (!data) {
      log.error(`[Resolver] 无法解析: ${cacheKey}`);
      return null;
    }

    this.cache.set(cacheKey, { data, time: Date.now() });
    log.info(`[Resolver] ${cacheKey} → ${data.title} / ${data.originalTitle} (${data.year})`);
    return { ...data, season, episode };
  }

  async resolveTMDB(tmdbId, imdbId, type) {
    try {
      if (imdbId) {
        // IMDB → TMDB find，并行获取中文标题
        const resp = await axios.get(`${TMDB_API}/find/${imdbId}`, {
          params: { api_key: this.tmdbKey, external_source: 'imdb_id' },
          timeout: 15000
        });
        const result = resp.data.movie_results?.[0] || resp.data.tv_results?.[0];
        if (!result) return null;

        const isSeries = !!resp.data.tv_results?.length;
        const id = result.id;
        const originalTitle = result.title || result.name;
        const year = (result.release_date || result.first_air_date || '').slice(0, 4);

        // 并行获取中文标题
        const zhTitle = await this.fetchLocalizedTitle(id, isSeries);
        return {
          title: zhTitle || originalTitle,
          originalTitle,
          year,
          isSeries
        };
      }

      // TMDB ID → 并行尝试电影和电视剧
      const [movieResp, tvResp] = await Promise.all([
        axios.get(`${TMDB_API}/movie/${tmdbId}`, {
          params: { api_key: this.tmdbKey, language: 'zh-CN' }, timeout: 15000
        }).catch(e => { log.info(`[Resolver] movie/${tmdbId} 失败: ${e.code || e.message}`); return null; }),
        axios.get(`${TMDB_API}/tv/${tmdbId}`, {
          params: { api_key: this.tmdbKey, language: 'zh-CN' }, timeout: 15000
        }).catch(e => { log.info(`[Resolver] tv/${tmdbId} 失败: ${e.code || e.message}`); return null; })
      ]);

      // 根据请求类型优先匹配（TMDB 同一 ID 可能同时有电影和电视剧条目）
      if (type === 'series') {
        if (tvResp) {
          return {
            title: tvResp.data.name || tvResp.data.original_name,
            originalTitle: tvResp.data.original_name,
            year: (tvResp.data.first_air_date || '').slice(0, 4),
            isSeries: true
          };
        }
        if (movieResp) {
          return {
            title: movieResp.data.title || movieResp.data.original_title,
            originalTitle: movieResp.data.original_title,
            year: (movieResp.data.release_date || '').slice(0, 4),
            isSeries: false
          };
        }
      } else {
        if (movieResp) {
          return {
            title: movieResp.data.title || movieResp.data.original_title,
            originalTitle: movieResp.data.original_title,
            year: (movieResp.data.release_date || '').slice(0, 4),
            isSeries: false
          };
        }
        if (tvResp) {
          return {
            title: tvResp.data.name || tvResp.data.original_name,
            originalTitle: tvResp.data.original_name,
            year: (tvResp.data.first_air_date || '').slice(0, 4),
            isSeries: true
          };
        }
      }
      return null;
    } catch (err) {
      log.error(`[Resolver] TMDB 查询失败: ${err.code || err.message}`);
      return null;
    }
  }

  async fetchLocalizedTitle(id, isSeries) {
    try {
      const endpoint = isSeries ? 'tv' : 'movie';
      const resp = await axios.get(`${TMDB_API}/${endpoint}/${id}`, {
        params: { api_key: this.tmdbKey, language: 'zh-CN' },
        timeout: 15000
      });
      const zhName = resp.data.title || resp.data.name;
      if (zhName) return zhName;
      return null;
    } catch {
      return null;
    }
  }

  async resolveOMDB(id) {
    try {
      const resp = await axios.get(OMDB_API, {
        params: { i: id, apikey: this.omdbKey },
        timeout: 10000
      });
      if (resp.data.Response === 'False') return null;
      return {
        title: resp.data.Title,
        originalTitle: resp.data.Title,
        year: (resp.data.Year || '').slice(0, 4),
        isSeries: resp.data.Type === 'series'
      };
    } catch (err) {
      log.error('[Resolver] OMDB 查询失败', err);
      return null;
    }
  }
}

module.exports = { TitleResolver };
