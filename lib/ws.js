const { WebSocketServer } = require('ws');

function setupWebSocket(server, ctx) {
  const { PORT, ACCESS_TOKEN, DEFAULT_BOT, BOTS, botState, getRequestToken } = ctx;
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = getRequestToken(req, url);
    if (token !== ACCESS_TOKEN) {
      ws.close(1008, 'Unauthorized');
      return;
    }
    const botId = url.searchParams.get('bot') || DEFAULT_BOT;
    if (!BOTS[botId]) {
      ws.close(1008, 'Invalid bot');
      return;
    }
    ws.botId = botId;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const cachedLogs = botState[ws.botId] ? botState[ws.botId].recentLogs : [];
    for (const cached of cachedLogs) {
      try { ws.send(cached); } catch {}
    }
  });

  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  return wss;
}

module.exports = { setupWebSocket };
