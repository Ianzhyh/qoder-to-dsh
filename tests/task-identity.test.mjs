import test from 'node:test';
import assert from 'node:assert/strict';

import {
  conversationSeed, createTaskRegistry, lastUserIndex, taskNameOf, uuidFromHex,
} from '../lib/task-identity.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantTool = (id) => ({
  role: 'assistant',
  content: [{ type: 'tool-call', id, name: 'read', arguments: '{}' }],
});
const tool = (id, text = 'ok') => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text }] });

test('uuidFromHex emits a valid v4-shaped UUID', () => {
  const value = uuidFromHex('0123456789abcdef0123456789abcdef');
  assert.match(value, UUID);
  assert.equal(value.length, 36);
});

test('one tool loop keeps the same task; a new user prompt starts a new one', () => {
  const registry = createTaskRegistry({ now: () => 1000 });
  const first = [user('fix the bug'), assistantTool('c1'), tool('c1')];
  const second = [...first, { role: 'assistant', content: [{ type: 'text', text: 'working' }] }, assistantTool('c2')];
  const a = registry.forRequest({ account: 'u1', model: 'dfmodel', messages: first });
  const b = registry.forRequest({ account: 'u1', model: 'dfmodel', messages: second });
  assert.equal(a.id, b.id, 'same last user message -> same task');
  assert.equal(a.sessionId, b.sessionId, 'same conversation -> same session');
  assert.equal(a.beginAt, b.beginAt);

  const next = [...second, tool('c2'), user('now add a test')];
  const c = registry.forRequest({ account: 'u1', model: 'dfmodel', messages: next });
  assert.notEqual(c.id, b.id, 'new user message -> new task');
  assert.equal(c.sessionId, b.sessionId, 'same conversation keeps session');
});

test('system prompt changes do not split the conversation', () => {
  const registry = createTaskRegistry({ now: () => 2000 });
  const a = registry.forRequest({
    account: 'u1', model: 'dfmodel', messages: [{ role: 'system', content: 'v1' }, user('hello')],
  });
  const b = registry.forRequest({
    account: 'u1', model: 'dfmodel', messages: [{ role: 'system', content: 'v2' }, user('hello')],
  });
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(a.id, b.id);
});

test('different account or model gets a different session', () => {
  const registry = createTaskRegistry({ now: () => 3000 });
  const base = [user('hello')];
  const a = registry.forRequest({ account: 'u1', model: 'dfmodel', messages: base });
  const b = registry.forRequest({ account: 'u2', model: 'dfmodel', messages: base });
  const c = registry.forRequest({ account: 'u1', model: 'qmodel', messages: base });
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.sessionId, c.sessionId);
});

test('named host session id wins over the message digest', () => {
  const registry = createTaskRegistry({ now: () => 4000 });
  const a = registry.forRequest({ account: 'u1', model: 'dfmodel', messages: [user('a')], sessionId: 's-1' });
  const b = registry.forRequest({ account: 'u1', model: 'dfmodel', messages: [user('b')], sessionId: 's-1' });
  assert.equal(a.sessionId, b.sessionId, 'same host session -> same upstream session');
  assert.notEqual(a.id, b.id, 'different prompt -> different task');
});

test('markAnswered moves the next call to processing without changing ids', () => {
  const registry = createTaskRegistry({ now: () => 5000 });
  const first = registry.forRequest({ account: 'u1', model: 'dfmodel', messages: [user('go')] });
  assert.equal(first.answered, false);
  registry.markAnswered(first.key);
  const second = registry.forRequest({ account: 'u1', model: 'dfmodel', messages: [user('go'), assistantTool('c1')] });
  assert.equal(second.id, first.id);
  assert.equal(second.answered, true);
});

test('idle tasks are swept and the registry is bounded', () => {
  let clock = 10_000;
  const registry = createTaskRegistry({ max: 3, idleMs: 1000, now: () => clock });
  registry.forRequest({ account: 'u', model: 'm', messages: [user('one')] });
  clock += 500;
  registry.forRequest({ account: 'u', model: 'm', messages: [user('two')] });
  clock += 600; // "one" is now older than idleMs
  const three = registry.forRequest({ account: 'u', model: 'm', messages: [user('three')] });
  assert.equal(registry.size(), 2, 'expired task removed');
  clock += 5000;
  registry.forRequest({ account: 'u', model: 'm', messages: [user('four')] });
  assert.ok(registry.size() <= 3);
  assert.ok(three.id);
});

test('helpers handle empty and non-text content', () => {
  assert.equal(lastUserIndex([{ role: 'system', content: 's' }]), -1);
  assert.equal(taskNameOf({ content: [{ type: 'image' }] }), '[image]');
  assert.equal(taskNameOf({ content: 'a very long prompt indeed' }), 'a very lon');
  assert.equal(conversationSeed({ account: 'u', model: 'm', messages: [] }), 'u\u0000m\u0000');
});
