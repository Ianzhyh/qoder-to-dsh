/**
 * 账号展示偏好：别名、顺序、隐藏。
 *
 * 只保存展示元数据，不保存任何令牌；账号本身仍由 desktop-auth / checkin 的
 * 只读扫描得到。账号键与签到共用 `${region}:${uid || 来源}`，切换、隐藏、
 * 签到结果因此能对齐到同一个账号。
 */
import { PATHS } from './config.mjs';
import { readJson, writeJson } from './state.mjs';

const SCHEMA_VERSION = 1;
const MAX_ALIAS = 24;
const MAX_ENTRIES = 200;
const MAX_KNOWN = 60;

export function normalizeAlias(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ALIAS);
}

export function accountKeyOf(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.key) return String(row.key);
  const region = row.region === 'cn' ? 'cn' : 'global';
  const uid = String(row.uid || '');
  if (uid) return `${region}:${uid}`;
  const email = String(row.email || '');
  if (email) return `${region}:email:${email}`;
  return `${region}:${row.kind || 'unknown'}:${row.file || row.label || ''}`;
}

/**
 * 已见账号的快照（只存展示元数据，不含任何令牌）。
 *
 * 官方客户端同一区域只保留一份登录态：再登录一个账号会覆盖上一份，
 * 桌面端扫描立刻少一行。有了这份快照，列表不会因为上游覆盖而突然变短，
 * 而是把缺失账号标成「需重新登录」。这是账号存储，不是令牌存储。
 */
function normalizeKnown(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list.slice(0, MAX_KNOWN) : []) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      region: item.region === 'cn' ? 'cn' : 'global',
      uid: String(item.uid || ''),
      label: String(item.label || '').slice(0, 80),
      kind: String(item.kind || ''),
      sourceLabel: String(item.sourceLabel || ''),
      file: String(item.file || ''),
      expiresAt: Number(item.expiresAt) || 0,
      seenAt: Number(item.seenAt) || 0,
    });
  }
  return out;
}

export function normalizeAccounts(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const aliases = {};
  if (source.aliases && typeof source.aliases === 'object' && !Array.isArray(source.aliases)) {
    for (const [key, value] of Object.entries(source.aliases).slice(0, MAX_ENTRIES)) {
      const alias = normalizeAlias(value);
      if (key && alias) aliases[String(key)] = alias;
    }
  }
  const order = [];
  const seen = new Set();
  if (Array.isArray(source.order)) {
    for (const key of source.order) {
      const value = String(key || '');
      if (!value || seen.has(value)) continue;
      seen.add(value);
      order.push(value);
      if (order.length >= MAX_ENTRIES) break;
    }
  }
  const hidden = {};
  const hiddenSource = source.hidden;
  if (Array.isArray(hiddenSource)) {
    for (const key of hiddenSource.slice(0, MAX_ENTRIES)) {
      if (key) hidden[String(key)] = true;
    }
  } else if (hiddenSource && typeof hiddenSource === 'object') {
    for (const [key, value] of Object.entries(hiddenSource).slice(0, MAX_ENTRIES)) {
      if (value === true) hidden[String(key)] = true;
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    aliases,
    order,
    hidden,
    known: normalizeKnown(source.known),
    current: typeof source.current === 'string' ? source.current : '',
  };
}

export function readAccounts(path = PATHS.accounts) {
  return normalizeAccounts(readJson(path, null));
}

export function writeAccounts(value, path = PATHS.accounts) {
  const clean = normalizeAccounts(value);
  writeJson(path, clean);
  return clean;
}

/** 合并一次面板提交；未提交的字段保持原值。 */
export function mergeAccounts(current, patch = {}) {
  const base = normalizeAccounts(current);
  const next = {
    ...base,
    aliases: { ...base.aliases },
    order: [...base.order],
    hidden: { ...base.hidden },
  };
  if (patch.restoreAll === true) next.hidden = {};
  if (patch.aliases && typeof patch.aliases === 'object' && !Array.isArray(patch.aliases)) {
    for (const [key, value] of Object.entries(patch.aliases).slice(0, MAX_ENTRIES)) {
      const alias = normalizeAlias(value);
      if (!key) continue;
      if (alias) next.aliases[String(key)] = alias;
      else delete next.aliases[String(key)];
    }
  }
  if (Array.isArray(patch.order)) {
    const seen = new Set();
    const order = [];
    for (const key of patch.order) {
      const value = String(key || '');
      if (!value || seen.has(value)) continue;
      seen.add(value);
      order.push(value);
    }
    for (const key of base.order) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    next.order = order.slice(0, MAX_ENTRIES);
  }
  if (patch.hidden && typeof patch.hidden === 'object' && !Array.isArray(patch.hidden)) {
    for (const [key, value] of Object.entries(patch.hidden).slice(0, MAX_ENTRIES)) {
      if (!key) continue;
      if (value === true) next.hidden[String(key)] = true;
      else if (value === false || value === null) delete next.hidden[String(key)];
    }
  }
  if (typeof patch.current === 'string') next.current = patch.current;
  return normalizeAccounts(next);
}

function decorated(row, prefs) {
  const key = accountKeyOf(row);
  return {
    ...row,
    key,
    alias: prefs.aliases[key] || '',
    hidden: Boolean(prefs.hidden[key]),
    displayName: prefs.aliases[key] || row.label || row.nickname || row.email || key,
  };
}

/**
 * 按用户顺序排列；没进 order 的新账号排在后面（当前账号优先、再按到期时间）。
 * 当前账号即使被隐藏也留在可见区并带 hidden 标记，避免“隐藏后当前账号消失”。
 */
export function applyAccountPrefs(rows = [], prefs = {}) {
  const normalized = normalizeAccounts(prefs);
  const order = new Map(normalized.order.map((key, index) => [key, index]));
  const all = rows.map((row) => decorated(row, normalized));
  all.sort((a, b) => {
    const left = order.has(a.key) ? order.get(a.key) : Number.MAX_SAFE_INTEGER;
    const right = order.has(b.key) ? order.get(b.key) : Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    if (left === Number.MAX_SAFE_INTEGER) {
      const active = Number(Boolean(b.active)) - Number(Boolean(a.active));
      if (active) return active;
      const expiry = (Number(b.expiresAt) || 0) - (Number(a.expiresAt) || 0);
      if (expiry) return expiry;
    }
    return String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-CN');
  });
  const visible = [];
  const hidden = [];
  for (const row of all) {
    if (row.hidden && !row.active) hidden.push(row);
    else visible.push(row);
  }
  return { visible, hidden, all };
}

export function publicAccountRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    key: row.key,
    label: row.label,
    displayName: row.displayName || row.alias || row.label,
    alias: row.alias || '',
    region: row.region,
    regionLabel: row.regionLabel || '',
    kind: row.kind,
    sourceLabel: row.sourceLabel || '',
    file: row.file || '',
    uid: row.uid || '',
    uidTail: row.uidTail || '',
    email: row.email || '',
    expiresAt: Number(row.expiresAt) || 0,
    active: row.active === true,
    tokenReady: row.tokenReady === true,
    hidden: row.hidden === true,
    missing: row.missing === true,
    sources: Array.isArray(row.sources) ? row.sources : undefined,
  };
}

/**
 * 把本轮扫描到的账号写进快照，并把「以前见过、这次没扫到」的账号补回列表。
 * 后者只作为可见占位（tokenReady=false, missing=true），用于解释少账号的原因，
 * 不参与签到，也不会被当成可用凭据。
 */
export function syncKnownAccounts(rows = [], prefs = {}, now = Date.now()) {
  const base = normalizeAccounts(prefs);
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map(base.known.map((item) => [item.key, item]));
  const present = new Set();
  let changed = false;

  for (const row of list) {
    const key = accountKeyOf(row);
    if (!key) continue;
    present.add(key);
    const prev = byKey.get(key);
    const next = {
      key,
      region: row.region === 'cn' ? 'cn' : 'global',
      uid: String(row.uid || ''),
      label: String(row.label || '').slice(0, 80),
      kind: String(row.kind || ''),
      sourceLabel: String(row.sourceLabel || ''),
      file: String(row.file || ''),
      expiresAt: Number(row.expiresAt) || 0,
      seenAt: now,
    };
    if (!prev
      || prev.label !== next.label
      || prev.kind !== next.kind
      || prev.file !== next.file
      || prev.expiresAt !== next.expiresAt
      || prev.uid !== next.uid) changed = true;
    byKey.set(key, next);
  }

  const merged = [...list];
  for (const item of byKey.values()) {
    if (present.has(item.key)) continue;
    merged.push({
      key: item.key,
      label: item.label || item.key,
      region: item.region,
      kind: item.kind || 'known',
      sourceLabel: item.sourceLabel || '历史账号',
      accessToken: '',
      refreshToken: '',
      file: item.file,
      expiresAt: item.expiresAt,
      uid: item.uid,
      uidTail: item.uid ? item.uid.slice(-6) : '',
      active: false,
      tokenReady: false,
      missing: true,
    });
  }

  const known = [...byKey.values()].slice(-MAX_KNOWN);
  return {
    rows: merged,
    state: { ...base, known },
    changed: changed || known.length !== base.known.length,
  };
}
