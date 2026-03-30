const initialUrl = new URL(location.href);
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const tokenFromUrl = (initialUrl.searchParams.get('token') || '').trim();
const tokenFromSession = (sessionStorage.getItem('diana_monitor_token') || '').trim();
const token = tokenFromUrl || tokenFromSession;
if (!token) {
  document.body.innerHTML = '<div style="padding:32px;color:#f85149;font-family:system-ui">缺少访问令牌，请通过带 token 的链接重新打开 Monitor。</div>';
  throw new Error('missing token');
}
if (tokenFromUrl) {
  sessionStorage.setItem('diana_monitor_token', tokenFromUrl);
  initialUrl.searchParams.delete('token');
  history.replaceState(null, '', initialUrl.toString());
}
let currentBot = initialUrl.searchParams.get('bot') || 'diana';

function apiUrl(path, extraParams = '') {
  const params = new URLSearchParams(extraParams || '');
  params.set('bot', currentBot);
  return `${path}?${params.toString()}`;
}

function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(url, { ...options, headers });
}

function wsUrl() { return `${wsProto}://${location.host}/ws?token=${encodeURIComponent(token)}&bot=${encodeURIComponent(currentBot)}`; }

// Bot 切换初始化
const botSelect = document.getElementById('botSelect');
apiFetch('/api/bots').then(r => r.json()).then(d => {
  if (d.ok && d.bots) {
    botSelect.innerHTML = d.bots.map(b => `<option value="${b.id}"${b.id === currentBot ? ' selected' : ''}>${b.name}</option>`).join('');
  }
}).catch(() => {
  botSelect.innerHTML = '<option value="diana">Diana</option><option value="jax">Jax</option>';
  botSelect.value = currentBot;
});
botSelect.addEventListener('change', () => {
  currentBot = botSelect.value;
  const u = new URL(location.href);
  u.searchParams.set('bot', currentBot);
  history.replaceState(null, '', u.toString());
  document.title = botSelect.options[botSelect.selectedIndex].text + ' Monitor';
  switchBot();
});

function switchBot() {
  if (ws) { ws.close(); ws = null; }
  logsPanel.innerHTML = '';
  logLines = 0;
  tasks.clear();
  tasksPanel.innerHTML = '<div class="empty-state">等待任务...</div>';
  tokensPanel.innerHTML = '<div class="token-loading">加载中...</div>';
  window._tokenCache = null;
  window._skillsCache = null;
  tokensLoaded = false;
  skillsLoaded = false;
  readCounts = JSON.parse(localStorage.getItem(rcKey()) || '{}');
  chatDetailContainer.style.display = 'none';
  chatDetailHeader.style.display = 'none';
  userListContainer.style.display = '';
  connectWs();
  loadChatList();
  const activeTab = document.querySelector('.tab.active');
  if (activeTab) {
    const tab = activeTab.dataset.tab;
    if (tab === 'tokens') loadTokenUsage();
    else if (tab === 'logs') loadLogsForDate(currentLogDate || todayStr());
    else if (tab === 'skills') loadSkills();
  }
}

const logsPanel = document.getElementById('logsPanel');
const tasksPanel = document.getElementById('tasksPanel');
const chatPanel = document.getElementById('chatPanel');
const userListContainer = document.getElementById('userListContainer');
const chatDetailContainer = document.getElementById('chatDetailContainer');
const chatDetailHeader = document.getElementById('chatDetailHeader');
const chatDetailName = document.getElementById('chatDetailName');
const chatDetailSub = document.getElementById('chatDetailSub');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const searchInput = document.getElementById('searchInput');
const autoScroll = document.getElementById('autoScroll');
const logCount = document.getElementById('logCount');
const taskCount = document.getElementById('taskCount');
const logToolbar = document.getElementById('logToolbar');

let ws = null;
let paused = false;
let logLines = 0;
const MAX_LOG_LINES = 10000;
const tasks = new Map();

const nameCache = {};
const AVATAR_COLORS = ['#1f6feb','#8957e5','#3fb950','#d29922','#f85149','#58a6ff','#da3633','#238636','#9e6a03','#a371f7'];

const userSummary = {};
let currentViewUser = null;
let currentRealtimeUser = null;
let chatPageToken = null;
let chatHasMore = false;
let chatLoadingMore = false;

function getAvatarColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function getInitial(name) {
  if (!name) return '?';
  const ch = name.charAt(0);
  if (/[\u4e00-\u9fff]/.test(ch)) return ch;
  return ch.toUpperCase();
}

const groupNameCache = {};

function rcKey() { return `monitor_readCounts_${currentBot}`; }
let readCounts = JSON.parse(localStorage.getItem(rcKey()) || '{}');
function getUnread(userId, total) {
  return Math.max(0, total - (readCounts[userId] || 0));
}
function markRead(userId, total) {
  readCounts[userId] = total;
  localStorage.setItem(rcKey(), JSON.stringify(readCounts));
}

async function loadNames() {
  try {
    const res = await apiFetch(apiUrl('/api/names'));
    if (!res.ok) return;
    Object.assign(nameCache, await res.json());
  } catch {}
  try {
    const res = await apiFetch(apiUrl('/api/group-names'));
    if (!res.ok) return;
    Object.assign(groupNameCache, await res.json());
  } catch {}
}

function displayName(userId, userName) {
  if (userName && !userName.startsWith('ou_')) return userName;
  if (nameCache[userId]) return nameCache[userId];
  return userId ? userId.substring(0, 10) + '...' : '?';
}

function ensureUserSummary(userId, userName) {
  if (!userSummary[userId]) {
    userSummary[userId] = { name: displayName(userId, userName), lastText: '', lastTime: null, msgCount: 0 };
  } else if (userName) {
    const resolved = displayName(userId, userName);
    if (resolved !== userSummary[userId].name) userSummary[userId].name = resolved;
  }
  return userSummary[userId];
}

// --- Load history for user list ---
async function loadHistory() {
  await loadNames();
  try {
    const res = await apiFetch(apiUrl('/api/history'));
    if (!res.ok) throw new Error('fail');
    const data = await res.json();
    for (const evt of (data.events || [])) {
      if (evt.kind === 'user_msg' && evt.userId) {
        const u = ensureUserSummary(evt.userId, evt.userName);
        u.lastText = evt.text;
        u.lastTime = evt.time;
        u.msgCount++;
      } else if (evt.kind === 'diana_status' && evt.userId) {
        const u = ensureUserSummary(evt.userId, evt.userName);
        u.lastTime = evt.time;
      }
    }
  } catch {}
  // Fill in users from chatIds that may have been pruned from history
  try {
    const chatRes = await apiFetch(apiUrl('/api/chats'));
    if (chatRes.ok) {
      const chatIds = await chatRes.json();
      for (const uid of Object.keys(chatIds)) {
        if (uid.startsWith('group:')) {
          if (!userSummary[uid]) {
            const gid = uid.replace('group:', '');
            const gName = groupNameCache[gid] || gid.substring(0, 12);
            ensureUserSummary(uid, gName);
          }
        } else {
          if (!userSummary[uid]) {
            const name = nameCache[uid] || uid.substring(0, 12);
            ensureUserSummary(uid, name);
          }
        }
      }
    }
  } catch {}
  renderUserList();
  loadTasksFromHistory();
}

function loadTasksFromHistory() {
  apiFetch(apiUrl('/api/history')).then(r => r.json()).then(data => {
    if (!data.events) return;
    const MAX_PROCESSING_AGE_MS = 15 * 60 * 1000;
    function findPendingTaskId(userId) {
      const ids = [...tasks.keys()].reverse();
      if (userId) {
        const byUser = ids.find((id) => {
          const t = tasks.get(id);
          return t && t.userId === userId && t.status === 'processing';
        });
        if (byUser) return byUser;
      }
      return ids.find((id) => {
        const t = tasks.get(id);
        return t && t.status === 'processing';
      }) || null;
    }
    for (const evt of data.events) {
      if (evt.kind === 'user_msg' && evt.userId) {
        const tid = taskDedup(evt.userId, evt.text, evt.time);
        if (!tasks.has(tid)) {
          tasks.set(tid, { userId: evt.userId, userName: displayName(evt.userId, evt.userName), text: evt.text, time: evt.time, status: 'processing', error: null });
        }
        lastTaskId = tid;
      } else if (evt.kind === 'diana_status') {
        const targetId = (lastTaskId && tasks.has(lastTaskId) && (!evt.userId || tasks.get(lastTaskId).userId === evt.userId))
          ? lastTaskId
          : findPendingTaskId(evt.userId || '');
        if (!targetId || !tasks.has(targetId)) continue;
        const task = tasks.get(targetId);
        if (evt.status === 'replied') task.status = 'success';
        else if (evt.status === 'failed') { task.status = 'failed'; task.error = evt.error || ''; }
        else if (evt.status === 'rate_limit') { task.status = 'rate_limit'; task.error = evt.error || ''; }
        else if (evt.status === 'overflow') { task.status = 'failed'; task.error = 'Context overflow'; }
        else if (evt.status === 'no_reply') task.status = 'failed';
        tasks.set(targetId, task);
        if (lastTaskId === targetId) lastTaskId = null;
      }
    }
    const now = Date.now();
    for (const [tid, task] of tasks.entries()) {
      if (task.status !== 'processing') continue;
      const ts = new Date(task.time || '').getTime();
      if (!Number.isFinite(ts)) continue;
      if (now - ts > MAX_PROCESSING_AGE_MS) {
        task.status = 'timeout';
        task.error = '历史状态缺失';
        tasks.set(tid, task);
      }
    }
    renderTasks();
  }).catch(() => {});
}

// --- User list ---
function renderUserList() {
  const users = Object.entries(userSummary)
    .map(([id, u]) => ({ id, ...u }))
    .sort((a, b) => {
      if (!a.lastTime) return 1;
      if (!b.lastTime) return -1;
      return new Date(b.lastTime) - new Date(a.lastTime);
    });

  if (users.length === 0) {
    userListContainer.innerHTML = '<div class="empty-state">暂无聊天记录，等待用户发消息...</div>';
    return;
  }

  userListContainer.innerHTML = users.map(u => {
    const isGroup = u.id.startsWith('group:');
    const cardClass = isGroup ? 'user-card group-card' : 'user-card';
    const avatarStyle = isGroup ? 'border-radius:8px;' : '';
    const icon = isGroup ? '群' : getInitial(u.name);
    const tag = isGroup ? '<span class="group-tag">群聊</span>' : '';
    return `<div class="${cardClass}" data-uid="${escHtml(u.id)}">
      <div class="user-avatar" style="background:${getAvatarColor(u.id)};${avatarStyle}">${icon}</div>
      <div class="user-info">
        <div class="user-info-top">
          <span class="user-card-name">${escHtml(u.name)}${tag}</span>
          <span class="user-card-time">${u.lastTime ? formatDate(u.lastTime) : ''}</span>
        </div>
        <div class="user-card-preview">${escHtml((u.lastText || '').substring(0, 50))}</div>
      </div>
      <div class="user-card-right">
        ${getUnread(u.id, u.msgCount) > 0 ? '<span class="user-card-badge">' + getUnread(u.id, u.msgCount) + '</span>' : ''}
      </div>
    </div>`;
  }).join('');

  userListContainer.querySelectorAll('.user-card').forEach(card => {
    card.addEventListener('click', () => openUserChat(card.dataset.uid));
  });
}

// --- Chat detail: fetch from Feishu API ---
async function openUserChat(userId) {
  currentViewUser = userId;
  const u = userSummary[userId];
  if (u) markRead(userId, u.msgCount);
  const name = u ? u.name : userId.substring(0, 10);
  const isGroup = userId.startsWith('group:');

  chatDetailName.textContent = name;
  chatDetailSub.textContent = isGroup ? '群聊' : '';
  chatDetailHeader.style.display = 'flex';
  userListContainer.style.display = 'none';
  chatDetailContainer.style.display = 'block';
  chatDetailContainer.innerHTML = '<div class="chat-loading">加载聊天记录中...</div>';

  await loadChatDetail(userId, name);
}

async function loadChatDetail(userId, name) {
  chatPageToken = null;
  chatHasMore = false;
  chatLoadingMore = false;
  try {
    const isGroup = userId.startsWith('group:');
    const chatParam = isGroup ? `chatId=${encodeURIComponent(userId.replace('group:', ''))}` : `userId=${encodeURIComponent(userId)}`;
    const res = await apiFetch(apiUrl('/api/chat-messages', `${chatParam}&limit=50`));
    const data = await res.json();

    if (!data.ok) {
      chatDetailContainer.innerHTML = `<div class="chat-error">无法加载聊天记录: ${escHtml(data.error || '未知错误')}<br><br><span style="color:#484f58;font-size:13px">可能需要在飞书开放平台添加 <code>im:message</code> 权限</span></div>`;
      chatDetailSub.textContent = '加载失败';
      return;
    }

    const msgs = data.messages || [];
    chatDetailContainer.innerHTML = '';
    chatPageToken = data.page_token;
    chatHasMore = data.has_more;

    if (msgs.length === 0) {
      chatDetailContainer.innerHTML = '<div class="empty-state">暂无消息记录</div>';
      chatDetailSub.textContent = '0 条消息';
      return;
    }

    if (chatHasMore) {
      const hint = document.createElement('div');
      hint.className = 'chat-load-more';
      hint.id = 'chatLoadMore';
      hint.textContent = '↑ 上滑加载更早消息';
      chatDetailContainer.appendChild(hint);
    }

    for (const msg of msgs) {
      appendChatMsg(chatDetailContainer, msg);
    }

    chatDetailSub.textContent = `${msgs.length} 条消息${chatHasMore ? '+' : ''}`;
    chatPanel.scrollTop = chatPanel.scrollHeight;
  } catch (e) {
    chatDetailContainer.innerHTML = `<div class="chat-error">网络错误: ${escHtml(e.message)}</div>`;
  }
}

function appendChatMsg(container, msg) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${msg.role}`;
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  meta.textContent = `${msg.senderName} · ${formatDate(msg.time)}`;
  const body = document.createElement('div');
  body.className = 'chat-msg';
  body.textContent = msg.text;
  bubble.appendChild(meta);
  bubble.appendChild(body);
  container.appendChild(bubble);
}

async function loadMoreMessages() {
  if (!currentViewUser || !chatHasMore || !chatPageToken || chatLoadingMore) return;
  chatLoadingMore = true;
  const hint = document.getElementById('chatLoadMore');
  if (hint) { hint.textContent = '加载中...'; hint.className = 'chat-load-more loading'; }

  try {
    const isGroupMore = currentViewUser.startsWith('group:');
    const chatParamMore = isGroupMore ? `chatId=${encodeURIComponent(currentViewUser.replace('group:', ''))}` : `userId=${encodeURIComponent(currentViewUser)}`;
    const res = await apiFetch(apiUrl('/api/chat-messages', `${chatParamMore}&limit=50&page_token=${encodeURIComponent(chatPageToken)}`));
    const data = await res.json();
    if (!data.ok) { chatLoadingMore = false; return; }

    chatPageToken = data.page_token;
    chatHasMore = data.has_more;

    const msgs = data.messages || [];
    if (msgs.length === 0) { chatHasMore = false; }

    const oldScrollHeight = chatPanel.scrollHeight;
    const oldScrollTop = chatPanel.scrollTop;

    if (hint) hint.remove();

    const refNode = chatDetailContainer.firstChild;
    if (chatHasMore) {
      const newHint = document.createElement('div');
      newHint.className = 'chat-load-more';
      newHint.id = 'chatLoadMore';
      newHint.textContent = '↑ 上滑加载更早消息';
      chatDetailContainer.insertBefore(newHint, refNode);
    }

    const frag = document.createDocumentFragment();
    for (const msg of msgs) {
      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${msg.role}`;
      const meta = document.createElement('div');
      meta.className = 'chat-meta';
      meta.textContent = `${msg.senderName} · ${formatDate(msg.time)}`;
      const body = document.createElement('div');
      body.className = 'chat-msg';
      body.textContent = msg.text;
      bubble.appendChild(meta);
      bubble.appendChild(body);
      frag.appendChild(bubble);
    }

    const insertBefore = chatHasMore ? chatDetailContainer.children[1] : refNode;
    chatDetailContainer.insertBefore(frag, insertBefore);

    chatPanel.scrollTop = oldScrollTop + (chatPanel.scrollHeight - oldScrollHeight);

    const total = chatDetailContainer.querySelectorAll('.chat-bubble').length;
    chatDetailSub.textContent = `${total} 条消息${chatHasMore ? '+' : ''}`;
  } catch {}
  chatLoadingMore = false;
}

function closeUserChat() {
  currentViewUser = null;
  chatDetailHeader.style.display = 'none';
  chatDetailContainer.style.display = 'none';
  userListContainer.style.display = 'block';
  renderUserList();
}

document.getElementById('chatBackBtn').addEventListener('click', closeUserChat);

chatPanel.addEventListener('scroll', () => {
  if (currentViewUser && chatHasMore && chatPanel.scrollTop < 80) {
    loadMoreMessages();
  }
});
document.getElementById('chatRefreshBtn').addEventListener('click', () => {
  if (currentViewUser) {
    const u = userSummary[currentViewUser];
    loadChatDetail(currentViewUser, u ? u.name : '');
  }
});
