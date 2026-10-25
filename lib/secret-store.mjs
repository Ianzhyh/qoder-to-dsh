import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

import { PATHS } from './config.mjs';

const isWindows = process.platform === 'win32';

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Windows DPAPI（CurrentUser）→ 只有当前 Windows 用户能解开。
 * 密钥不落盘，复制 auth.json 到别的机器/账户也无效。
 *
 * PowerShell 只接收 base64（字符集固定），不存在拼接注入面。
 */
function dpapi(input, mode) {
  const b64 = Buffer.from(input).toString('base64');
  const command = mode === 'protect'
    ? `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); $p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Convert]::ToBase64String($p)`
    : `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); $p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Convert]::ToBase64String($p)`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || 'DPAPI failed').trim());
  const out = String(result.stdout || '').trim();
  if (!out) throw new Error('DPAPI returned an empty payload');
  return Buffer.from(out, 'base64');
}

function aesKey() {
  ensureDir(PATHS.key);
  if (!existsSync(PATHS.key)) {
    writeFileSync(PATHS.key, randomBytes(32), { mode: 0o600 });
    try { chmodSync(PATHS.key, 0o600); } catch { /* Windows 上 chmod 语义有限 */ }
  }
  const key = readFileSync(PATHS.key);
  if (key.length !== 32) throw new Error('corrupted secret key file');
  return key;
}

export function dpapiUnprotectBytes(bytes) {
  return dpapi(Buffer.from(bytes), 'unprotect');
}

export function encryptRecord(value) {
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  if (isWindows) {
    try {
      return { v: 1, scheme: 'dpapi', data: dpapi(plain, 'protect').toString('base64') };
    } catch {
      // DPAPI 在受限 PowerShell 环境里可能不可用；退回 AES-GCM + 本机 0600 key。
    }
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    scheme: 'aes-256-gcm',
    data: Buffer.concat([iv, tag, ciphertext]).toString('base64'),
  };
}

export function decryptRecord(record) {
  if (!record || record.v !== 1 || typeof record.data !== 'string') {
    throw new Error('unsupported credential envelope');
  }
  if (record.scheme === 'dpapi') {
    return JSON.parse(dpapi(Buffer.from(record.data, 'base64'), 'unprotect').toString('utf8'));
  }
  if (record.scheme === 'aes-256-gcm') {
    const raw = Buffer.from(record.data, 'base64');
    if (raw.length < 29) throw new Error('truncated credential envelope');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  }
  throw new Error(`unknown credential scheme: ${record.scheme}`);
}

export function writeEncryptedJson(path, value) {
  ensureDir(path);
  writeFileSync(path, `${JSON.stringify(encryptRecord(value), null, 2)}\n`, { mode: 0o600 });
}

export function readEncryptedJson(path) {
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, 'utf8'));
  return decryptRecord(record);
}
