/**
 * 实机回归：用真实 Qoder 账号跑一遍 DSH 宿主装配 + 原生 adapter。
 * 会消耗极少量 Credits。用法：node tests/live-adapter.mjs
 */
import { apply } from '../dsh-plugin/lib/index.js';

let adapter = null;
let routes = [];
let toolNames = [];
let commands = [];
const llm = {
  registerAdapter(providers, value) {
    adapter = value;
    return { dispose() {} };
  },
  emitAdaptersUpdated() {},
};
const services = {
  llm,
  tools: { register(definition) { toolNames.push(definition.name); } },
  commands: { register(definition) { commands.push(definition.name); } },
  webServer: { register(route) { routes.push(route); return () => {}; } },
};
const ctx = {
  llm,
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => null };
    return services[name];
  },
  inject(names, callback) {
    const scope = { ...services, get: (name) => services[name] };
    callback(scope);
  },
  effect(fn) {
    const dispose = fn();
    return dispose;
  },
};

apply(ctx, {});
if (!adapter) throw new Error('adapter was not registered');
await new Promise((resolve) => setTimeout(resolve, 2500));

const models = await adapter.listModels('qoder');
console.log('models', models.length, models.slice(0, 4).map((model) => model.id));
const target = models.find((model) => model.id === 'qmodel_38max') || models[0];
if (!target) throw new Error('no models available');
console.log('target', target.id, target.name, target.description || '');

const call = await adapter.prepareCall('qoder', target.id, new AbortController().signal);
const controller = new AbortController();
const chunks = [];
for await (const chunk of call.stream({
  provider: 'qoder',
  model: target.id,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
  maxTokens: 256,
  signal: controller.signal,
})) {
  chunks.push(chunk);
}
const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
const finish = chunks.find((chunk) => chunk.type === 'finish');
const usage = chunks.find((chunk) => chunk.type === 'usage');
console.log('chunks', chunks.map((chunk) => chunk.type).join(','));
console.log('text', JSON.stringify(text));
console.log('finish', JSON.stringify(finish && finish.reason));
console.log('usage', JSON.stringify(usage && usage.usage));
console.log('routes', routes.length, 'tools', toolNames.join(','), 'commands', commands.join(','));
if (!text.toLowerCase().includes('pong')) throw new Error('unexpected reply');
if (!finish || finish.reason.kind !== 'stop') throw new Error('stream did not finish cleanly');
console.log('LIVE ADAPTER OK');
