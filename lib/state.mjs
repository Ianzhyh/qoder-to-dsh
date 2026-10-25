import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { rename as renameAsync, writeFile as writeFileAsync } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULTS, PATHS } from './config.mjs';

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

export function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * 原子写：同目录临时文件 → rename。
 * 进程被杀时最多留下一个 .tmp，不会出现半截 JSON 把偏好读没。
 */
export function writeJson(path, value) {
  ensureDir(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function removeFile(path) {
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

export function isWritableDir(path) {
  try {
    ensureDir(path);
    const probe = `${path}.write-probe`;
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 显示偏好
 * ------------------------------------------------------------------ */

export function normalizePrefs(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const visible = Array.isArray(source.visible)
    ? [...new Set(source.visible.map(String).filter(Boolean))]
    : null;
  const contextWindowByModel = {};
  if (source.contextWindowByModel && typeof source.contextWindowByModel === 'object') {
    for (const [id, value] of Object.entries(source.contextWindowByModel)) {
      const n = Number(value);
      if (id && Number.isSafeInteger(n) && n > 0) contextWindowByModel[id] = n;
    }
  }
  const paramsByModel = {};
  if (source.paramsByModel && typeof source.paramsByModel === 'object') {
    for (const [id, value] of Object.entries(source.paramsByModel)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const out = {};
      if (typeof value.temperature === 'number' && Number.isFinite(value.temperature)) {
        out.temperature = Math.min(2, Math.max(0, value.temperature));
      }
      if (Number.isInteger(value.maxTokens) && value.maxTokens > 0) out.maxTokens = value.maxTokens;
      if (typeof value.reasoningEffort === 'string' && value.reasoningEffort) {
        out.reasoningEffort = value.reasoningEffort;
      }
      if (Object.keys(out).length) paramsByModel[id] = out;
    }
  }
  return {
    visible,
    pinned: typeof source.pinned === 'string' ? source.pinned : '',
    includeAll: source.includeAll !== false,
    contextWindowByModel,
    paramsByModel,
    at: Number(source.at) || 0,
  };
}

export function readPrefs(path = PATHS.prefs) {
  return normalizePrefs(readJson(path, null));
}

export function writePrefs(prefs, path = PATHS.prefs) {
  const clean = normalizePrefs({ ...prefs, at: Date.now() });
  writeJson(path, clean);
  return clean;
}

/* ------------------------------------------------------------------ *
 * 签到
 * ------------------------------------------------------------------ */

const CHECKIN_STATUSES = new Set([
  'claimed', 'already', 'pending', 'unavailable', 'device', 'login', 'error', 'idle',
]);

export function normalizeCheckinResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.key || '').trim();
  if (!key) return null;
  const status = CHECKIN_STATUSES.has(raw.status) ? raw.status : 'idle';
  return {
    key,
    label: String(raw.label || '').slice(0, 80),
    region: raw.region === 'cn' ? 'cn' : 'global',
    kind: String(raw.kind || '').slice(0, 20),
    uidTail: String(raw.uidTail || '').slice(0, 12),
    status,
    credits: Math.max(0, Number(raw.credits) || 0),
    message: String(raw.message || '').slice(0, 240),
    checkedAt: Math.max(0, Number(raw.checkedAt) || 0),
    campaignEndAt: Math.max(0, Number(raw.campaignEndAt) || 0),
  };
}

export function normalizeCheckin(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const results = {};
  if (source.results && typeof source.results === 'object' && !Array.isArray(source.results)) {
    for (const [key, value] of Object.entries(source.results)) {
      const result = normalizeCheckinResult({ ...value, key });
      if (result) results[key] = result;
    }
  }
  return {
    auto: source.auto !== false,
    lastRunAt: Math.max(0, Number(source.lastRunAt) || 0),
    lastAutoAt: Math.max(0, Number(source.lastAutoAt) || 0),
    results,
  };
}

export function readCheckin(path = PATHS.checkin) {
  return normalizeCheckin(readJson(path, null));
}

export function writeCheckin(checkin, path = PATHS.checkin) {
  const clean = normalizeCheckin(checkin);
  writeJson(path, clean);
  return clean;
}

/* ------------------------------------------------------------------ *
 * 用量
 * ------------------------------------------------------------------ */

export function normalizeUsageRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at);
  const promptTokens = Math.max(0, Number(raw.promptTokens) || 0);
  const completionTokens = Math.max(0, Number(raw.completionTokens) || 0);
  if (!Number.isFinite(at) || at <= 0) return null;
  const rawCredits = Math.max(0, Number(raw.credits) || 0);
  const billable = raw.billable === true || raw.billable === false ? raw.billable : undefined;
  const originalCredits = Math.max(rawCredits, Number(raw.originalCredits) || 0);
  let credits = rawCredits;
  let savedCredits = Math.max(0, Number(raw.savedCredits) || 0);
  if (billable === false) {
    savedCredits = Math.max(savedCredits, rawCredits, originalCredits);
    credits = 0;
  } else {
    savedCredits = Math.max(savedCredits, originalCredits - rawCredits);
  }
  return {
    at,
    model: String(raw.model || ''),
    client: String(raw.client || 'unknown').slice(0, 24),
    promptTokens,
    completionTokens,
    totalTokens: Math.max(0, Number(raw.totalTokens) || promptTokens + completionTokens),
    cachedTokens: Math.max(0, Number(raw.cachedTokens) || 0),
    reasoningTokens: Math.max(0, Number(raw.reasoningTokens) || 0),
    credits,
    originalCredits,
    savedCredits,
    ...(billable === undefined ? {} : { billable }),
    latencyMs: Math.max(0, Number(raw.latencyMs) || 0),
    firstByteMs: Math.max(0, Number(raw.firstByteMs) || 0),
    ok: raw.ok !== false,
    status: String(raw.status || ''),
    error: String(raw.error || '').slice(0, 300),
  };
}

/**
 * 旧版本把所有 usage.credits 都当成实扣。免费模型在旧记录里没有 billable 标记，
 * 用当前目录的 free 标记做一次只读归因：不重写文件，只修正对外统计口径。
 */
export function reconcileUsage(records, freeModelIds = []) {
  const free = freeModelIds instanceof Set ? freeModelIds : new Set(freeModelIds || []);
  if (!free.size) return records;
  return (records || []).map((record) => {
    if (!record || record.billable !== undefined || !free.has(record.model)) return record;
    return {
      ...record,
      billable: false,
      credits: 0,
      originalCredits: Math.max(Number(record.originalCredits) || 0, Number(record.credits) || 0),
      savedCredits: Math.max(Number(record.savedCredits) || 0, Number(record.credits) || 0),
    };
  });
}

const usageStates = new Map();
const usageFlushTimers = new Map();
let usageExitHookInstalled = false;
let usageWriteSeq = 0;
let usageWriteChain = Promise.resolve();

function usageStat(path) {
  try {
    const stat = statSync(path);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

/** 进程内缓存：读面板/写记录都不再反复解析整份 usage.json。 */
function loadUsageState(path) {
  const cached = usageStates.get(path);
  if (cached?.dirty) return cached;
  const stat = usageStat(path);
  if (cached
    && cached.exists === stat.exists
    && cached.mtimeMs === stat.mtimeMs
    && cached.size === stat.size) return cached;
  const data = readJson(path, []);
  const records = Array.isArray(data) ? data.map(normalizeUsageRecord).filter(Boolean) : [];
  const state = { path, records, dirty: false, ...stat };
  usageStates.set(path, state);
  return state;
}

const usageJson = (records) => `${JSON.stringify(records)}\n`;

function writeUsageSync(path, records) {
  ensureDir(path);
  const tmp = `${path}.${process.pid}.${++usageWriteSeq}.tmp`;
  writeFileSync(tmp, usageJson(records), { mode: 0o600 });
  renameSync(tmp, path);
}

async function writeUsageAsync(path, records) {
  ensureDir(path);
  const tmp = `${path}.${process.pid}.${++usageWriteSeq}.tmp`;
  await writeFileAsync(tmp, usageJson(records), { mode: 0o600 });
  await renameAsync(tmp, path);
}

function installUsageExitHook() {
  if (usageExitHookInstalled) return;
  usageExitHookInstalled = true;
  process.once('exit', () => {
    for (const state of usageStates.values()) {
      if (!state.dirty) continue;
      try {
        // 测试或显式清理可能已经删掉数据目录；退出时不要把它重新建出来。
        if (!existsSync(dirname(state.path))) continue;
        writeUsageSync(state.path, state.records);
        state.dirty = false;
      } catch { /* 退出阶段尽力而为 */ }
    }
  });
}

function scheduleUsageFlush(path) {
  installUsageExitHook();
  if (usageFlushTimers.has(path)) return;
  const timer = setTimeout(() => {
    usageFlushTimers.delete(path);
    flushUsage(path).catch(() => { /* 保持 dirty，下次 append 或退出时重试 */ });
  }, 20);
  if (timer.unref) timer.unref();
  usageFlushTimers.set(path, timer);
}

/** 立即把内存中的用量合并写入磁盘；测试与正常退出路径使用。 */
export async function flushUsage(path = PATHS.usage) {
  const timer = usageFlushTimers.get(path);
  if (timer) {
    clearTimeout(timer);
    usageFlushTimers.delete(path);
  }
  const state = usageStates.get(path);
  if (!state?.dirty) return;
  const records = state.records;
  // 串行写入：即使两次 flush 交错，最后落盘的也一定是更新的快照。
  const run = () => writeUsageAsync(path, records);
  usageWriteChain = usageWriteChain.then(run, run);
  await usageWriteChain;
  if (usageStates.get(path) !== state) {
    // 写盘期间被 clearUsage 清掉：旧快照可能已经把文件重新建出来，
    // 没有新 state 接管时删掉它，不能让清除操作被一次在途写入抵消。
    if (!usageStates.has(path)) removeFile(path);
    return;
  }
  if (state.records === records) {
    Object.assign(state, usageStat(path));
    state.dirty = false;
  } else {
    scheduleUsageFlush(path);
  }
}

export function readUsage(path = PATHS.usage) {
  return loadUsageState(path).records;
}

export function appendUsage(record, path = PATHS.usage) {
  const clean = normalizeUsageRecord(record);
  const state = loadUsageState(path);
  if (!clean) return state.records;
  const cutoff = Date.now() - DEFAULTS.usageDays * 24 * 3600 * 1000;
  state.records = state.records
    .filter((item) => item.at >= cutoff)
    .concat(clean)
    .slice(-DEFAULTS.usageLimit);
  state.dirty = true;
  scheduleUsageFlush(path);
  return state.records;
}

export function clearUsage(path = PATHS.usage) {
  const timer = usageFlushTimers.get(path);
  if (timer) {
    clearTimeout(timer);
    usageFlushTimers.delete(path);
  }
  usageStates.delete(path);
  removeFile(path);
}

export function localDayKey(value) {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function listDays(start, end) {
  const out = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    out.push(new Date(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

const CREDIT_RANGES = {
  '1d': { label: '今天', days: 1 },
  '7d': { label: '最近 7 天', days: 7 },
  '30d': { label: '最近 30 天', days: 30 },
  mtd: { label: '本月至今' },
  'last-month': { label: '上个月' },
};

function creditRange(key, now) {
  const today = startOfLocalDay(now);
  const preset = CREDIT_RANGES[key] || CREDIT_RANGES['7d'];
  let start;
  let end;
  if (key === 'last-month') {
    const first = new Date(today.getTime());
    first.setDate(1);
    end = new Date(first.getTime());
    end.setDate(0);
    start = new Date(end.getTime());
    start.setDate(1);
  } else if (key === 'mtd') {
    start = new Date(today.getTime());
    start.setDate(1);
    end = today;
  } else {
    start = new Date(today.getTime());
    start.setDate(start.getDate() - (preset.days - 1));
    end = today;
  }
  return { key: CREDIT_RANGES[key] ? key : '7d', label: preset.label, start, end };
}

function blankDays(dates) {
  return dates.map((date) => ({
    date: localDayKey(date.getTime()),
    credits: 0,
    tokens: 0,
    requests: 0,
    failures: 0,
  }));
}

function addGroup(map, key, label, dayCount) {
  if (!map.has(key)) {
    map.set(key, {
      key,
      label,
      credits: 0,
      tokens: 0,
      requests: 0,
      points: Array(dayCount).fill(0),
    });
  }
  return map.get(key);
}

const round4 = (value) => Number((Number(value) || 0).toFixed(4));

/**
 * Credits 报表：range 内的日汇总 + 按模型/客户端的时间序列 + 近一年热力图。
 * 只用本地元数据，不包含 prompt / 回复。
 */
export function creditsReport(records, { now = Date.now(), range = '7d' } = {}) {
  const selected = creditRange(range, now);
  const dates = listDays(selected.start, selected.end);
  const days = blankDays(dates);
  const indexByDate = new Map(days.map((day, index) => [day.date, index]));
  const models = new Map();
  const clients = new Map();
  const totals = { credits: 0, savedCredits: 0, tokens: 0, requests: 0, failures: 0 };

  for (const record of records || []) {
    const index = indexByDate.get(localDayKey(record.at));
    if (index === undefined) continue;
    const day = days[index];
    const credits = Number(record.credits) || 0;
    day.credits += credits;
    day.tokens += record.totalTokens || 0;
    day.requests += 1;
    if (!record.ok) day.failures += 1;
    totals.credits += credits;
    totals.savedCredits += Number(record.savedCredits) || 0;
    totals.tokens += record.totalTokens || 0;
    totals.requests += 1;
    if (!record.ok) totals.failures += 1;
    const model = record.model || '未知模型';
    const client = record.client || 'unknown';
    const modelGroup = addGroup(models, model, model, days.length);
    const clientGroup = addGroup(clients, client, client, days.length);
    modelGroup.credits += credits;
    modelGroup.tokens += record.totalTokens || 0;
    modelGroup.requests += 1;
    modelGroup.points[index] += credits;
    clientGroup.credits += credits;
    clientGroup.tokens += record.totalTokens || 0;
    clientGroup.requests += 1;
    clientGroup.points[index] += credits;
  }

  const finishGroups = (map) => [...map.values()]
    .map((group) => ({
      ...group,
      credits: round4(group.credits),
      points: group.points.map(round4),
    }))
    .filter((group) => group.credits > 0)
    .sort((a, b) => b.credits - a.credits || b.tokens - a.tokens || a.label.localeCompare(b.label, 'zh-CN'));
  for (const day of days) day.credits = round4(day.credits);

  // 热力图取最近 12 个自然月（从 11 个月前的 1 号到今天），
  // 既贴近“近一年”，也避免滚动窗口首尾出现两个同名月份。
  const today = startOfLocalDay(now);
  const heatStart = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  const heatDates = listDays(heatStart, today);
  const heatDays = blankDays(heatDates);
  const heatIndex = new Map(heatDays.map((day, index) => [day.date, index]));
  for (const record of records || []) {
    const index = heatIndex.get(localDayKey(record.at));
    if (index === undefined) continue;
    heatDays[index].credits += Number(record.credits) || 0;
    heatDays[index].tokens += record.totalTokens || 0;
    heatDays[index].requests += 1;
  }
  for (const day of heatDays) day.credits = round4(day.credits);
  const heatmapMax = heatDays.reduce((max, day) => Math.max(max, day.credits), 0);

  return {
    range: {
      key: selected.key,
      label: selected.label,
      from: days[0] ? days[0].date : '',
      to: days[days.length - 1] ? days[days.length - 1].date : '',
      days: days.length,
    },
    totals: {
      credits: round4(totals.credits),
      savedCredits: round4(totals.savedCredits),
      tokens: totals.tokens,
      requests: totals.requests,
      failures: totals.failures,
    },
    days,
    series: {
      model: finishGroups(models),
      client: finishGroups(clients),
    },
    heatmap: {
      from: heatDays[0] ? heatDays[0].date : '',
      to: heatDays[heatDays.length - 1] ? heatDays[heatDays.length - 1].date : '',
      max: round4(heatmapMax),
      totalCredits: round4(heatDays.reduce((sum, day) => sum + day.credits, 0)),
      days: heatDays,
    },
    updatedAt: now,
  };
}

export function summarizeUsage(records, days = 14, now = Date.now()) {
  const dayMs = 24 * 3600 * 1000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayStart = new Date(start.getTime() - i * dayMs);
    const key = localDayKey(dayStart);
    buckets.push({ date: key, requests: 0, tokens: 0, credits: 0, failures: 0 });
  }
  const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
  const todayKey = localDayKey(start);
  const today = { requests: 0, tokens: 0, failures: 0, latencyMs: 0, firstByteMs: 0, credits: 0, savedCredits: 0 };
  const windowStart = start.getTime() - (days - 1) * dayMs;
  const totals = {
    requests: 0, tokens: 0, promptTokens: 0, completionTokens: 0,
    cachedTokens: 0, reasoningTokens: 0, credits: 0, savedCredits: 0, failures: 0,
    latencyMs: 0, firstByteMs: 0,
  };
  const models = new Map();
  for (const item of records || []) {
    const key = localDayKey(item.at);
    const bucket = byDate.get(key);
    if (bucket) {
      bucket.requests += 1;
      bucket.tokens += item.totalTokens;
      bucket.credits += item.credits || 0;
      if (!item.ok) bucket.failures += 1;
    }
    if (key === todayKey) {
      today.requests += 1;
      today.tokens += item.totalTokens;
      if (!item.ok) today.failures += 1;
      today.latencyMs += item.latencyMs;
      today.firstByteMs += item.firstByteMs;
      today.credits += item.credits || 0;
      today.savedCredits += item.savedCredits || 0;
    }
    if (item.at < windowStart) continue;
    totals.requests += 1;
    totals.tokens += item.totalTokens;
    totals.promptTokens += item.promptTokens || 0;
    totals.completionTokens += item.completionTokens || 0;
    totals.cachedTokens += item.cachedTokens || 0;
    totals.reasoningTokens += item.reasoningTokens || 0;
    totals.credits += item.credits || 0;
    totals.savedCredits += item.savedCredits || 0;
    totals.latencyMs += item.latencyMs || 0;
    totals.firstByteMs += item.firstByteMs || 0;
    if (!item.ok) totals.failures += 1;
    const name = item.model || '未知模型';
    const slot = models.get(name) || {
      model: name, requests: 0, tokens: 0, promptTokens: 0, completionTokens: 0,
      cachedTokens: 0, reasoningTokens: 0, credits: 0, savedCredits: 0, failures: 0, latencyMs: 0, firstByteMs: 0,
    };
    slot.requests += 1;
    slot.tokens += item.totalTokens;
    slot.promptTokens += item.promptTokens || 0;
    slot.completionTokens += item.completionTokens || 0;
    slot.cachedTokens += item.cachedTokens || 0;
    slot.reasoningTokens += item.reasoningTokens || 0;
    slot.credits += item.credits || 0;
    slot.savedCredits += item.savedCredits || 0;
    slot.latencyMs += item.latencyMs || 0;
    slot.firstByteMs += item.firstByteMs || 0;
    if (!item.ok) slot.failures += 1;
    models.set(name, slot);
  }
  const success = today.requests - today.failures;
  const rate = (failed, all) => (all ? (all - failed) / all : null);
  const round = (n) => Number(n.toFixed(4));
  for (const bucket of buckets) bucket.credits = round(bucket.credits);
  return {
    days: buckets,
    today: {
      requests: today.requests,
      tokens: today.tokens,
      failures: today.failures,
      credits: round(today.credits),
      savedCredits: round(today.savedCredits),
      avgLatencyMs: today.requests ? Math.round(today.latencyMs / today.requests) : 0,
      avgFirstByteMs: today.requests ? Math.round(today.firstByteMs / today.requests) : 0,
      successRate: today.requests ? success / today.requests : null,
    },
    totals: {
      requests: totals.requests,
      tokens: totals.tokens,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      cachedTokens: totals.cachedTokens,
      reasoningTokens: totals.reasoningTokens,
      credits: round(totals.credits),
      savedCredits: round(totals.savedCredits),
      failures: totals.failures,
      avgLatencyMs: totals.requests ? Math.round(totals.latencyMs / totals.requests) : 0,
      avgFirstByteMs: totals.requests ? Math.round(totals.firstByteMs / totals.requests) : 0,
      successRate: rate(totals.failures, totals.requests),
    },
    byModel: [...models.values()]
      .map((item) => ({
        model: item.model,
        requests: item.requests,
        tokens: item.tokens,
        promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        cachedTokens: item.cachedTokens,
        reasoningTokens: item.reasoningTokens,
        credits: round(item.credits),
        savedCredits: round(item.savedCredits),
        failures: item.failures,
        avgLatencyMs: item.requests ? Math.round(item.latencyMs / item.requests) : 0,
        avgFirstByteMs: item.requests ? Math.round(item.firstByteMs / item.requests) : 0,
        successRate: rate(item.failures, item.requests),
        share: totals.tokens ? item.tokens / totals.tokens : 0,
      }))
      .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests),
    range: { days, from: buckets[0] && buckets[0].date, to: buckets[buckets.length - 1] && buckets[buckets.length - 1].date },
    total: (records || []).length,
  };
}

/* ------------------------------------------------------------------ *
 * 目录缓存
 * ------------------------------------------------------------------ */

export function readCatalogCache(path = PATHS.catalog) {
  const data = readJson(path, null);
  if (!data || !Array.isArray(data.models)) return null;
  return {
    at: Number(data.at) || 0,
    region: String(data.region || ''),
    account: String(data.account || ''),
    schema: Number(data.schema) || 0,
    models: data.models.filter((model) => model && typeof model.id === 'string' && model.id),
  };
}

export function writeCatalogCache(region, models, account = '', path = PATHS.catalog) {
  // account 必须随目录一起落盘：换号后重启不能把上一个账号的目录当成当前缓存。
  writeJson(path, { at: Date.now(), region, account, schema: 5, models });
}

/* ------------------------------------------------------------------ *
 * 运行日志（面板诊断用，不记录对话内容）
 * ------------------------------------------------------------------ */

const logLines = [];
const MAX_LOG = 200;

const REDACTIONS = [
  [/eyJ[A-Za-z0-9._-]{20,}/g, '<token>'],
  [/\b(pt|dt|jt|jrt|drt|jot)-[A-Za-z0-9._-]{8,}/g, '<token>'],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <token>'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export function log(line, detail = '') {
  const text = `${new Date().toISOString()} ${redact(line)}${detail ? ` ${redact(detail)}` : ''}`;
  logLines.push(text);
  if (logLines.length > MAX_LOG) logLines.splice(0, logLines.length - MAX_LOG);
  try {
    ensureDir(PATHS.log);
    appendFileSync(PATHS.log, `${text}\n`);
  } catch { /* 日志失败不能影响主流程 */ }
}

export function recentLogs(limit = 80) {
  return logLines.slice(-limit);
}
