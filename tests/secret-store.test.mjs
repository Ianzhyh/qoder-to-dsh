import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCredentialScheme } from '../lib/secret-store.mjs';

test('readCredentialScheme reports the envelope without decrypting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-secret-'));
  const path = join(dir, 'auth.json');
  try {
    assert.equal(readCredentialScheme(path), 'missing');
    writeFileSync(path, JSON.stringify({ v: 1, scheme: 'dpapi', data: 'bm90LWEtcmVhbC10b2tlbg==' }));
    assert.equal(readCredentialScheme(path), 'dpapi');
    writeFileSync(path, JSON.stringify({ v: 1, scheme: 'aes-256-gcm', data: 'x' }));
    assert.equal(readCredentialScheme(path), 'aes-256-gcm');
    writeFileSync(path, '{broken');
    assert.equal(readCredentialScheme(path), 'unknown');
    writeFileSync(path, JSON.stringify({ v: 2, scheme: 'dpapi', data: 'x' }));
    assert.equal(readCredentialScheme(path), 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
