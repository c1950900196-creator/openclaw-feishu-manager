const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createWatchers(ctx) {
  const {
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
  } = ctx;

  function startSessionWatcher(botId) {
    const bid = botId || DEFAULT_BOT;
    const cfg = BOTS[bid];
    const st = botState[bid];
    if (!cfg || !st) return;
    const sessDir = cfg.sessionsDir;

    if (st.sessionWatcher) {
      st.sessionWatcher.close();
      st.sessionWatcher = null;
    }

    function findLatestSession() {
      try {
        const files = fs.readdirSync(sessDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        return files.length > 0 ? files[0].name : null;
      } catch {
        return null;
      }
    }

    function readNewLines() {
      if (!st.currentSessionFile) return;
      const fullPath = path.join(sessDir, st.currentSessionFile);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size < st.sessionFileOffset) {
          st.sessionFileOffset = 0;
          st.sessionLineBuffer = '';
        }
        if (stat.size <= st.sessionFileOffset) return;
        console.log('[session-watcher] ' + bid + ': +' + (stat.size - st.sessionFileOffset) + ' bytes');
        const fd = fs.openSync(fullPath, 'r');
        const newBytes = stat.size - st.sessionFileOffset;
        const buf = Buffer.alloc(Math.min(newBytes, 1024 * 1024));
        fs.readSync(fd, buf, 0, buf.length, st.sessionFileOffset);
        fs.closeSync(fd);
        st.sessionFileOffset = st.sessionFileOffset + buf.length;
        const text = st.sessionLineBuffer + buf.toString('utf8');
        const lines = text.split('\n');
        st.sessionLineBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = parseSessionEvent(line.trim());
          if (!parsed) continue;
          const wsMsg = JSON.stringify({ type: 'log', data: parsed });
          st.recentLogs.push(wsMsg);
          while (st.recentLogs.length > MAX_RECENT_LOGS) st.recentLogs.shift();
          wss.clients.forEach((client) => {
            if (client.readyState === 1 && client.botId === bid) {
              try { client.send(wsMsg); } catch {}
            }
          });
        }
      } catch (e) {
        console.error('[session-watcher] readNewLines error:', e.message);
      }
    }

    function switchToFile(filename) {
      if (!filename || filename === st.currentSessionFile) return;
      st.currentSessionFile = filename;
      const fullPath = path.join(sessDir, filename);
      try {
        st.sessionFileOffset = fs.statSync(fullPath).size;
        st.sessionLineBuffer = '';
      } catch {
        st.sessionFileOffset = 0;
      }
      console.log(`[session-watcher] ${bid}: watching ${filename}`);
    }

    const latest = findLatestSession();
    if (latest) switchToFile(latest);

    try {
      st.sessionWatcher = fs.watch(sessDir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const current = findLatestSession();
        if (current && current !== st.currentSessionFile) switchToFile(current);
        readNewLines();
      });
    } catch (e) {
      console.error('[session-watcher] watch failed for', bid, e.message);
      setInterval(() => {
        const current = findLatestSession();
        if (current && current !== st.currentSessionFile) switchToFile(current);
        readNewLines();
      }, 2000);
    }

    setInterval(() => readNewLines(), 1500);
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
      if (!logFile) {
        setTimeout(() => startTail(bid), 5000);
        return;
      }
    }
    if (st.tailProc && st.currentLogFile === logFile) return;
    if (st.tailProc) {
      st.tailProc.removeAllListeners('exit');
      st.tailProc.stdout.removeAllListeners('data');
      st.tailProc.kill();
      st.tailProc = null;
    }
    st.currentLogFile = logFile;
    st.tailProc = spawn('tail', ['-n', '50', '-f', logFile]);
    const currentProc = st.tailProc;
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
        wss.clients.forEach((client) => {
          if (client.readyState === 1 && client.botId === bid) {
            try { client.send(msg); } catch {}
          }
        });
      }
    });
    st.tailProc.on('exit', () => {
      if (st.tailProc === currentProc) {
        st.tailProc = null;
        setTimeout(() => startTail(bid), 3000);
      }
    });
  }

  function startLogFileRolloverWatcher() {
    setInterval(() => {
      for (const [bid, cfg] of Object.entries(BOTS)) {
        const st = botState[bid];
        const newFile = getLogFile(cfg.logDir);
        if (newFile !== st.currentLogFile) startTail(bid);
      }
    }, 60000);
  }

  return { startSessionWatcher, startTail, startLogFileRolloverWatcher };
}

module.exports = { createWatchers };
