/**
 * Qoder 客户端设备身份（UMID）。
 *
 * 每日活动只对带本机客户端设备头的请求下发；离线脚本普遍用安装目录里的
 * resources/umid/runtime-info.exe 生成 machineToken/Code/Type，再从客户端数据
 * 目录读 auth.machine-id。这里做同样的事，但只在内存里持有这些值，不落盘、
 * 不进日志、不返回面板。
 *
 * 0.5.1 起客户端还会把同一份身份写进 ~/.qoder/umid-cache.json。runtime-info
 * 找不到/启动失败时用它兜底，保证升级后签到不会因为安装布局变化直接失效。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { arch as osArch, homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { REGIONS } from './config.mjs';
import {
  effectiveProtocol, installRoots, launcherState, readUmidCache, resolveAppDataDir, versionDirs,
} from './client-env.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const cache = new Map();

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');

function binRuntimeCandidates(region, options = {}) {
  const cfg = REGIONS[region] || REGIONS.global;
  // CLI 的 runtime-info 在 ~/.qoder[.cn]/.bin 下；home 可注入以便跨平台测试。
  const dirs = [join(options.home || homedir(), cfg.homeDir, '.bin')];
  const out = [];
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) {
        // POSIX 布局下 CLI 直接放 `runtime-info`（无后缀）；只匹配 `-` 或
        // `.exe` 会漏掉它，签到被判成「未安装该地区 Qoder 客户端」。
        if (/^runtime-info(?:[-.]|$)/i.test(name)) out.push(join(dir, name));
      }
    } catch { /* CLI 没装或没运行过 */ }
  }
  return out;
}

function runtimeCandidates(region, options = {}) {
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
  for (const value of binRuntimeCandidates(region, options)) add(value);
  const state = launcherState(region, options);
  for (const entry of installRoots(region, options)) {
    const root = entry.root;
    if (state.appExecutable) {
      add(join(root, dirname(state.appExecutable), 'resources', 'umid', 'runtime-info.exe'));
      add(join(root, dirname(state.appExecutable), 'resources', 'umid', 'runtime-info'));
      add(join(root, 'Contents', 'Resources', 'umid', 'runtime-info'));
    }
    add(join(root, 'resources', 'umid', 'runtime-info.exe'));
    add(join(root, 'resources', 'umid', 'runtime-info'));
    add(join(root, 'Contents', 'Resources', 'umid', 'runtime-info'));
    for (const version of versionDirs(root)) {
      add(join(version, 'resources', 'umid', 'runtime-info.exe'));
      add(join(version, 'resources', 'umid', 'runtime-info'));
      add(join(version, 'Contents', 'Resources', 'umid', 'runtime-info'));
    }
  }
  return out;
}

export function findRuntimeInfo(region, options = {}) {
  return runtimeCandidates(region, options).find((path) => existsSync(path)) || '';
}

export function machineIdPath(region) {
  const cfg = REGIONS[region] || REGIONS.global;
  return join(resolveAppDataDir(region) || join(APPDATA, cfg.appDir), 'auth.machine-id');
}

function readMachineId(region) {
  const cfg = REGIONS[region] || REGIONS.global;
  const candidates = [
    machineIdPath(region),
    join(homedir(), cfg.homeDir, '.auth', 'machine_id'),
  ];
  for (const path of candidates) {
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value) return value;
    } catch { /* 试下一个位置 */ }
  }
  return '';
}

export function machineOS(platform = process.platform, arch = osArch()) {
  const normalized = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
  if (platform === 'darwin') return `${normalized}_darwin`;
  if (platform === 'linux') return `${normalized}_linux`;
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

function buildHeaders(region, machineId, info, version) {
  return {
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
}

function cacheIdentity(region, machineId, reason) {
  const cached = readUmidCache(region);
  if (!cached) return null;
  const version = effectiveProtocol(region).appVersion;
  const headers = buildHeaders(region, machineId, cached, version);
  const value = {
    ready: Boolean(headers['Cosy-MachineToken'] && headers['Cosy-MachineCode'] && headers['Cosy-MachineType']),
    reason: reason ? `runtime-info 不可用，已使用客户端设备缓存（${reason}）` : '已使用客户端设备缓存',
    headers,
    version,
    machineId,
    source: 'cache',
    cachePath: cached.path,
  };
  if (!value.ready) value.reason = '客户端设备缓存字段不完整';
  return value;
}

export async function getDeviceIdentity(region) {
  const targetRegion = region === 'cn' ? 'cn' : 'global';
  const exe = findRuntimeInfo(targetRegion);
  const machineId = readMachineId(targetRegion);
  if (!machineId) {
    return publicFailure('未找到客户端 auth.machine-id，请先打开对应地区 Qoder 客户端登录');
  }
  const key = `${targetRegion}\u0000${exe || 'cache'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  if (!exe) {
    const fallback = cacheIdentity(targetRegion, machineId, '未找到 runtime-info');
    const value = fallback || publicFailure('未找到该地区 Qoder 客户端（runtime-info）');
    cache.set(key, { at: Date.now(), ttl: fallback?.ready ? CACHE_TTL_MS : FAIL_TTL_MS, value });
    return value;
  }

  let info;
  try {
    info = await runRuntimeInfo(exe);
  } catch (error) {
    const fallback = cacheIdentity(targetRegion, machineId, String(error?.message || error));
    const value = fallback || publicFailure(String(error?.message || error));
    cache.set(key, { at: Date.now(), ttl: fallback?.ready ? CACHE_TTL_MS : FAIL_TTL_MS, value });
    return value;
  }
  const version = productVersion(exe) || effectiveProtocol(targetRegion).appVersion;
  const headers = buildHeaders(targetRegion, machineId, info, version);
  const value = {
    ready: Boolean(headers['Cosy-MachineToken'] && headers['Cosy-MachineCode'] && headers['Cosy-MachineType']),
    reason: '',
    headers,
    version,
    machineId,
    exe,
    source: 'runtime-info',
  };
  if (!value.ready) value.reason = '客户端设备身份字段不完整';
  cache.set(key, { at: Date.now(), ttl: value.ready ? CACHE_TTL_MS : FAIL_TTL_MS, value });
  return value;
}

/** 面板用的轻量状态：只看文件是否存在，不启动 runtime-info。 */
export function deviceAvailability(region) {
  const target = region === 'cn' ? 'cn' : 'global';
  const exe = findRuntimeInfo(target);
  if (!readMachineId(target)) return { available: false, reason: '客户端尚未登录（缺 auth.machine-id）' };
  if (exe) return { available: true, reason: '', version: productVersion(exe) || effectiveProtocol(target).appVersion, source: 'runtime-info' };
  const cached = readUmidCache(target);
  if (cached) {
    return {
      available: true,
      reason: 'runtime-info 未找到，将使用客户端设备缓存签到',
      version: effectiveProtocol(target).appVersion,
      source: 'cache',
    };
  }
  return { available: false, reason: '未安装该地区 Qoder 客户端' };
}

export function invalidateDeviceCache() {
  cache.clear();
}
