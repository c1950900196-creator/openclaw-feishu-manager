// --- Skills ---
let skillsLoaded = false;

async function loadSkills() {
  const panel = document.getElementById('skillsPanel');
  panel.innerHTML = '<div class="empty-state">加载技能列表...</div>';
  try {
    const data = window._skillsCache || await apiFetch(apiUrl('/api/skills')).then(r => r.json());
    window._skillsCache = null;
    if (!data.ok || !data.skills.length) {
      panel.innerHTML = '<div class="empty-state">暂无技能</div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'skills-grid';
    data.skills.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
    for (const skill of data.skills) {
      const card = document.createElement('div');
      card.className = 'skill-card';
      const totalSize = skill.files.reduce((s, f) => s + f.size, 0);
      const srcLabel = skill.source === 'workspace' ? '自定义' : '内置';
      const srcClass = skill.source === 'workspace' ? '' : 'builtin';
      const topFiles = skill.files.filter(f => !f.isDir);
      const dirFiles = skill.files.filter(f => f.isDir);
      const fileCountLabel = dirFiles.length > 0 ? `${topFiles.length} 文件 · ${dirFiles.length} 文件夹` : `${skill.files.length} 文件`;
      card.innerHTML = `
        <span class="skill-source-badge ${srcClass}">${srcLabel}</span>
        <div class="skill-card-header">
          <span class="skill-card-emoji">${skill.emoji || '📦'}</span>
          <span class="skill-card-name">${escHtml(skill.name)}</span>
        </div>
        <div class="skill-card-desc">${escHtml(skill.description) || '<span style=color:#484f58>暂无描述</span>'}</div>
        <div class="skill-card-meta">
          <span>${fileCountLabel}</span>
          <span>${formatSize(totalSize)}</span>
          <div class="skill-card-actions">
            <button class="skill-btn" onclick="event.stopPropagation();viewSkillDetail('${encodeURIComponent(skill.id)}')">查看</button>
            <button class="skill-btn primary" onclick="event.stopPropagation();downloadSkill('${encodeURIComponent(skill.id)}')">下载</button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    }
    panel.innerHTML = '';
    panel.appendChild(grid);
  } catch (e) {
    panel.innerHTML = `<div class="empty-state" style="color:#f85149">加载失败: ${escHtml(e.message)}</div>`;
  }
}

async function downloadSkill(encodedSkillId) {
  const skillId = decodeURIComponent(encodedSkillId);
  try {
    const res = await apiFetch(apiUrl(`/api/skills/${encodeURIComponent(skillId)}/download`));
    if (!res.ok) throw new Error('下载失败: HTTP ' + res.status);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = `${skillId}.skill`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch (e) {
    alert('下载失败: ' + e.message);
  }
}

async function viewSkillDetail(skillId) {
  skillId = decodeURIComponent(skillId);
  const overlay = document.createElement('div');
  overlay.className = 'skill-detail-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const modal = document.createElement('div');
  modal.className = 'skill-detail-modal';
  modal.innerHTML = '<div style="text-align:center;padding:20px;color:#484f58">加载中...</div>';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  try {
    const res = await apiFetch(apiUrl(`/api/skills/${encodeURIComponent(skillId)}/readme`));
    const data = await res.json();
    if (data.ok) {
      let filesHtml = '';
      if (data.files && data.files.length) {
        filesHtml = '<div style="margin-top:16px;padding:12px;background:#0d1117;border-radius:8px;font-size:12px"><div style="color:#8b949e;margin-bottom:8px;font-weight:600">文件结构</div>';
        for (const f of data.files) {
          if (f.isDir) {
            filesHtml += `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#58a6ff"><span>📁 ${escHtml(f.name)} (${f.fileCount} 个文件)</span><span style="color:#484f58">${formatSize(f.size)}</span></div>`;
          } else {
            filesHtml += `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#8b949e"><span>📄 ${escHtml(f.name)}</span><span style="color:#484f58">${formatSize(f.size)}</span></div>`;
          }
        }
        filesHtml += '</div>';
      }
      modal.innerHTML = `<button class="skill-detail-close" onclick="this.closest('.skill-detail-overlay').remove()">✕</button><pre>${escHtml(data.content)}</pre>${filesHtml}`;
    } else {
      modal.innerHTML = `<button class="skill-detail-close" onclick="this.closest('.skill-detail-overlay').remove()">✕</button><div style="color:#f85149;padding:20px">加载失败</div>`;
    }
  } catch {
    modal.innerHTML = `<button class="skill-detail-close" onclick="this.closest('.skill-detail-overlay').remove()">✕</button><div style="color:#f85149;padding:20px">网络错误</div>`;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}


// --- Stop All ---
document.getElementById('stopAllBtn').addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'stop-confirm';
  overlay.innerHTML = `
    <div class="stop-confirm-box">
      <div class="stop-confirm-title">停止所有任务</div>
      <div class="stop-confirm-desc">确定要中止 Diana 当前正在执行的所有任务吗？<br>已发送的回复不会被撤回。</div>
      <div class="stop-confirm-actions">
        <button class="stop-confirm-cancel" id="stopCancelBtn">取消</button>
        <button class="stop-confirm-ok" id="stopConfirmBtn">确认停止</button>
      </div>
      <div class="stop-result" id="stopResult" style="display:none"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#stopCancelBtn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#stopConfirmBtn').addEventListener('click', async () => {
    const btn = overlay.querySelector('#stopConfirmBtn');
    const result = overlay.querySelector('#stopResult');
    btn.textContent = '正在停止...';
    btn.disabled = true;
    result.style.display = 'block';
    result.textContent = '发送中止请求...';

    try {
      const res = await apiFetch(apiUrl('/api/stop-all'), { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        const aborted = data.results.filter(r => r.ok && r.result?.aborted).length;
        result.innerHTML = `<div style="color:#3fb950;margin-bottom:6px">完成</div>` +
          `<div>发现 ${data.sessionsFound} 个活跃会话</div>` +
          `<div>成功中止 ${aborted} 个任务</div>` +
          data.results.map(r => `<div style="margin-top:4px;color:${r.ok ? '#8b949e' : '#f85149'}">${r.key.split(':').slice(-1)[0].substring(0,12)}... ${r.ok ? (r.result?.aborted ? 'aborted' : 'no active run') : r.error}</div>`).join('');
        btn.textContent = '已完成';
        setTimeout(() => overlay.remove(), 3000);
      } else {
        result.innerHTML = `<div style="color:#f85149">失败: ${escHtml(data.error || '未知错误')}</div>`;
        btn.textContent = '失败';
      }
    } catch (e) {
      result.innerHTML = `<div style="color:#f85149">网络错误: ${escHtml(e.message)}</div>`;
      btn.textContent = '失败';
    }
  });
});

// 并行预加载所有数据
function loadChatList() {
  Object.keys(userSummary).forEach(k => delete userSummary[k]);
  Object.keys(nameCache).forEach(k => delete nameCache[k]);
  Object.keys(groupNameCache).forEach(k => delete groupNameCache[k]);
  userListContainer.innerHTML = '<div class="empty-state" id="chatEmpty">加载中...</div>';
  return Promise.all([
    loadHistory(),
    apiFetch(apiUrl('/api/group-names')).then(r => r.json()).then(d => Object.assign(groupNameCache, d)).catch(() => {}),
  ]);
}
loadChatList().then(() => connectWs());

// 后台预加载 skills 和 token-usage 数据（不阻塞初始渲染）
setTimeout(() => {
  if (!skillsLoaded) {
    apiFetch(apiUrl('/api/skills')).then(r => r.json()).then(data => {
      if (data.ok) window._skillsCache = data;
    }).catch(() => {});
  }
  // 预加载 token-usage 数据
  if (!tokensLoaded) {
    apiFetch(apiUrl('/api/token-usage', 'days=30')).then(r => r.json()).then(data => {
      if (data.ok) window._tokenCache = data;
    }).catch(() => {});
  }
}, 300);
