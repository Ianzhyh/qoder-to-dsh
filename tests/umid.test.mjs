import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const local = mkdtempSync(join(tmpdir(), 'qoder-umid-'));
const install = join(local, 'Qoder', 'install');
const launcher = join(local, 'Qoder', 'Qoder Launcher');
mkdirSync(launcher, { recursive: true });
writeFileSync(join(launcher, 'state.ini'), `installDir=${install}\n`);
for (const version of ['1.9.0', '1.10.0']) {
  const dir = join(install, '.qoder-versions', version, 'resources', 'umid');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runtime-info.exe'), '');
}

process.env.LOCALAPPDATA = local;
process.env.QODER_RUNTIME_INFO = '';
process.env.QODERCN_RUNTIME_INFO = '';
process.env.QODER_UMID_PATH = '';

const { findRuntimeInfo } = await import('../lib/umid.mjs');

test('multiple client installs pick the numerically newest runtime-info', () => {
  // Windows 安装布局：.qoder-versions 里多版本共存，取数字最新的那个。
  const found = findRuntimeInfo('global', { platform: 'win32' }).replace(/\\/g, '/');
  assert.match(found, /\/1\.10\.0\/resources\/umid\/runtime-info\.exe$/, '1.10.0 比 1.9.0 新');
});

test('cleanup', () => {
  rmSync(local, { recursive: true, force: true });
});

test('machineOS follows the running platform instead of always claiming Windows', async () => {
  const { machineOS } = await import('../lib/umid.mjs');
  assert.equal(machineOS('win32', 'x64'), 'x86_64_windows');
  assert.equal(machineOS('darwin', 'arm64'), 'aarch64_darwin');
  assert.equal(machineOS('linux', 'x64'), 'x86_64_linux');
});

test('linux CLI runtime-info is discovered from ~/.qoder/.bin and version dirs', () => {
  const home = mkdtempSync(join(tmpdir(), 'qoder-umid-linux-'));
  const bin = join(home, '.qoder', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'runtime-info-1.2.0'), '');
  assert.equal(
    findRuntimeInfo('global', { platform: 'linux', home }),
    join(bin, 'runtime-info-1.2.0'),
  );

  // 版本目录布局用显式 QODER_INSTALL_DIR 验证（/opt 在 CI 上不可写）。
  const install = join(home, 'opt', 'Qoder');
  const umidDir = join(install, '.qoder-versions', '2.0.0', 'resources', 'umid');
  mkdirSync(umidDir, { recursive: true });
  writeFileSync(join(umidDir, 'runtime-info'), '');
  rmSync(bin, { recursive: true, force: true });
  const previousInstallDir = process.env.QODER_INSTALL_DIR;
  process.env.QODER_INSTALL_DIR = install;
  try {
    const found = findRuntimeInfo('global', { platform: 'linux', home });
    assert.ok(found.endsWith(join('resources', 'umid', 'runtime-info')), `命中版本目录里的无扩展名 runtime-info：${found}`);
  } finally {
    if (previousInstallDir === undefined) delete process.env.QODER_INSTALL_DIR;
    else process.env.QODER_INSTALL_DIR = previousInstallDir;
  }
  rmSync(home, { recursive: true, force: true });
});
