import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findPat,
  normalizePatStore,
  patId,
  publicPat,
  publicPatStore,
  readPatStore,
  removePat,
  upsertPat,
  writePatStore,
} from '../lib/pat-store.mjs';

const pat = (name = 'a') => `pt-${name}${'x'.repeat(20)}`;

test('normalizes only pt- PATs, dedupes and caps the store', () => {
  const store = normalizePatStore({
    entries: [
      { id: '1', region: 'global', pat: pat('a'), uid: 'u1', label: '  A  ' },
      { id: '1', region: 'cn', pat: pat('b'), uid: 'u2' },
      { id: '2', region: 'cn', pat: 'dt-not-a-pat', uid: 'u3' },
      { id: '3', region: 'xx', pat: pat('c'), uid: 'u4', label: 'x'.repeat(40) },
    ],
  });
  assert.equal(store.entries.length, 2);
  assert.equal(store.entries[0].label, 'A');
  assert.equal(store.entries[1].region, 'global');
  assert.equal(store.entries[1].label.length, 24);
  assert.equal(store.schemaVersion, 1);
});

test('upsert updates the same region+uid and preserves first-added label/time', () => {
  const first = upsertPat(normalizePatStore(null), {
    region: 'global', pat: pat('a'), uid: 'u1', label: '一号', addedAt: 100,
  });
  assert.equal(first.entries.length, 1);
  const before = first.entries[0];
  const second = upsertPat(first, {
    region: 'global', pat: pat('b'), uid: 'u1', label: '', lastUsedAt: 200,
  });
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].id, before.id);
  assert.equal(second.entries[0].pat, pat('b'));
  assert.equal(second.entries[0].label, '一号');
  assert.equal(second.entries[0].addedAt, 100);
  assert.equal(second.entries[0].lastUsedAt, 200);

  const third = upsertPat(second, { region: 'cn', pat: pat('c'), uid: 'u2' });
  assert.equal(third.entries.length, 2);
  assert.equal(third.entries[0].region, 'cn', '新条目排在前面');
});

test('find/remove and public projection never expose the PAT', () => {
  const store = upsertPat(normalizePatStore(null), {
    region: 'global', pat: pat('a'), uid: 'u1', label: '一号', name: 'Alice', email: 'a@b.c',
  });
  const id = store.entries[0].id;
  assert.equal(findPat(store, id).pat, pat('a'));
  const pub = publicPat(store.entries[0], { activeUid: 'u1', activeRegion: 'global', activeSource: 'pat' });
  assert.equal(pub.active, true);
  assert.equal(pub.uidTail, 'u1'.slice(-6));
  assert.equal(pub.label, '一号');
  assert.equal('pat' in pub, false);
  assert.ok(!JSON.stringify(pub).includes('pt-'));
  const all = publicPatStore(store, { activeUid: 'u1', activeRegion: 'global', activeSource: 'desktop' });
  assert.equal(all.count, 1);
  assert.equal(all.entries[0].active, false);
  assert.ok(!JSON.stringify(all).includes('pt-'));

  const removed = removePat(store, id);
  assert.equal(removed.entries.length, 0);
  assert.equal(findPat(removed, id), null);
});

test('encrypted store round-trips and corrupt files stay visible as an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-pats-'));
  const path = join(dir, 'pats.json');
  try {
    const source = upsertPat(normalizePatStore(null), {
      region: 'cn', pat: pat('cn'), uid: 'u9', label: '国内',
    });
    await writePatStore(source, path);
    const loaded = readPatStore(path);
    assert.equal(loaded.error, '');
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0].pat, pat('cn'));
    assert.equal(loaded.entries[0].label, '国内');

    writeFileSync(path, 'not-json');
    const broken = readPatStore(path);
    assert.equal(broken.entries.length, 0);
    assert.ok(broken.error.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patId is stable and region/uid scoped', () => {
  assert.equal(patId('global', 'u1', pat('a')), patId('global', 'u1', pat('a')));
  assert.notEqual(patId('global', 'u1', pat('a')), patId('cn', 'u1', pat('a')));
  assert.notEqual(patId('global', 'u1', pat('a')), patId('global', 'u2', pat('a')));
});
