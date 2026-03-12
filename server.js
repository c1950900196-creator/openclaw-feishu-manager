const http = require('http');
const zlib = require('zlib');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// --- Skills ---
const SKILLS_DIR = '/home/ubuntu/.npm-global/lib/node_modules/openclaw/skills';
const { execSync } = require('child_process');

// --- Token Pricing (per 1M tokens, USD) ---
const TOKEN_PRICING = {
  'gpt-5.4':       { input: 2.50,  output: 15.00, cacheRead: 0.25 },
  'gpt-5.2':       { input: 1.75,  output: 14.00, cacheRead: 0.175 },
  'gpt-4.1':       { input: 2.00,  output: 8.00,  cacheRead: 0.50 },
  'gpt-4o':        { input: 2.50,  output: 10.00, cacheRead: 1.25 },
  'claude-opus-4-6':{ input: 15.00, output: 75.00, cacheRead: 1.50 },
  'qwen3.5-plus':  { input: 0.80,  output: 2.00,  cacheRead: 0.20 },
};

function estimateCost(model, input, output, cacheRead) {
  const pricing = TOKEN_PRICING[model];
  if (!pricing) return 0;
  return (input * pricing.input + output * pricing.output + (cacheRead || 0) * pricing.cacheRead) / 1000000;
}


function listSkills() {
  const skills = [];
  try {
    const dirs = fs.readdirSync(SKILLS_DIR).filter(d => {
      const p = path.join(SKILLS_DIR, d);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'));
    });
    for (const dir of dirs) {
      const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
      const content = fs.readFileSync(skillPath, 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let name = dir, description = '', emoji = '';
      if (fmMatch) {
        const fm = fmMatch[1];
        const nameM = fm.match(/^name:\s*(.+)$/m);
        if (nameM) name = nameM[1].trim();
        const descM = fm.match(/^description:\s*['"]?(.+?)['"]?$/m);
        if (descM) description = descM[1].trim().substring(0, 200);
        const emojiM = fm.match(/"emoji":\s*"([^"]+)"/);
        if (emojiM) emoji = emojiM[1];
      }
      const stat = fs.statSync(skillPath);
      const files = [];
      function walk(d, rel) {
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f);
          const r = rel ? rel + '/' + f : f;
          if (fs.statSync(full).isDirectory()) walk(full, r);
          else files.push({ name: r, size: fs.statSync(full).size });
        }
      }
      walk(path.join(SKILLS_DIR, dir), '');
      skills.push({ id: dir, name, emoji, description, files, modified: stat.mtime.toISOString() });
    }
  } catch (e) { console.error('listSkills error:', e.message); }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function packageSkill(skillDir) {
  const skillPath = path.join(SKILLS_DIR, skillDir);
  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) return null;
  const outPath = path.join('/tmp', skillDir + '.skill');
  try {
    execSync(`cd "${SKILLS_DIR}" && zip -r "${outPath}" "${skillDir}/"`, { timeout: 10000 });
    return outPath;
  } catch { return null; }
}

const { WebSocketServer } = require('ws');


// --- Response compression & caching ---
function sendJson(req, res, data, cacheSeconds) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip') && json.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    zlib.gzip(Buffer.from(json, 'utf8'), (err, compressed) => {
      if (err) { res.end(json); return; }
      res.end(compressed);
    });
  } else {
    res.writeHead(200, headers);
    res.end(json);
  }
}

const apiCache = new Map();
function getCached(key, ttlMs, producer) {
  const entry = apiCache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  // stale-while-revalidate: return stale data immediately, refresh in background
  if (entry) {
    setImmediate(() => {
      try {
        const data = producer();
        apiCache.set(key, { data, ts: Date.now() });
      } catch (e) { console.error('cache refresh error:', key, e.message); }
    });
    return entry.data;
  }
  const data = producer();
  apiCache.set(key, { data, ts: Date.now() });
  return data;
}

const PORT = 18790;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'changeme';
const MAX_HISTORY = 500;
const MAX_RECENT_LOGS = 200;

// --- Multi-bot configuration ---
const BOTS = {
  diana: {
    name: 'Diana',
    feishuAppId: 'cli_a92d030414381ced',
    feishuAppSecret: process.env.DIANA_FEISHU_SECRET || '',
    logDir: '/tmp/openclaw-1000',
    sessionsDir: '/home/ubuntu/.openclaw/agents/main/sessions',
    dataDir: __dirname,
    openclawBin: '/home/ubuntu/.npm-global/bin/openclaw',
    openclawToken: process.env.DIANA_OPENCLAW_TOKEN || '',
    useCli: true,
  },
  jax: {
    name: 'Jax',
    feishuAppId: 'cli_a909cea1b9385bd3',
    feishuAppSecret: process.env.JAX_FEISHU_SECRET || '',
    logDir: path.join(__dirname, 'bots/jax/logs'),
    sessionsDir: path.join(__dirname, 'bots/jax/sessions'),
    dataDir: path.join(__dirname, 'bots/jax'),
    useCli: false,
    usageCostFile: path.join(__dirname, 'bots/jax/usage-cost.json'),
    cronListFile: path.join(__dirname, 'bots/jax/cron-list.json'),
  }
};
const DEFAULT_BOT = 'diana';

function getBot(url) {
  const botId = (url.searchParams ? url.searchParams.get('bot') : null) || DEFAULT_BOT;
  return { id: botId, ...(BOTS[botId] || BOTS[DEFAULT_BOT]) };
}

function botPath(bot, filename) {
  return path.join(bot.dataDir, filename);
}

// Per-bot runtime state
const botState = {};
for (const [id, cfg] of Object.entries(BOTS)) {
  // Ensure data directories exist
  try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(cfg.logDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(cfg.sessionsDir, { recursive: true }); } catch {}
  botState[id] = {
    userNames: {},
    userChatIds: {},
    groupNames: {},
    voiceTranscripts: {},
    tenantToken: null,
    tokenExpiry: 0,
    history: { events: [] },
    recentLogs: [],
    tailProc: null,
    currentLogFile: '',
    _pendingRecognize: new Set(),
  };
  // Load persisted data
  try { botState[id].userNames = JSON.parse(fs.readFileSync(botPath(cfg, 'user-names.json'), 'utf8')); } catch {}
  try { botState[id].userChatIds = JSON.parse(fs.readFileSync(botPath(cfg, 'user-chats.json'), 'utf8')); } catch {}
  try { botState[id].groupNames = JSON.parse(fs.readFileSync(botPath(cfg, 'group-names.json'), 'utf8')); } catch {}
  try { botState[id].voiceTranscripts = JSON.parse(fs.readFileSync(botPath(cfg, 'voice-transcripts.json'), 'utf8')); } catch {}
  try { botState[id].history = JSON.parse(fs.readFileSync(botPath(cfg, 'history.json'), 'utf8')); if (!botState[id].history.events) botState[id].history = { events: [] }; } catch { botState[id].history = { events: [] }; }
}

function saveBotData(botId, filename, data) {
  const cfg = BOTS[botId];
  if (!cfg) return;
  try { fs.writeFileSync(botPath(cfg, filename), JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// --- Per-bot helper accessors (backward-compat shims for existing code) ---
// These point to the default bot's state; API handlers override via getBot()
let userNames = botState[DEFAULT_BOT].userNames;
let userChatIds = botState[DEFAULT_BOT].userChatIds;
let groupNames = botState[DEFAULT_BOT].groupNames;
let voiceTranscripts = botState[DEFAULT_BOT].voiceTranscripts;
let tenantToken = null;
let tokenExpiry = 0;

function saveNames(botId) { saveBotData(botId || DEFAULT_BOT, 'user-names.json', botState[botId || DEFAULT_BOT].userNames); }
function saveChatIds(botId) { saveBotData(botId || DEFAULT_BOT, 'user-chats.json', botState[botId || DEFAULT_BOT].userChatIds); }
function saveGroupNames(botId) { saveBotData(botId || DEFAULT_BOT, 'group-names.json', botState[botId || DEFAULT_BOT].groupNames); }
function saveVoiceTranscripts(botId) { saveBotData(botId || DEFAULT_BOT, 'voice-transcripts.json', botState[botId || DEFAULT_BOT].voiceTranscripts); }
function saveHistory(botId) { saveBotData(botId || DEFAULT_BOT, 'history.json', botState[botId || DEFAULT_BOT].history); }

function loadNames() {} // no-op, loaded in botState init
function loadChatIds() {}
function loadGroupNames() {}
// --- Per-bot history event helpers ---
function addEvent(evt, botId) {
  const bid = botId || DEFAULT_BOT;
  const h = botState[bid].history;
  h.events.push(evt);
  while (h.events.length > MAX_HISTORY) h.events.shift();
}

// Backfill: scan recent log files on startup to recover missed events
function backfillFromLogs(botId) {
  const bid = botId || DEFAULT_BOT;
  const cfg = BOTS[bid];
  if (!cfg) return;
  const LOG_DIR = cfg.logDir;
  const today = new Date();
  const dates = [];
  for (let i = 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dates.push(yy + '-' + mm + '-' + dd);
  }
  const _uci = botState[bid].userChatIds;
  let backfilled = 0;
  for (const date of dates) {
    const logPath = path.join(LOG_DIR, 'openclaw-' + date + '.log');
    if (!fs.existsSync(logPath)) continue;
    try {
      const raw = fs.readFileSync(logPath, 'utf8');
      const lines = raw.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseLogLine(line.trim());
        if (parsed.type === 'message_in') {
          const m2 = parsed.message.match(/received message from (\S+) in (\S+)/);
          if (m2) {
            const userId = m2[1];
            const chatId = m2[2];
            const isGroup = parsed.message.includes('(group)');
            if (!isGroup) {
              if (!_uci[userId] || _uci[userId] !== chatId) {
                _uci[userId] = chatId;
              }
            }
            backfilled++;
          }
        } else if (parsed.type === 'message_content') {
          const m2 = parsed.message.match(/DM from (\S+): ([\s\S]+)/);
          if (m2) {
            const userId = m2[1];
            const text = m2[2].substring(0, 100);
            const uname = botState[bid].userNames[userId] || userId.substring(0, 12);
            addEvent({ kind: 'user_msg', userId, userName: uname, text, time: parsed.time }, bid);
            backfilled++;
          }
        } else if (parsed.type === 'group_message_content') {
          const m2 = parsed.message.match(/message in group (\S+): ([\s\S]+)/);
          if (m2) {
            const groupId = m2[1];
            const text = m2[2].substring(0, 100);
            if (!_uci['group:' + groupId]) {
              _uci['group:' + groupId] = groupId;
            }
            addEvent({ kind: 'user_msg', userId: 'group:' + groupId, userName: 'group', text, time: parsed.time, isGroup: true, groupId }, bid);
            backfilled++;
          }
        }
      }
    } catch (e) { console.error('backfill error for', date, e.message); }
  }
  saveChatIds(bid);
  saveHistory(bid);
  console.log('[' + bid + '] Backfill complete: scanned ' + dates.length + ' log files, recovered ' + backfilled + ' message events');
}




function httpJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getTenantToken(botId) {
  const bid = botId || DEFAULT_BOT;
  const st = botState[bid];
  const cfg = BOTS[bid];
  if (!st || !cfg) return null;
  if (st.tenantToken && Date.now() < st.tokenExpiry) return st.tenantToken;
  try {
    const data = await httpJson({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { app_id: cfg.feishuAppId, app_secret: cfg.feishuAppSecret });
    if (data.code === 0) {
      st.tenantToken = data.tenant_access_token;
      st.tokenExpiry = Date.now() + (data.expire - 120) * 1000;
      return st.tenantToken;
    }
  } catch {}
  return null;
}

// --- Voice recognition (per-bot state already initialized in botState) ---
const _pendingRecognize = botState[DEFAULT_BOT]._pendingRecognize;

function loadVoiceTranscripts() {} // no-op, loaded in botState init

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

async function recognizeAudio(messageId, fileKey, botId) {
  const _bid = botId || DEFAULT_BOT;
  const _vt = botState[_bid].voiceTranscripts;
  const _pr = botState[_bid]._pendingRecognize;
  if (_vt[messageId]) return _vt[messageId];
  if (_pr.has(messageId)) return null;
  _pr.add(messageId);
  try {
    const feishuToken = await getTenantToken(_bid);
    if (!feishuToken) throw new Error('no feishu token');

    // Step 1: Download audio from Feishu
    const audioData = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'open.feishu.cn',
        path: `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${feishuToken}` }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('download timeout')); });
      req.end();
    });

    if (audioData.length < 100) throw new Error('audio too small: ' + audioData.length);

    // Step 2: Convert opus -> mp3 via ffmpeg
    const safeId = messageId.replace(/[^a-zA-Z0-9_]/g, '');
    const tmpOpus = `/tmp/voice_${safeId}.opus`;
    const tmpMp3 = `/tmp/voice_${safeId}.mp3`;
    fs.writeFileSync(tmpOpus, audioData);

    await new Promise((resolve, reject) => {
      const proc = require('child_process').spawn('ffmpeg', [
        '-y', '-i', tmpOpus, '-ar', '16000', '-ac', '1', '-b:a', '64k', tmpMp3
      ], { timeout: 15000 });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
      proc.on('error', reject);
    });

    const mp3Data = fs.readFileSync(tmpMp3);

    // Cleanup temp files
    try { fs.unlinkSync(tmpOpus); } catch {}
    try { fs.unlinkSync(tmpMp3); } catch {}

    // Step 3: Call OpenAI Whisper API via multipart/form-data
    const boundary = '----VoiceBoundary' + Date.now();
    const parts = [];
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nzh\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`);
    const head = Buffer.from(parts.join(''));
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, mp3Data, tail]);

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { reject(new Error('parse error')); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('whisper timeout')); });
      req.write(body);
      req.end();
    });

    if (result.text) {
      _vt[messageId] = result.text;
      saveVoiceTranscripts(_bid);
      console.log('Voice recognized [' + _bid + ']:', messageId, '->', result.text.substring(0, 60));
      return result.text;
    } else {
      throw new Error('Whisper error: ' + JSON.stringify(result));
    }
  } catch (e) {
    console.error('recognizeAudio error:', messageId, e.message);
    _vt[messageId] = '[语音识别失败]';
    saveVoiceTranscripts(_bid);
    return null;
  } finally {
    _pr.delete(messageId);
  }
}

async function resolveUserName(openId, botId) {
  const _bid = botId || DEFAULT_BOT;
  const _un = botState[_bid].userNames;
  if (_un[openId]) return _un[openId];
  try {
    const token = await getTenantToken(_bid);
    if (!token) return null;
    const data = await httpJson({
      hostname: 'open.feishu.cn',
      path: `/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data.code === 0 && data.data?.user?.name) {
      _un[openId] = data.data.user.name;
      saveNames(_bid);
      return data.data.user.name;
    }
  } catch {}
  return null;
}


async function resolveGroupName(chatId, botId) {
  const _bid = botId || DEFAULT_BOT;
  const _gn = botState[_bid].groupNames;
  if (_gn[chatId]) return _gn[chatId];
  try {
    const token = await getTenantToken(_bid);
    if (!token) return null;
    const data = await httpJson({
      hostname: 'open.feishu.cn',
      path: `/open-apis/im/v1/chats/${chatId}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data.code === 0 && data.data?.name) {
      _gn[chatId] = data.data.name;
      saveGroupNames(_bid);
      return data.data.name;
    }
  } catch {}
  return null;
}

async function fetchChatMessages(chatId, pageSize, pageToken, botId) {
  const _bid = botId || DEFAULT_BOT;
  const token = await getTenantToken(_bid);
  if (!token) return { ok: false, error: 'no token' };
  try {
    const size = pageSize || 50;
    const data = await httpJson({
      hostname: 'open.feishu.cn',
      path: `/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${size}&sort_type=ByCreateTimeDesc${pageToken ? '&page_token=' + pageToken : ''}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data.code !== 0) return { ok: false, error: data.msg || 'api error', code: data.code };

    const items = (data.data?.items || []).reverse();
    const messages = [];
    for (const item of items) {
      const sender = item.sender || {};
      const senderId = sender.id || '';
      const senderType = sender.sender_type || '';
      const isBot = senderType === 'app';
      const rawTs = parseInt(item.create_time || '0'); const createTime = rawTs ? new Date(rawTs > 1e12 ? rawTs : rawTs * 1000).toISOString() : '';
      const msgType = item.msg_type || '';

      let text = '';
      try {
        const body = JSON.parse(item.body?.content || '{}');
        if (msgType === 'text') text = body.text || '';
        else if (msgType === 'post') {
          const title = body.title || '';
          const lines = [];
          if (title) lines.push(title);
          for (const para of (body.content || [])) {
            const parts = [];
            for (const el of (para || [])) {
              if (el.tag === 'text') parts.push(el.text || '');
              else if (el.tag === 'a') parts.push(`[${el.text || ''}](${el.href || ''})`);
              else if (el.tag === 'img') parts.push('[图片]');
              else if (el.tag === 'media') parts.push('[媒体]');
              else if (el.tag === 'emotion') parts.push(el.emoji_type || '');
              else parts.push(`[${el.tag || '?'}]`);
            }
            lines.push(parts.join(''));
          }
          text = lines.join('\n');
        } else if (msgType === 'image') text = '[图片]';
        else if (msgType === 'file') text = `[文件] ${body.file_name || ''}`;
        else if (msgType === 'audio') {
          const fk = body.file_key || '';
          const mid = item.message_id || '';
          const _vt2 = botState[_bid].voiceTranscripts;
          const cached = _vt2[mid];
          if (cached) {
            text = cached === '[语音识别失败]' ? cached : '[语音] ' + cached;
          } else if (fk && mid) {
            recognizeAudio(mid, fk, _bid).catch(() => {});
            text = '[语音识别中...]';
          } else {
            text = '[语音]';
          }
        }
        else if (msgType === 'video') text = '[视频]';
        else if (msgType === 'sticker') text = '[表情]';
        else if (msgType === 'interactive') {
          const cardTitle = body.header?.title?.content || body.title || '';
          const cardTexts = [];
          for (const para of (body.elements || [])) {
            const els = Array.isArray(para) ? para : [para];
            for (const el of els) {
              if (!el || typeof el !== 'object') continue;
              if (el.tag === 'markdown' && el.content) cardTexts.push(el.content.substring(0, 300));
              else if (el.tag === 'div' && el.text?.content) cardTexts.push(el.text.content.substring(0, 200));
              else if (el.tag === 'text' && el.text && !el.text.includes('请升级至最新版本')) cardTexts.push(el.text);
              else if (el.tag === 'img') cardTexts.push('[图片]');
            }
          }
          const useful = cardTexts.filter(t => t && !t.includes('请升级至最新版本'));
          if (cardTitle) text = cardTitle + (useful.length ? ': ' + useful.join(' ') : '');
          else if (useful.length) text = useful.join(' ');
          else text = '[卡片消息 - 请在飞书查看]';
        } else if (msgType === 'system') text = '[系统消息]';
        else text = `[${msgType}]`;
      } catch { text = '[无法解析]'; }

      messages.push({
        role: isBot ? 'diana' : 'user',
        senderId,
        senderName: isBot ? (BOTS[_bid]?.name || 'Bot') : (botState[_bid].userNames[senderId] || senderId.substring(0, 10)),
        text,
        time: createTime,
        msgType
      });
    }
    return { ok: true, messages, has_more: !!data.data?.has_more, page_token: data.data?.page_token || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- History persistence (per-bot) ---

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveHistory(DEFAULT_BOT); }, 5000);
}

// addEvent is now defined above with botId param
// This legacy wrapper is for recordEvent compatibility
function addEventLegacy(evt) {
  addEvent(evt, DEFAULT_BOT);
  scheduleSave();
}

// history already loaded in botState init (line 188)

// Sync user names from OpenClaw sessions.json on startup
try {
  const sessFile = path.join(BOTS[DEFAULT_BOT].sessionsDir, 'sessions.json');
  if (fs.existsSync(sessFile)) {
    const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
    let updated = false;
    for (const [, v] of Object.entries(sessData)) {
      if (!v || typeof v !== 'object' || !v.origin) continue;
      const origin = v.origin;
      const fromId = (origin.from || '').replace('feishu:', '');
      const label = origin.label || '';
      if (fromId.startsWith('ou_') && label && !label.startsWith('ou_') && !label.startsWith('oc_')) {
        if (!userNames[fromId] || userNames[fromId] !== label) {
          userNames[fromId] = label;
          updated = true;
        }
      }
    }
    if (updated) saveNames();
  }
} catch {}

// --- Log parsing ---
function getLogFile(logDir) {
  if (!logDir) logDir = BOTS[DEFAULT_BOT].logDir;
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(logDir, `openclaw-${y}-${m}-${day}.log`);
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
    else if (subsystem.includes('feishu') && message.match(/message in group oc_\S+:/)) type = 'group_message_content';
    else if (subsystem.includes('feishu') && message.includes('dispatching to agent')) type = 'task_start';
    else if (subsystem.includes('feishu') && message.includes('group session scope=group')) type = 'group_session';
    else if (subsystem.includes('agent/embedded') && message.includes('run agent end')) type = 'task_end';
    else if (message.includes('error') || message.includes('Error') || level === 'ERROR') type = 'error';
    else if (subsystem.includes('gateway') && message.includes('listening')) type = 'startup';

    return { time, level, subsystem, message, type, raw: raw.substring(0, 500) };
  } catch {
    return { time: new Date().toISOString(), level: 'RAW', subsystem: '', message: raw.substring(0, 300), type: 'raw', raw: raw.substring(0, 500) };
  }
}

let lastMsgUserId = null;
let lastMsgUserName = null;
let lastGroupChatId = null;
let lastGroupSenderId = null;

async function recordEvent(parsed) {
  if (parsed.type === 'message_in') {
    const m = parsed.message.match(/received message from (\S+) in (\S+)/);
    if (m) {
      const userId = m[1];
      const chatId = m[2];
      const isGroup = parsed.message.includes('(group)');
      if (isGroup) {
        lastGroupChatId = chatId;
        lastGroupSenderId = userId;
      } else {
        if (!userChatIds[userId] || userChatIds[userId] !== chatId) {
          userChatIds[userId] = chatId;
          saveChatIds();
        }
      }
    }
  }

  if (parsed.type === 'message_content') {
    const m = parsed.message.match(/DM from (\S+): ([\s\S]+)/);
    if (m) {
      const userId = m[1];
      const name = await resolveUserName(userId);
      lastMsgUserId = userId;
      lastMsgUserName = name || userId.substring(0, 10);
      addEvent({ kind: 'user_msg', userId, userName: lastMsgUserName, text: m[2], time: parsed.time }, DEFAULT_BOT);
    }
  } else if (parsed.type === 'group_message_content') {
    const m = parsed.message.match(/message in group (\S+): ([\s\S]+)/);
    if (m) {
      const groupId = m[1];
      const text = m[2];
      const senderName = lastGroupSenderId ? (await resolveUserName(lastGroupSenderId)) || lastGroupSenderId.substring(0, 10) : 'unknown';
      const groupName = (await resolveGroupName(groupId)) || groupId.substring(0, 12);
      lastMsgUserId = 'group:' + groupId;
      lastMsgUserName = groupName;
      const _defaultChatIds = botState[DEFAULT_BOT].userChatIds;
      if (!_defaultChatIds['group:' + groupId]) {
        _defaultChatIds['group:' + groupId] = groupId;
        saveChatIds(DEFAULT_BOT);
      }
      addEvent({ kind: 'user_msg', userId: 'group:' + groupId, userName: groupName, text: `[${senderName}] ${text}`, time: parsed.time, isGroup: true, groupId, senderId: lastGroupSenderId, senderName }, DEFAULT_BOT);
    }
  } else if (parsed.type === 'task_end') {
    if (parsed.message.includes('isError=true')) {
      const errMatch = parsed.message.match(/error=(.+)/);
      const err = errMatch ? errMatch[1] : 'unknown';
      let status = 'failed';
      if (err.includes('rate limit')) status = 'rate_limit';
      else if (err.includes('Context overflow')) status = 'overflow';
      addEvent({ kind: 'diana_status', status, error: err.substring(0, 200), time: parsed.time, userId: lastMsgUserId, userName: lastMsgUserName }, DEFAULT_BOT);
    }
  } else if (parsed.type === 'message_done') {
    const m = parsed.message.match(/replies=(\d+)/);
    const replies = m ? parseInt(m[1]) : 0;
    addEvent({ kind: 'diana_status', status: replies > 0 ? 'replied' : 'no_reply', replies, time: parsed.time, userId: lastMsgUserId, userName: lastMsgUserName }, DEFAULT_BOT);
  } else if (parsed.type === 'startup') {
    addEvent({ kind: 'system', text: parsed.message, time: parsed.time }, DEFAULT_BOT);
  } else if (parsed.type === 'error' && !parsed.message.includes('permission scope')) {
    addEvent({ kind: 'error', text: parsed.message.substring(0, 200), time: parsed.time }, DEFAULT_BOT);
  }
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
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
    const htmlData = getCached('index.html', 5000, () => fs.readFileSync(htmlPath));
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (acceptEncoding.includes('gzip')) {
      const gzipped = getCached('index.html.gz', 5000, () => zlib.gzipSync(htmlData));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Cache-Control': 'no-cache' });
      res.end(gzipped);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(htmlData);
    }
    return;
  }

  if (url.pathname === '/api/bots') {
    const botList = Object.entries(BOTS).map(([id, cfg]) => ({ id, name: cfg.name }));
    sendJson(req, res, { ok: true, bots: botList }, 60);
    return;
  }

  if (url.pathname === '/api/history') {
    const bot = getBot(url);
    sendJson(req, res, botState[bot.id].history, 0);
    return;
  }

  if (url.pathname === '/api/names') {
    const bot = getBot(url);
    sendJson(req, res, botState[bot.id].userNames, 60);
    return;
  }

  if (url.pathname === '/api/chats') {
    const bot = getBot(url);
    sendJson(req, res, botState[bot.id].userChatIds, 30);
    return;
  }

  if (url.pathname === '/api/group-names') {
    const bot = getBot(url);
    sendJson(req, res, botState[bot.id].groupNames, 60);
    return;
  }

  if (url.pathname === '/api/chat-messages') {
    const bot = getBot(url);
    const userId = url.searchParams.get('userId');
    const directChatId = url.searchParams.get('chatId');
    if (!userId && !directChatId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'missing userId or chatId' }));
    }
    const chatId = directChatId || botState[bot.id].userChatIds[userId];
    if (!chatId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'no chatId found for user' }));
    }
    try {
      const result = await fetchChatMessages(chatId, parseInt(url.searchParams.get('limit') || '50'), url.searchParams.get('page_token') || null, bot.id);
      sendJson(req, res, result, 0);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }


  if (url.pathname === '/api/logs') {
    const bot = getBot(url);
    const LOG_DIR = bot.logDir;
    const dateParam = url.searchParams.get('date');
    const lines = Math.min(parseInt(url.searchParams.get('lines') || '2000'), 10000);
    let targetDate;
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      targetDate = dateParam;
    } else {
      const d = new Date();
      targetDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    const logPath = path.join(LOG_DIR, `openclaw-${targetDate}.log`);
    if (!fs.existsSync(logPath)) {
      sendJson(req, res, { ok: true, date: targetDate, logs: [], total: 0 }, 0);
      return;
    }
    const todayDate = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const isToday = targetDate === todayDate;
    const cacheKey = `logs:${targetDate}:${lines}`;
    const cacheTtl = isToday ? 10000 : 300000;
    try {
      const result = getCached(cacheKey, cacheTtl, () => {
        const content = fs.readFileSync(logPath, 'utf8');
        const allLines = content.split('\n').filter(l => l.trim());
        const slice = allLines.slice(-lines);
        const parsed = slice.map(l => parseLogLine(l.trim()));
        return { ok: true, date: targetDate, logs: parsed, total: allLines.length, showing: parsed.length };
      });
      sendJson(req, res, result, isToday ? 0 : 300);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/log-dates') {
    const bot = getBot(url);
    const LOG_DIR = bot.logDir;
    try {
      const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('openclaw-') && f.endsWith('.log')).sort();
      const dates = files.map(f => {
        const m = f.match(/openclaw-(\d{4}-\d{2}-\d{2})\.log/);
        const stat = fs.statSync(path.join(LOG_DIR, f));
        return m ? { date: m[1], size: stat.size } : null;
      }).filter(Boolean);
      sendJson(req, res, { ok: true, dates }, 60);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/stop-all' && req.method === 'POST') {
    try {
      const bot = getBot(url);
      if (!bot.useCli) { sendJson(req, res, { ok: false, error: 'stop-all not available for remote bots' }); return; }
      const openclaw = bot.openclawBin;
      const gwToken = bot.openclawToken;

      const sessionsOut = execSync(`${openclaw} sessions --active 120 --json 2>/dev/null`, { timeout: 15000, encoding: 'utf8' });
      const sessionsData = JSON.parse(sessionsOut);
      const sessions = sessionsData.sessions || [];

      const results = [];
      for (const sess of sessions) {
        const key = sess.key;
        try {
          const out = execSync(
            `${openclaw} gateway call chat.abort --token ${gwToken} --params '${JSON.stringify({ sessionKey: key })}' --json --timeout 5000 2>/dev/null`,
            { timeout: 10000, encoding: 'utf8' }
          );
          let parsed;
          try { parsed = JSON.parse(out); } catch { parsed = out.trim(); }
          results.push({ key, ok: true, result: parsed });
        } catch (e) {
          results.push({ key, ok: false, error: e.message.substring(0, 100) });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, sessionsFound: sessions.length, results }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (url.pathname === '/api/skills') {
    const skills = getCached('skills', 120000, listSkills);
    sendJson(req, res, { ok: true, skills }, 120);
    return;
  }

  if (url.pathname.startsWith('/api/skills/') && url.pathname.endsWith('/download')) {
    const parts = url.pathname.split('/');
    const skillId = decodeURIComponent(parts[3]);
    const filePath = packageSkill(skillId);
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'skill not found' }));
    }
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${skillId}.skill"`,
      'Content-Length': data.length
    });
    return res.end(data);
  }

  if (url.pathname.startsWith('/api/skills/') && url.pathname.endsWith('/readme')) {
    const parts = url.pathname.split('/');
    const skillId = decodeURIComponent(parts[3]);
    const skillPath = path.join(SKILLS_DIR, skillId, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
    const content = fs.readFileSync(skillPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, content }));
  }



  if (url.pathname === '/api/cron-usage') {
    try {
      const bot = getBot(url);
      const result = getCached('cron-usage:' + bot.id, 30000, () => {
        // 1) Get cron job list
        let jobs = [];
        if (bot.useCli) {
          try {
            const out = execSync(
              `${bot.openclawBin} cron list --json --token ${bot.openclawToken} 2>/dev/null`,
              { timeout: 15000, encoding: 'utf8' }
            );
            const parsed = JSON.parse(out);
            jobs = parsed.jobs || [];
          } catch (e) { console.error('cron list error:', e.message); }
        } else if (bot.cronListFile) {
          try { jobs = JSON.parse(fs.readFileSync(bot.cronListFile, 'utf8')).jobs || []; } catch {}
        }

        // 2) For each job, get run history
        const jobsWithRuns = [];
        for (const job of jobs) {
          let runs = [];
          try {
            const out = execSync(
              `${bot.openclawBin} cron runs --id ${job.id} --limit 100 --token ${bot.openclawToken} 2>/dev/null`,
              { timeout: 15000, encoding: 'utf8' }
            );
            const parsed = JSON.parse(out);
            runs = parsed.runs || parsed.entries || parsed || [];
            if (!Array.isArray(runs)) runs = [];
          } catch {}

          // Calculate stats
          let totalTokens = 0, totalCost = 0, runDetails = [];
          for (const run of runs) {
            const u = run.usage || {};
            const inp = run.inputTokens || u.input_tokens || u.input || 0;
            const out2 = run.outputTokens || u.output_tokens || u.output || 0;
            const toks = run.totalTokens || u.total_tokens || u.totalTokens || (inp + out2) || 0;
            const cacheR = u.cacheRead || u.cache_read || 0;
            const cost = run.cost || estimateCost(run.model || '', inp, out2, cacheR);
            totalTokens += toks;
            totalCost += cost;
            const startMs = run.runAtMs || run.startedAtMs || 0;
            runDetails.push({
              runId: run.runId || run.id || run.sessionId || '',
              startedAt: startMs ? new Date(startMs).toISOString() : (run.startedAt || run.timestamp || run.at || ''),
              finishedAt: run.finishedAt || run.completedAt || '',
              status: run.status || run.result || run.action || '',
              inputTokens: inp,
              outputTokens: out2,
              totalTokens: toks,
              cost: cost,
              durationMs: run.durationMs || run.duration || 0,
              model: run.model || '',
              error: run.error || ''
            });
          }

          // Also try to match tokens from session JSONL if cron runs don't have token data
          if (totalTokens === 0 && job.sessionKey) {
            // Try to find session file for this cron job
            const sessDir = bot.sessionsDir;
            const sessFile = path.join(sessDir, 'sessions.json');
            try {
              const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
              for (const [k, v] of Object.entries(sessData)) {
                if (v && typeof v === 'object' && v.sessionId && k.includes('cron')) {
                  const jf = path.join(sessDir, v.sessionId + '.jsonl');
                  if (fs.existsSync(jf)) {
                    const lines = fs.readFileSync(jf, 'utf8').split('\n');
                    for (const line of lines) {
                      if (!line.trim()) continue;
                      try {
                        const d = JSON.parse(line);
                        if (d.type === 'message' && d.message && d.message.role === 'assistant' && d.message.usage) {
                          const u = d.message.usage;
                          totalTokens += u.totalTokens || 0;
                          const costObj = u.cost || {};
                          totalCost += costObj.total || estimateCost(d.message.model || '', u.input || 0, u.output || 0, u.cacheRead || 0);
                        }
                      } catch {}
                    }
                  }
                }
              }
            } catch {}
          }

          const sched = job.schedule || {};
          const payload = job.payload || {};
          const state = job.state || {};
          const schedExpr = sched.expr || '';
          const schedTz = sched.tz || '';
          let scheduleStr = '';
          if (sched.kind === 'cron') scheduleStr = schedExpr + (schedTz ? ' (' + schedTz + ')' : '');
          else if (sched.kind === 'interval') scheduleStr = 'every ' + schedExpr;
          else if (sched.kind === 'once') scheduleStr = 'at ' + schedExpr;
          const nextRunMs = state.nextRunAtMs || 0;
          const lastRunMs = state.lastRunAtMs || 0;
          jobsWithRuns.push({
            id: job.id,
            name: job.name || '',
            description: job.description || '',
            cron: schedExpr,
            schedule: scheduleStr,
            enabled: job.enabled !== false,
            message: (payload.message || job.description || '').substring(0, 120),
            channel: (job.delivery || {}).channel || '',
            model: job.model || payload.model || '',
            createdAt: job.createdAtMs ? new Date(job.createdAtMs).toISOString() : '',
            lastRunAt: lastRunMs ? new Date(lastRunMs).toISOString() : '',
            nextRunAt: nextRunMs ? new Date(nextRunMs).toISOString() : '',
            runCount: runDetails.length,
            totalTokens,
            totalCost,
            runs: runDetails
          });
        }

        return { ok: true, jobs: jobsWithRuns, total: jobsWithRuns.length };
      });
      sendJson(req, res, result, 15);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/token-usage') {
    try {
      const bot = getBot(url);
      const days = parseInt(url.searchParams.get('days') || '30');
      const result = getCached('token-usage:' + bot.id + ':' + days, 300000, () => {
        // 1) Daily summary from openclaw CLI or pre-generated file
        let dailySummary = [];
        let totals = {};
        if (bot.useCli) {
          try {
            const out = execSync(
              `${bot.openclawBin} gateway usage-cost --days ${days} --json --token ${bot.openclawToken} 2>/dev/null`,
              { timeout: 20000, encoding: 'utf8' }
            );
            const parsed = JSON.parse(out);
            dailySummary = parsed.daily || [];
            totals = parsed.totals || {};
          } catch (e) { console.error('usage-cost error:', e.message); }
        } else if (bot.usageCostFile) {
          try {
            const parsed = JSON.parse(fs.readFileSync(bot.usageCostFile, 'utf8'));
            dailySummary = parsed.daily || [];
            totals = parsed.totals || {};
          } catch {}
        }

        // 2) Per-interaction detail from session JSONL files
        const sessDir = bot.sessionsDir;
        const sessFile = path.join(sessDir, 'sessions.json');
        const interactions = [];

        try {
          const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
          const sidMap = {};
          for (const [k, v] of Object.entries(sessData)) {
            if (v && typeof v === 'object' && v.sessionId) {
              const origin = v.origin || {};
              let lbl = origin.label || k.split(':').pop().substring(0, 12);
              if (v.chatType === 'group') {
                const gid = k.split(':').pop();
                try {
                  const gNames = botState[bot.id].groupNames;
                  if (gNames[gid]) lbl = gNames[gid] + ' (群)';
                } catch {}
              }
              sidMap[v.sessionId] = {
                label: lbl,
                chatType: v.chatType || '?',
                key: k
              };
            }
          }

          // Also load user-names for fallback lookup
          let savedNames = botState[bot.id].userNames;

          const jsonlFiles = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
          for (const jf of jsonlFiles) {
            const sid = jf.replace('.jsonl', '');
            let info = sidMap[sid];
            if (!info) {
              info = { label: '?', chatType: 'direct', key: '?' };
            }
            // For cron/isolated sessions, mark them
            if (info.label === '?' && (sid.includes('isolated') || info.chatType === '?')) {
              info.label = '[定时任务]';
            }
            const lines = fs.readFileSync(path.join(sessDir, jf), 'utf8').split('\n');
            let lastUserMsg = '';
            const sessionStartIdx = interactions.length;

            for (const line of lines) {
              if (!line.trim()) continue;
              let d;
              try { d = JSON.parse(line); } catch { continue; }
              if (!d || d.type !== 'message' || typeof d.message !== 'object') continue;
              const msg = d.message;
              const role = msg.role || '';

              if (role === 'user') {
                const content = msg.content;
                let rawText = '';
                if (Array.isArray(content)) {
                  const texts = content.filter(c => c && c.type === 'text').map(c => c.text || '');
                  rawText = texts.join(' ');
                } else if (typeof content === 'string') {
                  rawText = content;
                }
                // For orphan sessions, try to extract sender from any user message
                if (info.label === '?') {
                  const senderMatch = rawText.match(/"sender":\s*"([^"]+)"/);
                  const senderIdMatch = rawText.match(/"sender_id":\s*"([^"]+)"/);
                  if (senderMatch && !senderMatch[1].startsWith('ou_')) {
                    info.label = senderMatch[1];
                  } else if (senderIdMatch) {
                    const uid = senderIdMatch[1];
                    info.label = savedNames[uid] || uid.substring(0, 12);
                  }
                }
                // Extract real message: skip all metadata blocks
                let cleanMsg = rawText;
                // All metadata is inside ```json...``` code blocks; skip past the last one
                const lastCB = cleanMsg.lastIndexOf('```');
                if (lastCB >= 0) cleanMsg = cleanMsg.substring(lastCB + 3).trim();
                // Remove [message_id: ...]
                cleanMsg = cleanMsg.replace(/\[message_id:[^\]]*\]\s*/, '');
                // Remove sender prefix ("Name: " where name may contain spaces)
                const senderPrefixMatch = cleanMsg.match(/^(.+?):\s+/);
                if (senderPrefixMatch && senderPrefixMatch[1].length < 40) {
                  cleanMsg = cleanMsg.substring(senderPrefixMatch[0].length);
                }
                // Remove [Replying to: "..."] block (may span multiple lines)
                if (cleanMsg.startsWith('[Replying to:')) {
                  const closeIdx = cleanMsg.indexOf('"]');
                  if (closeIdx > 0) {
                    const afterQuote = cleanMsg.substring(closeIdx + 2).trim();
                    cleanMsg = afterQuote || cleanMsg.substring(14, closeIdx).trim();
                  } else {
                    cleanMsg = cleanMsg.replace(/^\[Replying to:\s*"?/, '').trim();
                  }
                }
                // Handle cron messages: [cron:ID NAME] actual message
                const cronMatch = cleanMsg.match(/^\[cron:[a-f0-9\-]+\s+([^\]]+)\]\s*([\s\S]*)/);
                if (cronMatch) {
                  info.label = '[定时] ' + cronMatch[1];
                  cleanMsg = cronMatch[2].split('\n')[0].trim();
                }
                // Remove "Current time: ..." lines
                cleanMsg = cleanMsg.replace(/^Current time:.*\n?/gm, '').trim();
                // Get first meaningful line
                const msgLines = cleanMsg.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                cleanMsg = msgLines[0] || '';
                // Handle media
                const mediaMatch = cleanMsg.match(/^\[media attached: (.+)\]/);
                if (mediaMatch) {
                  lastUserMsg = '[文件] ' + mediaMatch[1].split('/').pop().substring(0, 80);
                } else {
                  lastUserMsg = cleanMsg.substring(0, 120) || rawText.substring(0, 80);
                }
                // If userMsg looks like raw file_key JSON (voice/file), try voice cache
                if (lastUserMsg.startsWith('{"file_key"') || lastUserMsg === '[语音]') {
                  try {
                    const fkObj = lastUserMsg.startsWith('{') ? JSON.parse(lastUserMsg.length < 200 ? lastUserMsg : rawText.match(/\{"file_key"[^}]+\}/)?.[0] || '{}') : {};
                    if (fkObj.file_key && fkObj.duration) {
                      lastUserMsg = '[语音]';
                    }
                  } catch {}
                  // Try to find voice transcript via message_id from metadata
                  const midMatch = rawText.match(/"message_id":\s*"([^"]+)"/);
                  const _vtBot = botState[bot.id].voiceTranscripts;
                  if (midMatch && _vtBot[midMatch[1]] && _vtBot[midMatch[1]] !== '[语音识别失败]') {
                    lastUserMsg = '[语音] ' + _vtBot[midMatch[1]];
                  }
                }
              } else if (role === 'assistant' && msg.usage && typeof msg.usage === 'object') {
                const usage = msg.usage;
                let ts = msg.timestamp || d.timestamp || '';
                if (typeof ts === 'number') {
                  ts = new Date(ts).toISOString();
                }
                const costObj = usage.cost || {};
                interactions.push({
                  user: info.label,
                  chatType: info.chatType,
                  userMsg: lastUserMsg || '(unknown)',
                  time: ts,
                  date: typeof ts === 'string' ? ts.substring(0, 10) : '',
                  model: msg.model || '',
                  input: usage.input || 0,
                  output: usage.output || 0,
                  cacheRead: usage.cacheRead || 0,
                  cacheWrite: usage.cacheWrite || 0,
                  totalTokens: usage.totalTokens || 0,
                  cost: (costObj.total || 0) > 0 ? costObj.total : estimateCost(msg.model || '', usage.input || 0, usage.output || 0, usage.cacheRead || 0)
                });
              }
            }
            // Backfill user label for early interactions in this session
            if (info.label !== '?') {
              for (let bi = sessionStartIdx; bi < interactions.length; bi++) {
                if (interactions[bi].user === '?') interactions[bi].user = info.label;
              }
            }
          }

          interactions.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

          // Merge multi-turn interactions for the same user request (within 120s)
          const merged = [];
          for (const ix of interactions) {
            const prev = merged.length > 0 ? merged[merged.length - 1] : null;
            if (prev && prev.user === ix.user && prev.userMsg === ix.userMsg
                && prev.userMsg !== '(unknown)'
                && ix.time && prev._lastTime) {
              const gap = Math.abs(new Date(ix.time).getTime() - new Date(prev._lastTime).getTime());
              if (gap < 120000) {
                prev.input += ix.input || 0;
                prev.output += ix.output || 0;
                prev.cacheRead += ix.cacheRead || 0;
                prev.cacheWrite += ix.cacheWrite || 0;
                prev.totalTokens += ix.totalTokens || 0;
                prev.cost += ix.cost || 0;
                prev._lastTime = ix.time;
                prev.time = ix.time;
                prev.date = ix.date;
                prev._turns = (prev._turns || 1) + 1;
                continue;
              }
            }
            merged.push({ ...ix, _lastTime: ix.time, _turns: 1 });
          }
          for (const m of merged) { delete m._lastTime; }
          interactions.length = 0;
          interactions.push(...merged);

          interactions.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
        } catch (e) { console.error('session parse error:', e.message); }

        // Recalculate total cost from interactions if CLI totals are incomplete
        const calcTotalCost = interactions.reduce((s, i) => s + (i.cost || 0), 0);
        if (calcTotalCost > 0 && (!totals.totalCost || calcTotalCost > totals.totalCost)) {
          totals.calculatedCost = calcTotalCost;
        }

        // Group repeated tasks by message similarity
        const taskMap = new Map();
        for (const ix of interactions) {
          const key = (ix.userMsg || '').substring(0, 60).trim();
          if (!key) continue;
          if (!taskMap.has(key)) {
            taskMap.set(key, {
              msg: ix.userMsg || '',
              user: ix.user,
              model: ix.model,
              count: 0,
              totalTokens: 0,
              totalInput: 0,
              totalOutput: 0,
              totalCost: 0,
              runs: []
            });
          }
          const g = taskMap.get(key);
          g.count++;
          g.totalTokens += ix.totalTokens || 0;
          g.totalInput += ix.input || 0;
          g.totalOutput += ix.output || 0;
          g.totalCost += ix.cost || 0;
          if (ix.model && ix.model !== g.model) g.model = g.model + '/' + ix.model;
          g.runs.push({
            date: ix.date,
            time: ix.time,
            input: ix.input || 0,
            output: ix.output || 0,
            totalTokens: ix.totalTokens || 0,
            cost: ix.cost || 0
          });
        }

        const taskGroups = [...taskMap.values()]
          .filter(g => g.count >= 2)
          .sort((a, b) => b.totalTokens - a.totalTokens);

        // Add pricing info to response
        return { ok: true, daily: dailySummary, totals, interactions, taskGroups, pricing: TOKEN_PRICING };
      });
      sendJson(req, res, result, 30);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// --- WebSocket ---
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  if (token !== ACCESS_TOKEN) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  ws.botId = url.searchParams.get('bot') || DEFAULT_BOT;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const cachedLogs = botState[ws.botId] ? botState[ws.botId].recentLogs : [];
  for (const cached of cachedLogs) {
    try { ws.send(cached); } catch {}
  }
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// --- Tail logs (per-bot) ---
function getLatestLogFile(logDir) {
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('openclaw-') && f.endsWith('.log'))
      .sort();
    if (files.length > 0) return path.join(logDir, files[files.length - 1]);
  } catch {}
  return null;
}

function startTail(botId) {
  const bid = botId || DEFAULT_BOT;
  const cfg = BOTS[bid];
  const st = botState[bid];
  if (!cfg || !st) return;
  const LOG_DIR = cfg.logDir;
  let logFile = getLogFile(LOG_DIR);
  if (!fs.existsSync(logFile)) {
    logFile = getLatestLogFile(LOG_DIR);
    if (!logFile) { setTimeout(() => startTail(bid), 5000); return; }
  }
  if (st.tailProc && st.currentLogFile === logFile) return;
  if (st.tailProc) { st.tailProc.kill(); st.tailProc = null; }
  st.currentLogFile = logFile;
  st.tailProc = spawn('tail', ['-n', '50', '-f', logFile]);
  let buf = '';
  st.tailProc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseLogLine(line.trim());
      if (bid === DEFAULT_BOT) recordEvent(parsed);
      const msg = JSON.stringify({ type: 'log', data: parsed });
      st.recentLogs.push(msg);
      while (st.recentLogs.length > MAX_RECENT_LOGS) st.recentLogs.shift();
      wss.clients.forEach(client => {
        if (client.readyState === 1 && client.botId === bid) {
          try { client.send(msg); } catch {}
        }
      });
    }
  });
  st.tailProc.on('exit', () => { st.tailProc = null; setTimeout(() => startTail(bid), 3000); });
}

setInterval(() => {
  for (const [bid, cfg] of Object.entries(BOTS)) {
    const st = botState[bid];
    const newFile = getLogFile(cfg.logDir);
    if (newFile !== st.currentLogFile) startTail(bid);
  }
}, 60000);

// Backfill all bots
for (const bid of Object.keys(BOTS)) {
  backfillFromLogs(bid);
}

// Pre-warm slow caches on startup so first request is instant
setImmediate(() => {
  try {
    console.log('Pre-warming token-usage cache for ' + DEFAULT_BOT + '...');
    const url = new URL('http://localhost:' + PORT + '/api/token-usage?token=' + ACCESS_TOKEN + '&days=30');
    const http = require('http');
    http.get(url.toString(), (res) => {
      res.resume();
      res.on('end', () => console.log('Token-usage cache warmed'));
    }).on('error', () => {});
  } catch {}
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Diana Monitor listening on 0.0.0.0:${PORT} (bots: ${Object.keys(BOTS).join(', ')})`);
  console.log(`History: ${botState[DEFAULT_BOT].history.events.length} events, Names: ${Object.keys(userNames).length}, ChatIds: ${Object.keys(userChatIds).length}, Groups: ${Object.keys(groupNames).length}`);
  for (const bid of Object.keys(BOTS)) startTail(bid);
});
