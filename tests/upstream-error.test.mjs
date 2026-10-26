import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE, classifyError, extractErrorEnvelope, normalizeErrorText,
  parseRetryAfterHeader, retryAfterFrom,
  isModelQueue, isDailyCap, isTerminalSession, isVersionGate, isContentAudit, isTrialRestricted,
} from '../lib/upstream-error.mjs';

test('Qoder queue is retryable and survives escaped JSON', () => {
  assert.equal(classifyError('upstream isQueued', 200), CODE.RATE_LIMIT);
  assert.equal(classifyError('model 10605 is busy', 403), CODE.RATE_LIMIT);
  assert.equal(classifyError('{\\"code\\":\\"10605\\",\\"isQueued\\":true}', 403), CODE.RATE_LIMIT);
  assert.equal(isModelQueue('retryAfterSeconds: 12'), true);
  assert.equal(isModelQueue('a normal message'), false);
});

test('daily request cap is quota, not a retryable 5xx', () => {
  assert.equal(classifyError('Billing daily count exceeded', 200), CODE.QUOTA);
  assert.equal(classifyError('{"code":110,"message":"daily request count limit"}', 403), CODE.QUOTA);
  assert.equal(isDailyCap('model-1100 failed'), false, '不能把普通数字里的 110 当计费日限');
});

test('terminal session, version, audit and trial get deterministic classifications', () => {
  assert.equal(classifyError('12153', 403), CODE.AUTH);
  assert.equal(classifyError('TOKEN_EXPIRE', 403), CODE.AUTH);
  assert.equal(classifyError('Offline user session not found', 401), CODE.AUTH);
  assert.equal(isTerminalSession('TOKEN_EXPIRE'), true);
  assert.equal(classifyError('version_too_low', 400), CODE.INVALID);
  assert.equal(classifyError('anything', 430), CODE.INVALID);
  assert.equal(isVersionGate('version too low'), true);
  assert.equal(classifyError('DataInspectionFailed', 400), CODE.INVALID);
  assert.equal(isContentAudit('DataInspectionFailed'), true);
  assert.equal(classifyError('trial account is restricted', 403), CODE.INVALID);
  assert.equal(isTrialRestricted('试用账号受限'), true);
});

test('existing 402/408/429/context classifications stay intact', () => {
  assert.equal(classifyError('payment required', 402), CODE.QUOTA);
  assert.equal(classifyError('request timeout', 408), CODE.TIMEOUT);
  assert.equal(classifyError('too many requests', 429), CODE.RATE_LIMIT);
  assert.equal(classifyError('credits exhausted', 429), CODE.RATE_LIMIT);
  assert.equal(classifyError('insufficient_quota', 429), CODE.QUOTA);
  assert.equal(classifyError('maximum context length exceeded', 400), CODE.CONTEXT);
});

test('extractErrorEnvelope unwraps nested and escaped messages', () => {
  const plain = extractErrorEnvelope({
    error: { message: 'queued', code: 10605, retryAfterSeconds: 30 },
    isQueued: true,
  });
  assert.equal(plain.message, 'queued');
  assert.equal(plain.code, '10605');
  assert.equal(plain.isQueued, true);
  assert.equal(plain.retryAfterSeconds, 30);

  const escaped = extractErrorEnvelope('{\\"error\\":{\\"message\\":\\"queued\\",\\"code\\":10605,\\"retryAfterSeconds\\":12}}');
  assert.equal(escaped.code, '10605');
  assert.equal(escaped.retryAfterSeconds, 12);
  assert.equal(escaped.isQueued, false);

  const nested = extractErrorEnvelope({
    error: { message: '{"code":"110","message":"daily count exceeded"}' },
  });
  assert.equal(nested.code, '110');
  assert.match(nested.message, /daily count exceeded/);
});

test('retry-after parsing accepts seconds, decimals and HTTP dates', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(parseRetryAfterHeader('45', now), 45_000);
  assert.equal(parseRetryAfterHeader('1.5', now), 1500);
  assert.equal(parseRetryAfterHeader('Mon, 26 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfterHeader('Sun, 25 Oct 2026 12:00:00 GMT', now), null);
  assert.equal(parseRetryAfterHeader('-3', now), null);
  assert.equal(parseRetryAfterHeader('not-a-date', now), null);
  assert.equal(parseRetryAfterHeader('7200', now), null, '超过 1 小时不等待');
});

test('retryAfterFrom prefers body milliseconds over seconds and header', () => {
  const now = Date.now();
  const info = { retryAfterMs: 7000, retryAfterSeconds: 30, isQueued: true };
  assert.equal(retryAfterFrom({ info, headers: { 'retry-after': '45' }, now }), 7000);
  assert.equal(retryAfterFrom({ info: { retryAfterSeconds: 20 }, headers: { 'Retry-After': '45' }, now }), 20_000);
  assert.equal(retryAfterFrom({ info: {}, headers: { 'retry-after': '45' }, now }), 45_000);
  assert.equal(retryAfterFrom({ info: { isQueued: true }, now }), 5000);
  assert.equal(retryAfterFrom({ info: {}, now }), null);
});

test('normalizeErrorText folds escaped quotes for matching', () => {
  assert.equal(normalizeErrorText('{\\"code\\":\\"10605\\"}'), '{"code":"10605"}');
});
