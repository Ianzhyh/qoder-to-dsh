/**
 * 发布产物校验：`npm run verify:release [tgz|url]`
 *
 * 回答一个具体问题：「这个 tgz 真的是能装的那一份吗？」
 *
 * 与 `verify-install.mjs` 的分工：那边看**装进 profile 之后**的状态，
 * 这边只看**打包产物本身**，不需要 dsh 在跑，也不写任何文件。
 *
 * 之所以要单独一步：`npm pack` 按 `files` 白名单打包，漏掉一个运行时模块
 * （例如 `lib/baseprompt.json`）不会报错——包照样生成，插件启动后才失败。
 * 版本号也容易漏改：`package.json` 与 `lib/config.mjs` 的 VERSION 是两份真源。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(here, '..');

const results = [];
const check = (ok, label, detail = '', hint = '') => {
  results.push({ ok, label, detail, hint });
};

// ── 最小 tar 读取器 ──────────────────────────────────────────────────────────
// 不引入依赖：ustar 头部是固定偏移的定长字段，够读 npm pack 的产物。
const parseTar = (buffer) => {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const read = (start, end) => {
      const slice = header.subarray(start, end);
      const end0 = slice.indexOf(0);
      return slice.subarray(0, end0 === -1 ? slice.length : end0).toString('utf8');
    };
    const name = read(0, 100);
    const prefix = read(345, 500);
    const size = parseInt(read(124, 136).trim() || '0', 8);
    const type = read(156, 157);
    const full = prefix ? `${prefix}/${name}` : name;
    if (type === '0' || type === '\0' || type === '') {
      entries.set(full, buffer.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
};

// ── 定位产物 ────────────────────────────────────────────────────────────────
const arg = process.argv.slice(2).find((value) => !value.startsWith('-'));

const fetchToBuffer = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(Number(process.env.QODER_RELEASE_TIMEOUT_MS || 60000)) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

let tarball = null;
let tarballPath = null;
let checkFreshness = false;

if (arg && /^https?:\/\//i.test(arg)) {
  try {
    tarball = await fetchToBuffer(arg);
    tarballPath = arg;
  } catch (error) {
    check(false, '下载已发布产物', String(error?.message || error), '网络不通时可直接传本地 tgz 路径。');
  }
} else if (arg) {
  tarballPath = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  if (existsSync(tarballPath)) tarball = readFileSync(tarballPath);
  else check(false, '读取 tgz', tarballPath, '文件不存在。');
} else {
  // 没给参数：优先当前版本的 tgz。目录里留着旧版本产物不该让发版门禁失败，
  // 但同一版本出现多份时仍然拒绝猜。
  const candidates = existsSync(PACKAGE_ROOT)
    ? readdirSync(PACKAGE_ROOT).filter((name) => /^qoder-to-dsh-\d+\.\d+\.\d+\.tgz$/.test(name))
    : [];
  const version = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  const expected = `qoder-to-dsh-${version}.tgz`;
  const matching = candidates.filter((name) => name === expected);
  if (matching.length === 1) {
    tarballPath = join(PACKAGE_ROOT, matching[0]);
    tarball = readFileSync(tarballPath);
    checkFreshness = true;
    const ignored = candidates.filter((name) => name !== expected);
    check(true, '定位 tgz 产物', `${expected}${ignored.length ? `（忽略旧版本：${ignored.join(', ')}）` : ''}`);
  } else {
    check(false, '定位 tgz 产物', candidates.length
      ? `找到 ${candidates.length} 个，但没有唯一的 ${expected}：${candidates.join(', ')}`
      : '没找到',
      '先跑 `npm run pack:release`，或把 tgz 路径/Release 资产 URL 作为参数传入。');
  }
}

// ── 解包 ────────────────────────────────────────────────────────────────────
let entries = null;
if (tarball) {
  try {
    entries = parseTar(gunzipSync(tarball));
    check(entries.size > 0, '解包 tgz', `${entries.size} 个条目`);
  } catch (error) {
    check(false, '解包 tgz', String(error?.message || error), '不是有效的 gzip tar。');
  }
}

// 自动选中当前版本的本地产物时，额外确认它确实由当前工作区打出来：
// 版本号相同但忘了重新 pack，是最容易骗过版本检查的一种过期产物。
if (entries && checkFreshness) {
  const changed = [];
  let compared = 0;
  for (const [name, content] of entries) {
    if (!name.startsWith('package/')) continue;
    const rel = name.slice('package/'.length);
    let disk;
    try {
      disk = readFileSync(join(PACKAGE_ROOT, rel));
    } catch {
      changed.push(`${rel}（工作区缺失）`);
      continue;
    }
    compared += 1;
    if (!disk.equals(content)) changed.push(rel);
  }
  check(
    changed.length === 0,
    '产物与当前工作区一致',
    changed.length
      ? `不一致 ${changed.length} 项：${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` 等 ${changed.length} 项` : ''}`
      : `${compared} 个文件逐字节一致`,
    '重新跑 `npm run pack:release` 再校验；显式传 tgz 路径或 URL 时不做这项比较。',
  );
}

const file = (name) => entries?.get(`package/${name}`);
const has = (name) => Boolean(file(name));

// ── 1. 包元数据 ─────────────────────────────────────────────────────────────
let manifest = null;
if (entries) {
  try {
    manifest = JSON.parse(file('package.json').toString('utf8'));
  } catch { manifest = null; }
}

check(Boolean(manifest), 'tgz 内 package.json 可解析');
check(manifest?.name === 'qoder-to-dsh', '包名正确', manifest?.name || '未读到');

const version = manifest?.version || null;
check(Boolean(version), 'version 存在', version || '未读到');

// 文件名里的版本必须与 manifest 一致，否则 release 资产名和实际内容会错位。
if (version && tarballPath) {
  const fileName = /^https?:/i.test(tarballPath)
    ? basename(new URL(tarballPath).pathname)
    : basename(tarballPath);
  const fromName = /qoder-to-dsh-(\d+\.\d+\.\d+)\.tgz$/.exec(fileName)?.[1] || null;
  check(fromName === version, '文件名版本与 manifest 一致', `file=${fromName || '不匹配'} · manifest=${version}`);
}

// lib/config.mjs 的 VERSION 是第二份真源：诊断页、User-Agent 都用它。
const configSource = file('lib/config.mjs')?.toString('utf8') || '';
const configVersion = /export const VERSION\s*=\s*'([^']+)'/.exec(configSource)?.[1] || null;
check(
  Boolean(configVersion) && configVersion === version,
  'lib/config.mjs 的 VERSION 与 package.json 一致',
  `config=${configVersion || '未读到'} · package=${version || '未读到'}`,
  '两处不同步时，面板诊断显示的版本会与实际安装的包不一致。',
);

// ── 2. bundle 声明与 patch ──────────────────────────────────────────────────
check(Boolean(manifest?.dsh?.bundle?.patch), '声明 dsh.bundle.patch', manifest?.dsh?.bundle?.patch || '缺少');
check(Boolean(manifest?.dsh?.client?.platform), '声明 dsh.client.platform', manifest?.dsh?.client?.platform || '缺少');

const patchSource = file('cordis.patch.yml')?.toString('utf8') || '';
const patchName = /^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/m.exec(patchSource)?.[1] || null;
check(
  Boolean(patchName) && patchName === manifest?.name,
  'patch 里的 name 与包名一致',
  `patch=${patchName || '未读到'} · package=${manifest?.name || '未读到'}`,
  '不一致时 dsh 会把该 Loader 行当作未知包静默跳过，插件不加载也不报错。',
);

// ── 2b. exports / 文档 / locale 契约 ────────────────────────────────────────
const packageNames = entries ? [...entries.keys()] : [];
const exportsMissing = [];
for (const [key, target] of Object.entries(manifest?.exports || {})) {
  const normalized = String(target).replace(/^\.\//, '');
  if (normalized.includes('*')) {
    const prefix = `package/${normalized.split('*')[0]}`;
    const suffix = normalized.slice(normalized.indexOf('*') + 1);
    const matches = packageNames.filter((name) => name.startsWith(prefix) && name.endsWith(suffix));
    if (!matches.length) exportsMissing.push(`${key} → ${target}`);
  } else if (!has(normalized)) {
    exportsMissing.push(`${key} → ${target}`);
  }
}
check(exportsMissing.length === 0, 'exports 目标都在包内', exportsMissing.length ? exportsMissing.join(', ') : 'ok',
  'exports 指向不存在的文件时，宿主 import 会直接失败。');

const readmeSource = file('README.md')?.toString('utf8') || '';
const readmeVersion = /当前版本 \*\*(\d+\.\d+\.\d+)\*\*/.exec(readmeSource)?.[1] || null;
check(readmeVersion === version, 'README 当前版本与 manifest 一致', `README=${readmeVersion || '未读到'} · package=${version || '未读到'}`);

const changelogSource = file('CHANGELOG.md')?.toString('utf8') || '';
const changelogVersion = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelogSource)?.[1] || null;
check(changelogVersion === version, 'CHANGELOG 最新条目与 manifest 一致', `CHANGELOG=${changelogVersion || '未读到'} · package=${version || '未读到'}`);

const flattenKeys = (value, prefix = '') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
};
try {
  const zh = JSON.parse(file('locale/zh.json')?.toString('utf8') || '{}');
  const en = JSON.parse(file('locale/en.json')?.toString('utf8') || '{}');
  const zhKeys = flattenKeys(zh).sort();
  const enKeys = flattenKeys(en).sort();
  check(JSON.stringify(zhKeys) === JSON.stringify(enKeys), 'locale en/zh 键一致', `${zhKeys.length} 个键`);
} catch (error) {
  check(false, 'locale en/zh 键一致', String(error?.message || error));
}

// ── 3. 运行时文件齐全 ───────────────────────────────────────────────────────
// 这里是硬清单，不从 `files` 推导：白名单写错时，包照样生成，启动才炸。
const REQUIRED = [
  'dsh-plugin/lib/index.js',
  'dsh-plugin/lib/client.js',
  'dsh-plugin/lib/routes.mjs',
  'lib/adapter.mjs',
  'lib/chat-transport.mjs',
  'lib/checkin.mjs',
  'lib/config.mjs',
  'lib/desktop-auth.mjs',
  'lib/models.mjs',
  'lib/qoder-api.mjs',
  'lib/qoder-sign.mjs',
  'lib/request-guard.mjs',
  'lib/secret-store.mjs',
  'lib/state.mjs',
  'lib/tools.mjs',
  'lib/umid.mjs',
  'lib/upstream-error.mjs',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'LICENSE',
];
const missing = REQUIRED.filter((name) => !has(name));
check(missing.length === 0, '运行时文件齐全', missing.length ? `缺 ${missing.join(', ')}` : `${REQUIRED.length} 项`,
  '缺文件时插件能装上但启动即失败；检查 package.json 的 files 白名单。');

// baseprompt.json 有 59KB，是几处静默失败的来源：缺了不影响加载，只影响请求质量。
const basePrompt = file('lib/baseprompt.json');
check(
  Boolean(basePrompt) && basePrompt.length > 32 * 1024,
  'lib/baseprompt.json 存在且完整',
  basePrompt ? `${(basePrompt.length / 1024).toFixed(1)} KB` : '缺失',
  '缺它插件照常启动，但请求里的 base prompt 会退化成空模板。',
);

// ── 4. 不该进包的东西 ───────────────────────────────────────────────────────
const names = entries ? [...entries.keys()] : [];
const strayTests = names.filter((name) => /^package\/tests\//.test(name));
check(strayTests.length === 0, 'tests 未混入产物', strayTests.length ? `${strayTests.length} 个文件` : 'ok');
const strayModules = names.filter((name) => /^package\/(node_modules|\.tmp-|\.git\/)/.test(name));
check(strayModules.length === 0, '无 node_modules / 临时目录 / .git',
  strayModules.length ? strayModules.slice(0, 3).join(', ') : 'ok');

// ── 5. 摘要 ─────────────────────────────────────────────────────────────────
const summary = (() => {
  if (!tarball) return null;
  const sha256 = createHash('sha256').update(tarball).digest('hex');
  return {
    sha256,
    bytes: tarball.length,
    files: names.filter((name) => !name.endsWith('/')).length,
    label: tarballPath && !/^https?:/i.test(tarballPath) ? basename(tarballPath) : 'release asset',
  };
})();

const ok = results.every((r) => r.ok);
const pad = Math.max(...results.map((r) => r.label.length));
console.log(`\nqoder-to-dsh 发布产物校验${version ? ` · v${version}` : ''}\n`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(pad)}  ${r.detail || ''}`);
  if (!r.ok && r.hint) console.log(`        ${' '.repeat(pad)}  -> ${r.hint}`);
}

if (summary) {
  console.log(`\n  产物    ${summary.label}`);
  console.log(`  文件数  ${summary.files}`);
  console.log(`  体积    ${(summary.bytes / 1024).toFixed(1)} KB`);
  console.log(`  sha256  ${summary.sha256}`);
  console.log('\n  把 sha256 一并写进 release 正文，装机的人可以自行比对。');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${ok ? '全部通过' : `${failed} 项未通过`}（共 ${results.length} 项）\n`);
process.exit(ok ? 0 : 1);
