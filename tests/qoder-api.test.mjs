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
const { QoderAdapter } = await import('../lib/adapter.mjs');
const { PATHS } = await import('../lib/config.mjs');
const { readEncryptedJson } = await import('../lib/secret-store.mjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function catalogClient(options = {}) {
  const client = new QoderClient({ region: 'global', log: () => {}, ...options });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-catalog-token',
    user: { id: 'u-catalog', name: 'Catalog Tester' },
    source: 'token',
  }, { silent: true, persist: false });
  // 前面的用例会往临时目录写 catalog.json；这里明确从“无缓存”开始。
  client.catalogCache = { at: 0, models: [], error: '', staleMs: 0 };
  client.rawById = new Map();
  return client;
}

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

test('trial ignores literal null SSE frames instead of throwing', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const encoder = new TextEncoder();
  client.chat = async () => ({
    ok: true,
    text: async () => '',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: null\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"pong"}}],"usage":{"total_tokens":3}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
  });
  const result = await client.test({
    model: 'auto', prompt: 'ping', firstByteTimeoutMs: 2000, idleTimeoutMs: 2000,
  });
  assert.equal(result.text, 'pong');
  assert.equal(result.usage.total_tokens, 3);
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
  assert.equal(readEncryptedJson(PATHS.auth).accessToken, 'dt-test-access-token', '登录成功前凭据已经异步落盘');
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

test('an in-flight quota request from the previous account cannot overwrite the new account cache', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  const account = (id, token) => ({
    schemaVersion: 1,
    region: 'global',
    accessToken: token,
    user: { id, name: id },
    source: 'token',
  });
  client.setAuth(account('u-old', 'dt-old'), { silent: true });
  const releaseOld = deferred();
  const seen = [];
  await withFetch(async (url, options) => {
    const target = String(url);
    const auth = String(options?.headers?.authorization || '');
    seen.push(auth);
    if (target.endsWith('/api/v2/user/plan') || target.endsWith('/api/v2/quota/usage')) {
      if (auth.includes('dt-old')) {
        await releaseOld.promise;
        return json({ account: 'old' });
      }
      return json({ account: 'new' });
    }
    throw new Error(`unexpected request ${target}`);
  }, async () => {
    const oldTask = client.refreshExtras();
    await Promise.resolve();
    client.setAuth(account('u-new', 'dt-new'), { silent: true });
    const fresh = await client.refreshExtras();
    assert.equal(fresh.plan.account, 'new');
    releaseOld.resolve();
    const old = await oldTask;
    assert.equal(old.plan.account, 'old');
    assert.equal(client.extras.plan.account, 'new', 'old account must not overwrite the new cache');
    assert.equal(client.extras.quota.account, 'new');
    assert.equal(seen.filter((auth) => auth.includes('dt-old')).length, 2);
  });
});

test('trial times out when the upstream never returns response headers', async () => {
  const client = new QoderClient({
    region: 'global',
    log: () => {},
    transport: (_url, { signal }) => new Promise((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
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

  const started = Date.now();
  await assert.rejects(
    () => client.test({ model: 'auto', prompt: 'ping', firstByteTimeoutMs: 40 }),
    /首包/,
  );
  assert.ok(Date.now() - started < 2000);
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

test('catalog fetches are single-flight and stale cache returns immediately', async () => {
  const client = catalogClient({ catalogTtlMs: 60_000 });
  let calls = 0;
  let gate = deferred();
  client.fetchCatalog = async () => {
    calls += 1;
    await gate.promise;
    return {
      models: [{ id: 'auto', name: 'Auto' }],
      rawById: new Map([['auto', { id: 'auto', name: 'Auto' }]]),
    };
  };

  const first = client.listCatalog();
  const second = client.listCatalog();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1, '并发调用共享同一个目录请求');
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.models[0].id, 'auto');
  assert.equal(b.models[0].id, 'auto');
  assert.equal(calls, 1);
  assert.equal(client.rawModel('auto').name, 'Auto');

  client.catalogCache = {
    at: Date.now() - 120_000,
    models: [{ id: 'cached', name: 'Cached' }],
    error: '',
    staleMs: 0,
  };
  gate = deferred();
  const started = Date.now();
  const stale = await client.listCatalog();
  assert.ok(Date.now() - started < 50, '过期目录直接返回缓存，不等待上游');
  assert.equal(stale.models[0].id, 'cached');
  assert.ok(stale.staleMs >= 100_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2, '过期后触发一次后台刷新');
  const duplicate = await client.listCatalog();
  assert.equal(duplicate.models[0].id, 'cached');
  assert.equal(calls, 2, '后台刷新在途时不重复请求');
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const refreshed = await client.listCatalog();
  assert.equal(refreshed.models[0].id, 'auto');
  assert.equal(calls, 2);
});

test('catalog keeps stale models when refresh fails and throws only without cache', async () => {
  const client = catalogClient({ catalogTtlMs: 60_000 });
  client.catalogCache = {
    at: Date.now() - 120_000,
    models: [{ id: 'cached', name: 'Cached' }],
    error: '',
    staleMs: 0,
  };
  const gate = deferred();
  client.fetchCatalog = async () => {
    await gate.promise;
    throw new Error('catalog down');
  };
  const stale = await client.listCatalog();
  assert.equal(stale.models[0].id, 'cached');
  const job = client.catalogInflight;
  assert.ok(job, '后台刷新应已启动');
  gate.reject(new Error('catalog down'));
  const failed = await job;
  assert.equal(failed.models[0].id, 'cached');
  assert.match(failed.error, /catalog down/);
  const next = await client.listCatalog();
  assert.equal(next.models[0].id, 'cached');
  assert.match(next.error, /catalog down/);
  assert.ok(next.staleMs >= 100_000);

  const empty = catalogClient();
  empty.fetchCatalog = async () => { throw new Error('catalog down'); };
  await assert.rejects(() => empty.listCatalog(), /catalog down/);
});

test('prepareCall resolves from stale cache without waiting for a refresh', async () => {
  const client = catalogClient({ catalogTtlMs: 1000 });
  client.catalogCache = {
    at: Date.now() - 120_000,
    models: [{ id: 'auto', name: 'Auto', context_window: 200_000, supports_reasoning: false }],
    error: '',
    staleMs: 0,
  };
  const gate = deferred();
  client.fetchCatalog = async () => {
    await gate.promise;
    return {
      models: [{ id: 'auto', name: 'Fresh Auto' }],
      rawById: new Map([['auto', { id: 'auto', name: 'Fresh Auto' }]]),
    };
  };
  const adapter = new QoderAdapter({ provider: 'qoder', client, log: () => {} });
  const started = Date.now();
  const prepared = await adapter.prepareCall('qoder', 'auto', new AbortController().signal);
  assert.ok(Date.now() - started < 50, '目录过期不应挡住 prepareCall');
  assert.equal(prepared.model.id, 'auto');
  const job = client.catalogInflight;
  assert.ok(job, '应已转入后台刷新');
  gate.resolve();
  await job;
});

test('status can skip the desktop credential scan', () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const light = client.status({ desktop: false });
  assert.equal(Object.prototype.hasOwnProperty.call(light, 'desktop'), false);
  const full = client.status();
  assert.ok(Array.isArray(full.desktop.candidates));
});

test('desktop key prewarm is a no-op without official clients', async () => {
  const { prewarmDesktopKeysAsync } = await import('../lib/desktop-auth.mjs');
  await prewarmDesktopKeysAsync();
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});
