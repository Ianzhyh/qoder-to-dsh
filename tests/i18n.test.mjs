/**
 * 中英字典完整性：以源码里的中文串/模板静态片段为输入，确保英文模式下
 * translateText 不会留下中文。真正的用户内容（回复、日志）不经过 translateText，
 * 由 data-i18n="off" 保护。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'dsh-plugin', 'lib', 'client.js'), 'utf8');
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

function loadClient() {
  let factory = null;
  const sandbox = {
    console,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: true, status: 200, async json() { return {}; } }),
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
  return factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require: ${name}`);
  });
}

function hasCjk(text) {
  return /[\u4e00-\u9fa5]/.test(text);
}

/** 源码扫描：普通字符串 + 模板静态片段；跳过注释和 CSS 模板。 */
function extractTexts(src) {
  const plain = new Set();
  const quasi = new Set();
  function scan(start, end) {
    let i = start;
    let line = false;
    let block = false;
    while (i < end) {
      const ch = src[i];
      const next = src[i + 1];
      if (line) { if (ch === NL) line = false; i += 1; continue; }
      if (block) { if (ch === '*' && next === '/') { block = false; i += 2; continue; } i += 1; continue; }
      if (ch === '/' && next === '/') { line = true; i += 2; continue; }
      if (ch === '/' && next === '*') { block = true; i += 2; continue; }
      if (ch === "'" || ch === '"') {
        const result = readQuoted(i, ch);
        if (hasCjk(result.text)) plain.add(result.text);
        i = result.end;
        continue;
      }
      if (ch === '`') { i = readTemplate(i); continue; }
      i += 1;
    }
  }
  function readQuoted(start, quote) {
    let i = start + 1;
    let text = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === BS) { text += src.slice(i, i + 2); i += 2; continue; }
      if (ch === quote) return { text, end: i + 1 };
      text += ch;
      i += 1;
    }
    return { text, end: i };
  }
  function readTemplate(start) {
    let i = start + 1;
    let buf = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === BS) { buf += src.slice(i, i + 2); i += 2; continue; }
      if (ch === '`') { addQuasi(buf); return i + 1; }
      if (ch === '$' && src[i + 1] === '{') {
        addQuasi(buf);
        buf = '';
        i = scanExpression(i + 2);
        if (src[i] === '}') i += 1;
        continue;
      }
      buf += ch;
      i += 1;
    }
    return i;
  }
  function scanExpression(start) {
    return skipExpression(start);
  }
  function skipExpression(start) {
    let i = start;
    let depth = 1;
    let quote = '';
    while (i < src.length) {
      const ch = src[i];
      if (quote) {
        if (ch === BS) { i += 2; continue; }
        if (ch === quote) quote = '';
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const result = readQuoted(i, ch);
        if (hasCjk(result.text)) plain.add(result.text);
        i = result.end;
        continue;
      }
      if (ch === '`') { i = readTemplate(i); continue; }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
      i += 1;
    }
    return i;
  }
  function addQuasi(text) {
    const trimmed = text.trim();
    if (!hasCjk(trimmed)) return;
    // CSS 模板不是渲染文本；它的中文只出现在注释里。
    if (trimmed.includes('{') && (trimmed.includes(';') || trimmed.includes('*/'))) return;
    // 复杂模板的静态片段可能夹带代码；只保留真正的展示文本。
    if (trimmed.length > 400) return;
    if (/[\r\n]/.test(trimmed) && /(?:h\(|const |className|=>|\/\/)/.test(trimmed)) return;
    quasi.add(trimmed);
  }
  scan(0, src.length);
  return { plain: [...plain], quasi: [...quasi] };
}

test('English UI leaves no Chinese in any source-owned UI string', () => {
  const exports = loadClient();
  exports.setUILangMode('en');
  const { plain, quasi } = extractTexts(source);
  const missing = [];
  const normalize = (text) => text.replace(/\\n/g, '\n');
  for (const text of [...plain, ...quasi]) {
    if (text === '中文') continue; // 语言名保留中文，英文界面里也显示 中文
    const out = exports.translateText(normalize(text));
    if (hasCjk(out)) missing.push({ source: text, translated: out });
  }
  assert.deepEqual(missing, [], `英文模式仍有 ${missing.length} 条中文残留`);
});

test('Chinese mode preserves the source string byte for byte', () => {
  const exports = loadClient();
  exports.setUILangMode('zh');
  assert.equal(exports.translateText('额度不足，请换号'), '额度不足，请换号');
});

test('dynamic dates and counts are localized', () => {
  const exports = loadClient();
  exports.setUILangMode('en');
  for (const text of [
    '最近到期 2026-11-04',
    '共 5 条（显示最近 5 条）',
    '7 天后到期',
    '今天有额度到期',
    '已用 42%',
  ]) {
    assert.ok(!hasCjk(exports.translateText(text)), `仍有中文：${exports.translateText(text)}`);
  }
});
