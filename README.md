# Stremio Xiaoya Alist

Stremio 插件，浏览 Xiaoya Alist 资源并返回直链播放。支持 Forward 等播放器直接播放。

## 功能

- 浏览 Xiaoya Alist 的电影/电视剧分类目录
- 搜索 Alist 中的视频资源
- 通过 TMDB/IMDB ID 自动解析中文标题并匹配 Alist 文件
- 支持指定季/集切换
- 返回带签名的直链，可在 Forward 等播放器中直接播放

## 快速开始

### 1. 克隆并配置

```bash
git clone https://github.com/Keglr/stremio-xiaoya-alist.git
cd stremio-xiaoya-alist
cp .env.example .env
```

编辑 `.env` 填入配置：

```env
# Alist 服务地址
ALIST_URL=http://your-alist-host:port

# Alist 登录凭据
ALIST_USERNAME=dav
ALIST_PASSWORD=your_password

# 插件服务端口
PORT=7070

# TMDB API Key（可选，用于 IMDB/TMDB ID 解析中文标题）
# 免费申请: https://www.themoviedb.org/settings/api
TMDB_API_KEY=
# OMDB API Key（可选，TMDB 降级方案）
# 免费申请: https://www.omdbapi.com/apikey.aspx
OMDB_API_KEY=
```

> 不填 TMDB/OMDB Key 也能正常使用，只是标题搜索精度会下降。

### 2. 部署

**Docker（推荐）:**
```bash
docker-compose up -d
```
> 如果你的 Alist 也运行在 Docker 中，确保两者在同一网络或正确配置网络互通。

**手动运行:**
```bash
npm install
npm start
```

### 3. 安装到 Stremio/FORWARD

在 Stremio 中添加插件地址：

```
http://你的IP:7070/manifest.json
```

> Stremio Web 版要求远程插件必须是 HTTPS。本地 `127.0.0.1` 或 FORWARD 无此限制。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ALIST_URL` | ✓ | Alist 服务地址 |
| `ALIST_USERNAME` | ✓ | Alist 用户名 |
| `ALIST_PASSWORD` | ✓ | Alist 密码 |
| `PORT` | ✗ | 插件端口（默认 7070） |
| `TMDB_API_KEY` | ✗ | TMDB API Key |
| `OMDB_API_KEY` | ✗ | OMDB API Key |

## 技术栈

- Node.js + Express
- Alist API（`/api/fs/list`、`/api/fs/get`、WebDAV 读取 .strm）
- TMDB / OMDB API（标题解析）
