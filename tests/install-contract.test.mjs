/**
 * 安装契约：版本、包名、patch、注册 id、exports、文档任何一处漂移都必须红灯。
 * 这些字段分散在 6 个文件里，靠人工同步迟早会漏；参考仓库曾因 Loader id
 * 不匹配导致整个 dsh 启动中止。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('package.json'));
const version = manifest.version;

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

test('package version matches config, README, CHANGELOG and release note', () => {
  const configVersion = /export const VERSION\s*=\s*'([^']+)'/.exec(read('lib/config.mjs'))?.[1];
  assert.equal(configVersion, version, 'lib/config.mjs 的 VERSION 必须同步 package.json');

  const readmeVersion = /当前版本 \*\*(\d+\.\d+\.\d+)\*\*/.exec(read('README.md'))?.[1];
  assert.equal(readmeVersion, version, 'README 顶部的当前版本必须同步');

  const changelogVersion = /^## \[(\d+\.\d+\.\d+)\]/m.exec(read('CHANGELOG.md'))?.[1];
  assert.equal(changelogVersion, version, 'CHANGELOG 最新条目必须同步');

  assert.ok(existsSync(join(ROOT, 'docs', 'releases', `v${version}.md`)), `缺少 docs/releases/v${version}.md`);
});

test('README install examples only reference the current version', () => {
  const source = read('README.md');
  const tgzVersions = [...source.matchAll(/qoder-to-dsh-(\d+\.\d+\.\d+)\.tgz/g)].map((match) => match[1]);
  const tagVersions = [...source.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)\//g)].map((match) => match[1]);
  assert.ok(tgzVersions.length > 0, 'README 应有 tgz 安装示例');
  for (const wrong of [...tgzVersions, ...tagVersions].filter((value) => value !== version)) {
    assert.fail(`README 仍引用旧版本 ${wrong}；当前版本是 ${version}`);
  }
});

test('package name, patch name and client registration ids agree', () => {
  const patch = read('cordis.patch.yml');
  const patchName = /^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/m.exec(patch)?.[1];
  assert.equal(patchName, manifest.name, 'patch 的 name 必须等于包名');

  const client = read('dsh-plugin/lib/client.js');
  const idsSource = /const ids = new Set\(\[([^\]]+)\]\)/.exec(client)?.[1] || '';
  const ids = [...idsSource.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(ids.includes(manifest.name), `client 注册 id 必须包含包名 ${manifest.name}`);
  assert.ok(ids.includes('dsh-plugin-qoder'), '保留 github/link 两种安装形态的兼容 id');
});

test('exports and main point at files that exist', () => {
  assert.ok(existsSync(join(ROOT, manifest.main)), `main 不存在：${manifest.main}`);
  for (const [key, target] of Object.entries(manifest.exports || {})) {
    assert.equal(typeof target, 'string', `${key} 必须是字符串目标`);
    const matches = target.includes('*')
      ? readdirSync(join(ROOT, dirname(target))).map((name) => join(dirname(target), name))
      : [target];
    assert.ok(matches.length > 0, `exports ${key} 没有匹配文件`);
    for (const file of matches) {
      assert.ok(existsSync(join(ROOT, file)), `exports ${key} 指向不存在的文件：${file}`);
    }
  }
  assert.ok(manifest.dsh?.bundle?.patch, '缺少 dsh.bundle.patch');
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.equal(manifest.os, undefined, '不要给根包加 os 限制，否则非 Windows 的 npm ci 会失败');
});

test('published files whitelist still contains every runtime artifact', () => {
  const files = manifest.files || [];
  for (const required of ['dsh-plugin/lib', 'lib', 'cordis.patch.yml', 'locale/*.json', 'README.md', 'CHANGELOG.md', 'NOTICE.md', 'LICENSE', 'icon.svg']) {
    assert.ok(files.includes(required), `package.json files 缺少 ${required}`);
  }
  assert.ok(existsSync(join(ROOT, manifest.icon)), 'icon 文件不存在');
});

test('locale bundles expose the same key set', () => {
  const zh = JSON.parse(read('locale/zh.json'));
  const en = JSON.parse(read('locale/en.json'));
  assert.deepEqual(flattenKeys(en).sort(), flattenKeys(zh).sort(), 'en/zh 的键必须一致');
});
