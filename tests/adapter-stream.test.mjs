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
    authGeneration: 0,
    accountStamp() { return { account: 'uid:test1234', generation: this.authGeneration }; },
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

function errorClient({ status, text, headers = {} }) {
  return {
    auth: { source: 'desktop' },
    authGeneration: 0,
    accountStamp() { return { account: 'uid:test1234', generation: 0 }; },
    async chat() {
      return { ok: false, status, headers, body: null, text: async () => text };
    },
  };
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
  assert.equal(record.account, 'uid:test1234');
});

test('a consumer that stops early is recorded as aborted, not success', async () => {
  const body = sseBody([
    { choices: [{ delta: { content: 'partial answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const iterator = adapterFor(fakeClient(body)).stream({
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 32,
  })[Symbol.asyncIterator]();
  let first = await iterator.next();
  while (!first.done && first.value.type !== 'text-delta') first = await iterator.next();
  assert.equal(first.value.type, 'text-delta');
  await iterator.return();

  const record = lastUsage();
  assert.equal(record.ok, false, '提前结束不能记成成功');
  assert.equal(record.status, 'aborted');
});

test('account switch during a stream is visible as ABORTED and keeps the old account stamp', async () => {
  const encoder = new TextEncoder();
  let controllerRef = null;
  const body = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`));
    },
  });
  const client = fakeClient(body);
  const iterator = adapterFor(client).stream({
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 32,
  })[Symbol.asyncIterator]();
  let first = await iterator.next();
  while (!first.done && first.value.type !== 'text-delta') first = await iterator.next();
  assert.equal(first.value.type, 'text-delta');
  client.authGeneration = 1;
  controllerRef.error(new Error('socket closed'));
  const rest = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    rest.push(next.value);
  }
  const finish = rest.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.ABORTED);
  const record = lastUsage();
  assert.equal(record.status, 'aborted');
  assert.equal(record.ok, false);
  assert.equal(record.account, 'uid:test1234');
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

test('HTTP 403 queue uses Retry-After and does not become an auth error', async () => {
  const chunks = await collect(adapterFor(errorClient({
    status: 403,
    headers: { 'retry-after': '45' },
    text: JSON.stringify({ error: { message: 'queued', code: 10605 } }),
  })));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.failure.code, CODE.RATE_LIMIT);
  assert.equal(finish.reason.failure.status, 403);
  assert.equal(finish.reason.failure.providerRetryAfterMs, 45_000);
});

test('content audit and terminal session codes get actionable failures', async () => {
  const audit = await collect(adapterFor(errorClient({
    status: 400,
    text: JSON.stringify({ error: { message: 'DataInspectionFailed' } }),
  })));
  const auditFinish = audit.find((chunk) => chunk.type === 'finish');
  assert.equal(auditFinish.reason.failure.code, CODE.INVALID);
  assert.match(auditFinish.reason.failure.message, /内容审核/);

  const session = await collect(adapterFor(errorClient({
    status: 401,
    text: JSON.stringify({ error: { message: '12153', code: 12153 } }),
  })));
  const sessionFinish = session.find((chunk) => chunk.type === 'finish');
  assert.equal(sessionFinish.reason.failure.code, CODE.AUTH);
  assert.match(sessionFinish.reason.failure.message, /会话已失效/);
});

test('in-stream queue frames carry their retry delay', async () => {
  const chunks = await collect(adapterFor(fakeClient(sseBody([
    { error: { message: 'queued', code: 10605, retryAfterSeconds: 12 } },
  ]))));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.failure.code, CODE.RATE_LIMIT);
  assert.equal(finish.reason.failure.providerRetryAfterMs, 12_000);
});

test('queue, daily cap and version errors include actionable hints', async () => {
  const queue = await collect(adapterFor(errorClient({
    status: 403,
    text: JSON.stringify({ error: { message: 'queued', code: 10605, retryAfterSeconds: 4 } }),
  })));
  assert.match(queue.find((chunk) => chunk.type === 'finish').reason.failure.message, /排队/);

  const daily = await collect(adapterFor(errorClient({
    status: 403,
    text: JSON.stringify({ error: { message: 'Billing daily count exceeded', code: 110 } }),
  })));
  const dailyFinish = daily.find((chunk) => chunk.type === 'finish');
  assert.equal(dailyFinish.reason.failure.code, CODE.QUOTA);
  assert.match(dailyFinish.reason.failure.message, /今日请求次数/);

  const version = await collect(adapterFor(errorClient({
    status: 430,
    text: JSON.stringify({ error: { message: 'version too low', code: 430 } }),
  })));
  const versionFinish = version.find((chunk) => chunk.type === 'finish');
  assert.equal(versionFinish.reason.failure.code, CODE.INVALID);
  assert.match(versionFinish.reason.failure.message, /版本过低|升级/);
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});
