import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在加载业务模块之前设定：adapter 记录用量时读的是 PATHS.usage，
// 不隔离会把用例里的假请求（"should not reach upstream" 等）写进真实账本。
// ESM 的静态 import 会先于赋值执行，所以这里只能用动态 import。
const home = mkdtempSync(join(tmpdir(), 'qoder-adapter-'));
process.env.DSH_HOME = home;
process.env.QODER_TO_DSH_HOME = join(home, 'qoder');

const {
  CODE, QoderAdapter, StreamTranslator, classifyError, findInvalidTool, mapUsage, sanitizeWire, toWireMessage, toWireTools,
} = await import('../lib/adapter.mjs');
const { DEFAULTS } = await import('../lib/config.mjs');

test('cleanup adapter fixtures', () => {
  rmSync(home, { recursive: true, force: true });
});

test('StreamTranslator maps reasoning, text, tool calls and usage', () => {
  const translator = new StreamTranslator();
  const chunks = [];
  const frames = [
    'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"more","content":"hello"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":30}}}',
  ];
  for (const frame of frames) chunks.push(...translator.pushLine(frame));
  chunks.push(...translator.finish());

  const starts = chunks.filter((chunk) => chunk.type === 'block-start').map((chunk) => chunk.blockType);
  assert.deepEqual(starts, ['reasoning', 'text', 'tool-call']);
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'think more');
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'hello');
  const tool = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
  assert.equal(tool.block.id, 'call_1');
  assert.equal(tool.block.name, 'read');
  assert.equal(tool.block.arguments, '{"path":"x"}');
  const usage = chunks.find((chunk) => chunk.type === 'usage');
  assert.equal(usage.usage.inputTokens, 70);
  assert.equal(usage.usage.cacheReadTokens, 30);
  assert.equal(usage.usage.totalTokens, 120);
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'tool-calls');
});

test('stream error frames finish as errors instead of pretending success', () => {
  const translator = new StreamTranslator();
  translator.pushLine('data: {"choices":[{"delta":{"content":"partial"}}]}');
  translator.pushLine('data: {"error":{"message":"upstream exploded","code":"E1"}}');
  const chunks = translator.finish();
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.match(finish.reason.failure.message, /upstream exploded/);
  assert.match(finish.reason.failure.message, /E1/);
});

test('classifyError keeps 429 retryable when the body merely mentions credits', () => {
  assert.equal(classifyError('rate limit reached; credits are low', 429), CODE.RATE_LIMIT);
  assert.equal(classifyError('rate limit reached', 429), CODE.RATE_LIMIT);
  assert.equal(classifyError('insufficient credits', 429), CODE.QUOTA);
  assert.equal(classifyError('insufficient_quota', 429), CODE.QUOTA);
  assert.equal(classifyError('payment required', 402), CODE.QUOTA);
  assert.equal(classifyError('upstream request timeout', 408), CODE.TIMEOUT);
});

test('resolveModel always returns a positive context window even without catalog metadata', async () => {
  const adapter = new QoderAdapter({
    provider: 'qoder',
    client: { listCatalog: async () => ({ at: 0, models: [] }) },
    prefs: { visible: null, pinned: '', includeAll: true, contextWindowByModel: {}, paramsByModel: {} },
    log: () => {},
  });
  assert.equal(adapter.contextWindowFor('unknown'), DEFAULTS.fallbackContextWindow);
  const resolved = await adapter.resolveModel('qoder', 'unknown');
  assert.equal(resolved.context.contextWindow, DEFAULTS.fallbackContextWindow);
});

test('queue error frames carry providerRetryAfterMs and stay retryable', () => {
  const translator = new StreamTranslator();
  translator.pushLine('data: {"error":{"message":"queued","code":10605,"retryAfterSeconds":30}}');
  const finish = translator.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.failure.code, CODE.RATE_LIMIT);
  assert.equal(finish.reason.failure.providerRetryAfterMs, 30_000);

  const escaped = new StreamTranslator();
  escaped.pushLine('data: {"error":{"message":"{\\"code\\":\\"10605\\",\\"isQueued\\":true}"}}');
  const queued = escaped.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(queued.reason.failure.code, CODE.RATE_LIMIT);
  assert.equal(queued.reason.failure.providerRetryAfterMs, 5000);
});

test('reasoning-only finishes are visible EMPTY_RESPONSE, not success', () => {
  const stop = new StreamTranslator();
  stop.pushLine('data: {"choices":[{"delta":{"reasoning":"think only"}}]}');
  stop.pushLine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}');
  const stopFinish = stop.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(stopFinish.reason.kind, 'error');
  assert.equal(stopFinish.reason.failure.code, CODE.EMPTY);
  assert.match(stopFinish.reason.failure.message, /思考内容/);

  const length = new StreamTranslator();
  length.pushLine('data: {"choices":[{"delta":{"reasoning":"think only"}}]}');
  length.pushLine('data: {"choices":[{"delta":{},"finish_reason":"length"}]}');
  const lengthFinish = length.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(lengthFinish.reason.failure.code, CODE.EMPTY);

  const withText = new StreamTranslator();
  withText.pushLine('data: {"choices":[{"delta":{"reasoning":"think","content":"answer"}}]}');
  withText.pushLine('data: {"choices":[{"delta":{},"finish_reason":"length"}]}');
  assert.equal(withText.finish().find((chunk) => chunk.type === 'finish').reason.kind, 'max-tokens');
});

test('invalid tool calls are blocked from the session with a visible error', () => {
  const badName = new StreamTranslator();
  badName.pushLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bad.name","arguments":"{}"}}]}}]}');
  badName.pushLine('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  const badNameChunks = badName.finish();
  assert.equal(badNameChunks.some((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'), false);
  const nameFinish = badNameChunks.find((chunk) => chunk.type === 'finish');
  assert.equal(nameFinish.reason.failure.code, CODE.INVALID);
  assert.match(nameFinish.reason.failure.message, /工具名/);

  const badArgs = new StreamTranslator();
  badArgs.pushLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"read","arguments":"{\\"x\\":"}}]}}]}');
  badArgs.pushLine('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  const argsFinish = badArgs.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(argsFinish.reason.failure.code, CODE.INVALID);
  assert.match(argsFinish.reason.failure.message, /参数/);
});

test('synthesized tool ids include a per-translator prefix and are unique', () => {
  const frame = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{}"}}]}}]}';
  const injected = new StreamTranslator({ idPrefix: 'call_test' });
  injected.pushLine(frame);
  injected.pushLine('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  const injectedBlock = injected.finish().find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  assert.equal(injectedBlock.block.id, 'call_test_0');

  const first = new StreamTranslator();
  first.pushLine(frame);
  first.pushLine('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  const firstBlock = first.finish().find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  assert.match(firstBlock.block.id, /^call_[a-z0-9]+_0$/);

  const second = new StreamTranslator();
  second.pushLine(frame);
  second.pushLine('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  const secondBlock = second.finish().find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  assert.notEqual(firstBlock.block.id, secondBlock.block.id);
});

test('adapter keeps the optional image contract methods dsh calls directly', () => {
  const adapter = new QoderAdapter({ provider: 'qoder', client: {}, log: () => {} });
  assert.equal(adapter.imageRequestPricing('qoder', 'auto'), undefined);
  assert.deepEqual(adapter.imageRequestTarget('qoder', 'auto', { width: 10, height: 20, bytes: 30 }), {
    width: 10, height: 20, maxBytes: 30,
  });
  assert.equal(adapter.providerRetryPolicy().maxDelayMs, 60_000);
});

test('dispose clears the image cache and in-flight references', () => {
  const adapter = new QoderAdapter({
    provider: 'qoder',
    client: { listCatalog: async () => ({ at: 0, models: [] }) },
    prefs: { visible: null, pinned: '', includeAll: true, contextWindowByModel: {}, paramsByModel: {} },
    log: () => {},
  });
  adapter.imageCache.set('a', 'data:image/png;base64,xxx');
  adapter.imageCacheChars = 30;
  adapter.imageInflight.set('b', Promise.resolve());
  adapter.dispose();
  assert.equal(adapter.imageCache.size, 0);
  assert.equal(adapter.imageInflight.size, 0);
  assert.equal(adapter.imageCacheChars, 0);
  assert.equal(adapter.disposed, true);
});

test('an in-stream error frame keeps its HTTP status so retry policy can act on it', () => {
  const cases = [
    [{ message: 'upstream refused', code: 503 }, CODE.SERVER],
    [{ message: 'not allowed', code: 401 }, CODE.AUTH],
    [{ message: 'slow down', code: 429 }, CODE.RATE_LIMIT],
  ];
  for (const [error, expected] of cases) {
    const translator = new StreamTranslator();
    translator.pushLine(`data: ${JSON.stringify({ error })}`);
    const finish = translator.finish().find((chunk) => chunk.type === 'finish');
    assert.equal(finish.reason.kind, 'error');
    assert.equal(finish.reason.failure.code, expected, `code ${error.code} should classify as ${expected}`);
  }
});

test('null and primitive SSE frames are ignored without throwing', () => {
  const translator = new StreamTranslator();
  assert.deepEqual(translator.pushLine('data: null'), []);
  assert.deepEqual(translator.pushLine('data: 42'), []);
  assert.deepEqual(translator.pushLine('data: []'), []);
  assert.deepEqual(translator.pushLine('data: {"choices":[{"delta":{"content":"ok"}}]}').filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text), ['ok']);
  // 补上收尾标记：没有 finish_reason 又没有 [DONE] 的流现在算传输中断（见下一条用例），
  // 这条用例只关心 null / 原始值帧是否被安静丢弃。
  assert.deepEqual(translator.pushLine('data: [DONE]'), []);
  const finish = translator.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'stop');
});

test('a stream with content but no finish_reason and no [DONE] is a transport failure', () => {
  const translator = new StreamTranslator();
  translator.pushLine('data: {"choices":[{"delta":{"content":"half"}}]}');
  const finish = translator.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TRANSPORT);
});

test('a string error frame still fails the stream visibly', () => {
  const translator = new StreamTranslator();
  translator.pushLine('data: {"error":"upstream nope"}');
  const finish = translator.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.match(finish.reason.failure.message, /upstream nope/);
});

test('classifyError recognizes queue responses as rate limits', () => {
  assert.equal(classifyError('{"isQueued":true,"retryAfterSeconds":30}', 403), CODE.RATE_LIMIT);
  assert.equal(classifyError('unauthorized', 401), CODE.AUTH);
  assert.equal(classifyError('context length exceeded', 400), CODE.CONTEXT);
  assert.equal(classifyError('socket hang up', 0), CODE.TRANSPORT);
  assert.equal(classifyError('getaddrinfo ENOTFOUND api3.qoder.sh', 0), CODE.TRANSPORT, 'DNS 失败必须归到可重试的连接错误');
  assert.equal(classifyError('EAI_AGAIN api2.qoder.sh', 0), CODE.TRANSPORT);
});

test('mapUsage keeps bucket sum equal to total', () => {
  const usage = mapUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 30 },
    completion_tokens_details: { reasoning_tokens: 8 },
  });
  assert.equal(usage.inputTokens, 70);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cacheReadTokens, 30);
  assert.equal(usage.reasoningTokens, 8);
  assert.equal(usage.totalTokens, 120);
  assert.equal(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens, usage.totalTokens);
});

test('sanitizeWire drops empty assistant turns and orphan tool results', () => {
  const wire = sanitizeWire([
    { role: 'system', content: 's' },
    { role: 'assistant', content: '' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'tool', tool_call_id: 'orphan', content: 'drop' },
    { role: 'user', content: 'u' },
  ]);
  assert.equal(wire.length, 4);
  assert.equal(wire[1].content, '', 'null content 会被规整成空字符串');
  assert.equal(wire[3].content, 'u');
});

test('sanitizeWire closes tool groups atomically and reports counts', () => {
  const stats = {};
  const wire = sanitizeWire([
    { role: 'system', content: 's' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a1', function: { name: 'read', arguments: '{}' } },
        { id: 'a2', function: { name: 'grep', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a1', content: 'one' },
    { role: 'tool', tool_call_id: 'a1', content: 'duplicate' },
    { role: 'tool', tool_call_id: 'zzz', content: 'unknown' },
    { role: 'user', content: 'next' },
    { role: 'tool', tool_call_id: 'a2', content: 'late' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: '', function: { name: 'read', arguments: '{}' } },
        { id: 'b1', function: { name: '', arguments: '{}' } },
        { id: 'b2', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'b2', content: 'two' },
  ], stats);
  assert.deepEqual(wire.map((message) => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(wire[2].tool_calls.length, 1);
  assert.equal(wire[2].tool_calls[0].id, 'b2');
  assert.equal(stats.orphanTools, 3);
  assert.equal(stats.droppedToolGroups, 1);
  assert.equal(stats.droppedTools, 1);
  assert.equal(stats.droppedToolCalls, 2);
});

test('toWireMessage keeps assistant tool-call content as an empty string', async () => {
  const wire = await toWireMessage({
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
  }, async () => null);
  assert.equal(wire.content, '');
  assert.equal(wire.tool_calls[0].id, 'c1');
  assert.equal(wire.tool_calls[0].function.name, 'read');

  const text = await toWireMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }],
  }, async () => null);
  assert.equal(text.content, 'hi');
});

test('plain string content is not dropped on the way to the wire', async () => {
  const user = await toWireMessage({ role: 'user', content: 'hello' }, async () => null);
  assert.deepEqual(user, { role: 'user', content: 'hello' });
  const tool = await toWireMessage({ role: 'tool', tool_call_id: 'c1', content: 'file contents' }, async () => null);
  assert.equal(tool.content, 'file contents');
  const assistant = await toWireMessage({ role: 'assistant', content: 'done' }, async () => null);
  assert.equal(assistant.content, 'done');
});

test('toWireTools deduplicates by name and keeps JSON schema', () => {
  const tools = toWireTools({
    tools: [
      { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
      { name: 'a', description: 'duplicate', parameters: {} },
      { name: 'b', parameters: null },
    ],
  });
  assert.equal(tools.length, 2);
  assert.equal(tools[0].function.name, 'a');
  assert.deepEqual(tools[1].function.parameters, { type: 'object', properties: {} });
});

test('tool names that the gateway would reject are caught locally with a readable reason', () => {
  // 上游对含点号 / 斜杠 / 空格 / 超长的工具名回确定性 400，且通常不说是哪个工具。
  // 本地先拦，错误里点名。
  assert.equal(findInvalidTool({ tools: [{ name: 'read_file' }] }), '');
  assert.equal(findInvalidTool({ tools: [{ name: 'mcp__server__tool-2' }] }), '');
  assert.equal(findInvalidTool({ tools: [] }), '');
  // 历史里重复带同一批工具是常态，不算错。
  assert.equal(findInvalidTool({
    tools: [{ name: 'a' }],
    toolHistory: { updates: [{ additions: [{ name: 'a' }] }] },
  }), '');

  const dotted = findInvalidTool({ tools: [{ name: 'a' }, { name: 'server.tool' }] });
  assert.match(dotted, /server\.tool/);
  assert.match(dotted, /不合法/);

  const spaced = findInvalidTool({ tools: [{ name: 'my tool' }] });
  assert.match(spaced, /my tool/);

  const tooLong = findInvalidTool({ tools: [{ name: 'x'.repeat(65) }] });
  assert.match(tooLong, /64/);
});

test('catalog keeps the upstream cache timestamp instead of faking freshness', async () => {
  const staleAt = Date.now() - 3_600_000;
  const adapter = new QoderAdapter({
    provider: 'qoder',
    prefs: { visible: null, pinned: '', contextWindowByModel: {}, paramsByModel: {} },
    client: {
      listCatalog: async () => ({
        models: [{ id: 'auto' }], at: staleAt, staleMs: 3_600_000, error: '网关超时',
      }),
    },
  });
  await adapter.catalog({ refresh: true });
  assert.equal(adapter.catalogCache.at, staleAt, '刷新失败时不能把缓存时间改写成当前时间');
  assert.equal(adapter.catalogCache.staleMs, 3_600_000);
  assert.equal(adapter.catalogCache.error, '网关超时');
});

test('a catalog result without a timestamp is not reported as freshly refreshed', async () => {
  const adapter = new QoderAdapter({
    provider: 'qoder',
    prefs: { visible: null, pinned: '', contextWindowByModel: {}, paramsByModel: {} },
    client: {
      listCatalog: async () => ({ models: [], at: 0, staleMs: 0, error: '尚未登录 Qoder' }),
    },
  });
  await adapter.catalog();
  assert.equal(adapter.catalogCache.at, 0, '没有时间戳时不能伪造“刚刚刷新”');
  assert.equal(adapter.catalogCache.error, '尚未登录 Qoder');
});

test('resolveModel uses the public Qoder CLI 32K output default and clamps configured caps', async () => {
  const adapter = new QoderAdapter({
    provider: 'qoder',
    prefs: { visible: null, pinned: '', contextWindowByModel: {}, paramsByModel: {} },
    client: {
      listCatalog: async () => ({
        models: [
          { id: 'auto', name: 'Auto', max_input_tokens: 200000, context_window: 200000 },
          { id: 'capped', name: 'Capped', max_input_tokens: 96000, context_window: 96000, max_output_tokens: 8192 },
        ],
        at: Date.now(), staleMs: 0, error: '',
      }),
    },
  });
  const auto = await adapter.resolveModel('qoder', 'auto');
  assert.equal(auto.defaultMaxTokens, 32_000, '未声明输出上限时对齐 Qoder CLI 的 32K 默认');
  const capped = await adapter.resolveModel('qoder', 'capped');
  assert.equal(capped.defaultMaxTokens, 8192, '模型声明上限时优先使用模型上限');
  adapter.setModelParams({ capped: { maxTokens: 64_000 } });
  const clamped = await adapter.resolveModel('qoder', 'capped');
  assert.equal(clamped.defaultMaxTokens, 8192, '自定义值不能超过模型上限');
});

test('contextWindowFor honors a 1M selection and falls back to the model default', async () => {
  const adapter = new QoderAdapter({
    provider: 'qoder',
    prefs: { visible: null, pinned: '', contextWindowByModel: {}, paramsByModel: {} },
    client: {
      listCatalog: async () => ({
        models: [{
          id: 'deep', name: 'Deep', max_input_tokens: 180000,
          context_window: 200000, context_window_max: 1000000,
          context_window_options: [200000, 400000, 1000000],
        }],
        at: Date.now(), staleMs: 0, error: '',
      }),
    },
  });
  await adapter.catalog();
  assert.equal(adapter.contextWindowFor('deep'), 200000);
  adapter.setContextWindows({ deep: 1000000 });
  assert.equal(adapter.contextWindowFor('deep'), 1000000, '1M 档位不能被旧的 max_input_tokens 砍掉');
  adapter.setContextWindows({ deep: 4000000 });
  assert.equal(adapter.contextWindowFor('deep'), 1000000, '超过模型上限时收敛到 1M');
});

test('warm catalog rejects an unknown model but cold catalog passes it through', async () => {
  const client = {
    auth: { source: 'token' },
    authGeneration: 0,
    accountStamp: () => ({ account: 'uid:test' }),
    chat: async () => { throw new Error('should not reach upstream'); },
  };
  const adapter = new QoderAdapter({
    provider: 'qoder', client,
    prefs: { visible: null, pinned: '', includeAll: true, contextWindowByModel: {}, paramsByModel: {} },
    log: () => {},
  });
  adapter.catalogCache = { at: Date.now(), models: [{ id: 'known' }], error: '', staleMs: 0 };

  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'gone', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk);
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.MODEL_NOT_FOUND);
  assert.match(finish.reason.failure.message, /不在当前 Qoder 目录/);

  adapter.catalogCache = { at: 0, models: [], error: '', staleMs: 0 };
  const cold = [];
  for await (const chunk of adapter.stream({ model: 'gone', messages: [{ role: 'user', content: 'hi' }] })) cold.push(chunk);
  assert.match(cold.find((chunk) => chunk.type === 'finish').reason.failure.message, /should not reach upstream/);

  process.env.QODER_SKIP_MODEL_PREFLIGHT = '1';
  try {
    adapter.catalogCache = { at: Date.now(), models: [{ id: 'known' }], error: '', staleMs: 0 };
    const skipped = [];
    for await (const chunk of adapter.stream({ model: 'gone', messages: [{ role: 'user', content: 'hi' }] })) skipped.push(chunk);
    assert.match(skipped.find((chunk) => chunk.type === 'finish').reason.failure.message, /should not reach upstream/);
  } finally {
    delete process.env.QODER_SKIP_MODEL_PREFLIGHT;
  }
});

test('model ids copied with a context suffix are normalized before lookup', async () => {
  const payloads = [];
  const client = {
    auth: { source: 'token' },
    authGeneration: 0,
    accountStamp: () => ({ account: 'uid:test' }),
    chat: async (payload) => { payloads.push(payload); throw new Error('stop here'); },
  };
  const adapter = new QoderAdapter({
    provider: 'qoder', client,
    prefs: { visible: null, pinned: '', includeAll: true, contextWindowByModel: {}, paramsByModel: {} },
    log: () => {},
  });
  adapter.catalogCache = { at: Date.now(), models: [{ id: 'dfmodel' }], error: '', staleMs: 0 };
  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'dfmodel[1m]', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk);
  assert.equal(payloads[0].model, 'dfmodel');
  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'error');
});

test('tool errors, unknown blocks and tool images keep their semantics', async () => {
  const stats = {};
  const failed = await toWireMessage({
    role: 'tool',
    toolCallId: 'c1',
    isError: true,
    content: [{ type: 'text', text: 'ENOENT: missing' }],
  }, async () => null, stats);
  assert.match(failed.content, /^\[tool error\]/);
  assert.match(failed.content, /ENOENT/);

  const withImage = await toWireMessage({
    role: 'tool',
    toolCallId: 'c2',
    content: [{ type: 'text', text: 'screenshot' }, { type: 'image', attachmentId: 'a1' }],
  }, async () => 'data:image/png;base64,AA==', stats);
  assert.match(withImage.content, /1 张图片/);
  assert.equal(stats.toolImages, 1);
  assert.equal(stats.toolErrors, 1);

  const assistant = await toWireMessage({
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'hidden chain' },
      { type: 'mcp_tool_use', name: 'search', input: { q: 'x' } },
      { type: 'text', text: 'done' },
    ],
  }, async () => null, stats);
  assert.equal(assistant.content.includes('hidden chain'), false, 'reasoning is not replayed as text');
  assert.match(assistant.content, /\[mcp_tool_use\]/);
  assert.match(assistant.content, /done/);
  assert.equal(stats.droppedReasoning, 1);
  assert.equal(stats.unknownBlocks, 1);

  const user = await toWireMessage({
    role: 'user',
    content: [{ type: 'web_search_tool_result', results: [] }],
  }, async () => null, stats);
  assert.match(user.content[0].text, /\[web_search_tool_result\]/);
});

test('text-form tool calls are blocked instead of being treated as completion', () => {
  const translator = new StreamTranslator();
  translator.pushLine('data: {"choices":[{"delta":{"content":"[assistant 请求调用工具] [{\\"name\\":\\"read\\"}]"},"finish_reason":"stop"}]}');
  const finish = translator.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, CODE.TOOL_CALL_LEAK);

  process.env.QODER_LEAK_DETECT = '0';
  try {
    const relaxed = new StreamTranslator();
    relaxed.pushLine('data: {"choices":[{"delta":{"content":"[assistant 请求调用工具]"},"finish_reason":"stop"}]}');
    assert.equal(relaxed.finish().find((chunk) => chunk.type === 'finish').reason.kind, 'stop');
  } finally {
    delete process.env.QODER_LEAK_DETECT;
  }
});

test('invalid tool calls fail fast by default and can be dropped with a visible warning', () => {
  const frame = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bad.name","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}';
  const strict = new StreamTranslator();
  strict.pushLine(frame);
  const strictFinish = strict.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(strictFinish.reason.kind, 'error');
  assert.equal(strictFinish.reason.failure.code, CODE.INVALID);

  process.env.QODER_INVALID_TOOL_POLICY = 'drop';
  try {
    const relaxed = new StreamTranslator();
    relaxed.pushLine(frame);
    const chunks = relaxed.finish();
    assert.ok(chunks.some((chunk) => chunk.type === 'block-end' && /工具调用已丢弃/.test(chunk.block?.text || '')));
    assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'stop');
  } finally {
    delete process.env.QODER_INVALID_TOOL_POLICY;
  }
});

test('missing upstream usage is estimated and marked, not recorded as zero', () => {
  const translator = new StreamTranslator({ inputChars: 400 });
  translator.pushLine('data: {"choices":[{"delta":{"reasoning":"think"},"finish_reason":"stop"}]}');
  const usage = translator.finish().find((chunk) => chunk.type === 'usage').usage;
  assert.equal(usage.estimated, true);
  assert.equal(usage.inputTokens, 100);
  assert.ok(usage.outputTokens >= 1);
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens);
});

test('interleaved parallel tool calls keep their ids, names and arguments', () => {
  const translator = new StreamTranslator();
  translator.pushLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"a\\":"}}]}}]}');
  translator.pushLine('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"write","arguments":"{\\"b\\":"}}]}}]}');
  translator.pushLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}');
  translator.pushLine('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]},"finish_reason":"tool_calls"}]}');
  const chunks = translator.finish();
  const calls = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map((chunk) => chunk.block);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.id).sort(), ['c1', 'c2']);
  assert.equal(calls.find((call) => call.id === 'c1').arguments, '{"a":1}');
  assert.equal(calls.find((call) => call.id === 'c2').arguments, '{"b":2}');
  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'tool-calls');
});

test('non-function tools are counted instead of disappearing silently', () => {
  const stats = {};
  const tools = toWireTools({
    tools: [
      { name: 'read', description: 'r', parameters: { type: 'object' } },
      { type: 'custom', name: '' },
      { name: 'read', description: 'duplicate' },
    ],
  }, stats);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, 'read');
  assert.equal(stats.skippedTools, 1);
});
