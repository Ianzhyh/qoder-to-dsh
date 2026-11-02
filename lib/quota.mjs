/**
 * 额度归一化。
 *
 * 上游当前是 `userQuota` + `addOnQuota` 两个桶（2026-11-02 实测，见
 * tests/fixtures/quota-observations.json）。这里同时兼容未来可能出现的
 * `quotas/packages/items` 数组，并把「同名不同到期日」「不限量」统一成
 * 面板可以直接渲染的结构；字段缺失时如实留空，不猜数字。
 */
const NEVER_EXPIRES_MS = Date.UTC(2100, 0, 1);

export function isNeverExpires(value) {
  const at = Number(value) || 0;
  return !at || at >= NEVER_EXPIRES_MS;
}

export function isUnlimitedQuota(value) {
  if (value === true) return true;
  if (value == null) return false;
  if (typeof value === 'object') return value.unlimited === true || Number(value.total) < 0;
  return Number(value) < 0;
}

function num(value) {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

function finite(value, fallback = 0) {
  const n = num(value);
  return Number.isFinite(n) ? n : fallback;
}

function packageOf(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const total = num(raw.total ?? raw.limitNum ?? raw.limit ?? raw.quota);
  const used = num(raw.used ?? raw.credit ?? raw.usedQuota);
  const remaining = num(raw.remaining ?? raw.balance ?? raw.left);
  if (total === null && used === null && remaining === null) return null;
  const unlimited = raw.unlimited === true || (total !== null && total < 0);
  const expiresAt = isNeverExpires(raw.expiresAt ?? raw.expireAt ?? raw.end_date ?? raw.endDate)
    ? 0
    : Number(raw.expiresAt ?? raw.expireAt ?? raw.end_date ?? raw.endDate);
  const remainingKnown = remaining !== null || unlimited;
  return {
    id: String(raw.id || raw.key || defaults.id || ''),
    name: String(raw.name || raw.title || raw.packageName || defaults.name || '额度'),
    source: String(raw.source || defaults.source || ''),
    total: unlimited ? -1 : Math.max(0, total ?? 0),
    used: Math.max(0, used ?? 0),
    remaining: unlimited ? -1 : Math.max(0, remaining ?? 0),
    remainingKnown,
    unit: String(raw.unit || defaults.unit || 'credits'),
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
    unlimited,
  };
}

/** 同名 + 同到期日的包合并；到期日由近到远，无到期日排最后。 */
export function groupPackages(packages = []) {
  const groups = new Map();
  const order = [];
  for (const item of packages) {
    if (!item) continue;
    const key = `${item.name}\u0000${item.expiresAt || 0}\u0000${item.unit || ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: item.name,
        expiresAt: item.expiresAt || 0,
        unit: item.unit || 'credits',
        unlimited: false,
        total: 0,
        used: 0,
        remaining: 0,
        packages: [],
      };
      groups.set(key, group);
      order.push(group);
    }
    group.packages.push(item.id || item.source || item.name);
    if (item.unlimited) {
      group.unlimited = true;
      group.total = -1;
      group.remaining = -1;
    }
    group.used += Math.max(0, Number(item.used) || 0);
    if (!group.unlimited) {
      group.total += Math.max(0, Number(item.total) || 0);
      group.remaining += Math.max(0, Number(item.remaining) || 0);
    }
  }
  return order.sort((a, b) => {
    const left = a.expiresAt || Number.MAX_SAFE_INTEGER;
    const right = b.expiresAt || Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

/**
 * @param {object} rawQuota 上游 /api/v2/quota/usage 响应
 * @param {object} options { plan, auth, at, now, http:{ plan, quota } }
 */
export function normalizeQuota(rawQuota, { plan = null, auth = null, at = 0, now = Date.now(), http = {} } = {}) {
  if (!rawQuota || typeof rawQuota !== 'object' || Array.isArray(rawQuota)) return null;
  const planName = String(plan?.plan_tier_name || plan?.planName || plan?.name || '').trim();
  const quotaExpiry = isNeverExpires(rawQuota.expiresAt) ? 0 : Number(rawQuota.expiresAt) || 0;
  const packages = [];
  const push = (item) => { if (item) packages.push(item); };

  push(packageOf(rawQuota.userQuota, { id: 'plan', name: '套餐额度', source: 'userQuota' }));
  push(packageOf(rawQuota.addOnQuota, { id: 'addon', name: '加量包', source: 'addOnQuota' }));

  for (const key of ['quotas', 'packages', 'items']) {
    const list = rawQuota[key];
    if (!Array.isArray(list)) continue;
    for (const [index, item] of list.entries()) {
      push(packageOf(item, { id: `${key}:${index}`, source: key }));
    }
  }

  // 极少数响应直接把 total/remaining 放在顶层；只在没有任何包时兜底。
  if (!packages.length) {
    push(packageOf(rawQuota, { id: 'quota', name: planName || '额度', source: 'top' }));
  }

  const unlimited = packages.some((item) => item.unlimited) || isUnlimitedQuota(rawQuota);
  for (const item of packages) {
    const ms = item.expiresAt > 0 ? item.expiresAt - now : null;
    item.daysToExpiry = ms === null ? null : Math.floor(ms / 86400000);
    item.expiringSoon = ms !== null && ms > 0 && ms <= 7 * 86400000;
    item.expired = ms !== null && ms <= 0;
  }
  const totals = { total: 0, used: 0, remaining: 0 };
  for (const item of packages) {
    totals.used += Math.max(0, item.used || 0);
    if (item.unlimited) continue;
    totals.total += Math.max(0, item.total || 0);
    totals.remaining += Math.max(0, item.remaining || 0);
  }
  const ratioRaw = totals.total > 0
    ? totals.used / totals.total
    : Number(rawQuota.totalUsagePercentage);
  const ratio = unlimited ? 0 : Math.min(1, Math.max(0, Number.isFinite(ratioRaw) ? ratioRaw : 0));
  const expiresAt = quotaExpiry || (isNeverExpires(plan?.end_date) ? 0 : Number(plan?.end_date) || 0);
  const expiryMs = expiresAt > 0 ? expiresAt - now : null;
  const daysToExpiry = expiryMs === null ? null : Math.floor(expiryMs / 86400000);
  const expiringSoon = expiryMs !== null && expiryMs > 0 && expiryMs <= 7 * 86400000;
  const expired = expiryMs !== null && expiryMs <= 0;
  const warnings = [];
  const authUid = String(auth?.user?.id || '');
  const quotaUid = String(rawQuota.userId || rawQuota.user_id || '');
  if (authUid && quotaUid && authUid !== quotaUid) {
    warnings.push({ code: 'accountMismatch', params: { quotaUid: quotaUid.slice(-6), authUid: authUid.slice(-6) } });
  }
  if (Number(http.quota) === 404 || Number(http.quota) === 405) {
    warnings.push({ code: 'oldBuild', params: { status: Number(http.quota) } });
  }
  if (!packages.length) warnings.push({ code: 'empty', params: {} });
  if (at > 0 && now - at > 5 * 60_000) warnings.push({ code: 'stale', params: { minutes: Math.round((now - at) / 60_000) } });

  return {
    at: Number(at) || 0,
    planName,
    planPaid: plan?.is_paid_plan === true,
    planEnd: isNeverExpires(plan?.end_date) ? 0 : Number(plan?.end_date) || 0,
    expiresAt,
    daysToExpiry,
    expiringSoon,
    expired,
    unlimited,
    exceeded: rawQuota.isQuotaExceeded === true,
    ratio,
    usagePercent: Number(rawQuota.totalUsagePercentage) || 0,
    totals,
    packages,
    groups: groupPackages(packages),
    detailUrl: String(rawQuota.detailUrl || rawQuota.addOnQuota?.detailUrl || ''),
    upgradeUrl: String(rawQuota.upgradeUrl || ''),
    warnings,
  };
}

/** 诊断/额度卡共用的短结论；缺失数据是 warn，不是 pass。 */
export function quotaSummaryText(view) {
  if (!view) return '';
  if (!view.packages?.length) return '上游没有返回可用额度字段';
  if (view.unlimited) return `不限量${view.totals.used ? ` · 已用 ${view.totals.used}` : ''}`;
  const unknownRemaining = view.packages.some((item) => !item.unlimited && item.remainingKnown === false);
  if (view.totals.total > 0) {
    return unknownRemaining
      ? `总量 ${view.totals.total}，剩余未知`
      : `剩余 ${view.totals.remaining} / ${view.totals.total}`;
  }
  if (view.usagePercent > 0) return `已用 ${Math.round(view.usagePercent * 100)}%（上游未返回总量）`;
  return '上游没有返回可用额度字段';
}
