const fs = require('fs');
const path = require('path');

async function handleBasicApi(req, res, url, ctx) {
  const { BOTS, getBot, botState, sendJson, getCached, parseLogLine, fetchChatMessages } = ctx;

  if (url.pathname === '/api/bots') {
    const botList = Object.entries(BOTS).map(([id, cfg]) => ({ id, name: cfg.name }));
    sendJson(req, res, { ok: true, bots: botList }, 60);
    return true;
  }

  if (url.pathname === '/api/history') {
    const bot = getBot(url);
    sendJson(req, res, botState[bot.id].history, 0);
    return true;
  }

  if (url.pathname === '/api/names') {
    const bot = getBot(url);
    sendJson(req, res, botState[bot.id].userNames, 60);
    return true;
  }

  if (url.pathname === '/api/chats') {
    const bot = getBot(url);
    sendJson(req, res, botState[bot.id].userChatIds, 30);
    return true;
  }

  if (url.pathname === '/api/group-names') {
    const bot = getBot(url);
    sendJson(req, res, botState[bot.id].groupNames, 60);
    return true;
  }

  if (url.pathname === '/api/chat-messages') {
    const bot = getBot(url);
    const userId = url.searchParams.get('userId');
    const directChatId = url.searchParams.get('chatId');
    if (!userId && !directChatId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing userId or chatId' }));
      return true;
    }
    const chatId = directChatId || botState[bot.id].userChatIds[userId];
    if (!chatId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no chatId found for user' }));
      return true;
    }
    try {
      const result = await fetchChatMessages(chatId, parseInt(url.searchParams.get('limit') || '50', 10), url.searchParams.get('page_token') || null, bot.id);
      sendJson(req, res, result, 0);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  if (url.pathname === '/api/logs') {
    const bot = getBot(url);
    const LOG_DIR = bot.logDir;
    const dateParam = url.searchParams.get('date');
    const lines = Math.min(parseInt(url.searchParams.get('lines') || '2000', 10), 10000);
    let targetDate;
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) targetDate = dateParam;
    else {
      const d = new Date();
      targetDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const logPath = path.join(LOG_DIR, `openclaw-${targetDate}.log`);
    if (!fs.existsSync(logPath)) {
      sendJson(req, res, { ok: true, date: targetDate, logs: [], total: 0 }, 0);
      return true;
    }
    const todayDate = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const isToday = targetDate === todayDate;
    const cacheKey = `logs:${bot.id}:${targetDate}:${lines}`;
    const cacheTtl = isToday ? 10000 : 300000;
    try {
      const result = getCached(cacheKey, cacheTtl, () => {
        const content = fs.readFileSync(logPath, 'utf8');
        const allLines = content.split('\n').filter((l) => l.trim());
        const slice = allLines.slice(-lines);
        const parsed = slice.map((l) => parseLogLine(l.trim()));
        return { ok: true, date: targetDate, logs: parsed, total: allLines.length, showing: parsed.length };
      });
      sendJson(req, res, result, isToday ? 0 : 300);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  if (url.pathname === '/api/log-dates') {
    const bot = getBot(url);
    const LOG_DIR = bot.logDir;
    try {
      const files = fs.readdirSync(LOG_DIR).filter((f) => f.startsWith('openclaw-') && f.endsWith('.log')).sort();
      const dates = files
        .map((f) => {
          const m = f.match(/openclaw-(\d{4}-\d{2}-\d{2})\.log/);
          const stat = fs.statSync(path.join(LOG_DIR, f));
          return m ? { date: m[1], size: stat.size } : null;
        })
        .filter(Boolean);
      sendJson(req, res, { ok: true, dates }, 60);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  return false;
}

module.exports = { handleBasicApi };
