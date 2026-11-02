/**
 * 多 PAT 凭据库。
 *
 * 只保存 `pt-` 开头的个人令牌及其公开身份元数据；切换时重新走
 * `jobToken/exchange`，不把短期访问令牌再抄一份到第二个文件。
 *
 * 文件整体用 secret-store 加密（Windows DPAPI / AES-256-GCM 回退），
 * 面板路由只返回 id/区域/名称/uid 尾号/时间，永远不返回 pat 或令牌。
 */
import { createHash } from 'node:crypto';

import { PATHS, REGIONS } from './config.mjs';
import { readEncryptedJson, writeEncryptedJsonAsync } from './secret-store.mjs';

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 50;
const MAX_LABEL = 24;

function normalizeLabel(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL);
}

export function patId(region, uid, pat) {
  return createHash('sha256')
    .update(`${region}:${uid || 'anonymous'}:${pat || ''}`)
    .digest('hex')
    .slice(0, 16);
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pat = String(raw.pat || '').trim();
  if (!/^pt-/.test(pat)) return null;
  const region = raw.region === 'cn' ? 'cn' : 'global';
  const user = raw.user && typeof raw.user === 'object' ? raw.user : {};
  const uid = String(raw.uid || user.id || '');
  const id = String(raw.id || patId(region, uid, pat));
  const labelSource = raw.label === undefined || raw.label === null
    ? (user.name || user.email || uid)
    : raw.label;
  return {
    id,
    region,
    pat,
    label: normalizeLabel(labelSource),
    uid,
    name: String(raw.name || user.name || ''),
    email: String(raw.email || user.email || ''),
    avatarUrl: String(raw.avatarUrl || user.avatarUrl || ''),
    userType: String(raw.userType || ''),
    organizationId: String(raw.organizationId || ''),
    organizationName: String(raw.organizationName || ''),
    addedAt: Math.max(0, Number(raw.addedAt) || 0),
    lastUsedAt: Math.max(0, Number(raw.lastUsedAt) || 0),
  };
}

export function normalizePatStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = [];
  const seen = new Set();
  const list = Array.isArray(source.entries) ? source.entries : [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { schemaVersion: SCHEMA_VERSION, entries };
}

export function readPatStore(path = PATHS.pats) {
  try {
    return { ...normalizePatStore(readEncryptedJson(path)), error: '' };
  } catch (error) {
    // 文件存在但解不开时不要静默清空：保留原文件，让诊断/用户处理。
    return { schemaVersion: SCHEMA_VERSION, entries: [], error: String(error?.message || error) };
  }
}

export async function writePatStore(store, path = PATHS.pats) {
  const clean = normalizePatStore(store);
  await writeEncryptedJsonAsync(path, clean);
  return { ...clean, error: '' };
}

/** 同一区域+uid 的 PAT 视为同一个账号：更新令牌与资料，不新增重复行。 */
export function upsertPat(store, entry) {
  const clean = normalizePatStore(store);
  const next = normalizeEntry({ ...entry, addedAt: Number(entry?.addedAt) || Date.now() });
  if (!next) return clean;
  const index = clean.entries.findIndex((item) => item.id === next.id
    || (item.region === next.region && item.uid && next.uid && item.uid === next.uid));
  if (index >= 0) {
    const previous = clean.entries[index];
    clean.entries[index] = {
      ...next,
      id: previous.id,
      label: next.label || previous.label,
      addedAt: previous.addedAt || next.addedAt,
    };
  } else {
    clean.entries.unshift(next);
    clean.entries = clean.entries.slice(0, MAX_ENTRIES);
  }
  return clean;
}

export function removePat(store, id) {
  const clean = normalizePatStore(store);
  clean.entries = clean.entries.filter((item) => item.id !== String(id || ''));
  return clean;
}

export function findPat(store, id) {
  const wanted = String(id || '');
  return normalizePatStore(store).entries.find((item) => item.id === wanted) || null;
}

export function publicPat(entry, { activeUid = '', activeRegion = '', activeSource = '' } = {}) {
  if (!entry) return null;
  const active = activeSource === 'pat'
    && entry.region === activeRegion
    && Boolean(activeUid)
    && entry.uid === activeUid;
  return {
    id: entry.id,
    region: entry.region,
    regionLabel: REGIONS[entry.region]?.label || entry.region,
    label: entry.label,
    name: entry.name,
    email: entry.email,
    uidTail: entry.uid ? entry.uid.slice(-6) : '',
    addedAt: entry.addedAt,
    lastUsedAt: entry.lastUsedAt,
    active,
  };
}

export function publicPatStore(store, active = {}) {
  const clean = normalizePatStore(store);
  return {
    entries: clean.entries.map((entry) => publicPat(entry, active)).filter(Boolean),
    count: clean.entries.length,
    error: store && typeof store.error === 'string' ? store.error : '',
  };
}
