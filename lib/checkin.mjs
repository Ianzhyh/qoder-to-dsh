/**
 * Qoder 每日领取活动。
 *
 * 上游：GET  <oauthBase>/sash/api/v1/me/campaigns
 *       POST <oauthBase>/sash/api/v1/me/campaigns/{id}/claim
 *
 * 活动只对带本机客户端设备头的请求下发；这里复用 umid.mjs 读取的设备身份。
 * 领取接口幂等，重复调用不会重复发币。所有令牌只在内存中使用。
 */
import { REGIONS } from './config.mjs';
import { scanDesktopAuth } from './desktop-auth.mjs';
import { getDeviceIdentity } from './umid.mjs';
import { createLinkedSignal } from './request-guard.mjs';

const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
const CLAIM_PATH = (id) => `/sash/api/v1/me/campaigns/${encodeURIComponent(id)}/claim`;
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const CHECKIN_OPEN_HOUR = 10;
export const CHECKIN_RETRY_MS = 20 * 60 * 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 加购/赠送额度（addOnQuota）的有效期兜底。
 *
 * 接口只给 addOnQuota 的合计余额、不给逐笔到期（官方网页账号页能看，但那是
 * cookie 会话）。同类工具（qoder-account-manager）的口径一致：逐笔到期 =
 * 领取时刻 + benefit.validity.days，活动接口没给时按「每日赠送 30 天」推算，
 * 推算结果必须标注，不能当成官方数字。
 */
export const ADDON_VALIDITY_FALLBACK_DAYS = 30;

export function validityDaysOf(benefit) {
  const box = benefit && typeof benefit === 'object' ? benefit : {};
  const raw = box.validity ?? box.validityDays ?? box.validDays ?? box;
  const value = typeof raw === 'object' && raw ? Number(raw.days ?? raw.day ?? raw.value) : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function beijingDateKey(ts = Date.now()) {
  return new Date(Number(ts) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function beijingHour(ts = Date.now()) {
  return new Date(Number(ts) + BEIJING_OFFSET_MS).getUTCHours();
}

/** 今天（北京时间）10:00 的时间戳；now 已过 10:00 时仍返回今天的 10:00。 */
export function beijingOpenAt(ts = Date.now()) {
  const b = new Date(Number(ts) + BEIJING_OFFSET_MS);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), CHECKIN_OPEN_HOUR) - BEIJING_OFFSET_MS;
}

/**
 * 下一次自动签到应该发生的时间。
 * - 自动签到关闭：0
 * - 今天 10:00 之前：今天 10:00
 * - 10:00 后仍有可自动重试的账号：now（由 lastAutoAt 的 20 分钟节流控制）
 * - 全部处理完 / 只剩缺设备、登录失效：明天 10:00
 */
export function nextRunAt({ auto = true, results = {}, lastAutoAt = 0 } = {}, accounts = [], now = Date.now(), retryMs = CHECKIN_RETRY_MS) {
  if (!auto) return 0;
  if (!Array.isArray(accounts) || !accounts.length) return 0;
  const todayOpen = beijingOpenAt(now);
  const tomorrowOpen = todayOpen + 86400000;
  if (now < todayOpen) return todayOpen;
  const today = beijingDateKey(now);
  const needsUser = new Set(['device', 'login']);
  const pending = (Array.isArray(accounts) ? accounts : []).some((account) => {
    const saved = results && results[account.key];
    if (!saved || beijingDateKey(saved.checkedAt) !== today) return true;
    if (saved.status === 'claimed' || saved.status === 'already') return false;
    return !needsUser.has(saved.status);
  });
  if (!pending) return tomorrowOpen;
  const next = Number(lastAutoAt) > 0 ? Number(lastAutoAt) + Math.max(0, Number(retryMs) || 0) : now;
  return Math.min(Math.max(next, now), tomorrowOpen);
}

export function campaignStartMs(campaign) {
  const value = Number(campaign?.startAt);
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
}

export function campaignEndMs(campaign) {
  const value = Number(campaign?.endAt);
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
}

export function inCampaignWindow(campaign, now = Date.now()) {
  const start = campaignStartMs(campaign);
  const end = campaignEndMs(campaign);
  if (!start && !end) return true;
  if (start && now < start) return false;
  if (end && now >= end) return false;
  return true;
}

export function summarizeCampaigns(payload, now = Date.now()) {
  const campaigns = payload && Array.isArray(payload.campaigns) ? payload.campaigns : [];
  const benefits = campaigns.filter((campaign) => campaign && campaign.actionType === 'CLAIM_BENEFIT');
  const visible = benefits.filter((campaign) => inCampaignWindow(campaign, now));
  const claimable = visible.filter((campaign) => campaign.claimStatus === 'CLAIMABLE');
  const claimed = visible.filter((campaign) => campaign.claimStatus === 'CLAIMED');
  const endAt = visible.reduce((max, campaign) => Math.max(max, campaignEndMs(campaign)), 0);
  return {
    campaigns,
    benefits,
    visible,
    claimable,
    claimed,
    pending: benefits.length > 0 && visible.length > 0 && claimable.length === 0 && claimed.length === 0,
    endAt,
    campaignUrl: String(payload?.campaignUrl || ''),
    showCampaign: payload?.showCampaign !== false,
  };
}

function sourceOf(account) {
  const source = String(account?.source || 'desktop');
  if (source === 'cli') return 'cli';
  if (source === 'oauth') return 'oauth';
  if (source === 'pat' || source === 'token') return 'pat';
  return 'app';
}

function sourceLabel(kind) {
  return { app: '桌面端', cli: 'CLI', oauth: '浏览器授权', pat: 'PAT' }[kind] || '本机登录';
}

/**
 * 当前插件账号 + 本机官方客户端里所有有效账号，按 region+uid 去重。
 * 返回对象包含 token，只供宿主内部签到使用；面板只拿 controller 的公开快照。
 */
export function buildCheckinAccounts({ activeAuth = null, activeRegion = 'global' } = {}) {
  const map = new Map();
  if (activeAuth && (activeAuth.accessToken || activeAuth.refreshToken)) {
    const region = REGIONS[activeAuth.region] ? activeAuth.region : activeRegion;
    const uid = String(activeAuth.user?.id || '');
    const kind = sourceOf(activeAuth);
    const key = `${region}:${uid || 'active'}`;
    map.set(key, {
      key,
      label: String(activeAuth.user?.name || activeAuth.user?.email || `${REGIONS[region].label}账号`),
      region,
      kind,
      sourceLabel: sourceLabel(kind),
      accessToken: String(activeAuth.accessToken || ''),
      refreshToken: String(activeAuth.refreshToken || ''),
      expiresAt: Number(activeAuth.expiresAt) || 0,
      uid,
      uidTail: uid ? uid.slice(-6) : '',
      active: true,
      tokenReady: true,
    });
  }
  for (const candidate of scanDesktopAuth()) {
    if (!candidate.valid) continue;
    const uid = String(candidate.uid || '');
    const key = `${candidate.region}:${uid || `${candidate.kind}:${candidate.file}`}`;
    const existing = map.get(key);
    if (existing && existing.active) continue;
    const prefer = !existing
      || (candidate.kind === 'app' && existing.kind !== 'app')
      || (candidate.kind === existing.kind && (candidate.expiresAt || 0) > (existing.expiresAt || 0));
    if (!prefer) continue;
    map.set(key, {
      key,
      label: String(candidate.nickname || candidate.email || `${candidate.regionLabel}账号`),
      region: candidate.region,
      kind: candidate.kind,
      sourceLabel: sourceLabel(candidate.kind),
      accessToken: String(candidate.accessToken || ''),
      refreshToken: String(candidate.refreshToken || ''),
      file: candidate.file || '',
      expiresAt: Number(candidate.expiresAt) || 0,
      uid,
      uidTail: uid ? uid.slice(-6) : '',
      active: false,
      tokenReady: Boolean(candidate.accessToken || candidate.refreshToken),
    });
  }
  return [...map.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label, 'zh-CN'));
}

const SETTLED_ACTIONS = new Set(['claimed', 'already']);

export function checkinCanClaim(account) {
  return Boolean(account?.tokenReady)
    && Boolean(account?.deviceAvailable)
    && !SETTLED_ACTIONS.has(account?.status)
    && account?.status !== 'waiting';
}

/** 面板摘要。waiting / unavailable 单独计数，不能混进“待领取”或“异常”。 */
export function summarizeCheckinAccounts(accounts = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  const done = list.filter((account) => account.today && SETTLED_ACTIONS.has(account.status));
  return {
    total: list.length,
    done: done.length,
    claimed: done.filter((account) => account.status === 'claimed').length,
    already: done.filter((account) => account.status === 'already').length,
    credits: done.reduce((sum, account) => sum + (Number(account.credits) || 0), 0),
    pending: list.filter((account) => account.status === 'idle').length,
    notOpen: list.filter((account) => account.status === 'pending').length,
    waiting: list.filter((account) => account.status === 'waiting').length,
    unavailable: list.filter((account) => account.status === 'unavailable').length,
    errors: list.filter((account) => ['error', 'device', 'login'].includes(account.status)).length,
  };
}

function parseBody(text) {
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function request(url, { method = 'GET', headers, body, signal = null } = {}) {
  let lastError = null;
  const linked = createLinkedSignal(signal);
  const timer = setTimeout(() => {
    const error = new Error('Qoder 签到接口超时');
    error.code = 'ETIMEDOUT';
    linked.abort(error);
  }, 20_000);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: linked.signal,
        });
        const text = await res.text();
        if (res.status >= 500 && attempt === 0 && !linked.signal.aborted) {
          await delay(500);
          continue;
        }
        return { status: res.status, ok: res.ok, text, data: parseBody(text) };
      } catch (error) {
        lastError = error;
        if (linked.signal.aborted) throw linked.signal.reason || error;
        if (attempt === 0) await delay(500);
      }
    }
    throw lastError || new Error('请求 Qoder 签到接口失败');
  } finally {
    clearTimeout(timer);
    linked.dispose();
  }
}

function claimAmount(payload, campaign) {
  const box = payload && typeof payload.data === 'object' && payload.data ? payload.data : payload;
  const amount = Number(box?.benefit?.amount ?? campaign?.benefit?.amount ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * 查活动并领取。返回结构固定，供 UI 直接展示：
 * { status, credits, message, checkedAt, campaignEndAt, campaignUrl, deviceReady, version }
 */
export async function claimCampaigns({
  region, getToken, refreshToken = null, now = Date.now(), deviceProvider = getDeviceIdentity, signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('签到已取消');
  const targetRegion = region === 'cn' ? 'cn' : 'global';
  const cfg = REGIONS[targetRegion];
  const checkedAt = now;
  let token = typeof getToken === 'function' ? await getToken() : '';
  if (signal?.aborted) throw signal.reason || new Error('签到已取消');
  if (!token) {
    return { status: 'login', credits: 0, message: '尚未登录 Qoder', checkedAt, campaignEndAt: 0, campaignUrl: '', deviceReady: false, version: '' };
  }
  const device = await deviceProvider(targetRegion);
  if (signal?.aborted) throw signal.reason || new Error('签到已取消');
  if (!device.ready) {
    return {
      status: 'device', credits: 0, message: device.reason || '缺少 Qoder 客户端设备身份',
      checkedAt, campaignEndAt: 0, campaignUrl: '', deviceReady: false, version: device.version || '',
    };
  }
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'Qoder/claim',
    authorization: `Bearer ${token}`,
    ...device.headers,
  };
  let campaigns = await request(cfg.oauthBase + CAMPAIGNS_PATH, { headers, signal });
  if (campaigns.status === 401 && typeof refreshToken === 'function') {
    try {
      const next = await refreshToken();
      if (next) {
        token = next;
        headers.authorization = `Bearer ${token}`;
        campaigns = await request(cfg.oauthBase + CAMPAIGNS_PATH, { headers, signal });
      }
    } catch { /* 下面按登录失效处理 */ }
  }
  if (signal?.aborted) throw signal.reason || new Error('签到已取消');
  if (campaigns.status === 401 || campaigns.status === 403) {
    return {
      status: 'login', credits: 0, message: '登录已过期，请打开 Qoder 客户端重新登录',
      checkedAt, campaignEndAt: 0, campaignUrl: '', deviceReady: true, version: device.version || '',
    };
  }
  if (!campaigns.ok || !campaigns.data || typeof campaigns.data !== 'object') {
    return {
      status: 'error',
      credits: 0,
      message: `活动查询失败 HTTP ${campaigns.status}${campaigns.text ? '：' + String(campaigns.text).slice(0, 120) : ''}`,
      checkedAt, campaignEndAt: 0, campaignUrl: '', deviceReady: true, version: device.version || '',
    };
  }

  const summary = summarizeCampaigns(campaigns.data, checkedAt);
  const base = {
    checkedAt,
    campaignEndAt: summary.endAt,
    campaignUrl: summary.campaignUrl,
    deviceReady: true,
    version: device.version || '',
  };
  if (!summary.claimable.length) {
    if (summary.claimed.length) {
      return {
        ...base,
        status: 'already',
        credits: summary.claimed.reduce((sum, campaign) => sum + Number(campaign.benefit?.amount || 0), 0),
        validityDays: validityDaysOf(summary.claimed[0]?.benefit),
        message: '今日已领取',
      };
    }
    if (summary.benefits.length && !summary.visible.length) {
      return { ...base, status: 'pending', credits: 0, message: '活动未在当前时段开放' };
    }
    if (summary.benefits.length) {
      return { ...base, status: 'pending', credits: 0, message: '活动尚未下发，稍后重试' };
    }
    return { ...base, status: 'unavailable', credits: 0, message: '当前没有可领取的签到活动' };
  }

  let credits = 0;
  let claimedCount = 0;
  let validityDays = 0;
  let failures = 0;
  let lastError = '';
  for (const campaign of summary.claimable) {
    if (signal?.aborted) throw signal.reason || new Error('签到已取消');
    const id = String(campaign.campaignId || '');
    if (!id) {
      failures += 1;
      lastError = '活动缺少 campaignId';
      continue;
    }
    let response;
    try {
      response = await request(cfg.oauthBase + CLAIM_PATH(id), { method: 'POST', headers, body: {}, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      failures += 1;
      lastError = String(error?.message || error);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ...base,
        status: 'login',
        credits: 0,
        message: '登录已过期，请打开 Qoder 客户端重新登录',
      };
    }
    const box = response.data && typeof response.data === 'object' && response.data.data
      ? response.data.data
      : response.data;
    const claimed = response.ok && (box?.status === 'CLAIMED' || box?.status === 'ALREADY_CLAIMED');
    if (claimed) {
      claimedCount += 1;
      credits += claimAmount(response.data, campaign);
      if (!validityDays) validityDays = validityDaysOf(campaign?.benefit) || validityDaysOf(box?.benefit);
    } else {
      failures += 1;
      lastError = `HTTP ${response.status}${response.text ? '：' + String(response.text).slice(0, 100) : ''}`;
    }
  }
  if (claimedCount > 0) {
    return {
      ...base,
      status: 'claimed',
      credits,
      validityDays,
      message: credits > 0
        ? (failures ? `部分领取成功，${failures} 个活动失败` : `签到成功 +${credits} Credits`)
        : (failures ? `已领取，另有 ${failures} 个活动失败` : '已领取（本次 0 Credits）'),
    };
  }
  return {
    ...base,
    status: 'error',
    credits: 0,
    message: failures ? `领取失败：${lastError}` : '没有领取到 Credits',
  };
}

/**
 * 把领取账本还原成「按到期分批」的加购额度视图。
 *
 * 口径（与官方网页账号页一致）：
 * - 每次领取算一笔，到期 = 领取时刻 + validity.days（没给 validity 的按
 *   每日赠送默认 30 天推算，并标 inferred，UI 要写明是推算值）；
 * - 消耗按先到期先扣：越旧的批次越先被扣完，剩余余额留在越新的批次里；
 * - 已过期批次的余额作废；
 * - 账本没记到的领取（在 IDE 里领的）合计不出批次余额时，差额单独成一笔
 *   「到期未知」，不假装知道日期。
 */
export function addonBatches({
  ledger = [],
  remaining = 0,
  now = Date.now(),
  fallbackDays = ADDON_VALIDITY_FALLBACK_DAYS,
} = {}) {
  const entries = (Array.isArray(ledger) ? ledger : [])
    .map((item) => {
      const at = Math.max(0, Number(item?.at) || 0);
      const credits = Math.max(0, Number(item?.credits) || 0);
      const exactDays = Number(item?.validityDays) > 0 ? Math.round(Number(item.validityDays)) : 0;
      const days = exactDays || (Number(fallbackDays) > 0 ? Math.round(Number(fallbackDays)) : 0);
      const expiresAt = at > 0 && credits > 0 && days > 0 ? at + days * 86400000 : 0;
      return {
        at,
        credits,
        validityDays: days,
        exact: exactDays > 0,
        inferred: exactDays === 0 && expiresAt > 0,
        expiresAt,
      };
    })
    .filter((item) => item.credits > 0 && item.at > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt || a.at - b.at);

  let unconsumed = Math.max(0, Number(remaining) || 0);
  const usable = [];
  let expiredCredits = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const expired = entry.expiresAt > 0 && entry.expiresAt <= now;
    const batchRemaining = Math.min(entry.credits, unconsumed);
    unconsumed -= batchRemaining;
    if (expired) {
      expiredCredits += batchRemaining;
      continue;
    }
    if (batchRemaining <= 0) continue;
    usable.push({ ...entry, remaining: batchRemaining });
  }
  usable.sort((a, b) => a.expiresAt - b.expiresAt || a.at - b.at);

  const batches = usable.map((item) => ({
    at: item.at,
    credits: item.credits,
    remaining: item.remaining,
    expiresAt: item.expiresAt,
    validityDays: item.validityDays,
    exact: item.exact,
    inferred: item.inferred,
    expired: false,
  }));
  // 账本没覆盖到的余额（在 IDE 里领的）：单列一笔到期未知，不编日期。
  const untracked = Math.max(0, Math.min(unconsumed, Number(remaining) || 0));
  if (untracked > 0) {
    batches.push({
      at: 0,
      credits: untracked,
      remaining: untracked,
      expiresAt: 0,
      validityDays: 0,
      exact: false,
      inferred: false,
      expired: false,
      untracked: true,
    });
  }
  const nextExpiry = batches.find((batch) => batch.expiresAt > 0)?.expiresAt || 0;
  return {
    batches,
    expiredCredits,
    totalRemaining: batches.reduce((sum, batch) => sum + batch.remaining, 0),
    nextExpiry,
    fallbackDays: Number(fallbackDays) || 0,
  };
}
