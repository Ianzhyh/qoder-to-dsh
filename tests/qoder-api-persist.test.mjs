import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'qoder-persist-'));
process.env.DSH_HOME = home;
process.env.QODER_TO_DSH_HOME = join(home, 'qoder');
process.env.QODER_REGION = 'global';
process.env.APPDATA = join(home, 'appdata');
process.env.USERPROFILE = join(home, 'user');
// auth.json 是一个目录：任何落盘都会在 rename 时失败。
mkdirSync(join(home, 'qoder', 'auth.json'), { recursive: true });

const { QoderClient } = await import('../lib/qoder-api.mjs');

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

test('a failed credential write is reported instead of a false ready', { timeout: 30000 }, async () => {
  const client = new QoderClient({ region: 'global', log: () => {} });
  const original = globalThis.fetch;
  globalThis.fetch = async () => json({ id: 'u-write', name: 'Write Tester' });
  try {
    await assert.rejects(client.importPat('dt-write-token', 'global'), /凭据.*(失败|落盘)/);
  } finally {
    globalThis.fetch = original;
  }
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});
