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

const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
const CLAIM_PATH = (id) => `/sash/api/v1/me/campaigns/${encodeURIComponent(id)}/claim`;
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function beijingDateKey(ts = Date.now()) {
  return new Date(Number(ts) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function beijingHour(ts = Date.now()) {
  return new Date(Number(ts) + BEIJING_OFFSET_MS).getUTCHours();
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
    && !['waiting', 'unavailable'].includes(account?.status);
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

async function request(url, { method = 'GET', headers, body } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (res.status >= 500 && attempt === 0) {
        await delay(500);
        continue;
      }
      return { status: res.status, ok: res.ok, text, data: parseBody(text) };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await delay(500);
    }
  }
  throw lastError || new Error('请求 Qoder 签到接口失败');
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
  region, getToken, refreshToken = null, now = Date.now(), deviceProvider = getDeviceIdentity,
}) {
  const targetRegion = region === 'cn' ? 'cn' : 'global';
  const cfg = REGIONS[targetRegion];
  const checkedAt = now;
  let token = typeof getToken === 'function' ? await getToken() : '';
  if (!token) {
    return { status: 'login', credits: 0, message: '尚未登录 Qoder', checkedAt, campaignEndAt: 0, campaignUrl: '', deviceReady: false, version: '' };
  }
  const device = await deviceProvider(targetRegion);
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
  let campaigns = await request(cfg.oauthBase + CAMPAIGNS_PATH, { headers });
  if (campaigns.status === 401 && typeof refreshToken === 'function') {
    try {
      const next = await refreshToken();
      if (next) {
        token = next;
        headers.authorization = `Bearer ${token}`;
        campaigns = await request(cfg.oauthBase + CAMPAIGNS_PATH, { headers });
      }
    } catch { /* 下面按登录失效处理 */ }
  }
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
  let failures = 0;
  let lastError = '';
  for (const campaign of summary.claimable) {
    const id = String(campaign.campaignId || '');
    if (!id) {
      failures += 1;
      lastError = '活动缺少 campaignId';
      continue;
    }
    let response;
    try {
      response = await request(cfg.oauthBase + CLAIM_PATH(id), { method: 'POST', headers, body: {} });
    } catch (error) {
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
    if (claimed) credits += claimAmount(response.data, campaign);
    else {
      failures += 1;
      lastError = `HTTP ${response.status}${response.text ? '：' + String(response.text).slice(0, 100) : ''}`;
    }
  }
  if (credits > 0) {
    return {
      ...base,
      status: 'claimed',
      credits,
      message: failures ? `部分领取成功，${failures} 个活动失败` : `签到成功 +${credits} Credits`,
    };
  }
  return {
    ...base,
    status: 'error',
    credits: 0,
    message: failures ? `领取失败：${lastError}` : '没有领取到 Credits',
  };
}
