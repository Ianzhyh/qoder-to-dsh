import test from 'node:test';
import assert from 'node:assert/strict';

import { trimImages, __test } from '../lib/request-budget.mjs';

const image = (seed) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${seed}` } });
const msg = (parts) => ({ role: 'user', content: parts });

test('keeps the most recent N images and replaces the oldest', () => {
  const messages = [msg(Array.from({ length: 60 }, (_, index) => image(`img-${index}`)))];
  const out = trimImages(messages, { maxImages: 50, maxBytes: 10 * 1024 * 1024 });
  assert.equal(out.images, 50);
  assert.equal(out.droppedByCount, 10);
  assert.equal(out.droppedByBytes, 0);
  assert.equal(out.messages[0].content[0].type, 'text');
  assert.match(out.messages[0].content[0].text, /图片已省略/);
  assert.equal(out.messages[0].content[59].type, 'image_url');
});

test('drops older images until the body fits the byte budget', () => {
  const big = 'A'.repeat(4096);
  const messages = [msg(Array.from({ length: 12 }, () => image(big)))];
  const out = trimImages(messages, { maxImages: 50, maxBytes: 20_000 });
  assert.ok(out.bytes <= 20_000, `bytes=${out.bytes}`);
  assert.ok(out.droppedByBytes > 0);
  assert.ok(out.images < 12);
  assert.equal(out.messages[0].content[11].type, 'image_url', 'newest image stays');
});

test('maxImages=0 removes every image and leaves text untouched', () => {
  const messages = [msg([{ type: 'text', text: 'before' }, image('x'), { type: 'text', text: 'after' }])];
  const out = trimImages(messages, { maxImages: 0, maxBytes: 10 * 1024 * 1024 });
  assert.equal(out.images, 0);
  assert.equal(out.messages[0].content[0].text, 'before');
  assert.equal(out.messages[0].content[2].text, 'after');
  assert.match(out.messages[0].content[1].text, /图片已省略/);
});

test('messages without images are returned unchanged', () => {
  const messages = [msg([{ type: 'text', text: 'hello' }])];
  const out = trimImages(messages, { maxImages: 50, maxBytes: 10 * 1024 * 1024 });
  assert.equal(out.dropped, 0);
  assert.equal(out.images, 0);
  assert.equal(out.messages[0].content[0].text, 'hello');
});

test('non-array content and malformed messages are ignored', () => {
  const messages = [{ role: 'tool', content: 'text' }, null, msg([image('x')])];
  const out = trimImages(messages, { maxImages: 0, maxBytes: 10 * 1024 * 1024 });
  assert.equal(out.images, 0);
  assert.equal(out.dropped, 1);
});

test('byte estimator is stable for the placeholder text', () => {
  assert.equal(__test.bodyBytes([]), 2);
  assert.match(__test.PLACEHOLDER, /Qoder/);
});
