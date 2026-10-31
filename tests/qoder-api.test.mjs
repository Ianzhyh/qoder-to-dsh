import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const home = mkdtempSync(join(tmpdir(), 'qoder-api-'));
process.env.DSH_HOME = home;
process.env.QODER_TO_DSH_HOME = join(home, 'qoder');
process.env.APPDATA = join(home, 'appdata');
process.env.USERPROFILE = join(home, 'user');
process.env.QODER_REGION = 'global';

const { QoderClient, shouldAdoptDesktopAuth } = await import('../lib/qoder-api.mjs');
const { normalizeCatalog } = await import('../lib/qoder-api.mjs');
const { QoderAdapter, StreamTranslator, CODE } = await import('../lib/adapter.mjs');
const { PATHS, DEFAULTS } = await import('../lib/config.mjs');
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

const envelope = (inner) => `data: ${JSON.stringify({
  statusCodeValue: 200,
  body: typeof inner === 'string' ? inner : JSON.stringify(inner),
})}\n\n`;

function streamClient(chunks) {
  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-stream-token',
    user: { id: 'u-stream', name: 'Stream Tester' },
    source: 'token',
  }, { silent: true, persist: false });
  client.listCatalog = async () => ({ models: [], at: Date.now(), staleMs: 0, error: '' });
  const encoder = new TextEncoder();
  client.transport = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    text: async () => '',
    drain() {},
  });
  return client;
}

function translated(text) {
  const translator = new StreamTranslator();
  for (const line of text.split('\n')) translator.pushLine(line);
  return translator.finish();
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
    account: 'u-cache',
    schema: 5,
    models: [{
      id: 'vision', key: 'vision', name: 'Vision', display_name: 'Vision',
      context_window: 96000, context_window_max: 96000, max_input_tokens: 96000,
      max_output_tokens: 8192, supports_images: true, supports_reasoning: true,
      reasoning_efforts: ['low', 'high'], official: true,
    }],
  }));

  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-cache-token',
    user: { id: 'u-cache', name: 'Cache Tester' },
    source: 'token',
  }, { silent: true, persist: false });
  client.loadDiskCatalog();
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

test('disk catalog cache is account-scoped after a switch', () => {
  writeFileSync(join(process.env.QODER_TO_DSH_HOME, 'catalog.json'), JSON.stringify({
    at: Date.now(),
    region: 'global',
    account: 'u-old',
    schema: 5,
    models: [{
      id: 'old-only', key: 'old-only', name: 'Old only',
      context_window: 96000, max_output_tokens: 8192, official: true,
    }],
  }));

  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-new-token',
    user: { id: 'u-new', name: 'New Account' },
    source: 'token',
  }, { silent: true, persist: false });
  client.loadDiskCatalog();
  assert.equal(client.rawModel('old-only'), null, '另一个账号的目录不能在新账号启动时恢复');
  assert.equal(client.catalogCache.models.length, 0);
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

test('a 200 error envelope is not mistaken for an empty catalog', () => {
  assert.throws(
    () => normalizeCatalog({ code: 105, message: 'session expired' }),
    /模型目录响应异常/,
  );
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

test('envelope translation does not invent [DONE] when the upstream closes early', async () => {
  const client = streamClient([envelope({ choices: [{ delta: { content: 'half' } }] })]);
  const res = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const wire = await new Response(res.body).text();
  assert.ok(!wire.includes('data: [DONE]'), 'truncated upstream must not be marked complete');
  const finish = translated(wire).find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TRANSPORT);
});

test('a finish_reason without an outer [DONE] still closes cleanly', async () => {
  const client = streamClient([envelope({
    choices: [{ delta: { content: 'complete' }, finish_reason: 'stop' }],
  })]);
  const res = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const wire = await new Response(res.body).text();
  assert.ok(wire.includes('data: [DONE]'));
  assert.equal(translated(wire).find((chunk) => chunk.type === 'finish').reason.kind, 'stop');
});

test('HTTP 200 inner queue envelopes become visible queue errors', async () => {
  const client = streamClient([envelope({ error: { message: 'queued', code: 10605, retryAfterSeconds: 9 } })]);
  const res = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const wire = await new Response(res.body).text();
  assert.match(wire, /10605/);
  const finish = translated(wire).find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.failure.code, CODE.RATE_LIMIT);
  assert.equal(finish.reason.failure.providerRetryAfterMs, 9000);
});

test('trial rejects a translated stream that closes before finish_reason', async () => {
  const client = streamClient([envelope({ choices: [{ delta: { content: 'half' } }] })]);
  await assert.rejects(
    client.test({ model: 'auto', prompt: 'ping', firstByteTimeoutMs: 2000, idleTimeoutMs: 2000 }),
    /结束原因之前中断/,
  );
});

test('trial accepts a finish_reason without an outer [DONE]', async () => {
  const client = streamClient([envelope({
    choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }],
    usage: { total_tokens: 3 },
  })]);
  const result = await client.test({ model: 'auto', prompt: 'ping', firstByteTimeoutMs: 2000, idleTimeoutMs: 2000 });
  assert.equal(result.text, 'pong');
  assert.equal(result.usage.total_tokens, 3);
});

test('trial surfaces upstream error frames instead of reporting an empty reply', async () => {
  for (const frame of [
    { error: { message: 'Invalid JSON payload' } },
    { code: 10605, message: 'queued', choices: [] },
  ]) {
    const client = new QoderClient({ region: 'global', log: () => {} });
    const encoder = new TextEncoder();
    client.chat = async () => ({
      ok: true,
      text: async () => '',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
    });
    await assert.rejects(
      client.test({ model: 'auto', prompt: 'ping', firstByteTimeoutMs: 2000, idleTimeoutMs: 2000 }),
      /Invalid JSON payload|queued/,
      '上游错误不能被当成空回复',
    );
  }
});

test('a transient userinfo failure never reports a PAT login as ready', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    await assert.rejects(client.importPat('dt-transient-token', 'global'), /令牌验证失败/);
  });
  assert.equal(client.auth, null);
  assert.equal(existsSync(PATHS.auth), false, '没有验证成功的凭据不能留下半写状态');
});

test('importPat exchanges identity and stores a token-sourced account', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  let authChanges = 0;
  client.onAuthChange = () => { authChanges += 1; };
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
  assert.equal(authChanges, 1, '一次登录只触发一次 auth-change');
});

test('a rejected PAT keeps the previous account instead of logging it out', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-pat-old',
    user: { id: 'u-pat-old', name: 'Old Account' },
    source: 'token',
  }, { silent: true });
  client.catalogCache = { at: Date.now(), models: [{ id: 'keep-model', name: 'Keep' }], error: '', staleMs: 0 };
  client.rawById = new Map([['keep-model', { id: 'keep-model', name: 'Keep' }]]);
  await client.flushAuthWrite();

  await withFetch(async (url) => {
    assert.match(String(url), /\/api\/v1\/userinfo$/);
    return json({ message: 'invalid token' }, 401);
  }, async () => {
    await assert.rejects(client.importPat('dt-bad-token', 'global'), /令牌验证失败/);
  });

  assert.equal(client.auth.user.id, 'u-pat-old');
  assert.equal(client.auth.accessToken, 'dt-pat-old');
  assert.equal(readEncryptedJson(PATHS.auth).user.id, 'u-pat-old');
  assert.equal(client.catalogCache.models[0].id, 'keep-model', '回滚账号时也要把目录快照还原');
  assert.equal(client.rawModel('keep-model').name, 'Keep');
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

test('concurrent device polls share one upstream request', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  client.pendingDevices.set('dev-1', {
    verifier: 'verifier', nonce: 'nonce', region: 'global', createdAt: Date.now(), authUrl: 'https://qoder.com/device',
  });

  const release = deferred();
  let polls = 0;
  await withFetch(async (url) => {
    const target = String(url);
    if (target.includes('/api/v1/deviceToken/poll')) {
      polls += 1;
      await release.promise;
      return json({ token: 'dt-device', refresh_token: 'drt-device', expires_in: 3600 });
    }
    if (target.endsWith('/api/v1/userinfo')) return json({ id: 'u-device', name: 'Device' });
    throw new Error(`unexpected request ${target}`);
  }, async () => {
    const first = client.pollDeviceAuth('dev-1');
    const second = client.pollDeviceAuth('dev-1');
    await Promise.resolve();
    assert.equal(polls, 1, '同一个设备会话的并发轮询只能打一次上游');
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 'ready');
    assert.equal(b.status, 'ready');
  });
});

test('concurrent token refresh is single-flight', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: '',
    refreshToken: 'drt-concurrent',
    expiresAt: Date.now() - 1000,
    user: { id: 'u-refresh', name: 'Refresh Tester' },
    source: 'token',
  }, { silent: true });

  const release = deferred();
  let calls = 0;
  await withFetch(async (url) => {
    assert.match(String(url), /\/api\/v1\/deviceToken\/refresh$/);
    calls += 1;
    await release.promise;
    return json({ token: 'dt-refreshed', refresh_token: 'drt-next', expires_in: 3600 });
  }, async () => {
    const first = client.refreshAuth();
    const second = client.refreshAuth();
    await Promise.resolve();
    assert.equal(calls, 1, '同一账号的并发刷新只能打一次上游');
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.accessToken, 'dt-refreshed');
    assert.equal(b.accessToken, 'dt-refreshed');
    assert.equal(client.auth.accessToken, 'dt-refreshed');
    assert.equal(client.auth.refreshToken, 'drt-next');
  });
});

test('refreshing an auth without a uid is not treated as an account switch', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: '',
    refreshToken: 'drt-noid',
    expiresAt: Date.now() - 1000,
    user: { id: '', name: '', email: 'noid@example.com' },
    source: 'pat',
  }, { silent: true });

  await withFetch(async (url) => {
    assert.match(String(url), /\/api\/v1\/deviceToken\/refresh$/);
    return json({ token: 'dt-noid', refresh_token: 'drt-noid-next', expires_in: 3600 });
  }, async () => {
    const auth = await client.ensureAccessToken();
    assert.equal(auth.accessToken, 'dt-noid');
  });
  assert.equal(client.auth.user.email, 'noid@example.com', '刷新不能丢掉已有账号信息');
});

test('a refresh for the old account cannot overwrite a newly selected account', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: '',
    refreshToken: 'drt-old',
    expiresAt: Date.now() - 1000,
    user: { id: 'u-old', name: 'Old' },
    source: 'token',
  }, { silent: true });

  const release = deferred();
  await withFetch(async (url) => {
    assert.match(String(url), /\/api\/v1\/deviceToken\/refresh$/);
    await release.promise;
    return json({ token: 'dt-old-refreshed', refresh_token: 'drt-old-next', expires_in: 3600 });
  }, async () => {
    const oldTask = client.refreshAuth();
    await Promise.resolve();
    client.setAuth({
      schemaVersion: 1,
      region: 'global',
      accessToken: 'dt-new',
      user: { id: 'u-new', name: 'New' },
      source: 'token',
    }, { silent: true });
    release.resolve();
    await assert.rejects(oldTask, /账号已切换/);
    assert.equal(client.auth.user.id, 'u-new');
    assert.equal(client.auth.accessToken, 'dt-new');
  });
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
  const errors = [];
  const client = catalogClient({ catalogTtlMs: 60_000, onCatalogError: (message) => errors.push(message) });
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
  assert.equal(errors.length, 1, '后台刷新失败必须通知宿主');
  assert.match(errors[0], /catalog down/);
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

test('desktop token adoption only moves forward to a newer token', () => {
  const now = Date.now();
  const current = { accessToken: 'dt-current', expiresAt: now + 3_600_000 };
  assert.equal(shouldAdoptDesktopAuth(current, { accessToken: 'dt-current', expiresAt: now + 7_200_000 }, now), false, '同一个令牌无需切换');
  assert.equal(shouldAdoptDesktopAuth(current, { accessToken: 'dt-older', expiresAt: now + 1_800_000 }, now), false, '官方文件更旧时不能覆盖插件刚刷新的令牌');
  assert.equal(shouldAdoptDesktopAuth(current, { accessToken: 'dt-unknown', expiresAt: 0 }, now), false, '无法判断新旧时保留当前令牌');
  assert.equal(shouldAdoptDesktopAuth(current, { accessToken: 'dt-newer', expiresAt: now + 7_200_000 }, now), true);

  assert.equal(shouldAdoptDesktopAuth({ accessToken: '', expiresAt: 0 }, { accessToken: 'dt-any', expiresAt: 0 }, now), true, '没有访问令牌时必须采用官方令牌');
  const expired = { accessToken: 'dt-expired', expiresAt: now - 1000 };
  assert.equal(shouldAdoptDesktopAuth(expired, { accessToken: 'dt-also-expired', expiresAt: now - 500 }, now), false);
  assert.equal(shouldAdoptDesktopAuth(expired, { accessToken: 'dt-fresh', expiresAt: now + 3_600_000 }, now), true);
});

test('a token refresh treats expires_in as milliseconds, like the official client', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const rawSetAuth = client.setAuth.bind(client);
  client.setAuth = (auth, options = {}) => rawSetAuth(auth, { ...options, persist: false });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: '',
    refreshToken: 'drt-ms',
    expiresAt: Date.now() - 1000,
    user: { id: 'u-ms' },
    source: 'token',
  }, { silent: true });

  const before = Date.now();
  await withFetch(async (url) => {
    assert.match(String(url), /\/api\/v1\/deviceToken\/refresh$/);
    return json({ token: 'dt-ms', refresh_token: 'drt-ms-next', expires_in: 3_600_000 });
  }, async () => {
    await client.refreshAuth();
  });

  const ttl = client.auth.expiresAt - before;
  assert.ok(ttl > 3_500_000 && ttl < 3_700_000, `expires_in 必须按毫秒累加，实际 ${ttl}ms`);
});

test('buildChatBody forwards the temperature preference to upstream parameters', () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-temperature',
    user: { id: 'u-temperature' },
    source: 'token',
  }, { silent: true, persist: false });

  const body = client.buildChatBody({
    model: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.3,
    max_tokens: 512,
  }, null);
  assert.equal(body.parameters.temperature, 0.3);
  assert.equal(body.parameters.max_tokens, 512);

  const zero = client.buildChatBody({
    model: 'auto', messages: [{ role: 'user', content: 'hi' }], temperature: 0, max_tokens: 8,
  }, null);
  assert.equal(zero.parameters.temperature, 0, '0 是合法温度，不能当成未设置');

  const unset = client.buildChatBody({
    model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
  }, null);
  assert.equal('temperature' in unset.parameters, false, '未设置时必须继续由上游决定');
});

test('a catalog response that dies mid-body rejects instead of crashing or hanging', async () => {
  const client = catalogClient();
  const original = https.request;
  let calls = 0;
  https.request = (url, options, callback) => {
    calls += 1;
    const res = new PassThrough();
    res.statusCode = 200;
    callback(res);
    setImmediate(() => res.destroy(new Error('socket hang up')));
    return { on() {}, setTimeout() {}, write() {}, end() {}, destroy() {} };
  };
  try {
    await assert.rejects(() => client.fetchCatalog(), /socket hang up/);
    assert.equal(calls, 3, '每个候选网关都必须明确失败，而不是让请求悬住');
  } finally {
    https.request = original;
  }
});

test('switching accounts clears the model catalog and discards in-flight models', async () => {
  const client = catalogClient();
  client.catalogCache = { at: Date.now(), models: [{ id: 'old-model', name: 'Old' }], error: '', staleMs: 0 };
  client.rawById = new Map([['old-model', { id: 'old-model', name: 'Old' }]]);

  const gate = deferred();
  client.fetchCatalog = async () => {
    await gate.promise;
    return {
      models: [{ id: 'old-model', name: 'Old' }],
      rawById: new Map([['old-model', { id: 'old-model', name: 'Old' }]]),
    };
  };

  const job = client.listCatalog({ refresh: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const generation = client.catalogGeneration;

  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-account-b',
    user: { id: 'u-account-b', name: 'Account B' },
    source: 'token',
  }, { silent: true, persist: false });

  assert.equal(client.catalogCache.models.length, 0, '换号后不能继续展示上一个账号的模型');
  assert.equal(client.rawById.size, 0);
  assert.ok(client.catalogGeneration > generation);

  gate.resolve();
  const result = await job;
  assert.deepEqual(result.models, []);
  assert.equal(client.catalogCache.models.length, 0, '旧账号的目录结果不能写回新账号');
  assert.equal(client.rawModel('old-model'), null);

  // 同一账号的令牌刷新不属于换号：目录必须保留，否则每次刷新都会让选择器闪空。
  client.catalogCache = { at: Date.now(), models: [{ id: 'keep' }], error: '', staleMs: 0 };
  const keptGeneration = client.catalogGeneration;
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-account-b-next',
    user: { id: 'u-account-b', name: 'Account B' },
    source: 'token',
  }, { silent: true, sameIdentity: true, persist: false });
  assert.equal(client.catalogCache.models[0].id, 'keep');
  assert.equal(client.catalogGeneration, keptGeneration);
});

test('corrupt local credentials do not silently switch to a desktop account', () => {
  mkdirSync(process.env.QODER_TO_DSH_HOME, { recursive: true });
  writeFileSync(PATHS.auth, '{not valid json');
  const client = new QoderClient({ region: 'global', log: () => {} });
  assert.equal(client.auth, null);
  assert.equal(client.authLoad.state, 'corrupt');
  assert.match(client.status({ desktop: false }).authRestore.error, /JSON|Unexpected|解析/i);
  rmSync(PATHS.auth, { force: true });
});

test('account switch aborts an in-flight chat, while same-identity refresh does not', async () => {
  const auth = {
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-inflight',
    expiresAt: Date.now() + 3600_000,
    user: { id: 'u-inflight', name: 'Inflight' },
    source: 'token',
  };
  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth(auth, { silent: true, persist: false });
  client.listCatalog = async () => ({ models: [], at: Date.now(), staleMs: 0, error: '' });
  let captured = null;
  client.transport = (_url, options) => new Promise((_resolve, reject) => {
    captured = options.signal;
    options.signal.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
  });

  const caller = new AbortController();
  const pending = client.chat({ model: 'auto', messages: [] }, { signal: caller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.inflight.size, 1);
  assert.equal(captured.aborted, false);

  // 令牌刷新沿用同一个身份：不能打断正在生成的回复。
  client.setAuth({ ...auth, accessToken: 'dt-inflight-next' }, { silent: true, sameIdentity: true, persist: false });
  assert.equal(captured.aborted, false);
  assert.equal(client.inflight.size, 1);

  caller.abort(new Error('caller cancelled'));
  await assert.rejects(pending, /caller cancelled/);
  assert.equal(client.inflight.size, 0);

  const switchClient = new QoderClient({ region: 'global', log: () => {} });
  switchClient.setAuth(auth, { silent: true, persist: false });
  switchClient.listCatalog = async () => ({ models: [], at: Date.now(), staleMs: 0, error: '' });
  let switchedSignal = null;
  switchClient.transport = (_url, options) => new Promise((_resolve, reject) => {
    switchedSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
  });
  const switchedPending = switchClient.chat({ model: 'auto', messages: [] }, { signal: new AbortController().signal });
  const rejection = assert.rejects(switchedPending, (error) => error.code === 'ACCOUNT_SWITCHED');
  await new Promise((resolve) => setTimeout(resolve, 10));
  switchClient.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-other',
    user: { id: 'u-other', name: 'Other' },
    source: 'token',
  }, { silent: true, persist: false });
  assert.equal(switchedSignal.aborted, true);
  await rejection;
  assert.equal(switchClient.inflight.size, 0);
});

test('buildChatBody uses the shared context fallback instead of an ad-hoc 180K', () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const body = client.buildChatBody({ model: 'auto', messages: [] }, null);
  assert.equal(body.model_config.max_input_tokens, DEFAULTS.fallbackContextWindow);
});

test('refreshExtras rejects a cancelled caller without starting a second request', async () => {
  const client = catalogClient();
  client.extrasPromise = { generation: client.extrasGeneration, promise: new Promise(() => {}) };
  const controller = new AbortController();
  controller.abort(new Error('extras cancelled'));
  await assert.rejects(client.refreshExtras({ signal: controller.signal }), /extras cancelled/);
});

test('status reports a zero remaining balance instead of stale credits', () => {
  const client = catalogClient();
  client.auth.credits = 42;
  client.extras = {
    quota: {
      userQuota: { remaining: 0, total: 10, unit: 'credits' },
      addOnQuota: { remaining: 0, total: 0, unit: 'credits' },
    },
  };
  assert.equal(client.status({ desktop: false }).account.credits, 0);

  client.extras = { quota: { userQuota: { total: 10, unit: 'credits' } } };
  client.auth.credits = 42;
  assert.equal(client.status({ desktop: false }).account.credits, 42, '字段缺失时才保留旧值');
});

test('non-auth 401/403 responses are returned without refreshing the token', async () => {
  const auth = {
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-inflight',
    expiresAt: Date.now() + 3600_000,
    user: { id: 'u-queue', name: 'Queue' },
    source: 'token',
  };
  for (const [status, body] of [
    [403, { error: { message: 'queued', code: 10605 } }],
    [401, { error: { message: '12153', code: 12153 } }],
    [403, { error: { message: 'Billing daily count exceeded', code: 110 } }],
    [403, { error: { message: 'quota exceeded', code: 112 } }],
    [430, { error: { message: 'version too low', code: 430 } }],
  ]) {
    const client = new QoderClient({ region: 'global', log: () => {} });
    client.setAuth(auth, { silent: true, persist: false });
    client.listCatalog = async () => ({ models: [], at: Date.now(), staleMs: 0, error: '' });
    let calls = 0;
    let refreshed = 0;
    client.transport = async () => {
      calls += 1;
      return {
        ok: false,
        status,
        headers: { 'retry-after': '7' },
        body: null,
        text: async () => JSON.stringify(body),
        drain() {},
      };
    };
    client.refreshAuth = async () => { refreshed += 1; };
    const res = await client.chat({ model: 'auto', messages: [] });
    assert.equal(res.ok, false);
    assert.equal(res.status, status);
    assert.equal(res.headers['retry-after'], '7');
    assert.equal(calls, 1, '不能为排队/日限/会话失效再打一次网关');
    assert.equal(refreshed, 0, '不能刷新令牌');
  }
});

test('gateway failover never awaits a response that was already drained', { timeout: 2500 }, async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-failover-hang',
    expiresAt: Date.now() + 3600_000,
    user: { id: 'u-failover-hang', name: 'Failover Hang' },
    source: 'token',
  }, { silent: true, persist: false });
  client.rawModel = () => ({ key: 'auto', display_name: 'Auto' });
  let calls = 0;
  let drained = false;
  client.transport = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        headers: {},
        body: null,
        drain() { drained = true; },
        text() { return drained ? new Promise(() => {}) : Promise.resolve('gateway down'); },
      };
    }
    const error = new Error('connect ETIMEDOUT');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const started = Date.now();
  await assert.rejects(
    client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    /ETIMEDOUT|连接 Qoder 失败/,
  );
  assert.ok(Date.now() - started < 1000, '不能在已经 drain 的旧响应上等待 text()');
  assert.equal(calls, 3, '后续网关仍要尝试');
});

test('the last gateway 5xx body survives failover for diagnostics', async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  client.setAuth({
    schemaVersion: 1,
    region: 'global',
    accessToken: 'dt-failover',
    expiresAt: Date.now() + 3600_000,
    user: { id: 'u-failover', name: 'Failover' },
    source: 'token',
  }, { silent: true, persist: false });
  client.listCatalog = async () => ({ models: [], at: Date.now(), staleMs: 0, error: '' });
  let calls = 0;
  client.transport = async () => {
    calls += 1;
    let drained = false;
    return {
      ok: false,
      status: 503,
      headers: {},
      body: null,
      drain() { drained = true; },
      // 与 requestStream.drain() 一致：读空后 text() 只剩空串。
      text: async () => (drained ? '' : '{"error":{"message":"upstream overloaded","code":503}}'),
    };
  };
  const res = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(calls, 3, '三个候选网关都要试过');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /upstream overloaded/, '最后一个网关的 5xx 原因不能被 drain 掉');
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});
