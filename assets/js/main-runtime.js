// --- WebSocket ---
function connectWs() {
  if (ws) { ws.close(); ws = null; }
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    statusDot.classList.add('connected');
    statusText.textContent = 'connected';
  };
  ws.onclose = () => {
    statusDot.classList.remove('connected');
    statusText.textContent = 'reconnecting...';
    setTimeout(connectWs, 3000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    if (paused) return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'log') handleLog(msg.data);
    } catch {}
  };
}

function handleLog(data) {
  appendLogLine(data);
  processTask(data);
  processRealtimeChat(data);
}

function processRealtimeChat(data) {
  if (data.type === 'message_content') {
    const m = data.message.match(/DM from (\S+): ([\s\S]+)/);
    if (m) {
      const userId = m[1];
      const name = displayName(userId);
      const u = ensureUserSummary(userId, name);
      u.lastText = m[2];
      u.lastTime = data.time;
      u.msgCount++;
      currentRealtimeUser = userId;
      if (!currentViewUser) renderUserList();
    }
  } else if (data.type === 'group_message_content') {
    const m = data.message.match(/message in group (\S+): ([\s\S]+)/);
    if (m) {
      const groupId = 'group:' + m[1];
      const groupName = groupNameCache[m[1]] || m[1].substring(0, 12);
      const u = ensureUserSummary(groupId, groupName);
      u.lastText = m[2];
      u.lastTime = data.time;
      u.msgCount++;
      currentRealtimeUser = groupId;
      if (!currentViewUser) renderUserList();
    }
  } else if (data.type === 'message_done') {
    if (currentRealtimeUser) {
      const u = ensureUserSummary(currentRealtimeUser);
      u.lastTime = data.time;
      if (!currentViewUser) renderUserList();
      currentRealtimeUser = null;
    }
  } else if (data.type === 'task_end') {
    if (currentRealtimeUser) {
      const u = ensureUserSummary(currentRealtimeUser);
      u.lastTime = data.time;
      if (!currentViewUser) renderUserList();
      currentRealtimeUser = null;
    }
  }
}

// --- Logs ---
let logsLoaded = false;
let currentLogDate = '';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function loadLogsForDate(date) {
  logsPanel.innerHTML = '<div style="text-align:center;padding:40px;color:#484f58">加载中...</div>';
  logLines = 0;
  currentLogDate = date;
  try {
    const res = await apiFetch(apiUrl('/api/logs', `date=${encodeURIComponent(date)}&lines=5000`));
    const data = await res.json();
    logsPanel.innerHTML = '';
    if (!data.ok) {
      logsPanel.innerHTML = `<div style="text-align:center;padding:40px;color:#f85149">加载失败: ${data.error || ''}</div>`;
      return;
    }
    const info = document.getElementById('logInfo');
    if (data.total === 0) {
      logsPanel.innerHTML = '<div style="text-align:center;padding:40px;color:#484f58">该日期无日志</div>';
      info.textContent = `${date} · 0 条`;
      logCount.textContent = '0';
      return;
    }
    for (const log of data.logs) {
      appendLogLine(log, true);
    }
    info.textContent = `${date} · 显示 ${data.showing}/${data.total} 条`;
    if (autoScroll.checked) logsPanel.scrollTop = logsPanel.scrollHeight;
  } catch (e) {
    logsPanel.innerHTML = `<div style="text-align:center;padding:40px;color:#f85149">网络错误</div>`;
  }
}


function logCnAnnotation(msg, sub) {
  const s = msg || '';
  const rules = [
    [/received message from \S+ in \S+ \(group\)/, '收到群聊消息'],
    [/received message from \S+ in \S+/, '收到私聊消息'],
    [/DM from \S+: (.{0,30})/, (m) => '用户私信: ' + m[1]],
    [/message in group \S+: (.{0,30})/, (m) => '群聊消息: ' + m[1]],
    [/dispatching to agent.*group/, '分发给AI处理(群聊)'],
    [/dispatching to agent/, '分发给AI处理'],
    [/^\[tool\] exec: (.{0,40})/, (m) => '执行命令: ' + m[1]],
    [/^\[tool\] edit: (.+)/, (m) => '编辑文件: ' + m[1]],
    [/^\[tool\] file_write: (.+)/, (m) => '写入文件: ' + m[1]],
    [/^\[tool\] message: (.{0,30})/, (m) => '发送消息: ' + m[1]],
    [/^\[tool\] browser_navigate: (.+)/, (m) => '打开网页: ' + m[1]],
    [/^\[tool\] (\w+)/, (m) => '调用工具: ' + m[1]],
    [/^\[reply\] (.{0,40})/, (m) => '回复: ' + m[1]],
    [/^\[result\] (\w+) .*ERROR/, (m) => m[1] + ' 执行失败'],
    [/^\[result\] (\w+) exit=0/, (m) => m[1] + ' 执行成功'],
    [/^\[result\] (\w+)/, (m) => m[1] + ' 返回结果'],
    [/^\[input\] (.{0,40})/, (m) => '用户输入: ' + m[1]],
    [/dispatch complete.*replies=(\d+)/, (m) => m[1] !== '0' ? '处理完成, 回复' + m[1] + '条' : '处理完成, 无回复'],
    [/run agent end.*isError=true.*error=(.{0,40})/, (m) => 'AI处理出错: ' + m[1]],
    [/run agent end/, 'AI处理结束'],
    [/receive events or callbacks through persistent connection/, '飞书长连接配置说明(可忽略)'],
    [/ws client ready/, '飞书WebSocket连接成功'],
    [/WebSocket client started/, 'WebSocket连接启动中...'],
    [/starting feishu.*websocket/, '启动飞书频道(WebSocket模式)'],
    [/starting feishu/, '启动飞书频道'],
    [/abort signal received, stopping/, '收到停止信号, 正在关闭'],
    [/signal SIGTERM received/, '收到终止信号'],
    [/received SIGTERM.*shutting down/, '正在关闭服务'],
    [/force: no listeners on port \d+/, '端口已释放, 准备启动'],
    [/listening on ws:\/\/.*PID (\d+)/, (m) => '网关已启动 (PID: ' + m[1] + ')'],
    [/bot open_id resolved/, '机器人身份确认'],
    [/dedup warmup loaded (\d+)/, (m) => '消息去重缓存已加载 (' + m[1] + '条)'],
    [/event-dispatch is ready/, '事件分发就绪'],
    [/health-monitor: restarting.*stale-socket/, '健康检查: 连接过期, 自动重连'],
    [/health-monitor: restarting.*reason: (.+)/, (m) => '健康检查: 自动重启 (' + m[1] + ')'],
    [/gmail watcher stopped/, 'Gmail监控已停止'],
    [/Config valid/, '配置校验通过'],
    [/config change detected.*evaluating reload/, '检测到配置变更, 正在热重载'],
    [/config hot reload applied/, '配置热重载完成'],
    [/did not mention bot/, '未@机器人, 消息已忽略'],
    [/not in groupAllowFrom/, '群聊不在白名单内, 已忽略'],
    [/gateway name conflict resolved/, '网关名称冲突已自动解决'],
    [/gateway hostname conflict resolved/, '网关主机名冲突已解决'],
    [/bonjour: advertised gateway/, '网关广播已发布'],
    [/log file: (.+)/, (m) => '日志文件: ' + m[1]],
    [/agent model: (.+)/, (m) => '当前AI模型: ' + m[1]],
    [/Registered (\S+)/, (m) => '已注册工具: ' + m[1]],
    [/Browser control listening/, '浏览器控制已启动'],
    [/typing TTL reached/, '打字指示器超时已停止'],
    [/client ready/, '客户端就绪'],
    [/group session scope=group/, '群聊会话建立'],
    [/device pairing auto-approved/, '设备配对已自动通过'],
    [/restarting feishu channel/, '正在重启飞书频道'],
    [/unknown method: (.+)/, (m) => '不支持的方法: ' + m[1]],
    [/rate limit/, '触发频率限制'],
    [/Context overflow/, '上下文溢出'],
    [/permission scope/, '权限不足'],
    [/canvas host mounted/, 'Canvas服务已挂载'],
    [/started \(interval: (\d+)s/, (m) => '健康检查已启动 (间隔' + m[1] + '秒)'],
    [/queuedFinal=true/, '消息队列已清空'],
    [/session-store maintenance/, '会话存储维护'],
    [/cron: timer armed/, '定时任务计时器就绪(每分钟检查)'],
    [/cron: job .* started/, '定时任务开始执行'],
    [/cron: job .* finished/, '定时任务执行完成'],
    [/cron: job .* failed/, '定时任务执行失败'],
    [/cron: no jobs/, '无定时任务'],
    [/usage-cost/, 'Token用量统计(可忽略)'],
  ];
  for (const [pattern, handler] of rules) {
    const m = s.match(pattern);
    if (m) return typeof handler === 'function' ? handler(m) : handler;
  }
  return '';
}

function appendLogLine(data, skipScroll) {
  const div = document.createElement('div');
  div.className = `log-line type-${data.type}`;
  const timeStr = formatTime(data.time);
  const sub = data.subsystem ? `[${data.subsystem}]` : '';
  const cn = logCnAnnotation(data.message, data.subsystem);
  const modelBadge = data.model ? `<span class="log-model">${escHtml(data.model)}</span>` : '';
  const costBadge = data.cost ? `<span class="log-cost">${escHtml(data.cost)}</span>` : '';
  div.innerHTML = `<span class="log-time">${timeStr}</span><span class="log-sub">${escHtml(sub)}</span><span class="log-msg">${escHtml(data.message)}</span>${modelBadge}${costBadge}${cn ? '<span class="log-cn">// ' + escHtml(cn) + '</span>' : ''}`;
  const filter = searchInput.value.toLowerCase();
  if (filter && !data.message.toLowerCase().includes(filter) && !data.subsystem.toLowerCase().includes(filter)) {
    div.classList.add('filtered');
  }
  logsPanel.appendChild(div);
  logLines++;
  logCount.textContent = logLines;
  while (logsPanel.children.length > MAX_LOG_LINES) { logsPanel.removeChild(logsPanel.firstChild); logLines--; }
  if (!skipScroll && autoScroll.checked) logsPanel.scrollTop = logsPanel.scrollHeight;
}

// --- Tasks ---
let lastTaskId = null;

function taskDedup(userId, text, time) {
  return `${userId}|${(text||'').substring(0,30)}|${(time||'').substring(0,19)}`;
}

function processTask(data) {
  if (data.type === 'message_content') {
    const m = data.message.match(/DM from (\S+): (.+)/);
    if (m) {
      const tid = taskDedup(m[1], m[2], data.time);
      if (tasks.has(tid)) return;
      tasks.set(tid, { userId: m[1], userName: displayName(m[1]), text: m[2], time: data.time, status: 'processing', error: null });
      lastTaskId = tid;
      renderTasks();
    }
  } else if (data.type === 'task_end') {
    const tid = lastTaskId || [...tasks.keys()].reverse().find(k => tasks.get(k).status === 'processing');
    if (tid && tasks.has(tid)) {
      const task = tasks.get(tid);
      if (data.message.includes('isError=true')) {
        task.status = 'failed';
        const errMatch = data.message.match(/error=(.+)/);
        task.error = errMatch ? errMatch[1] : 'unknown';
        if (task.error.includes('rate limit')) task.status = 'rate_limit';
      } else { task.status = 'success'; }
      tasks.set(tid, task);
      lastTaskId = null;
      renderTasks();
    }
  } else if (data.type === 'message_done') {
    if (lastTaskId && tasks.has(lastTaskId)) {
      const task = tasks.get(lastTaskId);
      if (task.status === 'processing') {
        const rm = data.message.match(/replies=(\d+)/);
        const replies = rm ? parseInt(rm[1]) : 0;
        task.status = replies > 0 ? 'success' : 'failed';
        tasks.set(lastTaskId, task);
        lastTaskId = null;
        renderTasks();
      }
    }
  }
}

function renderTasks() {
  const arr = [...tasks.values()].reverse().slice(0, 50);
  taskCount.textContent = arr.length;
  if (!arr.length) { tasksPanel.innerHTML = '<div class="empty-state">等待任务...</div>'; return; }
  tasksPanel.innerHTML = arr.map(t => `
    <div class="task-card">
      <div class="task-header">
        <span class="task-user">${escHtml(t.userName || t.userId.substring(0, 12))}</span>
        <span class="task-time">${formatDate(t.time)}</span>
      </div>
      <div class="task-message">${escHtml(t.text)}</div>
      <span class="task-status ${t.status}">${({processing:'处理中...',success:'完成',failed:'失败',rate_limit:'限流',timeout:'超时未收口'})[t.status]||t.status}</span>
      ${t.error ? `<span style="color:#8b949e;font-size:12px;margin-left:8px">${escHtml(t.error.substring(0,80))}</span>` : ''}
    </div>`).join('');
}

// --- Utils ---
function formatTime(t) {
  if (!t) return '';
  try { return new Date(t).toLocaleTimeString('zh-CN', { hour12: false }); }
  catch { return ''; }
}

function formatDate(t) {
  if (!t) return '';
  try {
    const d = new Date(t);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('zh-CN', { hour12: false });
    return `${d.getMonth()+1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch { return ''; }
}

function toCN(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ');
  } catch { return isoStr; }
}

function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// --- Tab switching ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'Panel').classList.add('active');
    logToolbar.style.display = tab.dataset.tab === 'logs' ? 'flex' : 'none';
    if (tab.dataset.tab === 'logs' && !logsLoaded) {
      logsLoaded = true;
      loadLogsForDate(logDateInput.value);
    }
    if (tab.dataset.tab === 'skills' && !skillsLoaded) {
      skillsLoaded = true;
      loadSkills();
    }
    if (tab.dataset.tab === 'tokens') {
      const now = Date.now();
      if (!tokensLoaded || now - (window._tokenLoadedAt || 0) > 60000) {
        tokensLoaded = true;
        window._tokenLoadedAt = now;
        loadTokenUsage();
      }
    }
    if (tab.dataset.tab !== 'chat') {
      chatDetailHeader.style.display = 'none';
    } else if (currentViewUser) {
      chatDetailHeader.style.display = 'flex';
    }
  });
});

searchInput.addEventListener('input', () => {
  const f = searchInput.value.toLowerCase();
  logsPanel.querySelectorAll('.log-line').forEach(el => {
    el.classList.toggle('filtered', f && !el.textContent.toLowerCase().includes(f));
  });
});



document.getElementById('pauseBtn').addEventListener('click', () => {
  paused = !paused;
  document.getElementById('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
  document.getElementById('pauseBtn').classList.toggle('btn-danger', paused);
});

// Init date picker
const logDateInput = document.getElementById('logDateInput');
logDateInput.value = todayStr();

document.getElementById('loadLogsBtn').addEventListener('click', () => {
  loadLogsForDate(logDateInput.value);
});

logDateInput.addEventListener('change', () => {
  loadLogsForDate(logDateInput.value);
});
