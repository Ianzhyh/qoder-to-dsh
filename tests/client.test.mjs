/**
 * 客户端 bundle 的可测部分：宿主启动窗口的 404 自愈、后台标签页轮询。
 * 在 vm 里加载真实的 dsh-plugin/lib/client.js，用假 React / 假 DOM，
 * 只调用导出的数据与调度函数，不渲染组件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'dsh-plugin', 'lib', 'client.js'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function loadClient(fetchImpl) {
  let factory = null;
  const sandbox = {
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl,
    document: {
      currentScript: { src: 'https://dsh.local/plugins/qoder-to-dsh/client.js' },
      head: { appendChild() {} },
    },
    window: {
      __ModuleLoader__: { load(definition) { factory = definition.factory; } },
      addEventListener() {},
      removeEventListener() {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.ok(factory, 'client bundle did not register a factory');
  const react = {
    createElement() { return null; },
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useRef(value) { return { current: value }; },
    useMemo(fn) { return fn(); },
    useLayoutEffect() {},
  };
  const exports = factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require: ${name}`);
  });
  return { exports, sandbox };
}

function createDocument(initial) {
  const listeners = new Set();
  return {
    visibilityState: initial,
    addEventListener(type, fn) { if (type === 'visibilitychange') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    fire() { for (const fn of [...listeners]) fn(); },
    get count() { return listeners.size; },
  };
}

test('getJson retries a 404 from the host startup window', async () => {
  let calls = 0;
  const { exports } = loadClient(async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(404, { error: 'not found' })
      : jsonResponse(200, { ok: true, models: [] });
  });
  const data = await exports.getJson('/qoder/models');
  assert.equal(calls, 2);
  assert.deepEqual(data, { ok: true, models: [] });
});

test('postJson is never retried on 404', async () => {
  let calls = 0;
  const { exports } = loadClient(async () => {
    calls += 1;
    return jsonResponse(404, { error: 'missing route' });
  });
  await assert.rejects(exports.postJson('/qoder/checkin/run', {}), (error) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /还没就绪/);
    return true;
  });
  assert.equal(calls, 1);
});

test('GET outside /qoder/ is not retried', async () => {
  let calls = 0;
  const { exports } = loadClient(async () => {
    calls += 1;
    return jsonResponse(404, { error: 'missing' });
  });
  await assert.rejects(exports.getJson('/other/status'), (error) => error.status === 404);
  assert.equal(calls, 1);
});

test('an exhausted 404 explains that dsh needs a restart', async () => {
  let calls = 0;
  const { exports } = loadClient(async () => {
    calls += 1;
    return jsonResponse(404, {});
  });
  await assert.rejects(exports.getJson('/qoder/status'), (error) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /还没就绪/);
    assert.match(error.message, /重启 dsh/);
    return true;
  });
  assert.equal(calls, 4);
});

test('visibility polling stays idle while hidden and resumes once visible', async () => {
  const { exports } = loadClient(async () => jsonResponse(200, {}));
  const doc = createDocument('hidden');
  let ticks = 0;
  const stop = exports.startVisibilityPoll(doc, () => { ticks += 1; }, 10_000);
  await sleep(30);
  assert.equal(ticks, 0, 'hidden document must not poll');

  doc.visibilityState = 'visible';
  doc.fire();
  assert.equal(ticks, 1, 'becoming visible refreshes immediately');

  doc.fire();
  assert.equal(ticks, 1, 'duplicate visibility events must not add a round');

  doc.visibilityState = 'hidden';
  doc.fire();
  await sleep(30);
  assert.equal(ticks, 1, 'hiding stops the timer');

  doc.visibilityState = 'visible';
  doc.fire();
  assert.equal(ticks, 2, 'returning refreshes immediately');

  stop();
  assert.equal(doc.count, 0, 'stop removes the visibility listener');
  doc.visibilityState = 'hidden';
  doc.fire();
  assert.equal(ticks, 2);
});

test('visibility polling starts immediately when the document is already visible', async () => {
  const { exports } = loadClient(async () => jsonResponse(200, {}));
  const doc = createDocument('visible');
  let ticks = 0;
  const stop = exports.startVisibilityPoll(doc, () => { ticks += 1; }, 10);
  await sleep(30);
  stop();
  assert.ok(ticks >= 1, 'visible document should start its interval');
});

test('a throwing poll callback does not stop later ticks', async () => {
  const { exports } = loadClient(async () => jsonResponse(200, {}));
  const doc = createDocument('visible');
  let ticks = 0;
  const stop = exports.startVisibilityPoll(doc, () => {
    ticks += 1;
    if (ticks === 1) throw new Error('boom');
  }, 10);
  await sleep(35);
  stop();
  assert.ok(ticks >= 2, 'polling should survive a callback error');
});

test('quota timestamps treat second-level epochs like the official client', async () => {
  const { exports } = loadClient(async () => jsonResponse(200, {}));
  const seconds = 1_790_000_000;
  assert.equal(exports.toEpochMs(seconds), seconds * 1000);
  assert.equal(exports.toEpochMs(seconds * 1000), seconds * 1000);
  assert.equal(exports.toEpochMs('1790000000'), seconds * 1000);
  assert.equal(exports.toEpochMs(0), null);
  assert.equal(exports.toEpochMs('2026-10-25'), null, '日期字符串交给 Date 解析，不能当数字');
});

test('auto output tokens follows the same clamping as the host resolver', async () => {
  const { exports } = loadClient(async () => jsonResponse(200, {}));
  assert.equal(exports.autoOutputTokens(64_000, 32_000, 32_000), 32_000, '插件默认高于模型上限时要收敛');
  assert.equal(exports.autoOutputTokens(16_000, 128_000, 32_000), 16_000);
  assert.equal(exports.autoOutputTokens(0, 128_000, 32_000), 128_000);
  assert.equal(exports.autoOutputTokens(0, 0, 32_000), 32_000);
});

test('a per-request timeout can outlive the default so deep diagnostics can finish', async () => {
  const { exports } = loadClient((url, init) => new Promise((resolve, reject) => {
    const signal = init && init.signal;
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (!signal) return;
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  }));
  const started = Date.now();
  await assert.rejects(
    exports.getJson('/qoder/diagnostics', { timeoutMs: 30 }),
    (error) => {
      assert.match(error.message, /请求超时/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000, '应按本次请求的 30ms 超时，而不是默认 20 秒');
});
