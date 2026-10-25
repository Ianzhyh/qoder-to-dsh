import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE, QoderAdapter, StreamTranslator, classifyError, mapUsage, sanitizeWire, toWireMessage, toWireTools,
} from '../lib/adapter.mjs';

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

test('null and primitive SSE frames are ignored without throwing', () => {
  const translator = new StreamTranslator();
  assert.deepEqual(translator.pushLine('data: null'), []);
  assert.deepEqual(translator.pushLine('data: 42'), []);
  assert.deepEqual(translator.pushLine('data: []'), []);
  assert.deepEqual(translator.pushLine('data: {"choices":[{"delta":{"content":"ok"}}]}').filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text), ['ok']);
  const finish = translator.finish().find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'stop');
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
