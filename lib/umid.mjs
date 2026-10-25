/**
 * Qoder 客户端设备身份（UMID）。
 *
 * 每日活动只对带本机客户端设备头的请求下发；离线脚本普遍用安装目录里的
 * resources/umid/runtime-info.exe 生成 machineToken/Code/Type，再从客户端数据
 * 目录读 auth.machine-id。这里做同样的事，但只在内存里持有这些值，不落盘、
 * 不进日志、不返回面板。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { arch as osArch, homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { REGIONS } from './config.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const cache = new Map();

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

function readIni(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([^=]+)=(.*)$/.exec(line.trim());
      if (match) out[match[1].trim()] = match[2].trim();
    }
  } catch { /* ignore */ }
  return out;
}

function launcherState(region) {
  return readIni(region === 'cn'
    ? join(LOCALAPPDATA, 'Qoder CN', 'Qoder CN Launcher', 'state.ini')
    : join(LOCALAPPDATA, 'Qoder', 'Qoder Launcher', 'state.ini'));
}

function runtimeCandidates(region) {
  const env = (region === 'cn'
    ? process.env.QODERCN_RUNTIME_INFO
    : process.env.QODER_RUNTIME_INFO) || process.env.QODER_UMID_PATH;
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (!value) return;
    const path = resolve(String(value));
    if (seen.has(path.toLowerCase())) return;
    seen.add(path.toLowerCase());
    out.push(path);
  };
  add(env);
  const state = launcherState(region);
  if (state.installDir) {
    if (state.appExecutable) {
      add(join(state.installDir, dirname(state.appExecutable), 'resources', 'umid', 'runtime-info.exe'));
    }
    add(join(state.installDir, 'resources', 'umid', 'runtime-info.exe'));
    try {
      const versions = readdirSync(join(state.installDir, '.qoder-versions'))
        .filter((name) => !name.startsWith('.'))
        .sort()
        .reverse();
      for (const version of versions) {
        add(join(state.installDir, '.qoder-versions', version, 'resources', 'umid', 'runtime-info.exe'));
      }
    } catch { /* ignore */ }
  }
  const names = region === 'cn' ? ['Qoder CN'] : ['Qoder'];
  for (const name of names) {
    for (const base of [
      join(LOCALAPPDATA, 'Programs', name),
      join(PROGRAM_FILES, name),
      join(PROGRAM_FILES_X86, name),
    ]) {
      add(join(base, 'resources', 'umid', 'runtime-info.exe'));
      try {
        const versions = readdirSync(join(base, '.qoder-versions')).sort().reverse();
        for (const version of versions) {
          add(join(base, '.qoder-versions', version, 'resources', 'umid', 'runtime-info.exe'));
        }
      } catch { /* ignore */ }
    }
  }
  return out;
}

export function findRuntimeInfo(region) {
  return runtimeCandidates(region).find((path) => existsSync(path)) || '';
}

export function machineIdPath(region) {
  return join(APPDATA, REGIONS[region]?.appDir || REGIONS.global.appDir, 'auth.machine-id');
}

function readMachineId(region) {
  try { return readFileSync(machineIdPath(region), 'utf8').trim(); } catch { return ''; }
}

function machineOS() {
  const arch = String(osArch());
  const normalized = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
  return `${normalized}_windows`;
}

function productVersion(exe) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(dirname(exe), '..', 'build-manifest.json'), 'utf8'));
    return String(manifest.productVersion || manifest.version || '');
  } catch { return ''; }
}

function runRuntimeInfo(exe) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, ['--account-stdin'], {
      cwd: dirname(exe),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error('runtime-info 超时'));
    }, 25_000);
    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`runtime-info 退出码 ${code}${stderr ? '：' + String(stderr).slice(0, 160) : ''}`));
        return;
      }
      const lines = String(stdout || '').split(/\r?\n/).filter((line) => line.trim());
      let info = null;
      try { info = JSON.parse(lines[lines.length - 1]); } catch { /* ignore */ }
      if (!info || !info.machineToken) {
        finish(new Error('runtime-info 没有返回 machineToken'));
        return;
      }
      finish(null, info);
    });
    try { child.stdin.end(); } catch { /* ignore */ }
  });
}

function publicFailure(reason, extra = {}) {
  return { ready: false, reason, headers: {}, version: '', machineId: '', ...extra };
}

export async function getDeviceIdentity(region) {
  const targetRegion = region === 'cn' ? 'cn' : 'global';
  const exe = findRuntimeInfo(targetRegion);
  if (!exe) {
    return publicFailure('未找到该地区 Qoder 客户端（runtime-info.exe）');
  }
  const key = `${targetRegion}\u0000${exe}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const machineId = readMachineId(targetRegion);
  if (!machineId) {
    const value = publicFailure('未找到客户端 auth.machine-id，请先打开对应地区 Qoder 客户端登录');
    cache.set(key, { at: Date.now(), ttl: FAIL_TTL_MS, value });
    return value;
  }
  let info;
  try {
    info = await runRuntimeInfo(exe);
  } catch (error) {
    const value = publicFailure(String(error?.message || error));
    cache.set(key, { at: Date.now(), ttl: FAIL_TTL_MS, value });
    return value;
  }
  const version = productVersion(exe);
  const headers = {
    'Cosy-ClientType': '10',
    'Cosy-MachineOS': machineOS(),
    // fetch 不允许非 ASCII 头；主机名异常时退回一个固定值，避免整次签到失败。
    'Cosy-MachineHostname': String(hostname()).replace(/[^\x20-\x7E]/g, '') || 'DESKTOP',
    'Cosy-MachineId': machineId,
    'Cosy-MachineToken': String(info.machineToken || ''),
    'Cosy-MachineCode': String(info.machineCode || ''),
    'Cosy-MachineType': String(info.machineType || ''),
    ...(version ? { 'Cosy-Version': version } : {}),
  };
  const value = {
    ready: Boolean(headers['Cosy-MachineToken'] && headers['Cosy-MachineCode'] && headers['Cosy-MachineType']),
    reason: '',
    headers,
    version,
    machineId,
    exe,
  };
  if (!value.ready) value.reason = '客户端设备身份字段不完整';
  cache.set(key, { at: Date.now(), ttl: value.ready ? CACHE_TTL_MS : FAIL_TTL_MS, value });
  return value;
}

/** 面板用的轻量状态：只看文件是否存在，不启动 runtime-info。 */
export function deviceAvailability(region) {
  const target = region === 'cn' ? 'cn' : 'global';
  const exe = findRuntimeInfo(target);
  if (!exe) return { available: false, reason: '未安装该地区 Qoder 客户端' };
  if (!readMachineId(target)) return { available: false, reason: '客户端尚未登录（缺 auth.machine-id）' };
  return { available: true, reason: '', version: productVersion(exe) };
}

export function invalidateDeviceCache() {
  cache.clear();
}
