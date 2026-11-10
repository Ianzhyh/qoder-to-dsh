import test from 'node:test';
import assert from 'node:assert/strict';

import { createRouteTable } from '../dsh-plugin/lib/routes.mjs';

const seen = { account: 0, directory: 0, test: null };
const controller = {
  status: async () => ({}),
  directory: async ({ refresh } = {}) => { seen.directory += 1; return { refresh: Boolean(refresh) }; },
  usage: async () => ({}),
  credits: async () => ({}),
  diagnostics: async () => ({}),
  logs: async () => ({}),
  refreshCatalog: async () => ({}),
  savePrefs: async () => ({}),
  beginDeviceAuth: async () => ({}),
  importDesktop: async () => ({}),
  checkin: async () => ({}),
  runCheckin: async () => ({}),
  saveCheckinConfig: async () => ({}),
  account: async () => { seen.account += 1; return { extras: null }; },
  pollDeviceAuth: async () => ({}),
  importPat: async () => ({}),
  logout: async () => ({}),
  test: async (payload) => { seen.test = payload; return { text: 'pong' }; },
  clearUsage: async () => ({}),
};

const routes = createRouteTable({ controller, log: () => {} });

function createReq({ method = 'GET', url = '/', raw, headers = {} } = {}) {
  const buffer = raw === undefined ? null : Buffer.from(raw);
  const parts = buffer ? [buffer] : [];
  return {
    method,
    url,
    headers: { host: '127.0.0.1', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
    },
  };
}

function createRes() {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    done,
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.writableEnded = true;
      settle();
    },
  };
}

async function call(method, url, { raw, panel = false } = {}) {
  const path = url.split('?')[0];
  const route = routes.find((item) => item.path === path);
  assert.ok(route, `route ${path} should exist`);
  const req = createReq({ method, url, raw, headers: panel ? { 'x-qoder-panel': '1' } : {} });
  const res = createRes();
  await route.handler(req, res);
  await res.done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non json */ }
  return { status: res.statusCode, json };
}

test('account and models reads require the panel header because they hit upstream', async () => {
  seen.account = 0;
  seen.directory = 0;

  const accountDenied = await call('GET', '/qoder/account');
  assert.equal(accountDenied.status, 403);
  assert.equal(seen.account, 0, '没有面板头时不能触发票额刷新');

  const accountAllowed = await call('GET', '/qoder/account', { panel: true });
  assert.equal(accountAllowed.status, 200);
  assert.equal(seen.account, 1);

  const modelsDenied = await call('GET', '/qoder/models');
  assert.equal(modelsDenied.status, 403);
  assert.equal(seen.directory, 0, '没有面板头时不能触发目录刷新');

  const modelsAllowed = await call('GET', '/qoder/models', { panel: true });
  assert.equal(modelsAllowed.status, 200);
  assert.equal(seen.directory, 1);
});

test('trial rejects non-finite budgets instead of sending max_tokens: null', async () => {
  seen.test = null;
  const raw = '{"model":"auto","prompt":"hi","maxTokens":1e999}';
  const res = await call('POST', '/qoder/test', { raw, panel: true });
  assert.equal(res.status, 200);
  assert.equal(seen.test.maxTokens, 0, 'Infinity 必须收敛成 0，由默认预算接管');

  await call('POST', '/qoder/test', { raw: '{"model":"auto","maxTokens":12.9}', panel: true });
  assert.equal(seen.test.maxTokens, 12, '预算必须是整数');
});

test('user-input errors keep their 4xx status and are not logged as route failures', async () => {
  const logged = [];
  const table = createRouteTable({
    controller: {
      ...controller,
      importPat: async () => {
        const error = new Error('请输入 PAT');
        error.statusCode = 400;
        throw error;
      },
      status: async () => {
        throw new Error('boom');
      },
    },
    log: (message) => logged.push(String(message)),
  });
  const find = (path) => table.find((item) => item.path === path);

  const readBody = (route, body) => {
    const req = createReq({
      method: 'POST',
      url: '/qoder/auth/pat',
      raw: body,
      headers: { 'x-qoder-panel': '1' },
    });
    const res = createRes();
    return route.handler(req, res).then(async () => { await res.done; return { status: res.statusCode, json: JSON.parse(res.body) }; });
  };

  const pat = await readBody(find('/qoder/auth/pat'), '{"token":""}');
  assert.equal(pat.status, 400, '空 PAT 是用户输入问题，不能报 500');
  assert.match(pat.json.error, /PAT/);
  assert.deepEqual(logged, [], '4xx 不该写 "panel route failed" 日志');

  // 5xx 仍要留日志：这才是需要排查的失败。
  const statusRoute = find('/qoder/status');
  const res = createRes();
  await statusRoute.handler(createReq({ method: 'GET', url: '/qoder/status' }), res);
  await res.done;
  assert.equal(res.statusCode, 500);
  assert.deepEqual(logged, ['panel route failed'], '5xx 才需要写失败日志');
});

test('QoderAuthError maps to 401 so the panel stops treating it as a network blip', async () => {
  // QoderAuthError 只有 code='AUTH'，没有 statusCode。落到 500 时前端按
  // `status >= 500` 判定为「网络抖动」继续轮询，用户永远停在「正在重试授权状态」。
  const logged = [];
  const table = createRouteTable({
    controller: {
      refreshToken: async () => {
        const error = new Error('尚未登录 Qoder，无法刷新令牌');
        error.name = 'QoderAuthError';
        error.code = 'AUTH';
        throw error;
      },
    },
    log: (message) => logged.push(String(message)),
  });
  const route = table.find((item) => item.path === '/qoder/auth/refresh');
  const res = createRes();
  await route.handler(createReq({ method: 'POST', url: '/qoder/auth/refresh', headers: { 'x-qoder-panel': '1' } }), res);
  await res.done;
  assert.equal(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /刷新令牌/);
  assert.deepEqual(logged, [], '401 是鉴权结果，不该记成路由失败');
});

test('side-effect GETs require the panel header', async () => {
  // accounts / pats / checkin 都会写盘或解密凭据库；跨站 <img> 能发 GET，
  // 但带不上自定义头。缺了这道门等于把 CSRF 保护漏掉三个入口。
  const table = createRouteTable({ controller, log: () => {} });
  for (const path of ['/qoder/accounts', '/qoder/pats', '/qoder/checkin']) {
    const route = table.find((item) => item.path === path);
    const denied = createRes();
    await route.handler(createReq({ method: 'GET', url: path }), denied);
    await denied.done;
    assert.equal(denied.statusCode, 403, `${path} 必须要求面板头`);
  }
});
