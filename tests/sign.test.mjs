import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  CosySession, deriveId, deriveMachineToken, deriveMachineType, qoderDecode, qoderEncode, sortedCompact,
} from '../lib/qoder-sign.mjs';

test('qoderEncode / qoderDecode round-trip', () => {
  for (const value of [Buffer.from('{}'), Buffer.from('hello qoder'), randomBytes(97)]) {
    const encoded = qoderEncode(value);
    assert.ok(!encoded.includes('='));
    assert.deepEqual(qoderDecode(encoded), value);
  }
});

test('qoderEncode matches the original permutation at every padding length', () => {
  const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
  const std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const table = new Map();
  for (let i = 0; i < 64; i += 1) table.set(std[i], custom[i]);
  table.set('=', '$');
  const reference = (plain) => {
    const encoded = Buffer.from(plain).toString('base64');
    const n = encoded.length;
    const a = Math.floor(n / 3);
    const rearranged = encoded.slice(n - a) + encoded.slice(a, n - a) + encoded.slice(0, a);
    let out = '';
    for (const ch of rearranged) out += table.get(ch) || ch;
    return out;
  };
  for (let length = 0; length <= 300; length += 1) {
    const bytes = randomBytes(length);
    assert.equal(qoderEncode(bytes), reference(bytes), `buffer length ${length}`);
    assert.equal(qoderEncode(bytes.toString('latin1')), reference(bytes.toString('latin1')), `string length ${length}`);
  }
  assert.equal(qoderEncode('中文 · emoji 🚀'), reference('中文 · emoji 🚀'));
});

test('sortedCompact sorts keys and keeps compact JSON', () => {
  assert.equal(sortedCompact({ b: 1, a: 'x', c: null }), '{"a":"x","b":1,"c":null}');
  assert.equal(sortedCompact({ z: [1, 2], a: { d: true, c: false } }), '{"a":{"c":false,"d":true},"z":[1,2]}');
});

test('fingerprints are stable and shaped like the official client', () => {
  const uid = '01a1544b-75db-7ec6-acbc-f80e857d525c';
  const id = deriveId(uid, 'machine');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, deriveId(uid, 'machine'));
  assert.match(deriveMachineType(uid), /^[0-9a-f]{18}$/);
  assert.equal(deriveMachineToken(uid).length, 43);
});

test('COSY headers carry the signature envelope without SSE-only fields', () => {
  const session = new CosySession({
    uid: '01a1544b-75db-7ec6-acbc-f80e857d525c',
    nickname: 'tester',
    accessToken: 'dt-test-token',
    refreshToken: 'drt-test-token',
  });
  const headers = session.headers('body-bytes', 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1', {
    modelKey: 'auto',
    sse: false,
    accept: 'application/json',
  });
  assert.match(headers.authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+[.][0-9a-f]{32}$/);
  assert.equal(headers['cosy-version'], '1.1.75');
  assert.equal(headers['cosy-user'], '01a1544b-75db-7ec6-acbc-f80e857d525c');
  assert.equal(headers['x-model-key'], 'auto');
  assert.equal(headers.accept, 'application/json');
  assert.ok(headers['cosy-key']);
  assert.equal('cache-control' in headers, false);
  assert.equal('cosy-machinehostname' in headers, false);
});
