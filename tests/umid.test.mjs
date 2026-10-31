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
  const found = findRuntimeInfo('global').replace(/\\/g, '/');
  assert.match(found, /\/1\.10\.0\/resources\/umid\/runtime-info\.exe$/, '1.10.0 比 1.9.0 新');
});

test('cleanup', () => {
  rmSync(local, { recursive: true, force: true });
});
