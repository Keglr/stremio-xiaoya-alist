const axios = require('axios');

const API_TIMEOUT = 15000;

class AlistClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.token = null;
    this.tokenExpire = 0;
    this.loginPromise = null; // 防止并发登录
    this.basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  async login() {
    // 如果已有登录请求在进行中，等待它完成
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      try {
        const resp = await axios.post(`${this.baseUrl}/api/auth/login`, {
          username: this.username,
          password: this.password
        }, { timeout: API_TIMEOUT });

        if (resp.data?.code !== 200) {
          throw new Error(`Alist 登录失败: ${resp.data?.message}`);
        }

        this.token = resp.data.data.token;
        this.tokenExpire = Date.now() + 23 * 60 * 60 * 1000;
        console.log('[Alist] 登录成功');
        return this.token;
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  async getToken() {
    if (!this.token || Date.now() > this.tokenExpire) {
      await this.login();
    }
    return this.token;
  }

  /**
   * 将文件路径正确编码为 URL 路径段
   * /strm/电影/中国/file.mp4 → /strm/%E7%94%B5%E5%BD%B1/...
   */
  encodePath(filePath) {
    return filePath.split('/').map(encodeURIComponent).join('/');
  }

  async apiRequest(method, path, data = null) {
    const token = await this.getToken();
    const config = {
      method,
      url: `${this.baseUrl}${path}`,
      headers: { Authorization: token },
      timeout: API_TIMEOUT,
    };
    if (data) config.data = data;

    try {
      return await axios(config);
    } catch (err) {
      // token 过期，重新登录后重试一次
      if (err.response?.status === 401) {
        console.log('[Alist] Token 过期，重新登录...');
        await this.login();
        config.headers.Authorization = this.token;
        return await axios(config);
      }
      throw err;
    }
  }

  /**
   * 列出目录内容
   */
  async listDir(dirPath, page = 1, perPage = 100) {
    try {
      const resp = await this.apiRequest('POST', '/api/fs/list', {
        path: dirPath, page, per_page: perPage
      });
      if (resp.data?.code !== 200) return [];
      return (resp.data.data?.content || []).map(item => ({
        name: item.name,
        path: dirPath === '/' ? `/${item.name}` : `${dirPath}/${item.name}`,
        is_dir: item.is_dir,
        size: item.size
      }));
    } catch (err) {
      console.error('[Alist] listDir 错误:', dirPath, err.message);
      return [];
    }
  }

  /**
   * 获取文件信息（包含 raw_url 签名直链）
   */
  async getFileInfo(filePath) {
    try {
      const resp = await this.apiRequest('POST', '/api/fs/get', {
        path: filePath
      });
      if (resp.data?.code !== 200) return null;
      return resp.data.data;
    } catch (err) {
      return null;
    }
  }

  /**
   * 读取 strm 文件内容，返回其中的播放 URL
   */
  async readStrmUrl(filePath) {
    try {
      const resp = await axios.get(`${this.baseUrl}/dav${this.encodePath(filePath)}`, {
        headers: { Authorization: this.basicAuth },
        timeout: API_TIMEOUT,
        maxBodyLength: 2000,
        responseType: 'text'
      });
      const lines = resp.data.split('\n');
      for (const line of lines) {
        const trimmed = line.split('#')[0].trim();
        if (trimmed.startsWith('http')) return trimmed;
      }
      return null;
    } catch (err) {
      console.error('[Alist] readStrmUrl 错误:', filePath, err.message);
      return null;
    }
  }

  /**
   * 获取文件的可播放直链
   */
  async getPlayableUrl(filePath) {
    if (filePath.toLowerCase().endsWith('.strm')) {
      return await this.readStrmUrl(filePath);
    }
    const info = await this.getFileInfo(filePath);
    return info?.raw_url || null;
  }

  /**
   * 获取文件的完整播放信息（直链 + 来源 + 大小）
   */
  async getPlayableInfo(filePath) {
    let url = null;
    let provider = '';
    let size = 0;
    if (filePath.toLowerCase().endsWith('.strm')) {
      url = await this.readStrmUrl(filePath);
    } else {
      const info = await this.getFileInfo(filePath);
      if (info) {
        url = info.raw_url || null;
        provider = info.provider || '';
        size = info.size || 0;
      }
    }
    return { url, provider, size };
  }

  /**
   * 批量获取播放信息（并行）
   */
  async getPlayableInfos(filePaths) {
    return Promise.all(filePaths.map(p => this.getPlayableInfo(p)));
  }

  /**
   * 批量获取可播放直链（并行）
   */
  async getPlayableUrls(filePaths) {
    return Promise.all(filePaths.map(p => this.getPlayableUrl(p)));
  }

  /**
   * 通过网页搜索接口搜索
   */
  async webSearch(keyword, type = 'video') {
    try {
      const resp = await axios.get(`${this.baseUrl}/search`, {
        params: { box: keyword, type },
        timeout: API_TIMEOUT
      });
      const html = resp.data;
      // 匹配 <a href="/path">text</a> 格式
      const regex = /<a href=(\/[^>]+?)>([^<]+)<\/a>/g;
      const results = [];
      let match;
      while ((match = regex.exec(html)) !== null) {
        const path = decodeURIComponent(match[1]);
        if (!path || path === '/') continue;
        const name = path.split('/').filter(Boolean).pop() || '';
        if (!name) continue;
        results.push({
          name,
          path,
          is_dir: !/\.(mp4|mkv|avi|ts|rmvb|rm|wmv|flv|mov|iso|strm)$/i.test(name)
        });
      }
      if (results.length === 0) {
        console.log(`[Alist] 搜索无结果: "${keyword}" (响应 ${html.length} 字节, 可能HTML解析失败)`);
      }
      return results;
    } catch (err) {
      console.error('[Alist] 搜索失败:', err.message);
      return [];
    }
  }
}

module.exports = { AlistClient };
