import test from 'node:test';
import assert from 'node:assert/strict';

import { getLocale, setLocale, tr, trDeep } from '../lib/i18n.mjs';
import { errorHint } from '../lib/adapter.mjs';
import { CODE } from '../lib/upstream-error.mjs';

const hasCjk = (text) => /[\u4e00-\u9fa5]/.test(text);

test('server i18n switches between Chinese and English without leaking state', () => {
  setLocale('zh');
  assert.equal(getLocale(), 'zh');
  assert.equal(tr('Qoder 模型正在排队，稍后会自动重试。'), 'Qoder 模型正在排队，稍后会自动重试。');
  setLocale('en');
  assert.equal(getLocale(), 'en');
  assert.equal(tr('Qoder 模型正在排队，稍后会自动重试。'), 'Qoder is queuing the request; it will retry automatically.');
});

test('adapter error hints follow the server locale', () => {
  setLocale('en');
  const hint = errorHint(CODE.QUOTA, '');
  assert.ok(!hasCjk(hint), hint);
  assert.match(hint, /quota/i);
  setLocale('zh');
  assert.match(errorHint(CODE.QUOTA, ''), /额度/);
});

test('dynamic commands and tool parameters translate their own text', () => {
  setLocale('en');
  const status = tr('今日 6 次 · 18.2k tokens');
  assert.ok(!hasCjk(status), status);
  assert.match(status, /Today|requests/);
  const deep = trDeep({ type: 'object', properties: { query: { type: 'string', description: '按模型 id 或显示名过滤' } } });
  assert.equal(deep.properties.query.description, 'Filter by model id or display name');
  setLocale('zh');
});
