const path = require('path');
const fs = require('fs');

async function handleHeavyApi(req, res, url, ctx) {
  const {
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
  } = ctx;

  if (url.pathname === '/api/stop-all' && req.method === 'POST') {
    try {
      const bot = getBot(url);
      if (!bot.useCli) {
        sendJson(req, res, { ok: false, error: 'stop-all not available for remote bots' });
        return true;
      }
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
            { timeout: 10000, encoding: 'utf8' },
          );
          let parsed;
          try { parsed = JSON.parse(out); } catch { parsed = out.trim(); }
          results.push({ key, ok: true, result: parsed });
        } catch (e) {
          results.push({ key, ok: false, error: e.message.substring(0, 100) });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, sessionsFound: sessions.length, results }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  if (url.pathname === '/api/skills') {
    const skills = getCached('skills', 120000, listSkills);
    sendJson(req, res, { ok: true, skills }, 120);
    return true;
  }

  if (url.pathname.startsWith('/api/skills/') && url.pathname.endsWith('/download')) {
    const parts = url.pathname.split('/');
    const skillId = decodeURIComponent(parts[3]);
    const filePath = packageSkill(skillId);
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'skill not found' }));
      return true;
    }
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${skillId}.skill"`,
      'Content-Length': data.length,
    });
    res.end(data);
    return true;
  }

  if (url.pathname.startsWith('/api/skills/') && url.pathname.endsWith('/readme')) {
    const parts = url.pathname.split('/');
    const skillId = decodeURIComponent(parts[3]);
    let skillBase = WORKSPACE_SKILLS_DIR;
    if (!fs.existsSync(path.join(skillBase, skillId, 'SKILL.md'))) skillBase = SKILLS_DIR;
    const readmePath = path.join(skillBase, skillId, 'SKILL.md');
    if (!fs.existsSync(readmePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return true;
    }
    const readmeContent = fs.readFileSync(readmePath, 'utf8');
    const allSkills = listSkills();
    const thisSkill = allSkills.find((s) => s.id === skillId);
    const filesInfo = thisSkill ? thisSkill.files : [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, content: readmeContent, files: filesInfo }));
    return true;
  }

  if (url.pathname === '/api/cron-toggle' && req.method === 'POST') {
    try {
      const bot = getBot(url);
      if (!bot.useCli) {
        sendJson(req, res, { ok: false, error: 'cron toggle not available for remote bots' });
        return true;
      }
      const jobId = (url.searchParams.get('jobId') || '').trim();
      const enabledRaw = (url.searchParams.get('enabled') || '').trim();
      const enabled = enabledRaw === '1' || enabledRaw === 'true';
      if (!jobId) {
        sendJson(req, res, { ok: false, error: 'missing jobId' });
        return true;
      }
      const cmd = enabled
        ? `${bot.openclawBin} cron enable ${jobId} --token ${bot.openclawToken} --timeout 30000 2>/dev/null`
        : `${bot.openclawBin} cron disable ${jobId} --token ${bot.openclawToken} --timeout 30000 2>/dev/null`;
      const out = execSync(cmd, { timeout: 35000, encoding: 'utf8' });
      sendJson(req, res, { ok: true, jobId, enabled, output: (out || '').trim().substring(0, 400) });
    } catch (e) {
      sendJson(req, res, { ok: false, error: e.message });
    }
    return true;
  }

  if (url.pathname === '/api/cron-usage') {
    try {
      const bot = getBot(url);
      const result = getCached('cron-usage:' + bot.id, 3000, () => {
        let jobs = [];
        if (bot.useCli) {
          try {
            const out = execSync(
              `${bot.openclawBin} cron list --all --json --token ${bot.openclawToken} 2>/dev/null`,
              { timeout: 15000, encoding: 'utf8' },
            );
            const parsed = JSON.parse(out);
            jobs = parsed.jobs || [];
          } catch (e) {
            console.error('cron list error:', e.message);
          }
        } else if (bot.cronListFile) {
          try { jobs = JSON.parse(fs.readFileSync(bot.cronListFile, 'utf8')).jobs || []; } catch {}
        }

        const jobsWithRuns = [];
        for (const job of jobs) {
          let runs = [];
          try {
            const out = execSync(
              `${bot.openclawBin} cron runs --id ${job.id} --limit 100 --token ${bot.openclawToken} 2>/dev/null`,
              { timeout: 15000, encoding: 'utf8' },
            );
            const parsed = JSON.parse(out);
            runs = parsed.runs || parsed.entries || parsed || [];
            if (!Array.isArray(runs)) runs = [];
          } catch {}

          let totalTokens = 0;
          let totalCost = 0;
          const runDetails = [];
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
              cost,
              durationMs: run.durationMs || run.duration || 0,
              model: run.model || '',
              error: run.error || '',
            });
          }

          if (totalTokens === 0 && job.sessionKey) {
            const sessDir = bot.sessionsDir;
            const sessFile = path.join(sessDir, 'sessions.json');
            try {
              const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
              for (const [k, v] of Object.entries(sessData)) {
                if (v && typeof v === 'object' && v.sessionId && k.includes('cron')) {
                  const jf = path.join(sessDir, v.sessionId + '.jsonl');
                  if (!fs.existsSync(jf)) continue;
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
            runs: runDetails,
          });
        }
        return { ok: true, jobs: jobsWithRuns, total: jobsWithRuns.length };
      });
      sendJson(req, res, result, 15);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  if (url.pathname === '/api/token-usage') {
    try {
      const bot = getBot(url);
      const days = parseInt(url.searchParams.get('days') || '30');
      const result = getCached('token-usage:' + bot.id + ':' + days, 60000, () => {
        let dailySummary = [];
        let totals = {};
        if (bot.useCli) {
          try {
            const out = execSync(
              `${bot.openclawBin} gateway usage-cost --days ${days} --json --token ${bot.openclawToken} 2>/dev/null`,
              { timeout: 20000, encoding: 'utf8' },
            );
            const parsed = JSON.parse(out);
            dailySummary = parsed.daily || [];
            totals = parsed.totals || {};
          } catch (e) {
            console.error('usage-cost error:', e.message);
          }
        } else if (bot.usageCostFile) {
          try {
            const parsed = JSON.parse(fs.readFileSync(bot.usageCostFile, 'utf8'));
            dailySummary = parsed.daily || [];
            totals = parsed.totals || {};
          } catch {}
        }

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
              sidMap[v.sessionId] = { label: lbl, chatType: v.chatType || '?', key: k };
            }
          }

          const savedNames = botState[bot.id].userNames;
          const jsonlFiles = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
          for (const jf of jsonlFiles) {
            const sid = jf.replace('.jsonl', '');
            let info = sidMap[sid];
            if (!info) info = { label: '?', chatType: 'direct', key: '?' };
            if (info.label === '?' && (sid.includes('isolated') || info.chatType === '?')) info.label = '[定时任务]';
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
                if (Array.isArray(content)) rawText = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join(' ');
                else if (typeof content === 'string') rawText = content;
                if (info.label === '?') {
                  const senderMatch = rawText.match(/"sender":\s*"([^"]+)"/);
                  const senderIdMatch = rawText.match(/"sender_id":\s*"([^"]+)"/);
                  if (senderMatch && !senderMatch[1].startsWith('ou_')) info.label = senderMatch[1];
                  else if (senderIdMatch) {
                    const uid = senderIdMatch[1];
                    info.label = savedNames[uid] || uid.substring(0, 12);
                  }
                }
                let cleanMsg = rawText;
                const lastCB = cleanMsg.lastIndexOf('```');
                if (lastCB >= 0) cleanMsg = cleanMsg.substring(lastCB + 3).trim();
                cleanMsg = cleanMsg.replace(/\[message_id:[^\]]*\]\s*/, '');
                const senderPrefixMatch = cleanMsg.match(/^(.+?):\s+/);
                if (senderPrefixMatch && senderPrefixMatch[1].length < 40) cleanMsg = cleanMsg.substring(senderPrefixMatch[0].length);
                if (cleanMsg.startsWith('[Replying to:')) {
                  const closeIdx = cleanMsg.indexOf('"]');
                  if (closeIdx > 0) {
                    const afterQuote = cleanMsg.substring(closeIdx + 2).trim();
                    cleanMsg = afterQuote || cleanMsg.substring(14, closeIdx).trim();
                  } else cleanMsg = cleanMsg.replace(/^\[Replying to:\s*"?/, '').trim();
                }
                const cronMatch = cleanMsg.match(/^\[cron:[a-f0-9\-]+\s+([^\]]+)\]\s*([\s\S]*)/);
                if (cronMatch) {
                  info.label = '[定时] ' + cronMatch[1];
                  cleanMsg = cronMatch[2].split('\n')[0].trim();
                }
                cleanMsg = cleanMsg.replace(/^Current time:.*\n?/gm, '').trim();
                const msgLines = cleanMsg.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
                cleanMsg = msgLines[0] || '';
                const mediaMatch = cleanMsg.match(/^\[media attached: (.+)\]/);
                if (mediaMatch) lastUserMsg = '[文件] ' + mediaMatch[1].split('/').pop().substring(0, 80);
                else lastUserMsg = cleanMsg.substring(0, 120) || rawText.substring(0, 80);
                if (lastUserMsg.startsWith('{"file_key"') || lastUserMsg === '[语音]') {
                  try {
                    const fkObj = lastUserMsg.startsWith('{')
                      ? JSON.parse(lastUserMsg.length < 200 ? lastUserMsg : rawText.match(/\{"file_key"[^}]+\}/)?.[0] || '{}')
                      : {};
                    if (fkObj.file_key && fkObj.duration) lastUserMsg = '[语音]';
                  } catch {}
                  const midMatch = rawText.match(/"message_id":\s*"([^"]+)"/);
                  const vtBot = botState[bot.id].voiceTranscripts;
                  if (midMatch && vtBot[midMatch[1]] && vtBot[midMatch[1]] !== '[语音识别失败]') lastUserMsg = '[语音] ' + vtBot[midMatch[1]];
                }
              } else if (role === 'assistant' && msg.usage && typeof msg.usage === 'object') {
                const usage = msg.usage;
                let ts = msg.timestamp || d.timestamp || '';
                if (typeof ts === 'number') ts = new Date(ts).toISOString();
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
                  cost: (costObj.total || 0) > 0
                    ? costObj.total
                    : estimateCost(msg.model || '', usage.input || 0, usage.output || 0, usage.cacheRead || 0),
                });
              }
            }
            if (info.label !== '?') {
              for (let bi = sessionStartIdx; bi < interactions.length; bi++) {
                if (interactions[bi].user === '?') interactions[bi].user = info.label;
              }
            }
          }

          interactions.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
          const merged = [];
          for (const ix of interactions) {
            const prev = merged.length > 0 ? merged[merged.length - 1] : null;
            if (
              prev &&
              prev.user === ix.user &&
              prev.userMsg === ix.userMsg &&
              prev.userMsg !== '(unknown)' &&
              ix.time &&
              prev._lastTime
            ) {
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
          for (const m of merged) delete m._lastTime;
          interactions.length = 0;
          interactions.push(...merged);
          interactions.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
        } catch (e) {
          console.error('session parse error:', e.message);
        }

        const calcTotalCost = interactions.reduce((s, i) => s + (i.cost || 0), 0);
        if (calcTotalCost > 0 && (!totals.totalCost || calcTotalCost > totals.totalCost)) totals.calculatedCost = calcTotalCost;

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
              runs: [],
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
            cost: ix.cost || 0,
          });
        }

        const taskGroups = [...taskMap.values()].filter((g) => g.count >= 2).sort((a, b) => b.totalTokens - a.totalTokens);
        return { ok: true, daily: dailySummary, totals, interactions, taskGroups, pricing: TOKEN_PRICING };
      });
      sendJson(req, res, result, 30);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  return false;
}

module.exports = { handleHeavyApi };
