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
