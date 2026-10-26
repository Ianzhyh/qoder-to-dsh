import test from 'node:test';
import assert from 'node:assert/strict';

import { createFirstByteGuard, createLinkedSignal } from '../lib/request-guard.mjs';

test('linked signal relays parent abort with the same reason', () => {
  const parent = new AbortController();
  const linked = createLinkedSignal(parent.signal);
  assert.equal(linked.signal.aborted, false);
  const reason = new Error('stop');
  parent.abort(reason);
  assert.equal(linked.signal.aborted, true);
  assert.equal(linked.signal.reason, reason);
  linked.dispose();
});

test('linked signal starts aborted when the parent is already aborted', () => {
  const parent = new AbortController();
  parent.abort(new Error('already'));
  const linked = createLinkedSignal(parent.signal);
  assert.equal(linked.signal.aborted, true);
  assert.match(linked.signal.reason.message, /already/);
  linked.dispose();
});

test('dispose detaches the parent listener', () => {
  const parent = new AbortController();
  const linked = createLinkedSignal(parent.signal);
  linked.dispose();
  linked.dispose();
  parent.abort(new Error('late'));
  assert.equal(linked.signal.aborted, false);
});

test('first-byte guard times out with a stable error code', async () => {
  const guard = createFirstByteGuard({ timeoutMs: 10, label: '首包' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(guard.timedOut, true);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.signal.reason.code, 'FIRST_BYTE_TIMEOUT');
  guard.dispose();
});

test('clear stops the timeout but still relays caller cancellation', async () => {
  const parent = new AbortController();
  const guard = createFirstByteGuard({ signal: parent.signal, timeoutMs: 20 });
  guard.clear();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(guard.timedOut, false);
  assert.equal(guard.signal.aborted, false);

  parent.abort(new Error('caller cancelled'));
  assert.equal(guard.signal.aborted, true);
  assert.match(guard.signal.reason.message, /caller cancelled/);
  guard.dispose();
});

test('dispose prevents later caller cancellation from touching the signal', () => {
  const parent = new AbortController();
  const guard = createFirstByteGuard({ signal: parent.signal, timeoutMs: 0 });
  guard.dispose();
  parent.abort(new Error('after dispose'));
  assert.equal(guard.signal.aborted, false);
});
