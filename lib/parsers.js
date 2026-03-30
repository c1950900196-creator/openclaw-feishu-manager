const fs = require('fs');
const path = require('path');

function getLogFile(logDir) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(logDir, `openclaw-${y}-${m}-${day}.log`);
}

function parseLogLine(raw) {
  try {
    const obj = JSON.parse(raw);
    const time = obj.time || obj._meta?.date || '';
    const level = obj._meta?.logLevelName || 'INFO';
    let subsystem = '';
    let message = '';

    if (typeof obj['0'] === 'string') {
      const m = obj['0'].match(/^\{?"?subsystem"?:\s*"([^"]+)"/);
      if (m) subsystem = m[1];
      else message = obj['0'];
    }
    if (typeof obj['1'] === 'string') message = obj['1'];
    else if (typeof obj['1'] === 'object' && obj['1'] !== null) message = JSON.stringify(obj['1']);
    if (obj['2'] && typeof obj['2'] === 'string') message = obj['2'];

    let type = 'system';
    if (subsystem.includes('feishu') && message.includes('received message')) type = 'message_in';
    else if (subsystem.includes('feishu') && message.includes('dispatch complete')) type = 'message_done';
    else if (subsystem.includes('feishu') && message.includes('DM from')) type = 'message_content';
    else if (subsystem.includes('feishu') && message.match(/message in group oc_\S+:/)) type = 'group_message_content';
    else if (subsystem.includes('feishu') && message.includes('dispatching to agent')) type = 'task_start';
    else if (subsystem.includes('feishu') && message.includes('group session scope=group')) type = 'group_session';
    else if (subsystem.includes('agent/embedded') && message.includes('run agent end')) type = 'task_end';
    else if (message.includes('error') || message.includes('Error') || level === 'ERROR') type = 'error';
    else if (subsystem.includes('gateway') && message.includes('listening')) type = 'startup';

    return { time, level, subsystem, message, type, raw: raw.substring(0, 500) };
  } catch {
    return {
      time: new Date().toISOString(),
      level: 'RAW',
      subsystem: '',
      message: raw.substring(0, 300),
      type: 'raw',
      raw: raw.substring(0, 500),
    };
  }
}

function getLatestLogFile(logDir) {
  try {
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith('openclaw-') && f.endsWith('.log')).sort();
    if (files.length > 0) return path.join(logDir, files[files.length - 1]);
  } catch {}
  return null;
}

function parseSessionEvent(line) {
  try {
    const ev = JSON.parse(line);
    if (ev.type !== 'message' || !ev.message) return null;
    const msg = ev.message;
    const ts = ev.timestamp || msg.timestamp;
    const role = msg.role;
    const model = msg.model || '';
    const usage = msg.usage;

    if (role === 'assistant' && msg.content) {
      for (const block of msg.content) {
        if (block.type === 'toolCall') {
          const name = block.name || 'unknown';
          let argSummary = '';
          const args = block.arguments || {};
          if (name === 'exec') argSummary = (args.command || '').substring(0, 120);
          else if (name === 'edit' || name === 'file_write') argSummary = args.path || '';
          else if (name === 'message') argSummary = (args.text || args.content || '').substring(0, 80);
          else if (name === 'browser_navigate') argSummary = args.url || '';
          else argSummary = JSON.stringify(args).substring(0, 80);
          const costStr = usage ? ` · $${usage.cost?.total?.toFixed(4) || '?'}` : '';
          return { type: 'session_tool_call', time: ts, subsystem: 'agent', message: `[tool] ${name}: ${argSummary}`, model, cost: costStr };
        }
        if (block.type === 'text' && block.text) {
          const text = block.text.replace(/\[\[reply_to_current\]\]/g, '').trim();
          if (!text) continue;
          const preview = text.substring(0, 120).replace(/\n/g, ' ');
          const costStr = usage ? ` · $${usage.cost?.total?.toFixed(4) || '?'}` : '';
          return { type: 'session_reply', time: ts, subsystem: 'agent', message: `[reply] ${preview}${text.length > 120 ? '...' : ''}`, model, cost: costStr };
        }
      }
    }

    if (role === 'toolResult') {
      const toolName = msg.toolName || '';
      const isError = msg.isError || (msg.details && msg.details.isError);
      const exitCode = msg.details?.exitCode;
      let resultPreview = '';
      if (msg.content && msg.content[0] && msg.content[0].text) resultPreview = msg.content[0].text.substring(0, 100).replace(/\n/g, ' ');
      const statusStr = isError ? '❌ ERROR' : (exitCode !== undefined ? `exit=${exitCode}` : '✓');
      return { type: isError ? 'session_tool_error' : 'session_tool_result', time: ts, subsystem: 'agent', message: `[result] ${toolName} ${statusStr}: ${resultPreview}` };
    }

    if (role === 'user') {
      const textBlocks = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text);
      if (textBlocks.length) {
        const text = textBlocks.join(' ').substring(0, 120).replace(/\n/g, ' ');
        return { type: 'session_user_input', time: ts, subsystem: 'agent', message: `[input] ${text}` };
      }
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { getLogFile, parseLogLine, getLatestLogFile, parseSessionEvent };
