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

async function collect(target, options = {}) {
  const chunks = [];
  for await (const chunk of target.stream({
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 32,
    ...options,
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

test('missing upstream usage is estimated into the local ledger', async () => {
  const body = sseBody([
    { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] },
  ]);
  const chunks = await collect(adapterFor(fakeClient(body)));
  const usage = chunks.find((chunk) => chunk.type === 'usage').usage;
  assert.equal(usage.estimated, true);
  const record = lastUsage();
  assert.equal(record.estimated, true);
  assert.ok(record.promptTokens > 0);
  assert.ok(record.completionTokens > 0);
  assert.ok(record.totalTokens > 0);
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

test('an error frame with an empty choices array is still an upstream error', async () => {
  const chunks = await collect(adapterFor(fakeClient(rawBody(
    'data: {"code":10605,"message":"queued","choices":[],"retryAfterSeconds":3}\n\ndata: [DONE]\n\n',
  ))));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.RATE_LIMIT);
  assert.equal(finish.reason.failure.providerRetryAfterMs, 3000);
  assert.match(finish.reason.failure.message, /排队/);
});

test('an interrupted tool call is never emitted as a block-end', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
      ));
      setTimeout(() => controller.error(new Error('socket closed')), 5);
    },
  });
  const chunks = await collect(adapterFor(fakeClient(body)));
  assert.equal(chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').length, 0,
    '半截 JSON 的工具调用不能写成完整块');
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TRANSPORT);
});

test('a clean EOF with half-built tool arguments is a retryable transport drop', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
      ));
      controller.close();
    },
  });
  const chunks = await collect(adapterFor(fakeClient(body)));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TRANSPORT, 'clean EOF 没有 finish_reason，属中断而不是参数错误');
  assert.match(finish.reason.failure.message, /中断/);
});

test('a caller abort ends as ABORTED, not a retryable TRANSPORT drop', async () => {
  const controller = new AbortController();
  const client = {
    auth: { source: 'desktop' },
    authGeneration: 0,
    accountStamp() { return { account: 'uid:test1234', generation: 0 }; },
    async chat(_payload, { signal }) {
      const body = new ReadableStream({
        start(streamController) {
          streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          signal.addEventListener('abort', () => {
            try { streamController.close(); } catch { /* already closed */ }
          }, { once: true });
        },
      });
      return { ok: true, status: 200, headers: {}, body, text: async () => '' };
    },
  };
  const chunksPromise = collect(adapterFor(client), { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const chunks = await chunksPromise;
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'aborted');
  assert.equal(finish.reason.failure.code, CODE.ABORTED);
  assert.equal(lastUsage().status, 'aborted');
});

test('a clean EOF after an account switch is ABORTED, not TRANSPORT', async () => {
  const client = {
    auth: { source: 'desktop' },
    authGeneration: 0,
    accountStamp() { return { account: 'uid:test1234', generation: this.authGeneration }; },
    async chat() {
      const body = new ReadableStream({
        start(streamController) {
          streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          setTimeout(() => {
            client.authGeneration = 1;
            try { streamController.close(); } catch { /* already closed */ }
          }, 10);
        },
      });
      return { ok: true, status: 200, headers: {}, body, text: async () => '' };
    },
  };
  const chunks = await collect(adapterFor(client));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.ABORTED);
  assert.equal(lastUsage().status, 'aborted');
});

test('first-byte timeout after headers is still a TIMEOUT, not a transport drop', async () => {
  const client = {
    auth: { source: 'desktop' },
    authGeneration: 0,
    accountStamp() { return { account: 'uid:test1234' }; },
    async chat(_payload, { signal }) {
      // 真实客户端在守卫触发后会关闭转译流；适配器看到的是“正常结束”。
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => {
            try { controller.close(); } catch { /* already closed */ }
          }, { once: true });
        },
      });
      return { ok: true, status: 200, headers: {}, body, text: async () => '' };
    },
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

test('task identity stays stable across a tool loop and releases the lease', async () => {
  const payloads = [];
  const releases = [];
  const client = fakeClient(sseBody([
    { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ]));
  const chat = client.chat.bind(client);
  client.chat = async (payload, options) => {
    payloads.push(structuredClone(payload));
    return chat(payload, options);
  };
  client.releaseAsk = async (info) => { releases.push(info); return true; };

  const adapter = adapterFor(client);
  const firstMessages = [{ role: 'user', content: [{ type: 'text', text: 'fix the bug' }] }];
  await collect(adapter, { messages: firstMessages });
  await collect(adapter, {
    messages: [
      ...firstMessages,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file' }] },
    ],
  });

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].task.id, payloads[1].task.id, 'same task across tool loop');
  assert.equal(payloads[0].task.sessionId, payloads[1].task.sessionId);
  assert.equal(payloads[0].task.beginAt, payloads[1].task.beginAt);
  assert.equal(payloads[1].task.answered, true, 'second call is processing');
  assert.equal(releases.length, 2);
  assert.equal(releases[0].requestSetId, payloads[0].task.id);
});

test('a new user prompt starts a new task but keeps the session', async () => {
  const payloads = [];
  const client = fakeClient(sseBody([
    { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
  ]));
  const chat = client.chat.bind(client);
  client.chat = async (payload, options) => { payloads.push(structuredClone(payload)); return chat(payload, options); };
  client.releaseAsk = async () => true;

  const adapter = adapterFor(client);
  const first = [{ role: 'user', content: [{ type: 'text', text: 'one' }] }];
  await collect(adapter, { messages: first });
  await collect(adapter, {
    messages: [...first, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'two' }] }],
  });
  assert.notEqual(payloads[0].task.id, payloads[1].task.id);
  assert.equal(payloads[0].task.sessionId, payloads[1].task.sessionId);
});

test('queue failures release the upstream lease', async () => {
  const releases = [];
  const client = errorClient({ status: 403, text: '{"code":"10605","message":"isQueued","retryAfterSeconds":30}' });
  client.releaseAsk = async (info) => { releases.push(info); return true; };
  const chunks = await collect(adapterFor(client));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.failure.code, CODE.RATE_LIMIT);
  assert.equal(releases.length, 1);
  assert.ok(releases[0].requestSetId);
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});

test('HTTP 430 retries once with the legacy COSY version', async () => {
  const payloads = [];
  let call = 0;
  const client = {
    auth: { source: 'desktop' },
    authGeneration: 0,
    accountStamp() { return { account: 'uid:legacy', generation: 0 }; },
    async chat(payload) {
      payloads.push({ ...payload });
      call += 1;
      if (call === 1) {
        return { ok: false, status: 430, headers: {}, body: null, text: async () => 'version too low' };
      }
      return { ok: true, status: 200, headers: {}, body: sseBody([
        { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]), text: async () => '' };
    },
  };
  const chunks = await collect(adapterFor(client));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'stop');
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].forceLegacy, true);
  assert.equal(payloads[0].forceLegacy, undefined);
});

test('a missing billable flag stays unknown so free models can be reconciled later', async () => {
  // usage.billable !== false 会把「上游没给这个字段」钉成 true；一旦落盘，
  // reconcileUsage 因为 billable !== undefined 直接跳过，免费模型的消耗
  // 就被永久记成实扣，且没法回补。
  const body = sseBody([
    {
      choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, credits: 5 },
    },
  ]);
  await collect(adapterFor(fakeClient(body)));
  const record = lastUsage();
  assert.equal(record.billable, undefined, '未知必须保持 undefined，不能写成 true');
  assert.equal(record.credits, 5);
});

test('an explicit billable:false records zero spend and the saved amount', async () => {
  const body = sseBody([
    {
      choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, credits: 5, billable: false },
    },
  ]);
  await collect(adapterFor(fakeClient(body)));
  const record = lastUsage();
  assert.equal(record.billable, false);
  assert.equal(record.credits, 0);
  assert.equal(record.savedCredits, 5);
});

test('403 with a numeric quota code is not reported as an auth failure', async () => {
  // Qoder 常见形态：403 + {"code":110} 表示日限，{"code":112} 表示额度不足。
  // 以前 adapter 只把 codeLabel 裸拼进分类文本，全都落到 AUTH，把「等明天/
  // 换号」指成「重新授权」。
  const cases = [
    ['{"code":110,"message":"billing daily count exceeded"}', CODE.QUOTA],
    ['{"code":112,"message":"insufficient quota"}', CODE.QUOTA],
    ['{"code":114,"message":"trial restricted"}', CODE.INVALID],
    ['{"code":12153,"message":"TOKEN_EXPIRE"}', CODE.AUTH],
  ];
  for (const [text, expected] of cases) {
    const chunks = await collect(adapterFor(errorClient({ status: 403, text })));
    const finish = chunks.find((chunk) => chunk.type === 'finish');
    assert.equal(finish.reason.failure.code, expected, `${text} 应判为 ${expected}`);
  }
});

test('catalogClientStale on the client disables the model preflight gate', () => {
  // catalogClientStale 只由 QoderClient 赋值；adapter 以前读自己的同名字段，
  // 而它从不被写，于是「客户端升级后放行新模型」的逃生口永远不生效。
  const client = {
    ...fakeClient(sseBody([])),
    catalogClientStale: true,
    catalogCache: { at: Date.now(), models: [{ id: 'old-model' }] },
  };
  const adapter = adapterFor(client);
  adapter.catalogCache = { at: Date.now(), models: [{ id: 'old-model' }] };
  assert.equal(adapter.modelPreflight('brand-new-model'), '', '客户端目录过期时不该拦新模型');

  const fresh = adapterFor({ ...fakeClient(sseBody([])), catalogClientStale: false });
  fresh.catalogCache = { at: Date.now(), models: [{ id: 'old-model' }] };
  assert.match(fresh.modelPreflight('brand-new-model'), /不在当前 Qoder 目录/, '目录新鲜时仍要拦');
});
