import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDiagBundle, clientChecks, clientDrift } from '../lib/diagnostics.mjs';
import { normalizeQuota } from '../lib/quota.mjs';

function fakeInfo(dir) {
  return {
    region: 'global',
    client: {
      exists: true,
      root: 'D:\\APP\\Qoder',
      manifest: {
        path: join(dir, 'manifest.json'),
        appVersion: '0.5.1',
        cliVersion: '1.1.79-hotfix.7',
      },
    },
    roots: [],
    state: {},
    protocol: {},
    appData: { dir, appDataPath: dir, source: 'appdata', location: null },
    appStatus: { logged_in: true, version: '0.5.1' },
    umidCache: { machineToken: 'cached', machineType: 't', machineCode: 'c' },
    endpoint: { url: 'https://api3.qoder.sh' },
    runtimeInfo: 'D:\\APP\\Qoder\\runtime-info.exe',
    machineId: { path: join(dir, 'auth.machine-id'), exists: true },
    versions: ['0.5.1'],
    rootExes: ['Qoder.exe'],
    mixedProducts: false,
  };
}

test('client drift only reports a real version change', () => {
  assert.equal(clientDrift(null, { appVersion: '0.5.1' }), null);
  assert.equal(clientDrift({ appVersion: '0.5.1' }, null), null);
  assert.equal(clientDrift({ appVersion: '0.5.1', cliVersion: 'a' }, { appVersion: '0.5.1', cliVersion: 'a' }), null);
  assert.deepEqual(
    clientDrift({ appVersion: '0.4.11', cliVersion: '1.1.75' }, { appVersion: '0.5.1', cliVersion: '1.1.79-hotfix.7' }),
    { from: '0.4.11', to: '0.5.1', fromCli: '1.1.75', toCli: '1.1.79-hotfix.7' },
  );
});

test('client checks pass on a healthy 0.5.1 layout and warn on mixed installs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-diag-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.v1.dat'), 'v10');
    const info = fakeInfo(dir);
    const healthy = clientChecks({
      region: 'global',
      auth: { user: { id: 'u1' } },
      protocol: { cosyVersion: '1.1.79-hotfix.7', oauthUa: 'Qoder/1.1.79-hotfix.7', source: { cosy: 'manifest', ua: 'manifest' } },
      catalog: { schema: 6, cliVersion: '1.1.79-hotfix.7', account: 'u1', models: [{ id: 'm' }], at: Date.now() },
      info,
    });
    assert.deepEqual(healthy.checks.map((check) => check.id), ['qoder-client', 'client-protocol', 'umid', 'app-data-dir', 'cache-account', 'endpoint']);
    assert.ok(healthy.checks.every((check) => check.status === 'pass'), JSON.stringify(healthy.checks));

    const mixed = clientChecks({
      region: 'global',
      auth: { user: { id: 'u1' } },
      protocol: { cosyVersion: '1.1.79-hotfix.7', oauthUa: 'Qoder/1.1.79-hotfix.7', source: { cosy: 'manifest', ua: 'manifest' } },
      catalog: { schema: 5, cliVersion: '1.1.75', account: 'u1', models: [{ id: 'm' }], at: Date.now() },
      info: { ...info, mixedProducts: true, versions: ['0.4.11', '0.5.1'] },
    });
    assert.equal(mixed.checks.find((check) => check.id === 'qoder-client').status, 'warn');
    assert.equal(mixed.checks.find((check) => check.id === 'cache-account').status, 'warn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostic bundle masks account ids and redacts token-shaped strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-diag-'));
  try {
    writeFileSync(join(dir, 'auth.v1.dat'), 'v10');
    const info = fakeInfo(dir);
    const quota = normalizeQuota({
      userId: '01a1544b-75db-7ec6-acbc-f80e857d525c',
      userQuota: { total: 10, remaining: 5, used: 5, unit: 'credits' },
    }, { auth: { user: { id: '01a1544b-75db-7ec6-acbc-f80e857d525c' } } });
    const bundle = buildDiagBundle({
      status: {
        version: '1.4.0',
        region: 'global',
        signedIn: true,
        account: { name: 'Alice', email: 'alice@example.com', uid: '01a1544b-75db-7ec6-acbc-f80e857d525c', plan: 'Free' },
        client: { appVersion: '0.5.1', cliVersion: '1.1.79-hotfix.7' },
        catalog: { count: 1, at: 1, error: '' },
        extras: { quota: { userId: '01a1544b-75db-7ec6-acbc-f80e857d525c', userQuota: { total: 10, remaining: 5, used: 5, unit: 'credits' } } },
        extrasAt: Date.now(),
      },
      checks: [{ id: 'x', label: 'X', status: 'warn', detail: 'token dt-abcdefghijkl and Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop', hint: '' }],
      protocol: { appVersion: '0.5.1', cliVersion: '1.1.79-hotfix.7', cosyVersion: '1.1.79-hotfix.7', oauthUa: 'Qoder/1.1.79-hotfix.7', source: {} },
      info,
    });
    const text = JSON.stringify(bundle);
    assert.equal(bundle.redacted, true);
    assert.ok(!text.includes('alice@example.com'), '完整邮箱不能出现');
    assert.ok(!text.includes('01a1544b-75db-7ec6-acbc-f80e857d525c'), '完整 uid 不能出现');
    assert.ok(!text.includes('dt-abcdefghijkl'), '令牌样式必须脱敏');
    assert.ok(!/Bearer\s+eyJ/.test(text), 'Bearer 令牌必须脱敏');
    assert.match(text, /a\*\*\*@example\.com/);
    assert.match(text, /…7d525c/);
    assert.equal(bundle.quota.totals.total, 10);
    assert.ok(quota, 'fixture quota parsed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
