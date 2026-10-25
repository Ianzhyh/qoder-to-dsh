/**
 * Qoder COSY 请求签名与请求体编码（从 MIT 许可的 qoder2api-hub 移植，
 * 见 NOTICE.md）。仅使用 Node 内置 crypto。
 */
import { createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID, constants } from 'node:crypto';

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PAD = '$';

// 编码热路径用码表 + Buffer，避免对大请求体逐字符做 Map 查找和字符串拼接。
const ENCODE_TABLE = new Uint8Array(128);
for (let i = 0; i < 64; i += 1) ENCODE_TABLE[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
ENCODE_TABLE['='.charCodeAt(0)] = PAD.charCodeAt(0);
const CUSTOM_TO_STD = new Map();
for (let i = 0; i < 64; i += 1) CUSTOM_TO_STD.set(CUSTOM_ALPHABET[i], STD_ALPHABET[i]);
CUSTOM_TO_STD.set(PAD, '=');

export const COSY_VERSION = '1.1.75';
export const COSY_USER_AGENT = 'undici';

export const SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** Qoder 自定义 Base64：尾/中/首三段轮转 + 自定义字母表，'=' → '$'。 */
export function qoderEncode(plain) {
  const std = Buffer.isBuffer(plain) ? plain.toString('base64') : Buffer.from(plain).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let p = 0;
  for (let i = n - a; i < n; i += 1) out[p++] = ENCODE_TABLE[std.charCodeAt(i)];
  for (let i = a; i < n - a; i += 1) out[p++] = ENCODE_TABLE[std.charCodeAt(i)];
  for (let i = 0; i < a; i += 1) out[p++] = ENCODE_TABLE[std.charCodeAt(i)];
  return out.toString('latin1');
}

export function qoderDecode(encoded) {
  let std = '';
  for (const ch of String(encoded)) std += CUSTOM_TO_STD.get(ch) || ch;
  const n = std.length;
  const a = Math.floor(n / 3);
  const original = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return Buffer.from(original, 'base64');
}

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

/** 键排序 + 无空白的紧凑 JSON（签名逐字节依赖）。 */
export function sortedCompact(value) {
  if (Array.isArray(value)) return `[${value.map(sortedCompact).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedCompact(value[key])}`).join(',')}}`;
  }
  if (value === undefined) return '""';
  return JSON.stringify(value);
}

/** uid + salt → 稳定的 UUID 形状设备标识（版本位 4、变体位 a）。 */
export function deriveId(uid, salt) {
  let hash = md5(`${salt}:${uid || 'anonymous'}`);
  hash = `${hash.slice(0, 12)}4${hash.slice(13, 16)}a${hash.slice(17)}`;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function deriveMachineType(uid) {
  return deriveId(uid, 'machinetype').replaceAll('-', '').slice(0, 18);
}

export function deriveMachineToken(uid) {
  return createHash('sha512').update(`machinetoken:${uid}`).digest('base64url').slice(0, 43);
}

export function deriveMachineHostname(uid) {
  const hash = md5(`hostname:${uid || 'anonymous'}`);
  return `DESKTOP-${hash.slice(0, 7).toUpperCase()}`;
}

function machineOs() {
  if (process.env.QODER_COSY_MACHINE_OS) return process.env.QODER_COSY_MACHINE_OS;
  if (process.platform === 'win32') return 'x86_64_win32';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'aarch64_darwin' : 'x86_64_darwin';
  return process.arch === 'arm64' ? 'aarch64_linux' : 'x86_64_linux';
}

/**
 * 单账号 COSY 会话。access token 变化后必须重建。
 */
export class CosySession {
  constructor({ uid, nickname = '', accessToken = '', refreshToken = '', userType = '', organizationId = '', organizationName = '' }) {
    if (!accessToken) throw new Error('COSY: empty access token');
    this.uid = uid || '';
    this.accessToken = accessToken;
    this.machineId = deriveId(uid, 'machine');
    this.machineToken = deriveMachineToken(uid);
    this.machineType = deriveMachineType(uid);
    this.machineHostname = deriveMachineHostname(uid);

    // 官方实现使用 16 个十六进制字符作为 AES-128 key；服务端按字节解包，不能改。
    this.tempKey = randomBytes(8).toString('hex');
    this.cosyKey = publicEncrypt(
      { key: SERVER_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(this.tempKey),
    ).toString('base64');

    const identity = {
      name: nickname || '',
      aid: uid,
      uid,
      yx_uid: '',
      organization_id: organizationId || '',
      organization_name: organizationName || '',
      user_type: userType || 'personal_professional_trial',
      security_oauth_token: accessToken,
      refresh_token: refreshToken || '',
    };
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(this.tempKey), Buffer.from(this.tempKey));
    this.info = Buffer.concat([cipher.update(sortedCompact(identity)), cipher.final()]).toString('base64');
  }

  bearer(body, rawUrl) {
    let path = '/';
    try { path = new URL(rawUrl).pathname || '/'; } catch { /* keep default */ }
    if (path.startsWith('/algo')) path = path.slice('/algo'.length);
    const payload = {
      cosyVersion: COSY_VERSION,
      ideVersion: '',
      info: this.info,
      requestId: randomUUID(),
      version: 'v1',
    };
    const payloadB64 = Buffer.from(sortedCompact(payload)).toString('base64');
    const date = String(Math.floor(Date.now() / 1000));
    // 分段哈希，避免为了签名把整个编码后的请求体再拼成一个大字符串。
    const signature = createHash('md5')
      .update(payloadB64).update('\n')
      .update(this.cosyKey).update('\n')
      .update(date).update('\n')
      .update(body).update('\n')
      .update(path)
      .digest('hex');
    return { payloadB64, date, bearer: `Bearer COSY.${payloadB64}.${signature}` };
  }

  headers(body, rawUrl, { modelKey = '', sse = true, accept = 'text/event-stream' } = {}) {
    const { date, bearer } = this.bearer(body, rawUrl);
    const headers = {
      'cosy-data-policy': 'agree',
      'content-type': 'application/json',
      'cosy-business-product': 'cli',
      'cosy-business-type': 'agent',
      'cosy-scene': 'assistant',
      'cosy-clienttype': '5',
      'cosy-date': date,
      'cosy-user': this.uid,
      'cosy-key': this.cosyKey,
      accept,
      authorization: bearer,
      'accept-encoding': 'identity',
      'cosy-version': COSY_VERSION,
      'cosy-machineid': this.machineId,
      'cosy-machinetoken': this.machineToken,
      'cosy-machinetype': this.machineType,
      'cosy-clientip': '169.254.198.161',
      'login-version': 'v2',
      'user-agent': COSY_USER_AGENT,
      'cosy-machineos': machineOs(),
    };
    if (sse) {
      headers['cosy-machinehostname'] = this.machineHostname;
      headers['cache-control'] = 'no-cache';
    }
    if (modelKey) {
      headers['x-model-key'] = modelKey;
      headers['x-model-source'] = 'system';
    }
    return headers;
  }
}
