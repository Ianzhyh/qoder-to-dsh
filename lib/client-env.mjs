/**
 * Qoder 客户端环境探测（只读）。
 *
 * 0.5.1 起客户端的安装布局、内置 CLI 版本、设备身份缓存与端点缓存都可能在升级
 * 后变化。这里把「客户端现在长什么样」集中成一组纯读函数，避免版本号、路径和
 * 端点散落在签名、凭据、签到场里各写一份。
 *
 * 设计约束：
 *   - 任何函数都不写文件、不启动客户端；
 *   - 所有路径都接受显式 options，方便用临时目录单测；
 *   - 读不到就返回空值/兜底常量，由调用方决定是降级还是报错。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { REGIONS } from './config.mjs';

/** 0.5.1 内置的 qoderCliVersion；仅作为 manifest 读不到时的兜底。 */
export const FALLBACK_CLI_VERSION = '1.1.79-hotfix.7';
/** 已验证过的旧 COSY 版本；`QODER_PROTOCOL=legacy` 时强制使用。 */
export const LEGACY_COSY_VERSION = '1.1.75';

const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

function platformOf(options = {}) {
  return options.platform || process.platform;
}

function homeRoot(options = {}) {
  return options.home || process.env.USERPROFILE || homedir();
}

function appDataRoot(options = {}) {
  if (options.appData) return options.appData;
  const platform = platformOf(options);
  if (platform === 'darwin') return join(homeRoot(options), 'Library', 'Application Support');
  if (platform === 'linux') return process.env.XDG_CONFIG_HOME || join(homeRoot(options), '.config');
  return process.env.APPDATA || join(homeRoot(options), 'AppData', 'Roaming');
}

function localAppDataRoot(options = {}) {
  if (options.localAppData) return options.localAppData;
  const platform = platformOf(options);
  if (platform === 'darwin') return join(homeRoot(options), 'Library', 'Application Support');
  if (platform === 'linux') return process.env.XDG_DATA_HOME || join(homeRoot(options), '.local', 'share');
  return process.env.LOCALAPPDATA || join(homeRoot(options), 'AppData', 'Local');
}

export function readIni(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([^=]+)=(.*)$/.exec(line.trim());
      if (match) out[match[1].trim()] = match[2].trim();
    }
  } catch { /* 文件不存在或不可读 */ }
  return out;
}

function launcherDir(region) {
  return region === 'cn' ? ['Qoder CN', 'Qoder CN Launcher'] : ['Qoder', 'Qoder Launcher'];
}

export function launcherState(region, options = {}) {
  const [base, launcher] = launcherDir(region);
  return readIni(join(localAppDataRoot(options), base, launcher, 'state.ini'));
}

/** 版本目录按数字段降序；字典序会把 1.9.0 排在 1.10.0 前面。 */
export function compareVersionDesc(a, b) {
  const left = (String(a).match(/\d+/g) || []).map(Number);
  const right = (String(b).match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] || 0) - (left[i] || 0);
    if (diff) return diff;
  }
  return String(b).localeCompare(String(a));
}

export function versionDirs(root) {
  try {
    return readdirSync(join(root, '.qoder-versions'))
      .filter((name) => !name.startsWith('.'))
      .sort(compareVersionDesc)
      .map((name) => join(root, '.qoder-versions', name));
  } catch {
    return [];
  }
}

/**
 * 安装根候选，按可靠性排序：显式环境变量 → launcher state.ini → 默认安装目录。
 * 目录可能同时存在多个版本；调用方继续看 `resources/umid/manifest.json`。
 */
export function installRoots(region, options = {}) {
  const envKey = region === 'cn' ? 'QODERCN_INSTALL_DIR' : 'QODER_INSTALL_DIR';
  const out = [];
  const seen = new Set();
  const add = (root, source) => {
    if (!root) return;
    const value = resolve(String(root));
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ root: value, source, exists: existsSync(value) });
  };
  add(region === 'cn' ? process.env.QODERCN_INSTALL_DIR : process.env.QODER_INSTALL_DIR, 'env');
  const state = launcherState(region, options);
  add(state.installDir, 'launcher');
  const names = region === 'cn' ? ['Qoder CN'] : ['Qoder'];
  const platform = platformOf(options);
  for (const name of names) {
    if (platform === 'darwin') {
      add(join('/Applications', `${name}.app`), 'default');
      add(join(homeRoot(options), 'Applications', `${name}.app`), 'default');
      continue;
    }
    if (platform === 'linux') {
      const slug = region === 'cn' ? 'qoder-cn' : 'qoder';
      add(join('/opt', name), 'default');
      add(join('/opt', slug), 'default');
      add(join('/usr/share', slug), 'default');
      add(join('/usr/lib', slug), 'default');
      continue;
    }
    add(join(localAppDataRoot(options), 'Programs', name), 'default');
    add(join(PROGRAM_FILES, name), 'default');
    add(join(PROGRAM_FILES_X86, name), 'default');
  }
  return out;
}

/** 从安装根读 build-manifest / umid manifest；优先 launcher 指向的版本。 */
export function readUmidManifest(root, options = {}) {
  if (!root) return null;
  const candidates = [];
  const state = options.state || null;
  if (state && state.appExecutable) {
    const exeDir = dirname(join(root, state.appExecutable));
    candidates.push(join(exeDir, 'resources', 'umid'));
    candidates.push(join(root, dirname(state.appExecutable), 'resources', 'umid'));
  }
  candidates.push(join(root, 'Contents', 'Resources', 'umid'));
  candidates.push(join(root, 'resources', 'umid'));
  for (const dir of versionDirs(root)) candidates.push(join(dir, 'resources', 'umid'));

  for (const umidDir of candidates) {
    const manifestPath = join(umidDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
    const versionDir = dirname(dirname(umidDir));
    let build = null;
    try { build = JSON.parse(readFileSync(join(versionDir, 'resources', 'build-manifest.json'), 'utf8')); } catch { /* ignore */ }
    return {
      path: manifestPath,
      umidDir,
      versionDir,
      root,
      appVersion: String(build?.productVersion || build?.version || ''),
      cliVersion: String(manifest.qoderCliVersion || ''),
      sdkVersion: String(manifest.sdkVersion || ''),
      sdkPackageName: String(manifest.sdkPackageName || ''),
    };
  }
  return null;
}

/** 找到当前区域最可信的一套客户端。 */
export function findClient(region, options = {}) {
  const roots = installRoots(region, options);
  const state = launcherState(region, options);
  for (const entry of roots) {
    if (!entry.exists) continue;
    const manifest = readUmidManifest(entry.root, { ...options, state });
    if (manifest) return { ...entry, manifest, state };
  }
  const first = roots.find((entry) => entry.exists) || roots[0] || null;
  return first ? { ...first, manifest: null, state } : { state };
}

function uaPrefix(region) {
  return region === 'cn' ? 'QoderWork' : 'Qoder';
}

/**
 * 当前应使用的协议版本。
 *   - QODER_COSY_VERSION / QODER_OAUTH_UA 显式覆盖优先；
 *   - QODER_PROTOCOL=legacy 强制回退到已验证的 1.1.75；
 *   - 否则跟随客户端内置 CLI 版本（升级后自动前进）。
 */
export function effectiveProtocol(region, options = {}) {
  const target = region === 'cn' ? 'cn' : 'global';
  const client = options.client === undefined ? findClient(target, options) : options.client;
  const manifest = client?.manifest || null;
  const legacy = String(options.env?.QODER_PROTOCOL ?? process.env.QODER_PROTOCOL ?? '').toLowerCase() === 'legacy';
  const env = options.env || process.env;
  const cliVersion = String(manifest?.cliVersion || '');
  const fallbackVersion = legacy ? LEGACY_COSY_VERSION : (cliVersion || FALLBACK_CLI_VERSION);
  const cosyVersion = String(env.QODER_COSY_VERSION || fallbackVersion);
  const fallbackUa = legacy ? `${uaPrefix(target)}/1.1.75` : `${uaPrefix(target)}/${cliVersion || FALLBACK_CLI_VERSION}`;
  const oauthUa = String(env.QODER_OAUTH_UA || fallbackUa);
  return {
    region: target,
    cosyVersion,
    oauthUa,
    cliVersion,
    appVersion: String(manifest?.appVersion || ''),
    source: {
      cosy: env.QODER_COSY_VERSION ? 'env' : legacy ? 'legacy' : cliVersion ? 'manifest' : 'fallback',
      ua: env.QODER_OAUTH_UA ? 'env' : legacy ? 'legacy' : cliVersion ? 'manifest' : 'fallback',
    },
    client,
  };
}

const ENDPOINT_CACHE_SCHEMA = 2;
const ALLOWED_GLOBAL_HOST = /(^|\.)qoder\.sh$/i;
const ALLOWED_CN_HOST = /(^|\.)qoder\.com\.cn$/i;

export function isAllowedInferenceUrl(region, raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const allow = region === 'cn' ? ALLOWED_CN_HOST : ALLOWED_GLOBAL_HOST;
  return allow.test(url.hostname);
}

function endpointCachePath(region, options = {}) {
  const cfg = REGIONS[region] || REGIONS.global;
  return join(homeRoot(options), cfg.homeDir, '.cache', 'qoder-client-endpoint-cache.json');
}

/**
 * 0.5.1 的客户端会把当前可用推理端点写进 endpoint cache。
 * 只读取 inference.selected，且必须命中域名白名单；读不到/不认识就返回 null。
 */
export function readEndpointCache(region, options = {}) {
  const target = region === 'cn' ? 'cn' : 'global';
  const path = endpointCachePath(target, options);
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!raw || raw.version !== ENDPOINT_CACHE_SCHEMA) return null;
  const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  const prod = entries.prod || entries[Object.keys(entries)[0]] || {};
  const sets = prod.endpointSets || {};
  const inference = sets.inference || {};
  const candidates = Array.isArray(inference.candidates) ? inference.candidates : [];
  const selected = String(inference.selected || '');
  if (!isAllowedInferenceUrl(target, selected)) return null;
  return {
    url: selected.replace(/\/+$/, ''),
    candidates: candidates.filter((item) => isAllowedInferenceUrl(target, item)),
    path,
    updatedAt: Number(prod.updatedAt) || 0,
  };
}

/** 网关候选：客户端缓存优先，随后是配置里的静态故障切换列表。 */
export function gatewaysFor(region, options = {}) {
  const cfg = REGIONS[region] || REGIONS.global;
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const key = String(value || '').replace(/\/+$/, '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  const cached = readEndpointCache(region, options);
  add(cached?.url);
  for (const item of cfg.gateways || []) add(item);
  return out;
}

function locationPath(region, options = {}) {
  const cfg = REGIONS[region] || REGIONS.global;
  return join(homeRoot(options), cfg.homeDir, 'desktop', 'storage', 'stable', 'location.v1.json');
}

/**
 * 客户端数据目录。APPDATA 下通常是 symlink/junction，Node 会透明跟随；
 * 若路径不存在（搬迁后未留链接），再读 location.v1.json 的 activeRoots。
 */
export function appDataInfo(region, options = {}) {
  const target = region === 'cn' ? 'cn' : 'global';
  const cfg = REGIONS[target];
  const appDataPath = join(appDataRoot(options), cfg.appDir);
  const platform = platformOf(options);
  const label = target === 'cn' ? 'Qoder CN' : 'Qoder';
  const candidates = [appDataPath];
  if (platform === 'darwin') candidates.push(join(appDataRoot(options), label));
  if (platform === 'linux') {
    candidates.push(join(appDataRoot(options), label));
    candidates.push(join(homeRoot(options), cfg.homeDir));
  }
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    return {
      region: target,
      dir,
      appDataPath,
      source: dir === appDataPath ? 'appdata' : 'platform',
      location: null,
    };
  }
  if (platform !== 'win32') {
    return { region: target, dir: '', appDataPath, source: '', location: null };
  }
  const path = locationPath(target, options);
  let raw = null;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { /* ignore */ }
  if (raw) {
    const roots = Array.isArray(raw.activeRoots) ? raw.activeRoots : (Array.isArray(raw.roots) ? raw.roots : []);
    const match = roots.find((entry) => String(entry?.logicalPath || '').toLowerCase() === appDataPath.toLowerCase())
      || roots[0];
    const dir = String(match?.targetPath || '');
    if (dir && existsSync(dir)) {
      return { region: target, dir, appDataPath, source: 'location', location: path };
    }
  }
  return { region: target, dir: '', appDataPath, source: '', location: path };
}

export function resolveAppDataDir(region, options = {}) {
  return appDataInfo(region, options).dir;
}

function stateHomeFile(region, name, options) {
  const cfg = REGIONS[region] || REGIONS.global;
  return join(homeRoot(options), cfg.homeDir, name);
}

/** 0.5.1 的登录状态快照；只用于诊断，不替代 auth.v1.dat。 */
export function readAppStatus(region, options = {}) {
  const target = region === 'cn' ? 'cn' : 'global';
  const path = stateHomeFile(target, '.qoder-app-status.json', options);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? { ...raw, path } : null;
  } catch { return null; }
}

/** 0.5.1 的设备身份缓存；runtime-info 不可用时作为签到设备头兜底。 */
export function readUmidCache(region, options = {}) {
  const target = region === 'cn' ? 'cn' : 'global';
  const path = stateHomeFile(target, 'umid-cache.json', options);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const info = raw.info && typeof raw.info === 'object' ? raw.info : {};
    if (!info.machineToken) return null;
    return {
      path,
      version: Number(raw.version) || 0,
      environment: Number(raw.environment) || 0,
      platform: String(raw.platform || ''),
      arch: String(raw.arch || ''),
      machineToken: String(info.machineToken || ''),
      machineType: String(info.machineType || ''),
      machineCode: String(info.machineCode || ''),
      vmInfo: info.vmInfo || null,
    };
  } catch { return null; }
}
