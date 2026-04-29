const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 单文件最大 10MB
const MAX_LOG_DAYS = 7; // 保留最近 7 天

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function getTimeStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function getLogPath(type = 'access') {
  return path.join(LOG_DIR, `${type}-${getDateStr()}.log`);
}

/**
 * 写日志到文件
 */
function write(type, level, msg) {
  const filePath = getLogPath(type);
  const line = `[${getTimeStr()}] [${level}] ${msg}\n`;

  // 超过最大大小则轮转
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_SIZE) {
      const rotated = filePath + '.1';
      fs.renameSync(filePath, rotated);
    }
  } catch (_) { /* ignore */ }

  fs.appendFile(filePath, line, () => {});
}

/**
 * 清理过期日志
 */
function cleanup() {
  try {
    const cutoff = Date.now() - MAX_LOG_DAYS * 86400000;
    const files = fs.readdirSync(LOG_DIR);
    for (const f of files) {
      const fullPath = path.join(LOG_DIR, f);
      if (fs.statSync(fullPath).mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch (_) { /* ignore */ }
}

// 启动时清理一次，之后每天清理一次
cleanup();
setInterval(cleanup, 86400000);

module.exports = {
  /** HTTP 请求日志 */
  access(req, statusCode, duration, extra = '') {
    const ua = req.headers['user-agent'] || '-';
    const referer = req.headers['referer'] || '-';
    const accept = req.headers['accept'] || '-';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
    let msg = `${req.method} ${req.originalUrl} → ${statusCode} ${duration}ms | IP: ${ip} | UA: ${ua} | Accept: ${accept} | Referer: ${referer}`;
    if (extra) msg += ` | ${extra}`;
    write('access', statusCode >= 400 ? 'WARN' : 'INFO', msg);
  },

  /** 普通信息日志 */
  info(msg) {
    write('app', 'INFO', msg);
    console.log(`[INFO] ${msg}`);
  },

  /** 错误日志 */
  error(msg, err) {
    const detail = err ? ` | ${err.message || err}` : '';
    write('app', 'ERROR', msg + detail);
    console.error(`[ERROR] ${msg}${detail}`);
  },

  /** 读取最近 N 行日志 */
  readRecent(type = 'access', lines = 200) {
    const filePath = getLogPath(type);
    if (!fs.existsSync(filePath)) return '';
    const buf = fs.readFileSync(filePath, 'utf8');
    const arr = buf.trim().split('\n');
    return arr.slice(-lines).join('\n');
  },
};
