const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');

function createFeishuService(ctx) {
  const {
    BOTS,
    DEFAULT_BOT,
    botState,
    saveVoiceTranscripts,
    saveNames,
    saveGroupNames,
  } = ctx;

  const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

  function httpJson(options, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('parse error')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
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
        headers: { 'Content-Type': 'application/json' },
      }, { app_id: cfg.feishuAppId, app_secret: cfg.feishuAppSecret });
      if (data.code === 0) {
        st.tenantToken = data.tenant_access_token;
        st.tokenExpiry = Date.now() + (data.expire - 120) * 1000;
        return st.tenantToken;
      }
    } catch {}
    return null;
  }

  async function recognizeAudio(messageId, fileKey, botId) {
    const bid = botId || DEFAULT_BOT;
    const vt = botState[bid].voiceTranscripts;
    const pr = botState[bid]._pendingRecognize;
    if (!OPENAI_API_KEY) {
      console.error('recognizeAudio disabled: OPENAI_API_KEY is missing');
      vt[messageId] = '[语音识别失败]';
      saveVoiceTranscripts(bid);
      return null;
    }
    if (vt[messageId]) return vt[messageId];
    if (pr.has(messageId)) return null;
    pr.add(messageId);
    try {
      const feishuToken = await getTenantToken(bid);
      if (!feishuToken) throw new Error('no feishu token');

      const audioData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'open.feishu.cn',
          path: `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
          method: 'GET',
          headers: { Authorization: `Bearer ${feishuToken}` },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
          req.destroy();
          reject(new Error('download timeout'));
        });
        req.end();
      });

      if (audioData.length < 100) throw new Error('audio too small: ' + audioData.length);
      const safeId = messageId.replace(/[^a-zA-Z0-9_]/g, '');
      const tmpOpus = `/tmp/voice_${safeId}.opus`;
      const tmpMp3 = `/tmp/voice_${safeId}.mp3`;
      fs.writeFileSync(tmpOpus, audioData);
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-y', '-i', tmpOpus, '-ar', '16000', '-ac', '1', '-b:a', '64k', tmpMp3], { timeout: 15000 });
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))));
        proc.on('error', reject);
      });
      const mp3Data = fs.readFileSync(tmpMp3);
      try { fs.unlinkSync(tmpOpus); } catch {}
      try { fs.unlinkSync(tmpMp3); } catch {}

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
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('parse error')); }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
          req.destroy();
          reject(new Error('whisper timeout'));
        });
        req.write(body);
        req.end();
      });

      if (result.text) {
        vt[messageId] = result.text;
        saveVoiceTranscripts(bid);
        console.log('Voice recognized [' + bid + ']:', messageId, '->', result.text.substring(0, 60));
        return result.text;
      }
      throw new Error('Whisper error: ' + JSON.stringify(result));
    } catch (e) {
      console.error('recognizeAudio error:', messageId, e.message);
      vt[messageId] = '[语音识别失败]';
      saveVoiceTranscripts(bid);
      return null;
    } finally {
      pr.delete(messageId);
    }
  }

  async function resolveUserName(openId, botId) {
    const bid = botId || DEFAULT_BOT;
    if (!openId) return '';
    const un = botState[bid].userNames;
    if (un[openId]) return un[openId];
    const token = await getTenantToken(bid);
    if (!token) return openId.substring(0, 10);
    try {
      const data = await httpJson({
        hostname: 'open.feishu.cn',
        path: `/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const name = data?.data?.user?.name || '';
      if (name) {
        un[openId] = name;
        saveNames(bid);
        return name;
      }
    } catch {}
    return openId.substring(0, 10);
  }

  async function resolveGroupName(chatId, botId) {
    const bid = botId || DEFAULT_BOT;
    if (!chatId) return '';
    const gn = botState[bid].groupNames;
    if (gn[chatId]) return gn[chatId];
    const token = await getTenantToken(bid);
    if (!token) return chatId.substring(0, 12);
    try {
      const data = await httpJson({
        hostname: 'open.feishu.cn',
        path: `/open-apis/im/v1/chats/${chatId}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const name = data?.data?.name || '';
      if (name) {
        gn[chatId] = name;
        saveGroupNames(bid);
        return name;
      }
    } catch {}
    return chatId.substring(0, 12);
  }

  async function fetchChatMessages(chatId, pageSize, pageToken, botId) {
    const bid = botId || DEFAULT_BOT;
    const token = await getTenantToken(bid);
    if (!token) return { ok: false, error: 'no token' };
    try {
      const size = pageSize || 50;
      const data = await httpJson({
        hostname: 'open.feishu.cn',
        path: `/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${size}&sort_type=ByCreateTimeDesc${pageToken ? '&page_token=' + pageToken : ''}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (data.code !== 0) return { ok: false, error: data.msg || 'api error', code: data.code };

      const items = (data.data?.items || []).reverse();
      const messages = [];
      for (const item of items) {
        const sender = item.sender || {};
        const senderId = sender.id || '';
        const senderType = sender.sender_type || '';
        const isBot = senderType === 'app';
        const rawTs = parseInt(item.create_time || '0', 10);
        const createTime = rawTs ? new Date(rawTs > 1e12 ? rawTs : rawTs * 1000).toISOString() : '';
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
            const vt2 = botState[bid].voiceTranscripts;
            const cached = vt2[mid];
            if (cached) text = cached === '[语音识别失败]' ? cached : '[语音] ' + cached;
            else if (fk && mid) {
              recognizeAudio(mid, fk, bid).catch(() => {});
              text = '[语音识别中...]';
            } else text = '[语音]';
          } else if (msgType === 'video') text = '[视频]';
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
            const useful = cardTexts.filter((t) => t && !t.includes('请升级至最新版本'));
            if (cardTitle) text = cardTitle + (useful.length ? ': ' + useful.join(' ') : '');
            else if (useful.length) text = useful.join(' ');
            else text = '[卡片消息 - 请在飞书查看]';
          } else if (msgType === 'system') text = '[系统消息]';
          else text = `[${msgType}]`;
        } catch {
          text = '[无法解析]';
        }

        messages.push({
          role: isBot ? 'diana' : 'user',
          senderId,
          senderName: isBot ? (BOTS[bid]?.name || 'Bot') : (botState[bid].userNames[senderId] || senderId.substring(0, 10)),
          text,
          time: createTime,
          msgType,
        });
      }
      return { ok: true, messages, page_token: data.data?.page_token || null, has_more: !!data.data?.has_more };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { getTenantToken, recognizeAudio, resolveUserName, resolveGroupName, fetchChatMessages };
}

module.exports = { createFeishuService };
