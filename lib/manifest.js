function createManifest() {
  return {
    id: 'community.stremio.xiaoya-alist',
    version: '1.0.0',
    name: 'Xiaoya Alist',
    description: '浏览 Xiaoya Alist 资源，返回直链播放',
    catalogs: [
      { type: 'movie',  id: 'xiaoya-movie-4kremux', name: 'Xiaoya 4K REMUX' },
      { type: 'movie',  id: 'xiaoya-movie-4k',      name: 'Xiaoya 4K系列' },
      { type: 'movie',  id: 'xiaoya-movie-china',   name: 'Xiaoya 中国电影' },
      { type: 'movie',  id: 'xiaoya-movie-japan',   name: 'Xiaoya 日本电影' },
      { type: 'movie',  id: 'xiaoya-movie-korea',   name: 'Xiaoya 韩国电影' },
      { type: 'movie',  id: 'xiaoya-movie-india',   name: 'Xiaoya 印度电影' },
      { type: 'movie',  id: 'xiaoya-movie-thai',    name: 'Xiaoya 泰国电影' },
      { type: 'movie',  id: 'xiaoya-movie-douban',  name: 'Xiaoya 豆瓣TOP1000' },
      { type: 'movie',  id: 'xiaoya-movie-dolby',   name: 'Xiaoya 杜比视界' },
      { type: 'series', id: 'xiaoya-series-china',  name: 'Xiaoya 国产剧' },
      { type: 'series', id: 'xiaoya-series-japan',  name: 'Xiaoya 日剧' },
      { type: 'series', id: 'xiaoya-series-korea',  name: 'Xiaoya 韩剧' },
      { type: 'series', id: 'xiaoya-series-western',name: 'Xiaoya 欧美剧' },
      { type: 'series', id: 'xiaoya-series-hk',     name: 'Xiaoya 港台剧' },
      { type: 'series', id: 'xiaoya-anime',         name: 'Xiaoya 动漫' },
      { type: 'series', id: 'xiaoya-doc',           name: 'Xiaoya 纪录片' },
      { type: 'series', id: 'xiaoya-variety',       name: 'Xiaoya 综艺' }
    ],
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb:', 'xiaoya:']
  };
}

module.exports = { createManifest };
