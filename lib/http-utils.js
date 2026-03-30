const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function sendJson(req, res, data, cacheSeconds) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (cacheSeconds > 0) headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  else headers['Cache-Control'] = 'no-cache';

  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip') && json.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    zlib.gzip(Buffer.from(json, 'utf8'), (err, compressed) => {
      if (err) {
        res.end(json);
        return;
      }
      res.end(compressed);
    });
    return;
  }
  res.writeHead(200, headers);
  res.end(json);
}

const apiCache = new Map();
function getCached(key, ttlMs, producer) {
  const entry = apiCache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  if (entry) {
    setImmediate(() => {
      try {
        const data = producer();
        apiCache.set(key, { data, ts: Date.now() });
      } catch (e) {
        console.error('cache refresh error:', key, e.message);
      }
    });
    return entry.data;
  }
  const data = producer();
  apiCache.set(key, { data, ts: Date.now() });
  return data;
}

const STATIC_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function sendStaticFile(res, filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_MIME[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
    });
    return res.end(data);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Internal Server Error');
  }
}

function getRequestToken(req, url) {
  const auth = (req.headers.authorization || '').toString();
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  return (url.searchParams.get('token') || '').trim();
}

module.exports = { sendJson, getCached, sendStaticFile, getRequestToken };
