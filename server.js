const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const { listSkills, packageSkill } = require('./lib/skills');
const { sendJson, getCached, sendStaticFile, getRequestToken } = require('./lib/http-utils');
const { getLogFile, parseLogLine, getLatestLogFile, parseSessionEvent } = require('./lib/parsers');
const { estimateCost } = require('./lib/cost-utils');
const { handleHeavyApi } = require('./lib/api-heavy');
const { handleBasicApi } = require('./lib/api-basic');
const { createWatchers } = require('./lib/watchers');
const { setupWebSocket } = require('./lib/ws');
const { createFeishuService } = require('./lib/feishu-service');
const {
  PORT,
  ACCESS_TOKEN,
  MAX_HISTORY,
  MAX_RECENT_LOGS,
  BOTS,
  DEFAULT_BOT,
  TOKEN_PRICING,
  SKILLS_DIR,
  WORKSPACE_SKILLS_DIR,
} = require('./lib/config');

function getBot(url) {
  const botId = (url.searchParams ? url.searchParams.get('bot') : null) || DEFAULT_BOT;
  if (!BOTS[botId]) return null;
  return { id: botId, ...BOTS[botId] };
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
    sessionWatcher: null,
    currentSessionFile: '',
    sessionFileOffset: 0,
    sessionLineBuffer: '',
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
  const dates = [];
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('openclaw-') && f.endsWith('.log')).sort();
    for (const f of files) {
      const m = f.match(/openclaw-(\d{4}-\d{2}-\d{2})\.log/);
      if (m) dates.push(m[1]);
    }
  } catch {}
  if (dates.length === 0) return;
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
        } else if (parsed.type === 'task_end') {
          if (parsed.message.includes('isError=true')) {
            const errMatch = parsed.message.match(/error=(.+)/);
            const err = errMatch ? errMatch[1] : 'unknown';
            let status = 'failed';
            if (err.includes('rate limit')) status = 'rate_limit';
            else if (err.includes('Context overflow')) status = 'overflow';
            addEvent({ kind: 'diana_status', status, error: err.substring(0, 200), time: parsed.time }, bid);
          }
        } else if (parsed.type === 'message_done') {
          const m2 = parsed.message.match(/replies=(\d+)/);
          const replies = m2 ? parseInt(m2[1]) : 0;
          addEvent({ kind: 'diana_status', status: replies > 0 ? 'replied' : 'no_reply', replies, time: parsed.time }, bid);
        }
      }
    } catch (e) { console.error('backfill error for', date, e.message); }
  }
  saveChatIds(bid);
  saveHistory(bid);
  console.log('[' + bid + '] Backfill complete: scanned ' + dates.length + ' log files, recovered ' + backfilled + ' message events');
}

async function refreshChatPreviews(botId) {
  const bid = botId || DEFAULT_BOT;
  const chatIds = botState[bid].userChatIds;
  const entries = Object.entries(chatIds);
  if (entries.length === 0) return;
  console.log('[' + bid + '] Refreshing chat previews via Feishu API for ' + entries.length + ' chats...');
  let updated = 0;
  for (const [userId, chatId] of entries) {
    try {
      const result = await fetchChatMessages(chatId, 10, null, bid);
      if (!result || !result.ok) continue;
      const msgs = result.messages || [];
      if (msgs.length === 0) continue;
      const existingEvents = botState[bid].history.events;
      const userEvents = existingEvents.filter(e => e.userId === userId && e.kind === 'user_msg');
      const lastUserEvent = userEvents.length > 0 ? userEvents[userEvents.length - 1] : null;
      const lastEventTime = lastUserEvent ? new Date(lastUserEvent.time).getTime() : 0;
      const latestUserMsg = [...msgs].reverse().find(m => m.role === 'user');
      const latestBotMsg = [...msgs].reverse().find(m => m.role === 'diana');
      if (latestUserMsg && latestUserMsg.time && new Date(latestUserMsg.time).getTime() > lastEventTime) {
        const userNames_bid = botState[bid].userNames;
        const sName = latestUserMsg.senderName || userNames_bid[userId] || userId.substring(0, 12);
        addEvent({ kind: 'user_msg', userId, userName: sName, text: latestUserMsg.text || '', time: latestUserMsg.time }, bid);
        if (sName && !sName.startsWith('ou_')) userNames_bid[userId] = sName;
        updated++;
      }
      if (latestBotMsg && latestBotMsg.time) {
        const botTime = new Date(latestBotMsg.time).getTime();
        const lastStatusEvents = existingEvents.filter(e => e.userId === userId && e.kind === 'diana_status');
        const lastStatusTime = lastStatusEvents.length > 0 ? new Date(lastStatusEvents[lastStatusEvents.length - 1].time).getTime() : 0;
        if (botTime > lastStatusTime) {
          addEvent({ kind: 'diana_status', status: 'replied', time: latestBotMsg.time, userId }, bid);
          updated++;
        }
      }
    } catch (e) {
      console.error('[' + bid + '] refreshChatPreviews error for ' + userId + ':', e.message);
    }
  }
  if (updated > 0) {
    saveHistory(bid);
    saveNames(bid);
  }
  console.log('[' + bid + '] Chat preview refresh done: updated ' + updated + '/' + entries.length);
}




const { getTenantToken, recognizeAudio, resolveUserName, resolveGroupName, fetchChatMessages } = createFeishuService({
  BOTS,
  DEFAULT_BOT,
  botState,
  saveVoiceTranscripts,
  saveNames,
  saveGroupNames,
});

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
  } else if (parsed.type === 'error' && !parsed.message.includes('permission scope') && !parsed.message.startsWith('{')) {
    addEvent({ kind: 'error', text: parsed.message.substring(0, 200), time: parsed.time }, DEFAULT_BOT);
  }
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
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

  if (url.pathname.startsWith('/assets/')) {
    const rel = url.pathname.slice('/assets/'.length);
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bad Request');
    }
    const staticPath = path.join(__dirname, 'assets', rel);
    return sendStaticFile(res, staticPath);
  }

  const token = getRequestToken(req, url);
  if (token !== ACCESS_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('Unauthorized');
  }

  const requestedBotId = url.searchParams.get('bot');
  if (requestedBotId && !BOTS[requestedBotId]) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: 'invalid bot id' }));
  }

  if (await handleBasicApi(req, res, url, {
    BOTS,
    getBot,
    botState,
    sendJson,
    getCached,
    parseLogLine,
    fetchChatMessages,
  })) {
    return;
  }

  if (await handleHeavyApi(req, res, url, {
    getBot,
    getCached,
    sendJson,
    listSkills,
    packageSkill,
    execSync,
    WORKSPACE_SKILLS_DIR,
    SKILLS_DIR,
    estimateCost,
    botState,
    TOKEN_PRICING,
  })) {
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
  } catch (e) {
    console.error('Unhandled HTTP handler error:', e && e.stack ? e.stack : e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'internal server error' }));
    } else {
      try { res.end(); } catch {}
    }
  }
});

// --- WebSocket ---
const wss = setupWebSocket(server, {
  PORT,
  ACCESS_TOKEN,
  DEFAULT_BOT,
  BOTS,
  botState,
  getRequestToken,
});

// --- Tail logs (per-bot) ---
const { startSessionWatcher, startTail, startLogFileRolloverWatcher } = createWatchers({
  BOTS,
  DEFAULT_BOT,
  MAX_RECENT_LOGS,
  botState,
  wss,
  parseLogLine,
  parseSessionEvent,
  getLogFile,
  getLatestLogFile,
  recordEvent,
});

startLogFileRolloverWatcher();

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
  for (const bid of Object.keys(BOTS)) { startTail(bid); startSessionWatcher(bid); }
  setImmediate(async () => {
    for (const bid of Object.keys(BOTS)) {
      try { await refreshChatPreviews(bid); } catch (e) { console.error('refreshChatPreviews error:', e.message); }
    }
  });
});
