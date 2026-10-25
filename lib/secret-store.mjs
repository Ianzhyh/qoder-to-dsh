import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rename as renameAsync, writeFile as writeFileAsync } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';

import { PATHS } from './config.mjs';

const isWindows = process.platform === 'win32';
const execFileAsync = promisify(execFile);

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Windows DPAPI（CurrentUser）→ 只有当前 Windows 用户能解开。
 * 密钥不落盘，复制 auth.json 到别的机器/账户也无效。
 *
 * PowerShell 只接收 base64（字符集固定），不存在拼接注入面。
 */
function dpapiCommand(input, mode) {
  const b64 = Buffer.from(input).toString('base64');
  const call = mode === 'protect' ? 'Protect' : 'Unprotect';
  return `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); $p=[System.Security.Cryptography.ProtectedData]::${call}($b,$null,'CurrentUser'); [Convert]::ToBase64String($p)`;
}

function dpapi(input, mode) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', dpapiCommand(input, mode),
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || 'DPAPI failed').trim());
  const out = String(result.stdout || '').trim();
  if (!out) throw new Error('DPAPI returned an empty payload');
  return Buffer.from(out, 'base64');
}

async function dpapiAsync(input, mode) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', dpapiCommand(input, mode),
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  const out = String(stdout || '').trim();
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

export async function dpapiUnprotectBytesAsync(bytes) {
  return dpapiAsync(Buffer.from(bytes), 'unprotect');
}

function aesRecord(plain) {
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

export function encryptRecord(value) {
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  if (isWindows) {
    try {
      return { v: 1, scheme: 'dpapi', data: dpapi(plain, 'protect').toString('base64') };
    } catch {
      // DPAPI 在受限 PowerShell 环境里可能不可用；退回 AES-GCM + 本机 0600 key。
    }
  }
  return aesRecord(plain);
}

async function encryptRecordAsync(value) {
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  if (isWindows) {
    try {
      return { v: 1, scheme: 'dpapi', data: (await dpapiAsync(plain, 'protect')).toString('base64') };
    } catch {
      // 与同步路径一致：DPAPI 不可用时退回 AES-GCM。
    }
  }
  return aesRecord(plain);
}

/**
 * 异步版本：PowerShell DPAPI 放到子进程里等，不占用主事件循环。
 * 写入仍然是临时文件 + rename，进程中途退出不会留下半截 JSON。
 */
export async function writeEncryptedJsonAsync(path, value) {
  const record = await encryptRecordAsync(value);
  ensureDir(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFileAsync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await renameAsync(tmp, path);
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
