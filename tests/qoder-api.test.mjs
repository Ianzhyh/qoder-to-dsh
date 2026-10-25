import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'qoder-api-'));
process.env.DSH_HOME = home;
process.env.QODER_TO_DSH_HOME = join(home, 'qoder');
process.env.APPDATA = join(home, 'appdata');
process.env.USERPROFILE = join(home, 'user');
process.env.QODER_REGION = 'global';

const { QoderClient } = await import('../lib/qoder-api.mjs');
const { normalizeCatalog } = await import('../lib/qoder-api.mjs');

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

async function withFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('disk catalog restores raw model metadata for the first request after restart', () => {
  mkdirSync(process.env.QODER_TO_DSH_HOME, { recursive: true });
  writeFileSync(join(process.env.QODER_TO_DSH_HOME, 'catalog.json'), JSON.stringify({
    at: Date.now(),
    region: 'global',
    schema: 4,
    models: [{
      id: 'vision', key: 'vision', name: 'Vision', display_name: 'Vision',
      context_window: 96000, context_window_max: 96000, max_input_tokens: 96000,
      max_output_tokens: 8192, supports_images: true, supports_reasoning: true,
      reasoning_efforts: ['low', 'high'], official: true,
    }],
  }));

  const client = new QoderClient({ region: 'global', log: () => {} });
  const raw = client.rawModel('vision');
  assert.ok(raw, '缓存模型应能重建 raw 索引');
  assert.equal(raw.supports_images, true);
  const body = client.buildChatBody({
    model: 'vision',
    messages: [{ role: 'user', content: 'describe' }],
    stream: true,
  }, raw);
  assert.equal(body.model_config.is_vl, true);
  assert.equal(body.model_config.is_reasoning, true);
  assert.equal(body.model_config.max_input_tokens, 96000);
  assert.equal(body.model_config.display_name, 'Vision');
  assert.equal(body.parameters.max_tokens, 32_768, '自动输出对齐 Qoder CLI 的 32K 默认');
  assert.ok(!Object.prototype.hasOwnProperty.call(body.parameters, 'temperature'), '自动温度不传 temperature');

  const capped = client.buildChatBody({
    model: 'vision',
    messages: [{ role: 'user', content: 'describe' }],
    max_tokens: 8192,
    contextWindow: 1000000,
  }, raw);
  assert.equal(capped.parameters.max_tokens, 8192);
  assert.equal(capped.model_config.max_input_tokens, 1000000, '选择的 1M 上下文必须写回请求');

  client.invalidateCatalog();
  assert.equal(client.rawModel('vision'), null, '切换账号/刷新失败后不能残留旧目录');
});

test('catalog uses the effective price factor, not the crossed-out original price', () => {
  const { models } = normalizeCatalog({
    chat: [
      {
        key: 'free-model', display_name: 'Free', is_free: true,
        price_factor: 0, original_price_factor: 0.1,
      },
      {
        key: 'promo-model', display_name: 'Promo',
        price_factor: 0.5,
        promotion: { active: true, discount_factor: 0.4, before_promotion_price_factor: 0.5 },
      },
      { key: 'paid-model', display_name: 'Paid', price_factor: 0.8, original_price_factor: 1 },
    ],
  });
  const byId = Object.fromEntries(models.map((model) => [model.id, model]));
  assert.equal(byId['free-model'].credits, 0);
  assert.equal(byId['free-model'].free, true);
  assert.equal(byId['promo-model'].credits, 0.2);
  assert.equal(byId['promo-model'].promotion_active, true);
  assert.equal(byId['paid-model'].credits, 0.8, '没有促销时不能取划线原价');
  assert.equal(byId['paid-model'].free, false);
});

test('importPat exchanges identity and stores a token-sourced account', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  await withFetch(async (url) => {
    assert.match(String(url), /\/api\/v1\/userinfo$/);
    return json({ id: 'u-1', name: 'Token Tester', email: 'tester@example.com', user_type: 'personal_professional' });
  }, async () => {
    const result = await client.importPat('dt-test-access-token', 'global');
    assert.equal(result.status, 'ready');
    assert.equal(result.account.name, 'Token Tester');
  });
  assert.equal(client.auth.source, 'token');
  assert.equal(client.auth.region, 'global');
  assert.equal(client.auth.user.email, 'tester@example.com');
  assert.equal(client.status().account.sourceLabel, '访问令牌');
});

test('device authorization polls into a persisted account for the requested region', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  let authChanges = 0;
  client.onAuthChange = () => { authChanges += 1; };
  await withFetch(async (url) => {
    const target = String(url);
    if (target.includes('/api/v1/deviceToken/poll')) {
      return json({ token: 'dt-device-token', refresh_token: 'drt-device-refresh', expires_in: 3600 });
    }
    if (target.endsWith('/api/v1/userinfo')) {
      return json({ id: 'u-2', name: 'Device Tester', user_type: 'personal_professional' });
    }
    throw new Error(`unexpected request ${target}`);
  }, async () => {
    const started = await client.beginDeviceAuth('cn');
    assert.match(started.verificationUri, /\/device\/selectAccounts\?/);
    assert.match(started.verificationUri, /client_id=/);
    const result = await client.pollDeviceAuth(started.id);
    assert.equal(result.status, 'ready');
    assert.equal(result.account.name, 'Device Tester');
  });
  assert.equal(authChanges, 1);
  assert.equal(client.auth.source, 'oauth');
  assert.equal(client.auth.region, 'cn');
  assert.equal(client.status().regionLabel, 'Qoder 国内版');
});

test('refreshExtras refreshes an expired token once and retries both quota endpoints', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-old-token',
    refreshToken: 'drt-refresh-token',
    expiresAt: Date.now() + 3600_000,
    user: { id: 'u-3', name: 'Quota Tester' },
    source: 'token',
  }, { silent: true, persist: false });

  const seen = [];
  const extras = await withFetch(async (url, options) => {
    const target = String(url);
    const auth = String(options?.headers?.authorization || '');
    seen.push({ target, auth });
    if (target.includes('/api/v1/deviceToken/refresh')) {
      return json({ token: 'dt-new-token', refresh_token: 'drt-new-refresh', expires_in: 3600 });
    }
    if (target.endsWith('/api/v2/user/plan')) {
      return auth.includes('dt-new-token')
        ? json({ plan_tier_name: 'Pro Trial', is_paid_plan: false })
        : json({ message: 'expired' }, 401);
    }
    if (target.endsWith('/api/v2/quota/usage')) {
      return auth.includes('dt-new-token')
        ? json({ userQuota: { total: 300, used: 100, remaining: 200, unit: 'credits' } })
        : json({ message: 'expired' }, 401);
    }
    throw new Error(`unexpected request ${target}`);
  }, () => client.refreshExtras());

  assert.equal(seen.filter((item) => item.target.includes('/api/v1/deviceToken/refresh')).length, 1);
  assert.equal(extras.plan.plan_tier_name, 'Pro Trial');
  assert.equal(extras.quota.userQuota.remaining, 200);
  assert.equal(client.auth.accessToken, 'dt-new-token');
  assert.equal(client.auth.refreshToken, 'drt-new-refresh');
  const planCalls = seen.filter((item) => item.target.endsWith('/api/v2/user/plan'));
  assert.equal(planCalls.length, 2);
  assert.match(planCalls.at(-1).auth, /dt-new-token/);
});

test('refreshExtras exchanges a refresh-only credential before fetching quota', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: '',
    refreshToken: 'drt-only-token',
    user: { id: 'u-4', name: 'Refresh Only' },
    source: 'token',
  }, { silent: true, persist: false });

  const seen = [];
  const extras = await withFetch(async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.includes('/api/v1/deviceToken/refresh')) {
      return json({ token: 'dt-exchanged-token', refresh_token: 'drt-next-token', expires_in: 3600 });
    }
    if (target.endsWith('/api/v2/user/plan')) return json({ plan_tier_name: 'Refresh Plan' });
    if (target.endsWith('/api/v2/quota/usage')) return json({ userQuota: { remaining: 42, total: 100, unit: 'credits' } });
    throw new Error(`unexpected request ${target}`);
  }, () => client.refreshExtras());

  assert.equal(seen[0].includes('/api/v1/deviceToken/refresh'), true);
  assert.equal(extras.plan.plan_tier_name, 'Refresh Plan');
  assert.equal(extras.quota.userQuota.remaining, 42);
  assert.equal(client.auth.accessToken, 'dt-exchanged-token');
  assert.equal(client.status().token.needsRefresh, false);
});

test('trial times out when the upstream never returns response headers', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-hang-token',
    refreshToken: 'drt-hang-refresh',
    expiresAt: Date.now() + 3600_000,
    user: { id: 'u-7', name: 'Hang Tester' },
    source: 'token',
  }, { silent: true, persist: false });
  // 目录请求走 https 模块，不能靠 mock fetch 拦截；这里直接让 rawModel 缺失时不做目录探测。
  client.listCatalog = async () => ({ models: [], at: Date.now(), staleMs: 0, error: '' });

  await withFetch((_url, options) => new Promise((_, reject) => {
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }), async () => {
    const started = Date.now();
    await assert.rejects(
      () => client.test({ model: 'auto', prompt: 'ping', firstByteTimeoutMs: 40 }),
      /首包/,
    );
    assert.ok(Date.now() - started < 2000);
  });
});

test('status surfaces plan, quota remaining and refresh-only token state', () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-status-token',
    refreshToken: 'drt-status-refresh',
    user: { id: 'u-5', name: 'Status Tester' },
    source: 'desktop',
  }, { silent: true, persist: false });
  client.extras = {
    plan: { plan_tier_name: 'Pro Plan' },
    quota: { userQuota: { remaining: 42 }, addOnQuota: { remaining: 8 } },
  };
  const status = client.status();
  assert.equal(status.account.plan, 'Pro Plan');
  assert.equal(status.account.credits, 50);
  assert.equal(status.token.needsRefresh, false);

  const refreshOnly = new QoderClient({ region: 'global', log: () => {} });
  refreshOnly.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: '',
    refreshToken: 'drt-only',
    user: { id: 'u-6', name: 'Refresh Only' },
    source: 'desktop',
  }, { silent: true, persist: false });
  assert.equal(refreshOnly.status().token.needsRefresh, true);
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});
