import test from 'node:test';
import assert from 'node:assert/strict';

import { createTools } from '../lib/tools.mjs';

const baseState = {
  version: '1.2.0',
  signedIn: true,
  account: { name: 'Tester', email: 'tester@example.com', plan: 'Pro' },
  regionLabel: 'Qoder 国际版',
  token: { source: 'desktop', expiresAt: Date.now() + 3600_000 },
  route: { registered: true, provider: 'qoder' },
  catalog: { count: 2, visibleCount: 1 },
  usage: {
    today: {
      requests: 3, tokens: 120, failures: 1, credits: 0.12, savedCredits: 0.01,
      successRate: 2 / 3, avgLatencyMs: 800, avgFirstByteMs: 120,
    },
    days: [
      { date: '2026-10-24', requests: 1, tokens: 50, failures: 0 },
      { date: '2026-10-25', requests: 3, tokens: 120, failures: 1 },
    ],
  },
  recentFailures: [{ at: Date.now(), model: 'alpha', status: 'http-500', error: 'boom' }],
  directory: [
    {
      id: 'alpha', name: 'Alpha', contextWindow: 200000, supportsImages: true,
      supportsReasoning: true, credits: 0.5, visible: true, pinned: true,
    },
    {
      id: 'beta', name: 'Beta', contextWindow: 128000, supportsImages: false,
      supportsReasoning: false, free: true, visible: false, pinned: false,
    },
  ],
  checks: [
    { label: '登录凭据', status: 'pass', detail: 'Tester' },
    { label: '模型目录', status: 'warn', detail: '目录为空' },
  ],
  lastError: '',
};

function tool(name, state = baseState) {
  const calls = [];
  const snapshot = async (options) => {
    calls.push(options);
    return state;
  };
  const definition = createTools({ snapshot }).find((item) => item.name === name);
  assert.ok(definition, `${name} should exist`);
  return { definition, calls };
}

test('qoder_status summarizes login, route, catalog and usage', async () => {
  const { definition, calls } = tool('qoder_status');
  const text = await definition.execute({}, { signal: new AbortController().signal });
  assert.match(text, /登录：已登录（Tester）/);
  assert.match(text, /套餐：Pro/);
  assert.match(text, /路由：已注册/);
  assert.match(text, /模型：目录 2 个/);
  assert.match(text, /今日：3 次请求/);
  assert.equal(calls[0].desktop, false);
  assert.ok(calls[0].signal, '工具调用应沿用宿主取消信号');
});

test('qoder_models filters by query and respects limit', async () => {
  const { definition } = tool('qoder_models');
  const all = await definition.execute({}, {});
  assert.match(all, /共 2 个模型，显示 2 个/);
  assert.match(all, /✓ alpha/);
  assert.match(all, /· beta/);
  const filtered = await definition.execute({ query: 'BETA', limit: 1 }, {});
  assert.match(filtered, /显示 1 个/);
  assert.match(filtered, /beta/);
  assert.doesNotMatch(filtered, /alpha/);
});

test('qoder_models explains the unauthenticated case', async () => {
  const { definition } = tool('qoder_models', { ...baseState, signedIn: false, directory: [] });
  const text = await definition.execute({}, {});
  assert.match(text, /尚未登录 Qoder/);
});

test('qoder_usage renders today, trend and recent failures', async () => {
  const { definition } = tool('qoder_usage');
  const text = await definition.execute({}, {});
  assert.match(text, /今日：3 次/);
  assert.match(text, /近 14 天/);
  assert.match(text, /2026-10-25  3 次/);
  assert.match(text, /最近失败/);
  assert.match(text, /alpha http-500 boom/);
});

test('qoder_diagnose maps every check to a readable line', async () => {
  const { definition, calls } = tool('qoder_diagnose');
  const text = await definition.execute({}, {});
  assert.match(text, /✓ 登录凭据/);
  assert.match(text, /! 模型目录/);
  assert.equal(calls[0].deep, true);
  assert.equal(calls[0].desktop, false);
});
