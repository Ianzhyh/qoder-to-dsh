/**
 * 宿主端冒烟：用假的 dsh 服务加载真实插件入口，验证路由、工具、命令、
 * 适配器注册与偏好持久化。不触碰真实 ~/.dsh，也不会联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'qoder-host-'));
process.env.DSH_HOME = home;
process.env.QODER_TO_DSH_HOME = join(home, 'qoder');
process.env.QODER_REGION = 'global';
// 隔离本机官方客户端登录态：否则首次加载会自动导入真实账号，测试结果依赖机器状态。
process.env.APPDATA = join(home, 'appdata');
process.env.USERPROFILE = join(home, 'user');

const { apply, resolveConfig } = await import('../dsh-plugin/lib/index.js');

const routes = [];
const tools = [];
const commands = [];
const adapters = [];
const effects = [];
const webServer = {
  register(definition) {
    routes.push(definition);
    return () => {};
  },
};
const ctx = {
  llm: {
    registerAdapter(names, adapter) { adapters.push({ names, adapter }); },
    emitAdaptersUpdated() {},
  },
  get(name) {
    if (name === 'tools') return { register: (definition) => tools.push(definition) };
    if (name === 'commands') return { register: (definition) => commands.push(definition) };
    if (name === 'webServer') return webServer;
    return undefined;
  },
  effect(run) {
    const dispose = run();
    if (typeof dispose === 'function') effects.push(dispose);
    return () => {};
  },
};

apply(ctx, { region: 'global' });

function createReq({ method = 'GET', url = '/', body, raw, chunks, headers = {} } = {}) {
  const buffer = raw !== undefined ? Buffer.from(raw) : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  const parts = chunks || (buffer ? [buffer] : []);
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1', ...headers },
    consumed: 0,
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        req.consumed += 1;
        yield part;
      }
    },
  };
  return req;
}

function createRes() {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    done,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers || {});
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      settle();
    },
  };
}

async function call(method, url, { body, raw, chunks, panel = false } = {}) {
  const path = url.split('?')[0];
  const route = routes.find((item) => item.path === path);
  assert.ok(route, `route ${path} should be mounted`);
  const req = createReq({ method, url, body, raw, chunks, headers: panel ? { 'x-qoder-panel': '1' } : {} });
  const res = createRes();
  await route.handler(req, res);
  await res.done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non json */ }
  return { status: res.statusCode, json, headers: res.headers, req };
}

test('plugin registers one adapter, its tools, command and all panel routes', () => {
  assert.equal(adapters.length, 1);
  assert.deepEqual(adapters[0].names, ['qoder']);
  assert.ok(adapters[0].adapter && typeof adapters[0].adapter.stream === 'function');
  assert.deepEqual(tools.map((item) => item.name).sort(), ['qoder_diagnose', 'qoder_models', 'qoder_status', 'qoder_usage']);
  assert.deepEqual(commands.map((item) => item.name), ['qoder']);
  assert.equal(routes.length, 19);
  assert.ok(effects.length >= 2);
});

test('resolveConfig clamps model defaults and keeps zero timeouts meaningful', () => {
  const config = resolveConfig({
    region: 'cn',
    defaultTemperature: 9,
    defaultMaxTokens: 12.9,
    firstByteTimeoutMs: 0,
    streamIdleTimeoutMs: 0,
    showCost: 'false',
  });
  assert.equal(config.region, 'cn');
  assert.equal(config.defaultTemperature, 2);
  assert.equal(config.defaultMaxTokens, 12);
  assert.equal(config.firstByteTimeoutMs, 0);
  assert.equal(config.streamIdleTimeoutMs, 0);
  assert.equal(config.showCost, false);
  assert.equal(resolveConfig({ defaultTemperature: 'bad' }).defaultTemperature, undefined);
});

test('status is readable without auth and never returns tokens', async () => {
  const { status, json } = await call('GET', '/qoder/status');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.signedIn, false);
  assert.equal(json.route.registered, true);
  assert.equal(json.provider, 'qoder');
  assert.deepEqual(json.prefs.contextWindowByModel, {});
  assert.deepEqual(json.prefs.paramsByModel, {});
  assert.ok(json.desktop && Array.isArray(json.desktop.candidates), '面板需要 desktop.candidates 才能列出多账号');
  assert.equal(json.catalog.count, 0);
  assert.equal(json.config.firstByteTimeoutMs, 45000);
  assert.equal(json.config.streamIdleTimeoutMs, 120000);
  assert.equal(json.config.defaultMaxTokens, 0);
  assert.equal(json.config.defaultTemperature, null);
  assert.equal(json.config.defaultReasoningEffort, '');
  assert.equal(json.config.providerDefaultMaxTokens, 32_000);
  assert.match(String(json.config.credentialProtection), /DPAPI|AES-256-GCM/);
  assert.ok(!JSON.stringify(json).toLowerCase().includes('accesstoken'));
  assert.ok(!JSON.stringify(json).toLowerCase().includes('refreshtoken'));
});

test('usage endpoint honors the days window and keeps per-model aggregation', async () => {
  const { status, json } = await call('GET', '/qoder/usage?days=7');
  assert.equal(status, 200);
  assert.equal(json.summary.range.days, 7);
  assert.equal(json.summary.days.length, 7);
  assert.ok(Array.isArray(json.summary.byModel));
  assert.ok(Object.prototype.hasOwnProperty.call(json.summary, 'totals'));
});

test('recent usage follows the selected day window', async () => {
  const { appendUsage } = await import('../lib/state.mjs');
  const old = Date.now() - 10 * 86400000;
  appendUsage({ at: old, model: 'old', totalTokens: 1, ok: true });
  appendUsage({ at: Date.now(), model: 'fresh', totalTokens: 1, ok: true });
  const week = await call('GET', '/qoder/usage?days=7&limit=200');
  assert.ok(week.json.recent.some((item) => item.model === 'fresh'));
  assert.ok(!week.json.recent.some((item) => item.model === 'old'), '7 天窗口外记录不应出现在最近记录里');
  const month = await call('GET', '/qoder/usage?days=30&limit=200');
  assert.ok(month.json.recent.some((item) => item.model === 'old'));
});

test('credits report returns a range series and a year heatmap', async () => {
  const { status, json } = await call('GET', '/qoder/credits?range=7d');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.range.key, '7d');
  assert.equal(json.range.days, 7);
  assert.equal(json.days.length, 7);
  assert.ok(json.series && Array.isArray(json.series.model) && Array.isArray(json.series.client));
  assert.ok(json.heatmap.days.length >= 350 && json.heatmap.days.length <= 366);
  assert.ok(Number.isFinite(json.heatmap.max));
});

test('prefs require the panel header and persist per-model context/params', async () => {
  const denied = await call('POST', '/qoder/prefs', {
    body: { contextWindowByModel: { auto: 400000 } },
  });
  assert.equal(denied.status, 403);

  const saved = await call('POST', '/qoder/prefs', {
    panel: true,
    body: {
      contextWindowByModel: { auto: 400000 },
      paramsByModel: { ultimate: { temperature: 0.6, maxTokens: 8192, reasoningEffort: 'max' } },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.deepEqual(saved.json.prefs.contextWindowByModel, { auto: 400000 });
  assert.deepEqual(saved.json.prefs.paramsByModel, { ultimate: { temperature: 0.6, maxTokens: 8192, reasoningEffort: 'max' } });
  assert.equal(saved.json.customized, 2);
  assert.equal(saved.json.notified, true);

  const file = join(process.env.QODER_TO_DSH_HOME, 'prefs.json');
  assert.ok(existsSync(file));
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.contextWindowByModel.auto, 400000);
  assert.equal(persisted.paramsByModel.ultimate.maxTokens, 8192);

  const status = await call('GET', '/qoder/status');
  assert.equal(status.json.customized, 2);
  assert.equal(status.json.prefs.contextWindowByModel.auto, 400000);

  const cleared = await call('POST', '/qoder/prefs', {
    panel: true,
    body: { contextWindowByModel: {}, paramsByModel: {} },
  });
  assert.deepEqual(cleared.json.prefs.contextWindowByModel, {});
  assert.deepEqual(cleared.json.prefs.paramsByModel, {});
  assert.equal(cleared.json.customized, 0);
});

test('an oversized panel body is drained before the 413 so the client can read it', async () => {
  const chunk = Buffer.alloc(200 * 1024, 0x20);
  const { status, json, req } = await call('POST', '/qoder/prefs', {
    panel: true,
    chunks: [chunk, chunk],
  });
  assert.equal(status, 413);
  assert.match(String(json.error), /请求体过大/);
  assert.equal(req.consumed, 2, 'remaining chunks must be read instead of tearing down the stream');
});

test('checkin route exposes auto state, can be toggled, and stays offline with no accounts', async () => {
  const snapshot = await call('GET', '/qoder/checkin');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.ok, true);
  assert.equal(snapshot.json.summary.total, 0);
  assert.equal(snapshot.json.autoConfigured, true);
  assert.equal(snapshot.json.enabled, true);
  assert.equal(snapshot.json.summary.waiting, 0);
  assert.equal(snapshot.json.summary.unavailable, 0);
  assert.ok(Array.isArray(snapshot.json.accounts));
  assert.ok(snapshot.json.devices.global && snapshot.json.devices.cn);

  const off = await call('POST', '/qoder/checkin/config', { panel: true, body: { auto: false } });
  assert.equal(off.json.autoConfigured, false);
  assert.equal(off.json.auto, false);
  const invalid = await call('POST', '/qoder/checkin/config', { panel: true, body: {} });
  assert.equal(invalid.status, 400, '空 body 不能悄悄打开自动签到');
  assert.equal(invalid.json.ok, false);
  const malformed = await call('POST', '/qoder/checkin/config', { panel: true, raw: '{"auto":' });
  assert.equal(malformed.status, 400, '截断的 JSON 必须报错，不能当成空对象');
  const on = await call('POST', '/qoder/checkin/config', { panel: true, body: { auto: true } });
  assert.equal(on.json.autoConfigured, true);

  const denied = await call('POST', '/qoder/checkin/run', { body: {} });
  assert.equal(denied.status, 403);

  const run = await call('POST', '/qoder/checkin/run', { panel: true, body: {} });
  assert.equal(run.status, 200);
  assert.equal(run.json.ok, true);
  assert.deepEqual(run.json.results, []);
  assert.equal(existsSync(join(process.env.QODER_TO_DSH_HOME, 'checkin.json')), true);
});

test('diagnostics and test routes fail visibly instead of pretending success', async () => {
  const diagnostics = await call('GET', '/qoder/diagnostics');
  assert.equal(diagnostics.status, 200);
  assert.ok(Array.isArray(diagnostics.json.checks));
  assert.ok(diagnostics.json.checks.some((check) => check.id === 'auth' && check.status === 'fail'));
  assert.ok(diagnostics.json.checks.some((check) => check.id === 'prefs' && check.status === 'pass'));
  assert.ok(Array.isArray(diagnostics.json.logs));

  const testRun = await call('POST', '/qoder/test', {
    panel: true,
    body: { model: 'auto', prompt: 'ping' },
  });
  assert.equal(testRun.status, 200);
  assert.equal(testRun.json.ok, false);
  assert.match(String(testRun.json.error), /登录|凭据|Qoder/);
});

test('the bare /qoder command defaults to status instead of an unknown subcommand', async () => {
  const command = commands.find((item) => item.name === 'qoder');
  for (const rawInput of ['', '   ', undefined]) {
    const result = await command.handler({ rawInput });
    assert.equal(result.kind, 'success', `rawInput=${JSON.stringify(rawInput)} should fall back to status`);
    assert.match(result.text, /登录：/);
  }
});

test('login command reuses the panel session, reports pending, and recovers from expiry', async () => {
  const client = adapters[0].adapter.client;
  const previousBegin = client.beginDeviceAuth;
  const previousPoll = client.pollDeviceAuth;
  const command = commands.find((item) => item.name === 'qoder');
  let begins = 0;
  let poll = { ok: true, status: 'pending', message: '等待浏览器完成授权' };
  client.beginDeviceAuth = async () => {
    begins += 1;
    return {
      id: `device-${begins}`,
      userCode: '',
      verificationUri: `https://qoder.com/device?id=${begins}`,
      expiresIn: 600,
    };
  };
  client.pollDeviceAuth = async () => poll;
  try {
    const started = await command.handler({ rawInput: 'login' });
    assert.equal(started.kind, 'success');
    assert.match(started.text, /device\?id=1/);
    assert.ok(!started.text.includes('输入代码'), '没有 userCode 时不能提示输入授权码');

    const pending = await command.handler({ rawInput: 'login' });
    assert.equal(pending.kind, 'success');
    assert.match(pending.text, /device\?id=1/, '面板发起的授权会话也应能复用 URI');

    poll = { ok: false, status: 'expired', error: '授权会话已过期' };
    const expired = await command.handler({ rawInput: 'login' });
    assert.equal(expired.kind, 'error');
    assert.match(expired.text, /重新运行/);

    poll = { ok: true, status: 'pending', message: '等待授权' };
    const restarted = await command.handler({ rawInput: 'login' });
    assert.match(restarted.text, /device\?id=2/, '过期后应重新发起授权，而不是卡在旧会话');
  } finally {
    client.beginDeviceAuth = previousBegin;
    client.pollDeviceAuth = previousPoll;
  }
});

test('trial treats an empty upstream reply as a failure and records its usage', async () => {  const adapter = adapters[0].adapter;
  const client = adapter.client;
  const hadAuth = Object.prototype.hasOwnProperty.call(client, 'auth');
  const previousAuth = client.auth;
  const previousTest = client.test;
  client.auth = { source: 'desktop' };
  client.test = async () => ({
    text: '',
    reasoning: '',
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    firstByteMs: 12,
    latencyMs: 34,
  });
  try {
    const result = await call('POST', '/qoder/test', {
      panel: true,
      body: { model: 'auto', prompt: 'ping' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, false);
    assert.match(result.json.error, /空回复/);
    const usage = await call('GET', '/qoder/usage?days=7');
    const latest = usage.json.recent[0];
    assert.equal(latest.status, 'test-failed');
    assert.equal(latest.ok, false);
    assert.equal(latest.totalTokens, 5);
    assert.equal(latest.firstByteMs, 12);
  } finally {
    client.test = previousTest;
    if (hadAuth) client.auth = previousAuth;
    else delete client.auth;
  }
});

test('trial forwards an explicit budget and falls back to plugin defaults', async () => {
  const adapter = adapters[0].adapter;
  const client = adapter.client;
  const previousDefaults = adapter.defaults;
  const previousTest = client.test;
  const previousAuth = client.auth;
  const calls = [];
  adapter.defaults = { maxTokens: 4096, temperature: 0.3, reasoningEffort: 'low' };
  client.auth = { source: 'desktop' };
  client.test = async (args) => {
    calls.push(args);
    return { text: 'ok', reasoning: '', usage: { total_tokens: 1 }, firstByteMs: 1, latencyMs: 2 };
  };
  try {
    await call('POST', '/qoder/test', { panel: true, body: { model: 'auto', prompt: 'ping' } });
    assert.equal(calls[0].maxTokens, 4096);
    assert.equal(calls[0].temperature, 0.3);
    assert.equal(calls[0].reasoningEffort, 'low');
    await call('POST', '/qoder/test', { panel: true, body: { model: 'auto', prompt: 'ping', maxTokens: 123 } });
    assert.equal(calls[1].maxTokens, 123);
  } finally {
    adapter.defaults = previousDefaults;
    client.test = previousTest;
    client.auth = previousAuth;
  }
});

test('trial falls back to the public Qoder CLI 32K output default', async () => {
  const adapter = adapters[0].adapter;
  const client = adapter.client;
  const previousDefaults = adapter.defaults;
  const previousTest = client.test;
  const previousAuth = client.auth;
  let captured = null;
  adapter.defaults = {};
  client.auth = { source: 'desktop' };
  client.test = async (args) => {
    captured = args;
    return { text: 'ok', reasoning: '', usage: { total_tokens: 1 }, firstByteMs: 1, latencyMs: 2 };
  };
  try {
    await call('POST', '/qoder/test', { panel: true, body: { model: 'auto', prompt: 'ping' } });
    assert.equal(captured.maxTokens, 32_000);
  } finally {
    adapter.defaults = previousDefaults;
    client.test = previousTest;
    client.auth = previousAuth;
  }
});

test('trial accepts a supported reasoning effort and rejects unsupported ones', async () => {
  const adapter = adapters[0].adapter;
  const client = adapter.client;
  const previousModels = adapter.catalogCache.models;
  const previousTest = client.test;
  const previousAuth = client.auth;
  const calls = [];
  adapter.catalogCache.models = [{
    id: 'reasoner', name: 'Reasoner', reasoning_efforts: ['low', 'high'], context_window: 200000, context_window_max: 200000,
  }];
  client.auth = { source: 'desktop' };
  client.test = async (args) => {
    calls.push(args);
    return { text: 'ok', reasoning: '', usage: { total_tokens: 1 }, firstByteMs: 1, latencyMs: 2 };
  };
  try {
    const high = await call('POST', '/qoder/test', {
      panel: true, body: { model: 'reasoner', prompt: 'ping', reasoningEffort: 'high' },
    });
    assert.equal(high.status, 200);
    assert.equal(high.json.ok, true);
    assert.equal(calls[0].reasoningEffort, 'high');
    assert.equal(high.json.reasoningEffort, 'high');
    const unsupported = await call('POST', '/qoder/test', {
      panel: true, body: { model: 'reasoner', prompt: 'ping', reasoningEffort: 'max' },
    });
    assert.equal(unsupported.json.ok, false);
    assert.match(String(unsupported.json.error), /只支持 low \/ high/);
    assert.equal(calls.length, 1, '不支持的档位不能发到上游');
  } finally {
    adapter.catalogCache.models = previousModels;
    client.test = previousTest;
    client.auth = previousAuth;
  }
});

test('auth routes keep a consistent envelope and reject malformed writes', async () => {
  const poll = await call('POST', '/qoder/auth/poll', { panel: true, body: {} });
  assert.equal(poll.status, 200);
  assert.equal(poll.json.ok, false);
  assert.match(String(poll.json.error), /device id/);
  const malformed = await call('POST', '/qoder/auth/pat', { panel: true, raw: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.ok, false);
});

test('cleanup', () => {
  for (const dispose of effects) {
    try { dispose(); } catch { /* ignore */ }
  }
  rmSync(home, { recursive: true, force: true });
});
