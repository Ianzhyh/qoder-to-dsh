import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  accountKeyOf,
  applyAccountPrefs,
  mergeAccounts,
  normalizeAccounts,
  normalizeAlias,
  publicAccountRow,
  readAccounts,
  writeAccounts,
} from '../lib/accounts.mjs';

test('alias normalization trims, collapses controls and caps at 24 chars', () => {
  assert.equal(normalizeAlias('  国际 版\n一号  '), '国际 版 一号');
  assert.equal(normalizeAlias('x'.repeat(40)).length, 24);
  assert.equal(normalizeAlias(null), '');
  assert.equal(normalizeAlias('a\u0000b'), 'a b');
});

test('account keys are stable across app/cli and fall back to email/file', () => {
  assert.equal(accountKeyOf({ key: 'cn:u1', region: 'cn', uid: 'u1' }), 'cn:u1');
  assert.equal(accountKeyOf({ region: 'global', uid: 'u2' }), 'global:u2');
  assert.equal(accountKeyOf({ region: 'cn', email: 'a@b.c' }), 'cn:email:a@b.c');
  assert.equal(accountKeyOf({ region: 'global', kind: 'cli', file: 'user.1' }), 'global:cli:user.1');
});

test('normalizeAccounts accepts legacy array hidden and dedupes order', () => {
  const value = normalizeAccounts({
    aliases: { 'cn:u1': '  国内  ', 'cn:u2': '   ' },
    order: ['cn:u1', 'cn:u1', '', 'global:u2'],
    hidden: ['cn:u3', 'cn:u3', ''],
    current: 'cn:u1',
  });
  assert.deepEqual(value.aliases, { 'cn:u1': '国内' });
  assert.deepEqual(value.order, ['cn:u1', 'global:u2']);
  assert.deepEqual(value.hidden, { 'cn:u3': true });
  assert.equal(value.current, 'cn:u1');
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(normalizeAccounts(null), { schemaVersion: 1, aliases: {}, order: [], hidden: {}, current: '' });
});

test('mergeAccounts keeps untouched fields and appends order tails', () => {
  const base = mergeAccounts({ order: ['a', 'b'], aliases: { a: '旧' }, hidden: { b: true } }, {
    aliases: { a: '新', b: '' },
    order: ['b'],
  });
  assert.equal(base.aliases.a, '新');
  assert.equal(base.aliases.b, undefined);
  assert.deepEqual(base.order, ['b', 'a']);
  assert.deepEqual(base.hidden, { b: true });

  const toggled = mergeAccounts(base, { hidden: { b: false, c: true } });
  assert.equal(toggled.hidden.b, undefined);
  assert.equal(toggled.hidden.c, true);
  const restored = mergeAccounts(toggled, { restoreAll: true });
  assert.deepEqual(restored.hidden, {});
});

test('applyAccountPrefs orders, decorates and keeps the active hidden account visible', () => {
  const rows = [
    { key: 'g:1', region: 'global', uid: '1', label: 'A', active: false, expiresAt: 100 },
    { key: 'g:2', region: 'global', uid: '2', label: 'B', active: true, expiresAt: 200 },
    { key: 'g:3', region: 'global', uid: '3', label: 'C', active: false, expiresAt: 300 },
    { key: 'g:4', region: 'global', uid: '4', label: 'D', active: false, expiresAt: 50 },
  ];
  const prefs = {
    order: ['g:3', 'g:1', 'g:2'],
    aliases: { 'g:1': '一号' },
    hidden: { 'g:2': true, 'g:4': true },
  };
  const { visible, hidden, all } = applyAccountPrefs(rows, prefs);
  assert.deepEqual(visible.map((row) => row.key), ['g:3', 'g:1', 'g:2']);
  assert.deepEqual(hidden.map((row) => row.key), ['g:4']);
  assert.equal(visible.find((row) => row.key === 'g:2').hidden, true, '当前账号隐藏也留在可见区');
  assert.equal(visible.find((row) => row.key === 'g:1').displayName, '一号');
  assert.equal(all.length, 4);

  const publicRow = publicAccountRow(visible[0]);
  assert.equal(publicRow.active, false);
  assert.equal(publicRow.alias, '');
  assert.equal(publicRow.displayName, 'C');
  assert.equal('accessToken' in publicRow, false);
});

test('accounts file round-trips through the normalizer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-accounts-'));
  const path = join(dir, 'accounts.json');
  try {
    writeAccounts({ order: ['a', 'a', 'b'], aliases: { a: '  A  ' }, hidden: { b: true } }, path);
    const loaded = readAccounts(path);
    assert.deepEqual(loaded.order, ['a', 'b']);
    assert.equal(loaded.aliases.a, 'A');
    assert.equal(loaded.hidden.b, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
