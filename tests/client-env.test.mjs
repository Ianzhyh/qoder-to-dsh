/**
 * 客户端环境探测：安装根、版本、协议、端点缓存、数据目录搬迁。
 * 全部用临时目录 + 显式 options，不读本机真实客户端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  appDataInfo,
  compareVersionDesc,
  effectiveProtocol,
  findClient,
  gatewaysFor,
  installRoots,
  isAllowedInferenceUrl,
  launcherState,
  readAppStatus,
  readEndpointCache,
  readUmidCache,
  readUmidManifest,
  resolveAppDataDir,
} from '../lib/client-env.mjs';

const tempRoots = [];
function tempDir(prefix = 'qoder-env-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempRoots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function makeInstall(root, versions, { stateVersion = '' } = {}) {
  for (const [version, cliVersion] of Object.entries(versions)) {
    const dir = join(root, '.qoder-versions', version);
    writeJson(join(dir, 'resources', 'umid', 'manifest.json'), { qoderCliVersion: cliVersion, sdkVersion: '1.0.0' });
    writeJson(join(dir, 'resources', 'build-manifest.json'), { productVersion: version });
  }
  if (stateVersion) {
    mkdirSync(join(root, '.qoder-versions', stateVersion), { recursive: true });
  }
}

function writeLauncher(localAppData, region, { installDir, appExecutable = '', version = '' }) {
  const base = region === 'cn' ? ['Qoder CN', 'Qoder CN Launcher'] : ['Qoder', 'Qoder Launcher'];
  const path = join(localAppData, ...base, 'state.ini');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, [
    '[launcher]',
    'schemaVersion=3',
    'status=healthy',
    `installDir=${installDir}`,
    appExecutable ? `appExecutable=${appExecutable}` : '',
    version ? `targetVersion=${version}` : '',
  ].filter(Boolean).join('\n'));
}

function writeEndpointCache(home, region, selected) {
  const folder = region === 'cn' ? '.qoder-cn' : '.qoder';
  writeJson(join(home, folder, '.cache', 'qoder-client-endpoint-cache.json'), {
    version: 2,
    entries: {
      prod: {
        endpointSets: {
          inference: { candidates: [selected], selected },
          openapi: { candidates: ['https://center.qoder.sh'], selected: 'https://center.qoder.sh' },
        },
        updatedAt: 1_700_000_000_000,
      },
    },
  });
}

test('compareVersionDesc compares numeric segments', () => {
  const versions = ['1.9.0', '1.10.0', '0.4.11', '0.5.1'];
  assert.deepEqual(versions.slice().sort(compareVersionDesc), ['1.10.0', '1.9.0', '0.5.1', '0.4.11']);
});

test('installRoots prefers env and launcher, then defaults', () => {
  const base = tempDir();
  const root = join(base, 'Qoder');
  makeInstall(root, { '0.5.1': '1.1.79-hotfix.7' });
  const envRoot = join(base, 'EnvQoder');
  mkdirSync(envRoot, { recursive: true });
  const localAppData = join(base, 'local');
  writeLauncher(localAppData, 'global', { installDir: root, appExecutable: '.qoder-versions\\0.5.1\\Qoder.exe', version: '0.5.1' });
  const previous = process.env.QODER_INSTALL_DIR;
  process.env.QODER_INSTALL_DIR = envRoot;
  try {
    const roots = installRoots('global', { localAppData, home: join(base, 'home'), appData: join(base, 'appdata') });
    assert.equal(roots[0].source, 'env');
    assert.equal(roots[0].root, envRoot);
    assert.ok(roots.some((entry) => entry.source === 'launcher' && entry.root === root));
    const state = launcherState('global', { localAppData });
    assert.equal(state.installDir, root);
  } finally {
    if (previous === undefined) delete process.env.QODER_INSTALL_DIR;
    else process.env.QODER_INSTALL_DIR = previous;
  }
});

test('readUmidManifest follows launcher executable and reads build version', () => {
  const base = tempDir();
  const root = join(base, 'Qoder');
  makeInstall(root, { '0.4.11': '1.1.75-hotfix.1', '0.5.1': '1.1.79-hotfix.7' });
  const state = { appExecutable: '.qoder-versions\\0.5.1\\Qoder.exe' };
  const manifest = readUmidManifest(root, { state });
  assert.equal(manifest.cliVersion, '1.1.79-hotfix.7');
  assert.equal(manifest.appVersion, '0.5.1');
  assert.equal(manifest.versionDir, join(root, '.qoder-versions', '0.5.1'));
});

test('readUmidManifest falls back to newest version dir', () => {
  const base = tempDir();
  const root = join(base, 'Qoder');
  makeInstall(root, { '0.4.11': '1.1.75-hotfix.1', '0.10.0': '1.1.80', '0.5.1': '1.1.79-hotfix.7' });
  const manifest = readUmidManifest(root);
  assert.equal(manifest.cliVersion, '1.1.80');
  assert.equal(findClient('global', { localAppData: join(base, 'none'), home: join(base, 'home'), appData: join(base, 'appdata') }).manifest, null);
});

test('effectiveProtocol follows manifest, env override and legacy switch', () => {
  const base = tempDir();
  const root = join(base, 'Qoder');
  makeInstall(root, { '0.5.1': '1.1.79-hotfix.7' });
  const manifest = readUmidManifest(root);
  const client = { root, manifest };
  const protocol = effectiveProtocol('global', { client, env: {} });
  assert.equal(protocol.cosyVersion, '1.1.79-hotfix.7');
  assert.equal(protocol.oauthUa, 'Qoder/1.1.79-hotfix.7');
  assert.equal(protocol.source.cosy, 'manifest');

  const overridden = effectiveProtocol('global', {
    client,
    env: { QODER_COSY_VERSION: '1.1.70', QODER_OAUTH_UA: 'Qoder/test' },
  });
  assert.equal(overridden.cosyVersion, '1.1.70');
  assert.equal(overridden.oauthUa, 'Qoder/test');
  assert.equal(overridden.source.cosy, 'env');

  const legacy = effectiveProtocol('cn', { client: null, env: { QODER_PROTOCOL: 'legacy' } });
  assert.equal(legacy.cosyVersion, '1.1.75');
  assert.equal(legacy.oauthUa, 'QoderWork/1.1.75');
  assert.equal(legacy.source.cosy, 'legacy');

  const fallback = effectiveProtocol('global', { client: null, env: {} });
  assert.equal(fallback.cosyVersion, '1.1.79-hotfix.7');
  assert.equal(fallback.oauthUa, 'Qoder/1.1.79-hotfix.7');
  assert.equal(fallback.source.cosy, 'fallback');
});

test('endpoint cache only accepts whitelisted inference hosts', () => {
  const home = tempDir();
  writeEndpointCache(home, 'global', 'https://api3.qoder.sh/');
  const cached = readEndpointCache('global', { home });
  assert.equal(cached.url, 'https://api3.qoder.sh');
  assert.equal(cached.updatedAt, 1_700_000_000_000);

  writeEndpointCache(home, 'cn', 'https://gateway.qoder.com.cn');
  assert.equal(readEndpointCache('cn', { home }).url, 'https://gateway.qoder.com.cn');

  writeEndpointCache(home, 'global', 'https://evil.example.com');
  assert.equal(readEndpointCache('global', { home }), null);
  assert.equal(isAllowedInferenceUrl('global', 'https://api3.qoder.sh'), true);
  assert.equal(isAllowedInferenceUrl('global', 'https://evil.qoder.sh.evil.com'), false);
  assert.equal(isAllowedInferenceUrl('global', 'http://api3.qoder.sh'), false);
});

test('gatewaysFor prepends cached inference and keeps static fallbacks', () => {
  const home = tempDir();
  writeEndpointCache(home, 'global', 'https://api2.qoder.sh');
  const gateways = gatewaysFor('global', { home });
  assert.equal(gateways[0], 'https://api2.qoder.sh');
  assert.ok(gateways.includes('https://api3.qoder.sh'));
  assert.ok(gateways.includes('https://api1.qoder.sh'));
  assert.equal(new Set(gateways).size, gateways.length);
  assert.deepEqual(gatewaysFor('cn', { home }), ['https://gateway.qoder.com.cn']);
});

test('appDataInfo follows APPDATA path, location.v1.json, then gives up', () => {
  const base = tempDir();
  const appData = join(base, 'appdata');
  const home = join(base, 'home');
  const appDir = join(appData, 'com.qoder.app.stable');
  mkdirSync(appDir, { recursive: true });
  const direct = appDataInfo('global', { platform: 'win32', appData, home });
  assert.equal(direct.source, 'appdata');
  assert.equal(direct.dir, appDir);
  assert.equal(resolveAppDataDir('global', { platform: 'win32', appData, home }), appDir);

  rmSync(appDir, { recursive: true, force: true });
  const target = join(base, 'moved-data');
  mkdirSync(target, { recursive: true });
  writeJson(join(home, '.qoder', 'desktop', 'storage', 'stable', 'location.v1.json'), {
    revision: 1,
    activeRoots: [{ logicalPath: appDir, targetPath: target }],
  });
  const moved = appDataInfo('global', { platform: 'win32', appData, home });
  assert.equal(moved.source, 'location');
  assert.equal(moved.dir, target);
  assert.equal(moved.appDataPath, appDir);

  const missing = appDataInfo('global', { platform: 'win32', appData: join(base, 'empty'), home: join(base, 'nohome') });
  assert.equal(missing.dir, '');
  assert.equal(missing.source, '');
});

test('appDataInfo resolves a junction/symlink back to its target', (t) => {
  const base = tempDir();
  const appData = join(base, 'appdata');
  const target = join(base, 'real-data');
  mkdirSync(appData, { recursive: true });
  mkdirSync(target, { recursive: true });
  const link = join(appData, 'com.qoder.app.stable');
  try {
    symlinkSync(target, link, 'junction');
  } catch (error) {
    t.skip(`当前环境不能创建 junction：${error.message}`);
    return;
  }
  const info = appDataInfo('global', { appData, home: join(base, 'home') });
  assert.equal(info.source, 'appdata');
  assert.equal(info.dir, link);
  assert.equal(existsSync(join(info.dir, 'auth.v1.dat')), false);
});

test('readAppStatus and readUmidCache are region-scoped and tolerant', () => {
  const home = tempDir();
  writeJson(join(home, '.qoder-cn', '.qoder-app-status.json'), { logged_in: true, version: '0.5.1', product: 'qoder' });
  writeJson(join(home, '.qoder-cn', 'umid-cache.json'), {
    version: 1,
    info: { machineToken: 'token', machineType: 'type', machineCode: 'code' },
  });
  assert.equal(readAppStatus('cn', { home }).version, '0.5.1');
  assert.equal(readAppStatus('global', { home }), null);
  const cache = readUmidCache('cn', { home });
  assert.equal(cache.machineToken, 'token');
  assert.equal(cache.machineType, 'type');
  assert.equal(readUmidCache('global', { home }), null);
});

test('macOS install roots and data directories are discovered without Windows paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'qoder-mac-'));
  mkdirSync(join(home, 'Library', 'Application Support', 'Qoder'), { recursive: true });
  const roots = installRoots('global', { platform: 'darwin', home });
  assert.ok(roots.some((entry) => entry.root.includes('Applications') && entry.root.endsWith('Qoder.app')));
  assert.ok(roots.some((entry) => entry.root === join(home, 'Applications', 'Qoder.app')));
  assert.equal(roots.some((entry) => entry.root.includes('Program Files')), false);
  const info = appDataInfo('global', { platform: 'darwin', home });
  assert.equal(info.dir, join(home, 'Library', 'Application Support', 'Qoder'));
  assert.equal(info.source, 'platform');
  rmSync(home, { recursive: true, force: true });
});

test('Linux install roots and config directories are discovered', () => {
  const home = mkdtempSync(join(tmpdir(), 'qoder-linux-'));
  mkdirSync(join(home, '.config', 'Qoder CN'), { recursive: true });
  const roots = installRoots('cn', { platform: 'linux', home });
  assert.ok(roots.some((entry) => entry.root.includes('opt') && entry.root.endsWith('Qoder CN')));
  assert.ok(roots.some((entry) => entry.root.includes('opt') && entry.root.endsWith('qoder-cn')));
  const info = appDataInfo('cn', { platform: 'linux', home });
  assert.equal(info.dir, join(home, '.config', 'Qoder CN'));
  rmSync(home, { recursive: true, force: true });
});
