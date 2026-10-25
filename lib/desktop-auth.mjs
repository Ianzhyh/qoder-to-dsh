/**
 * 只读导入 Qoder 官方客户端已登录的凭证。
 *
 * 两种官方存储：
 *   桌面 App：%APPDATA%/<appDir>/auth.v1.dat
 *     布局 "v10" + AES-256-GCM；密钥在 Local State 的
 *     os_crypt.encrypted_key（DPAPI 保护）→ 剥 "DPAPI" → DPAPI 解出。
 *   CLI：~/.qoder[.cn]/.auth/user[.*]
 *     AES-128-CBC，key=iv=machine_id 前 16 字符。
 *
 * 全程只读。候选里的 token 只留在内存，绝不进日志或面板响应。
 */
import { createDecipheriv } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { REGIONS } from './config.mjs';
import { dpapiUnprotectBytes, dpapiUnprotectBytesAsync } from './secret-store.mjs';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const keyCache = new Map();
const keyInflight = new Map();
let scanCache = { at: 0, candidates: [] };

function readOsCryptKey(appDir) {
  if (keyCache.has(appDir)) return keyCache.get(appDir);
  const localState = join(appDir, 'Local State');
  const state = JSON.parse(readFileSync(localState, 'utf8'));
  const encrypted = (state.os_crypt || {}).encrypted_key;
  if (!encrypted) throw new Error('Local State 里没有 os_crypt.encrypted_key');
  const blob = Buffer.from(encrypted, 'base64');
  if (blob.subarray(0, 5).toString() !== 'DPAPI') throw new Error('encrypted_key 不是 DPAPI 信封');
  const key = dpapiUnprotectBytes(blob.subarray(5));
  if (key.length !== 32) throw new Error(`DPAPI 解出的 key 长度异常：${key.length}`);
  keyCache.set(appDir, key);
  return key;
}

function readOsCryptEnvelope(appDir) {
  const localState = join(appDir, 'Local State');
  if (!existsSync(localState)) return null;
  const state = JSON.parse(readFileSync(localState, 'utf8'));
  const encrypted = (state.os_crypt || {}).encrypted_key;
  if (!encrypted) return null;
  const blob = Buffer.from(encrypted, 'base64');
  if (blob.subarray(0, 5).toString() !== 'DPAPI') return null;
  return blob.subarray(5);
}

async function readOsCryptKeyAsync(appDir) {
  if (keyCache.has(appDir)) return keyCache.get(appDir);
  if (keyInflight.has(appDir)) return keyInflight.get(appDir);
  const task = (async () => {
    const envelope = readOsCryptEnvelope(appDir);
    if (!envelope) return null;
    const key = await dpapiUnprotectBytesAsync(envelope);
    if (key.length !== 32) throw new Error(`DPAPI 解出的 key 长度异常：${key.length}`);
    keyCache.set(appDir, key);
    return key;
  })();
  keyInflight.set(appDir, task);
  try {
    return await task;
  } finally {
    keyInflight.delete(appDir);
  }
}

/**
 * 启动时在子进程里解出两个版本的 os_crypt key。这样 8 秒后的自动签到、
 * 首次打开账号页时的同步扫描都直接命中缓存，不会在主线程等 PowerShell。
 */
export async function prewarmDesktopKeysAsync() {
  await Promise.all(['global', 'cn'].map(async (region) => {
    const appDir = join(APPDATA, REGIONS[region].appDir);
    if (!existsSync(join(appDir, 'Local State'))) return;
    try {
      await readOsCryptKeyAsync(appDir);
    } catch { /* 真正需要时会走同步路径并给出可见错误 */ }
  }));
}

function decryptV10(blob, key) {
  if (blob.subarray(0, 3).toString() !== 'v10') throw new Error('auth.v1.dat 不是 v10 信封');
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(15, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseEpoch(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : 0;
}

function normalizeUserType(value) {
  return typeof value === 'string' && value ? value : 'personal_professional_trial';
}

function appCandidate(region) {
  const cfg = REGIONS[region];
  const appDir = join(APPDATA, cfg.appDir);
  const authPath = join(appDir, 'auth.v1.dat');
  const base = {
    kind: 'app',
    region,
    regionLabel: cfg.label,
    path: authPath,
    file: 'auth.v1.dat',
    exists: existsSync(authPath),
    readable: false,
    valid: false,
    uid: '',
    nickname: '',
    email: '',
    avatarUrl: '',
    expiresAt: 0,
    error: '',
    accessToken: '',
    refreshToken: '',
    source: 'desktop',
    userType: '',
    organizationId: '',
    organizationName: '',
  };
  if (!base.exists) {
    base.error = '未找到（未安装或未登录该版本客户端）';
    return base;
  }
  const readFileData = () => {
    const key = readOsCryptKey(appDir);
    return JSON.parse(decryptV10(readFileSync(authPath), key).toString('utf8'));
  };
  let data = null;
  try {
    data = readFileData();
  } catch (error) {
    // os_crypt key 与安装绑定；只有真正解密失败时才丢弃缓存重读一次（重装/轮换 key）。
    if (keyCache.has(appDir)) {
      keyCache.delete(appDir);
      try {
        data = readFileData();
      } catch (retryError) {
        base.error = String(retryError?.message || retryError);
      }
    } else {
      base.error = String(error?.message || error);
    }
  }
  if (data) {
    const user = data.user || {};
    const token = String(data.token || '');
    const refreshToken = String(data.refreshToken || '');
    base.readable = true;
    base.valid = token.startsWith('dt-') || Boolean(refreshToken);
    base.uid = String(user.id || '');
    base.nickname = String(user.name || '');
    base.email = String(user.email || '');
    base.avatarUrl = String(user.avatarUrl || '');
    base.expiresAt = parseEpoch(data.expiresAt);
    base.refreshExpiresAt = parseEpoch(data.refreshTokenExpiresAt);
    base.expiresLabel = base.expiresAt ? new Date(base.expiresAt).toISOString() : '';
    base.userType = normalizeUserType(data.userType || data.user_type);
    base.organizationId = String(data.organizationId || data.organization_id || '');
    base.organizationName = String(data.organizationName || data.organization_name || '');
    base.accessToken = token;
    base.refreshToken = refreshToken;
    if (!token && !refreshToken) base.error = 'auth.v1.dat 里没有令牌';
  }
  return base;
}

function cliCandidates(region) {
  const cfg = REGIONS[region];
  const authDir = join(homedir(), cfg.homeDir, '.auth');
  if (!existsSync(authDir)) return [];
  let machineId = '';
  try { machineId = readFileSync(join(authDir, 'machine_id'), 'utf8').trim(); } catch { /* ignore */ }
  let names = [];
  try {
    names = readdirSync(authDir).filter((name) => name === 'user' || name.startsWith('user.'));
  } catch { return []; }
  const out = [];
  for (const file of names) {
    const path = join(authDir, file);
    const base = {
      kind: 'cli', region, regionLabel: cfg.label, path, file,
      exists: true, readable: false, valid: false, uid: '', nickname: '', email: '', avatarUrl: '',
      expiresAt: 0, error: '', accessToken: '', refreshToken: '', source: 'cli', userType: '',
      organizationId: '', organizationName: '',
    };
    try {
      const raw = readFileSync(path, 'utf8').trim();
      let data;
      if (raw.startsWith('{')) {
        data = JSON.parse(raw);
      } else {
        if (machineId.length < 16) throw new Error('machine_id 长度不足 16');
        const key = Buffer.from(machineId.slice(0, 16), 'utf8');
        const decipher = createDecipheriv('aes-128-cbc', key, key);
        const plain = Buffer.concat([decipher.update(Buffer.from(raw, 'base64')), decipher.final()]);
        data = JSON.parse(plain.toString('utf8'));
      }
      const token = String(data.access_token || data.token || '');
      base.readable = true;
      base.valid = /^(dt|jt)-/.test(token);
      base.uid = String(data.uid || data.user_id || '');
      base.nickname = String(data.name || data.nickname || '');
      base.email = String(data.email || '');
      base.expiresAt = parseEpoch(data.expire_time || data.expiresAt);
      base.accessToken = token;
      base.refreshToken = String(data.refresh_token || '');
      base.userType = normalizeUserType(data.user_type);
      base.organizationId = String(data.organization_id || '');
      base.organizationName = String(data.organization_name || '');
    } catch (error) {
      base.error = String(error?.message || error);
    }
    out.push(base);
  }
  return out;
}

/** 只读扫描双区官方客户端；结果缓存 15 秒。 */
export function scanDesktopAuth({ force = false } = {}) {
  if (!force && Date.now() - scanCache.at < 15_000) return scanCache.candidates;
  const candidates = [];
  for (const region of ['global', 'cn']) {
    candidates.push(appCandidate(region));
    candidates.push(...cliCandidates(region));
  }
  scanCache = { at: Date.now(), candidates };
  return candidates;
}

/** 面板公开信息：剔除任何令牌。 */
export function publicCandidate(candidate) {
  if (!candidate) return null;
  return {
    kind: candidate.kind,
    region: candidate.region,
    regionLabel: candidate.regionLabel,
    file: candidate.file,
    path: candidate.path,
    exists: candidate.exists,
    readable: candidate.readable,
    valid: candidate.valid,
    uid: candidate.uid,
    nickname: candidate.nickname,
    email: candidate.email,
    avatarUrl: candidate.avatarUrl,
    expiresAt: candidate.expiresAt,
    error: candidate.error,
  };
}

export function publicDesktopCandidates(options) {
  return scanDesktopAuth(options).map(publicCandidate);
}

/** 精确找一个可生成凭据的本机账号；用于首页/账号页的账号切换。 */
export function findDesktopCandidate({ region = '', uid = '', kind = '', file = '' } = {}) {
  const candidates = scanDesktopAuth({ force: true })
    .filter((candidate) => candidate.valid && (candidate.accessToken || candidate.refreshToken));
  return candidates.find((candidate) => (!region || candidate.region === region)
    && (!uid || candidate.uid === uid)
    && (!kind || candidate.kind === kind)
    && (!file || candidate.file === file)) || null;
}

/** 选出可导入的候选：优先指定区域，其次国际版，取过期时间最新。 */
export function pickDesktopAuth(region = 'global') {
  const candidates = scanDesktopAuth().filter((candidate) => candidate.valid && (candidate.accessToken || candidate.refreshToken));
  if (!candidates.length) return null;
  const score = (candidate) => (candidate.region === region ? 2 : candidate.region === 'global' ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a) || (b.expiresAt || 0) - (a.expiresAt || 0))[0];
}

export function authFromCandidate(candidate) {
  return {
    schemaVersion: 1,
    region: candidate.region,
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    expiresAt: candidate.expiresAt,
    user: {
      id: candidate.uid,
      name: candidate.nickname,
      email: candidate.email,
      avatarUrl: candidate.avatarUrl,
    },
    userType: candidate.userType || 'personal_professional_trial',
    organizationId: candidate.organizationId || '',
    organizationName: candidate.organizationName || '',
    source: candidate.kind === 'app' ? 'desktop' : 'cli',
    updatedAt: Date.now(),
  };
}

/** 当前机器是否至少有一个可用的官方登录态（不返回令牌）。 */
export function hasDesktopLogin() {
  return scanDesktopAuth().some((candidate) => candidate.valid);
}

export function invalidateDesktopScan() {
  scanCache = { at: 0, candidates: [] };
  // keyCache 刻意保留：os_crypt key 不会随登录令牌变化；
  // 每次清掉都会多起一次 PowerShell DPAPI（Windows 上约 250ms）。
  // 若应用重装导致 key 变化，appCandidate 解密失败时会自动丢弃缓存重试。
}
