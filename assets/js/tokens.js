// --- Token Usage ---
let tokensLoaded = false;
let tokenData = null;

async function loadTokenUsage() {
  const panel = document.getElementById('tokensPanel');
  panel.innerHTML = '<div class="token-loading">正在加载 Token 用量数据...</div>';
  try {
    let data = window._tokenCache || null;
    if (!data) {
      const res = await apiFetch(apiUrl('/api/token-usage', 'days=30'));
      data = await res.json();
    }
    window._tokenCache = null;
    if (!data.ok) {
      panel.innerHTML = `<div class="token-loading" style="color:#f85149">加载失败: ${escHtml(data.error || '')}</div>`;
      return;
    }
    tokenData = data;
    renderTokenUsage(data);
  } catch (e) {
    panel.innerHTML = `<div class="token-loading" style="color:#f85149">网络错误: ${escHtml(e.message)}</div>`;
  }
}

function formatTokenNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function renderTokenUsage(data) {
  const panel = document.getElementById('tokensPanel');
  const daily = data.daily || [];
  const totals = data.totals || {};
  const interactions = data.interactions || [];

  // Total stats
  const totalTokens = totals.totalTokens || daily.reduce((s, d) => s + (d.totalTokens || 0), 0);
  const totalInput = totals.input || daily.reduce((s, d) => s + (d.input || 0), 0);
  const totalOutput = totals.output || daily.reduce((s, d) => s + (d.output || 0), 0);
  const totalCache = interactions.reduce((s, i) => s + (i.cacheRead || 0), 0);
  const totalCost = totals.totalCost || 0;
  const totalDays = daily.length;

  const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().substring(0, 10);
  const todayCost = interactions.filter(i => (i.date || '').startsWith(todayStr)).reduce((s, i) => s + (i.cost || 0), 0);
  const todayTokens = interactions.filter(i => (i.date || '').startsWith(todayStr)).reduce((s, i) => s + (i.totalTokens || 0), 0);
  const todayCount = interactions.filter(i => (i.date || '').startsWith(todayStr)).length;

  let html = '';

  // Overview cards
  html += '<div class="token-overview">';
  html += `<div class="token-stat-card highlight"><div class="token-stat-value" style="color:#f0883e">${todayCost > 0 ? '$' + todayCost.toFixed(4) : '$0'}</div><div class="token-stat-label">今日花费 (${todayCount}次 · ${formatTokenNum(todayTokens)})</div></div>`;
  html += `<div class="token-stat-card"><div class="token-stat-value">${formatTokenNum(totalTokens)}</div><div class="token-stat-label">总 Tokens (${totalDays}天)</div></div>`;
  html += `<div class="token-stat-card"><div class="token-stat-value">${formatTokenNum(totalInput)}</div><div class="token-stat-label">输入 Tokens</div></div>`;
  html += `<div class="token-stat-card"><div class="token-stat-value" style="color:#da8ee7">${formatTokenNum(totalCache)}</div><div class="token-stat-label">缓存命中 Tokens</div></div>`;
  html += `<div class="token-stat-card"><div class="token-stat-value">${formatTokenNum(totalOutput)}</div><div class="token-stat-label">输出 Tokens</div></div>`;
  const calcCost = totals.calculatedCost || totalCost;
  html += `<div class="token-stat-card"><div class="token-stat-value">${calcCost > 0 ? '$' + calcCost.toFixed(2) : '—'}</div><div class="token-stat-label">总费用 (USD)</div></div>`;
  html += `<div class="token-stat-card"><div class="token-stat-value">${interactions.length}</div><div class="token-stat-label">总交互次数</div></div>`;
  html += '</div>';

  // Daily bar chart
  if (daily.length > 0) {
    const maxTokens = Math.max(...daily.map(d => (d.input || 0) + (d.output || 0)), 1);
    html += '<div class="token-chart">';
    html += '<div class="token-chart-title">每日 Token 用量</div>';
    html += '<div class="token-legend"><div class="token-legend-item"><div class="token-legend-dot" style="background:#58a6ff"></div>输入</div><div class="token-legend-item"><div class="token-legend-dot" style="background:#3fb950"></div>输出</div></div>';
    html += '<div class="token-bars">';
    for (const d of daily) {
      const inp = d.input || 0;
      const out = d.output || 0;
      const total = d.totalTokens || 0;
      const hInput = Math.max(((inp) / maxTokens) * 130, 2);
      const hOutput = Math.max(((out) / maxTokens) * 130, 2);
      const dateLabel = (d.date || '').substring(5);
      const costStr = d.totalCost > 0 ? ' $' + d.totalCost.toFixed(3) : '';
      html += `<div class="token-bar-group">`;
      html += `<div class="token-bar-tooltip">${d.date}<br>输入: ${formatTokenNum(inp)} · 输出: ${formatTokenNum(out)}<br>总计: ${formatTokenNum(total)}${costStr}</div>`;
      html += `<div class="token-bar output" style="height:${hOutput}px" title="输出: ${formatTokenNum(out)}"></div>`;
      html += `<div class="token-bar input" style="height:${hInput}px" title="输入: ${formatTokenNum(inp)}"></div>`;
      html += `<span class="token-bar-date">${dateLabel}</span>`;
      html += `</div>`;
    }
    html += '</div></div>';
  }

  // Cron task section (loaded async)
  html += '<div class="task-group-section" id="cronSection"><div class="token-loading" style="padding:20px;font-size:13px">加载定时任务...</div></div>';

  // Filter toolbar
  html += '<div class="token-toolbar">';
  html += '<label>筛选用户:</label><select id="tokenUserFilter"><option value="">全部</option></select>';
  html += '<label style="margin-left:12px">筛选日期:</label><input type="date" id="tokenDateFilter" style="width:140px">';
  html += '<span style="flex:1"></span>';
  html += '<span id="tokenFilterInfo" style="font-size:12px;color:#484f58"></span>';
  html += '</div>';

  // Detail table
  html += '<div class="token-detail">';
  html += '<div class="token-detail-title">指令明细</div>';
  html += '<table class="token-table"><thead><tr>';
  html += '<th>时间</th><th>用户</th><th>指令内容</th><th>模型</th><th style="text-align:right">输入</th><th style="text-align:right">缓存</th><th style="text-align:right">输出</th><th style="text-align:right">总计</th><th style="text-align:right">费用</th>';
  html += '</tr></thead><tbody id="tokenTableBody"></tbody></table>';
  html += '</div>';

  panel.innerHTML = html;

  // Populate user filter
  const users = [...new Set(interactions.map(i => i.user))].sort();
  const userSelect = document.getElementById('tokenUserFilter');
  for (const u of users) {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = u;
    userSelect.appendChild(opt);
  }

  renderTokenTable(interactions);
  loadCronUsage();

  userSelect.addEventListener('change', () => applyTokenFilter(interactions));
  document.getElementById('tokenDateFilter').addEventListener('change', () => applyTokenFilter(interactions));
}

function applyTokenFilter(interactions) {
  const userFilter = document.getElementById('tokenUserFilter').value;
  const dateFilter = document.getElementById('tokenDateFilter').value;
  let filtered = interactions;
  if (userFilter) filtered = filtered.filter(i => i.user === userFilter);
  if (dateFilter) filtered = filtered.filter(i => (i.date || '').startsWith(dateFilter));
  renderTokenTable(filtered);
  const info = document.getElementById('tokenFilterInfo');
  const totalFiltered = filtered.reduce((s, i) => s + (i.totalTokens || 0), 0);
  info.textContent = `${filtered.length} 条记录 · ${formatTokenNum(totalFiltered)} tokens`;
}

function renderTokenTable(items) {
  const tbody = document.getElementById('tokenTableBody');
  if (!tbody) return;
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:#484f58">无匹配记录</td></tr>';
    return;
  }
  const rows = items.slice(0, 200);
  window._tipMessages = rows.map(i => i.userMsg || '');
  tbody.innerHTML = rows.map((i, idx) => {
    const timeStr = toCN(i.time);
    return `<tr>
      <td class="date-cell">${escHtml(timeStr)}</td>
      <td class="user-cell">${escHtml(i.user || '?')}</td>
      <td class="msg-cell" data-tip-idx="${idx}">${escHtml((i.userMsg || '').substring(0, 40))}${(i._turns || 1) > 1 ? ' <span style="color:#8b949e;font-size:11px">(' + i._turns + '轮)</span>' : ''}</td>
      <td class="model-cell">${escHtml(i.model || '')}</td>
      <td class="num-cell">${formatTokenNum(i.input || 0)}</td>
      <td class="num-cell" style="color:#da8ee7">${(i.cacheRead || 0) > 0 ? formatTokenNum(i.cacheRead) : '—'}</td>
      <td class="num-cell">${formatTokenNum(i.output || 0)}</td>
      <td class="num-cell">${formatTokenNum(i.totalTokens || 0)}</td>
      <td class="num-cell" style="color:#3fb950">${(i.cost || 0) > 0 ? '$' + i.cost.toFixed(4) : '—'}</td>
    </tr>`;
  }).join('');
  if (items.length > 200) {
    tbody.innerHTML += `<tr><td colspan="9" style="text-align:center;padding:12px;color:#484f58">仅显示前 200 条 (共 ${items.length} 条)</td></tr>`;
  }
  const info = document.getElementById('tokenFilterInfo');
  if (info) {
    const totalFiltered = items.reduce((s, i) => s + (i.totalTokens || 0), 0);
    info.textContent = `${items.length} 条记录 · ${formatTokenNum(totalFiltered)} tokens`;
  }
}


// --- Cron task monitoring ---
async function loadCronUsage() {
  const section = document.getElementById('cronSection');
  if (!section) return;
  try {
    const res = await apiFetch(apiUrl('/api/cron-usage'));
    const data = await res.json();
    if (!data.ok) {
      section.innerHTML = '';
      return;
    }
    const jobs = data.jobs || [];
    if (jobs.length === 0) {
      section.innerHTML = '<div class="task-group-title">定时任务 <span class="tg-badge" style="background:#484f58">0</span></div><div style="font-size:13px;color:#484f58;padding:8px 0">暂无定时任务。可以对 Diana 说「每天早上八点发送最新的AI新闻」来创建定时任务。</div>';
      return;
    }

    let h = '<div class="task-group-title">定时任务 <span class="tg-badge">' + jobs.length + ' 个</span></div>';
    for (let gi = 0; gi < jobs.length; gi++) {
      const j = jobs[gi];
      const statusDot = j.enabled ? '<span style="color:#3fb950">●</span>' : '<span style="color:#f85149">●</span>';
      const statusText = j.enabled ? '运行中' : '已停止';
      h += '<div class="task-group-card">';
      h += '<div class="task-group-header" onclick="toggleTaskGroup(' + gi + ')">';
      h += '<span class="tg-expand" id="tgArrow' + gi + '">▶</span>';
      h += '<span class="tg-msg" title="' + escHtml(j.message || j.description || j.name) + '">';
      h += statusDot + ' ' + escHtml(j.name || j.description || j.message.substring(0, 40) || j.id);
      h += '</span>';
      h += '<span class="tg-user" style="color:#58a6ff">' + escHtml(j.schedule) + '</span>';
      const nextEnabled = j.enabled ? '0' : '1';
      const btnLabel = j.enabled ? '暂停' : '恢复';
      const btnClass = j.enabled ? 'danger' : 'success';
      h += '<button class="tg-action-btn ' + btnClass + '" id="cronToggleBtn' + gi + '" onclick="event.stopPropagation();toggleCronJob(\'' + encodeURIComponent(j.id) + '\',' + nextEnabled + ',' + gi + ')">' + btnLabel + '</button>';
      h += '<div class="tg-stats">';
      h += '<div class="tg-stat"><div class="tg-stat-val">' + j.runCount + '</div><div class="tg-stat-label">执行次数</div></div>';
      h += '<div class="tg-stat"><div class="tg-stat-val">' + formatTokenNum(j.totalTokens) + '</div><div class="tg-stat-label">总tokens</div></div>';
      h += '<div class="tg-stat"><div class="tg-stat-val">' + (j.totalCost > 0 ? '$' + j.totalCost.toFixed(3) : '—') + '</div><div class="tg-stat-label">总费用</div></div>';
      h += '</div></div>';

      // Runs detail
      h += '<div class="tg-runs" id="tgRuns' + gi + '">';
      if (j.message) {
        h += '<div class="tg-avg" style="border-bottom:1px solid #21262d">指令: <span>' + escHtml(j.message) + '</span></div>';
      }
      if (j.runCount > 0) {
        const avgTokens = Math.round(j.totalTokens / j.runCount);
        const avgCost = j.totalCost / j.runCount;
        h += '<div class="tg-avg">平均每次: <span>' + formatTokenNum(avgTokens) + ' tokens</span>' + (avgCost > 0 ? ' · <span>$' + avgCost.toFixed(4) + '</span>' : '') + '</div>';
        h += '<table class="tg-run-table"><thead><tr><th>#</th><th>执行时间</th><th>状态</th><th style="text-align:right">输入</th><th style="text-align:right">输出</th><th style="text-align:right">总计</th><th style="text-align:right">费用</th></tr></thead><tbody>';
        const runs = j.runs || [];
        for (let ri = 0; ri < runs.length; ri++) {
          const r = runs[ri];
          const timeStr = toCN(r.startedAt);
          const st = r.status || '?';
          const stColor = st === 'ok' || st === 'success' || st === 'completed' ? '#3fb950' : st === 'error' || st === 'failed' ? '#f85149' : '#d29922';
          h += '<tr><td>' + (ri + 1) + '</td><td>' + escHtml(timeStr) + '</td>';
          h += '<td style="color:' + stColor + '">' + escHtml(st) + '</td>';
          h += '<td class="num">' + formatTokenNum(r.inputTokens) + '</td>';
          h += '<td class="num">' + formatTokenNum(r.outputTokens) + '</td>';
          h += '<td class="num">' + formatTokenNum(r.totalTokens) + '</td>';
          h += '<td class="num" style="color:#3fb950">' + (r.cost > 0 ? '$' + r.cost.toFixed(4) : '—') + '</td></tr>';
        }
        h += '</tbody></table>';
      } else {
        h += '<div class="tg-avg">尚未执行过</div>';
      }
      if (j.nextRunAt) {
        h += '<div class="tg-avg">下次执行: <span>' + escHtml(toCN(j.nextRunAt)) + '</span></div>';
      }
      h += '</div></div>';
    }
    section.innerHTML = h;
  } catch (e) {
    section.innerHTML = '';
  }
}

function toggleTaskGroup(gi) {
  const runs = document.getElementById('tgRuns' + gi);
  const arrow = document.getElementById('tgArrow' + gi);
  if (!runs) return;
  const isOpen = runs.classList.contains('open');
  runs.classList.toggle('open');
  arrow.classList.toggle('open');
}

async function toggleCronJob(encodedJobId, enabledValue, gi) {
  const jobId = decodeURIComponent(encodedJobId);
  const btn = document.getElementById('cronToggleBtn' + gi);
  const oldText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '处理中...';
    btn.classList.add('is-busy');
  }
  try {
    const res = await apiFetch(apiUrl('/api/cron-toggle', `jobId=${encodeURIComponent(jobId)}&enabled=${enabledValue}`), { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'unknown error');
    // Refresh list after toggle; server side cache is 3s.
    setTimeout(() => { loadCronUsage(); }, 400);
  } catch (e) {
    alert('定时任务操作失败: ' + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '重试';
      btn.classList.remove('is-busy');
    }
  }
}


  // --- Custom tooltip for msg-cell ---
  (function() {
    const tip = document.createElement('div');
    tip.className = 'msg-tooltip';
    document.body.appendChild(tip);
    let showTimer = null;
    document.addEventListener('mouseover', function(e) {
      const cell = e.target.closest('[data-tip-idx]');
      if (!cell) return;
      const idx = parseInt(cell.dataset.tipIdx);
      const msgs = window._tipMessages;
      if (!msgs || isNaN(idx) || !msgs[idx]) return;
      clearTimeout(showTimer);
      showTimer = setTimeout(function() {
        tip.textContent = msgs[idx];
        tip.style.display = 'block';
        const rect = cell.getBoundingClientRect();
        let top = rect.bottom + 6;
        let left = rect.left;
        tip.classList.add('visible');
        requestAnimationFrame(function() {
          const tw = tip.offsetWidth;
          const th = tip.offsetHeight;
          if (left + tw > window.innerWidth - 12) left = window.innerWidth - tw - 12;
          if (left < 8) left = 8;
          if (top + th > window.innerHeight - 12) top = rect.top - th - 6;
          tip.style.left = left + 'px';
          tip.style.top = top + 'px';
        });
      }, 100);
    });
    document.addEventListener('mouseout', function(e) {
      const cell = e.target.closest('[data-tip-idx]');
      if (!cell) return;
      clearTimeout(showTimer);
      tip.classList.remove('visible');
      setTimeout(function() { if (!tip.classList.contains('visible')) tip.style.display = 'none'; }, 200);
    });
  })();
