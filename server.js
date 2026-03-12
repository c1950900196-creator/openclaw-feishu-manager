const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

require('dotenv').config();

const PORT = process.env.PORT || 18790;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'please_set_access_token';
const LOG_DIR = '/tmp/openclaw-1000';
const MAX_HISTORY = 200;

function getLogFile() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `openclaw-${y}-${m}-${day}.log`);
}

function parseLogLine(raw) {
  try {
    const obj = JSON.parse(raw);
    const time = obj.time || obj._meta?.date || '';
    const level = obj._meta?.logLevelName || 'INFO';
    let subsystem = '';
    let message = '';

    if (typeof obj['0'] === 'string') {
      const m = obj['0'].match(/^\{?"?subsystem"?:\s*"([^"]+)"/);
      if (m) subsystem = m[1];
      else message = obj['0'];
    }
    if (typeof obj['1'] === 'string') {
      message = obj['1'];
    } else if (typeof obj['1'] === 'object' && obj['1'] !== null) {
      message = JSON.stringify(obj['1']);
    }
    if (obj['2'] && typeof obj['2'] === 'string') {
      message = obj['2'];
    }

    let type = 'system';
    if (subsystem.includes('feishu') && message.includes('received message')) type = 'message_in';
    else if (subsystem.includes('feishu') && message.includes('dispatch complete')) type = 'message_done';
    else if (subsystem.includes('feishu') && message.includes('DM from')) type = 'message_content';
    else if (subsystem.includes('feishu') && message.includes('dispatching to agent')) type = 'task_start';
    else if (subsystem.includes('agent/embedded') && message.includes('run agent end')) type = 'task_end';
    else if (message.includes('error') || message.includes('Error') || level === 'ERROR') type = 'error';
    else if (subsystem.includes('gateway') && message.includes('listening')) type = 'startup';

    return { time, level, subsystem, message, type, raw: raw.substring(0, 500) };
  } catch {
    return { time: new Date().toISOString(), level: 'RAW', subsystem: '', message: raw.substring(0, 300), type: 'raw', raw: raw.substring(0, 500) };
  }
}

// WebSocket (RFC 6455 minimal implementation, no dependencies)
function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC525C75')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return {
    send(data) {
      const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      try { socket.write(Buffer.concat([header, payload])); } catch {}
    },
    onClose(cb) { socket.on('close', cb); socket.on('error', cb); },
    destroy() { try { socket.destroy(); } catch {} }
  };
}

const clients = new Set();
let tailProc = null;
let currentLogFile = '';

function startTail() {
  const logFile = getLogFile();
  if (tailProc && currentLogFile === logFile) return;
  if (tailProc) { tailProc.kill(); tailProc = null; }
  if (!fs.existsSync(logFile)) {
    setTimeout(startTail, 5000);
    return;
  }
  currentLogFile = logFile;
  tailProc = spawn('tail', ['-n', '50', '-f', logFile]);
  let buf = '';
  tailProc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseLogLine(line.trim());
      const msg = JSON.stringify({ type: 'log', data: parsed });
      for (const c of clients) {
        try { c.send(msg); } catch { clients.delete(c); }
      }
    }
  });
  tailProc.on('exit', () => { tailProc = null; setTimeout(startTail, 3000); });
}

// Check for new log file at midnight
setInterval(() => {
  const newFile = getLogFile();
  if (newFile !== currentLogFile) startTail();
}, 60000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  const token = url.searchParams.get('token');
  if (token !== ACCESS_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('Unauthorized');
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) { res.writeHead(500); return res.end('Error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  if (token !== ACCESS_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const ws = acceptWebSocket(req, socket);
  clients.add(ws);
  ws.onClose(() => clients.delete(ws));

  // Parse on-connect: read frame to detect pong/close
  socket.on('data', (buf) => {
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    if (opcode === 0x08) { clients.delete(ws); ws.destroy(); }
    // opcode 0x09 = ping -> send pong
    if (opcode === 0x09) {
      const pong = Buffer.alloc(2);
      pong[0] = 0x8a;
      pong[1] = 0x00;
      try { socket.write(pong); } catch {}
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Diana Monitor listening on 0.0.0.0:${PORT}`);
  startTail();
});
