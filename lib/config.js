const path = require('path');

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

const PORT = parseInt(process.env.DIANA_MONITOR_PORT || '18790', 10);
const ACCESS_TOKEN = requireEnv('DIANA_MONITOR_ACCESS_TOKEN');
const MAX_HISTORY = 2000;
const MAX_RECENT_LOGS = 200;

const SKILLS_DIR = '/home/ubuntu/.npm-global/lib/node_modules/openclaw/skills';
const WORKSPACE_SKILLS_DIR = '/home/ubuntu/.openclaw/workspace/skills';

// Token pricing per 1M tokens, USD
const TOKEN_PRICING = {
  'gpt-5.4': { input: 2.50, output: 15.00, cacheRead: 0.25 },
  'gpt-5.2': { input: 1.75, output: 14.00, cacheRead: 0.175 },
  'gpt-4.1': { input: 2.00, output: 8.00, cacheRead: 0.50 },
  'gpt-4o': { input: 2.50, output: 10.00, cacheRead: 1.25 },
  'claude-opus-4-6': { input: 15.00, output: 75.00, cacheRead: 1.50 },
  'qwen3.5-plus': { input: 0.80, output: 2.00, cacheRead: 0.20 },
};

const BOTS = {
  diana: {
    name: 'Diana',
    feishuAppId: requireEnv('DIANA_FEISHU_APP_ID'),
    feishuAppSecret: requireEnv('DIANA_FEISHU_APP_SECRET'),
    logDir: '/tmp/openclaw-1000',
    sessionsDir: '/home/ubuntu/.openclaw/agents/main/sessions',
    dataDir: path.resolve(__dirname, '..'),
    openclawBin: '/home/ubuntu/.npm-global/bin/openclaw',
    openclawToken: requireEnv('DIANA_OPENCLAW_TOKEN'),
    useCli: true,
  },
  jax: {
    name: 'Jax',
    feishuAppId: requireEnv('JAX_FEISHU_APP_ID'),
    feishuAppSecret: requireEnv('JAX_FEISHU_APP_SECRET'),
    logDir: path.resolve(__dirname, '../bots/jax/logs'),
    sessionsDir: path.resolve(__dirname, '../bots/jax/sessions'),
    dataDir: path.resolve(__dirname, '../bots/jax'),
    useCli: false,
    usageCostFile: path.resolve(__dirname, '../bots/jax/usage-cost.json'),
    cronListFile: path.resolve(__dirname, '../bots/jax/cron-list.json'),
  },
};

const DEFAULT_BOT = 'diana';

module.exports = {
  PORT,
  ACCESS_TOKEN,
  MAX_HISTORY,
  MAX_RECENT_LOGS,
  SKILLS_DIR,
  WORKSPACE_SKILLS_DIR,
  TOKEN_PRICING,
  BOTS,
  DEFAULT_BOT,
};
