import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'qoder-stream-'));
process.env.DSH_HOME = home;
process.env.QODER_TO_DSH_HOME = join(home, 'qoder');

const { QoderAdapter, CODE } = await import('../lib/adapter.mjs');
const { readUsage } = await import('../lib/state.mjs');

const encoder = new TextEncoder();

function sseBody(frames) {
  const text = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function fakeClient(body) {
  return {
    auth: { source: 'desktop' },
    async chat() {
      return {
        ok: true,
        status: 200,
        body,
        text: async () => '',
      };
    },
  };
}

function adapterFor(client, options = {}) {
  return new QoderAdapter({
    provider: 'qoder',
    displayName: 'Qoder',
    client,
    prefs: { visible: null, pinned: '', includeAll: true, contextWindowByModel: {}, paramsByModel: {} },
    log: () => {},
    streamIdleTimeoutMs: 1000,
    firstByteTimeoutMs: 1000,
    ...options,
  });
}

async function collect(target) {
  const chunks = [];
  for await (const chunk of target.stream({
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 32,
  })) chunks.push(chunk);
  return chunks;
}

function lastUsage() {
  return readUsage().at(-1);
}

test('stream accepts reasoning deltas and records a successful request', async () => {
  const body = sseBody([
    { choices: [{ delta: { reasoning: 'think ' } }] },
    { choices: [{ delta: { reasoning_content: 'more', content: 'hello' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, credits: 0.01 },
    },
  ]);
  const chunks = await collect(adapterFor(fakeClient(body)));
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'think more');
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'hello');
  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'stop');
  const record = lastUsage();
  assert.equal(record.ok, true);
  assert.equal(record.status, 'ok');
  assert.equal(record.credits, 0.01);
  assert.equal(record.totalTokens, 13);
});

test('empty stop and content_filter both finish as errors and are not recorded as success', async () => {
  const empty = await collect(adapterFor(fakeClient(sseBody([
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]))));
  const emptyFinish = empty.find((chunk) => chunk.type === 'finish');
  assert.equal(emptyFinish.reason.kind, 'error');
  assert.equal(emptyFinish.reason.failure.code, CODE.EMPTY);
  let record = lastUsage();
  assert.equal(record.ok, false);
  assert.equal(record.status, 'stream-error');
  assert.match(record.error, /没有任何内容/);

  const filtered = await collect(adapterFor(fakeClient(sseBody([
    { choices: [{ delta: { content: 'partial' } }] },
    { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
  ]))));
  const filteredFinish = filtered.find((chunk) => chunk.type === 'finish');
  assert.equal(filteredFinish.reason.kind, 'error');
  assert.equal(filteredFinish.reason.failure.code, CODE.INVALID);
  record = lastUsage();
  assert.equal(record.ok, false);
  assert.equal(record.status, 'stream-error');
  assert.match(record.error, /content_filter/);
});

test('first-byte timeout ends the stream with a visible TIMEOUT instead of hanging', async () => {
  const hanging = new ReadableStream({ start() {}, cancel() {} });
  const started = Date.now();
  const chunks = await collect(adapterFor(fakeClient(hanging), { firstByteTimeoutMs: 40 }));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TIMEOUT);
  assert.match(finish.reason.failure.message, /首包/);
  assert.ok(Date.now() - started < 2000);
  const record = lastUsage();
  assert.equal(record.ok, false);
  assert.equal(record.status, 'stream-error');
});

test('request setup failures keep auth errors distinct from network failures', async () => {
  const client = {
    auth: { source: 'desktop' },
    async chat() {
      const error = new Error('尚未登录 Qoder');
      error.code = 'AUTH';
      throw error;
    },
  };
  const chunks = await collect(adapterFor(client));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.AUTH);
  assert.match(finish.reason.failure.message, /重新授权/);
  assert.equal(lastUsage().status, 'auth');
});

test('first-byte timeout also covers a request that never returns headers', async () => {
  const client = {
    auth: { source: 'desktop' },
    chat: (_payload, { signal }) => new Promise((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };
  const started = Date.now();
  const chunks = await collect(adapterFor(client, { firstByteTimeoutMs: 40 }));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TIMEOUT);
  assert.match(finish.reason.failure.message, /首包/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(lastUsage().status, 'stream-error');
});

test('disabling first-byte timeout still applies the idle timeout to the first block', async () => {
  const hanging = new ReadableStream({ start() {}, cancel() {} });
  const started = Date.now();
  const chunks = await collect(adapterFor(fakeClient(hanging), {
    firstByteTimeoutMs: 0,
    streamIdleTimeoutMs: 40,
  }));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TIMEOUT);
  assert.match(finish.reason.failure.message, /首包/);
  assert.ok(Date.now() - started < 2000, '首块仍受 idle 超时保护');
});

function rawBody(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

test('a stream that ends without finish_reason or [DONE] is a transport failure, not a silent success', async () => {
  // 上游半路关连接：有内容、没有 finish_reason、也没有 [DONE]。
  // 旧实现落到 mapFinishReason 的 default 分支返回 stop——半截回答被当成成功，
  // 不重试，用户也不知道少了一段。
  const chunks = await collect(adapterFor(fakeClient(rawBody(
    'data: {"choices":[{"delta":{"content":"half an answer"}}]}\n\n',
  ))));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TRANSPORT);
  assert.match(finish.reason.failure.message, /中断/);
  assert.equal(lastUsage().ok, false);
  assert.equal(lastUsage().status, 'stream-error');
});

test('[DONE] alone still counts as a clean completion', async () => {
  // 有些网关只发 [DONE]、不填 finish_reason；这仍是明确的收尾，不能报成中断。
  const chunks = await collect(adapterFor(fakeClient(rawBody(
    'data: {"choices":[{"delta":{"content":"complete"}}]}\n\ndata: [DONE]\n\n',
  ))));
  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'stop');
  assert.equal(lastUsage().ok, true);
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});
