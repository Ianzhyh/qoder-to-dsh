/**
 * 额度归一化。
 *
 * 上游当前是 `userQuota` + `addOnQuota` 两个桶（2026-11-02 实测，见
 * tests/fixtures/quota-observations.json）。这里同时兼容未来可能出现的
 * `quotas/packages/items` 数组，并把「同名不同到期日」「不限量」统一成
 * 面板可以直接渲染的结构；字段缺失时如实留空，不猜数字。
 */
const NEVER_EXPIRES_MS = Date.UTC(2100, 0, 1);

/**
 * 上游到期时间的三种写法都见过：毫秒 epoch、秒 epoch（早期额度接口）、
 * ISO 字符串（新版 me/usage 的 dedicatedResourcePackages）。统一成毫秒；
 * 2100 年以后一律视为「不限期」——上游用 253402214400000（9999 年）表示永久。
 */
export function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  let ms = 0;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value);
    ms = Number.isFinite(parsed) ? parsed : 0;
  } else {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // 秒级 epoch 落在 1e9~1e11（2001–5138 年）；毫秒级约 1.7e12。
    // 小于 1e9 的数值只可能是测试/占位的毫秒值，不再乘 1000。
    ms = n >= 1e9 && n < 1e11 ? n * 1000 : n;
  }
  if (!ms || ms <= 0) return 0;
  return ms >= NEVER_EXPIRES_MS ? 0 : ms;
}

export function isNeverExpires(value) {
  return toEpochMs(value) === 0;
}

/**
 * 到期字段的三态，不能混为一谈：
 * - `{ at: 时间戳 }` 上游给了具体日期；
 * - `{ never: true }` 上游明确给的是「永久」哨兵（9999 年）；
 * - `{}` 上游根本没给这个字段。
 * 旧实现把后两者都折成 0，界面于是把「没给」说成「不限期」——这是错的。
 */
function expiryOf(...values) {
  let seen = false;
  let never = false;
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    seen = true;
    const at = toEpochMs(value);
    if (at > 0) return { at, known: true, never: false };
    const numeric = typeof value === 'string' && !/^\d+$/.test(value.trim())
      ? Date.parse(value)
      : Number(value);
    if (Number.isFinite(numeric) && numeric >= NEVER_EXPIRES_MS) never = true;
    // 当前字段解析不出日期（0 / 非法）时继续看下一个别名，不要一票否决。
  }
  return { at: 0, known: seen, never };
}

export function isUnlimitedQuota(value) {
  if (value === true) return true;
  if (value == null) return false;
  if (typeof value === 'object') return value.unlimited === true || Number(value.total) < 0;
  return Number(value) < 0;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  // `Number('1,200')` / `Number('abc')` 都是 NaN；旧实现把它当有效值继续算，
  // 于是 packages[].total 变成 NaN，额度卡显示成 “NaN / NaN”。
  return Number.isFinite(n) ? n : null;
}

function finite(value, fallback = 0) {
  const n = num(value);
  return Number.isFinite(n) ? n : fallback;
}

function packageOf(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const total = num(raw.total ?? raw.limitNum ?? raw.limit ?? raw.quota ?? raw.cap);
  const used = num(raw.used ?? raw.credit ?? raw.usedQuota);
  const remaining = num(raw.remaining ?? raw.balance ?? raw.left);
  if (total === null && used === null && remaining === null) return null;
  const unlimited = raw.unlimited === true || (total !== null && total < 0);
  const expiry = expiryOf(raw.expiresAt, raw.expires_at, raw.expireAt, raw.expire_at,
    raw.end_date, raw.endDate, raw.expiryDate, raw.expiry_date);
  const remainingKnown = remaining !== null || unlimited;
  return {
    id: String(raw.id || raw.key || defaults.id || ''),
    name: String(raw.name || raw.title || raw.packageName || defaults.name || '额度'),
    description: String(raw.description || defaults.description || ''),
    source: String(raw.source || defaults.source || ''),
    status: String(raw.status || defaults.status || ''),
    total: unlimited ? -1 : Math.max(0, total ?? 0),
    used: Math.max(0, used ?? 0),
    remaining: unlimited ? -1 : Math.max(0, remaining ?? 0),
    remainingKnown,
    unit: String(raw.unit || defaults.unit || 'credits'),
    expiresAt: expiry.at || 0,
    expiresKnown: expiry.known,
    neverExpires: expiry.never,
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
        expiresKnown: item.expiresKnown === true,
        neverExpires: item.neverExpires === true,
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
    group.expiresKnown = group.expiresKnown || item.expiresKnown === true;
    group.neverExpires = group.neverExpires || (item.neverExpires === true && !group.expiresAt);
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
  // 新版 me/usage 外面套了一层 { displayMode, qoderUsage }；直接传原始响应也能用。
  if (rawQuota.qoderUsage && typeof rawQuota.qoderUsage === 'object' && !Array.isArray(rawQuota.qoderUsage)) {
    rawQuota = rawQuota.qoderUsage;
  }
  const planName = String(plan?.plan_tier_name || plan?.planName || plan?.name || '').trim();
  const quotaExpiry = expiryOf(rawQuota.expiresAt, rawQuota.expires_at);
  const packages = [];
  const push = (item) => { if (item) packages.push(item); };

  // 新版 /api/v2/me/usage 与旧 /api/v2/quota/usage 的桶名大小写不同，两种都认。
  const userBucket = rawQuota.userQuota ?? rawQuota.user_quota;
  const addOnBucket = rawQuota.addOnQuota ?? rawQuota.add_on_quota;
  push(packageOf(userBucket, { id: 'plan', name: '套餐额度', source: 'userQuota' }));
  push(packageOf(addOnBucket, { id: 'addon', name: '加量包', source: 'addOnQuota' }));
  // 企业版/教育版不走个人 userQuota：余额在 orgResourcePackage（cap/used/remaining），
  // 漏掉它会让企业账号显示“上游没有返回可用额度字段”。
  const org = rawQuota.orgResourcePackage ?? rawQuota.org_resource_package
    ?? rawQuota.sharedQuota ?? rawQuota.shared_quota;
  if (org && typeof org === 'object') {
    push(packageOf({
      name: '企业额度',
      total: org.cap ?? org.total,
      used: org.used,
      remaining: org.remaining,
      unit: org.unit,
      expiresAt: org.expiresAt ?? org.expires_at,
      unlimited: Number(org.cap) < 0,
    }, { id: 'enterprise', name: '企业额度', source: 'orgResourcePackage' }));
  }
  // 资源包（活动/加量/专属包）：唯一稳定带到期时间的桶，官方客户端也按包展示。
  const dedicated = rawQuota.dedicatedResourcePackages ?? rawQuota.dedicated_resource_packages;
  if (Array.isArray(dedicated)) {
    for (const [index, item] of dedicated.entries()) {
      if (!item || typeof item !== 'object') continue;
      const total = num(item.total ?? item.cap);
      const used = num(item.used);
      const remaining = num(item.remaining);
      // 官方客户端会丢掉 total≤0 且没有任何数量的条目，这里保持一致。
      if (!(total > 0) && !(used > 0) && !(remaining > 0)) continue;
      push(packageOf(item, {
        id: String(item.id || `dedicated:${index}`),
        name: String(item.name || item.description || `资源包 ${index + 1}`),
        source: 'dedicated',
      }));
    }
  }

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
  const planExpiry = expiryOf(plan?.end_date);
  const expiresAt = quotaExpiry.at || planExpiry.at || 0;
  const expiresKnown = quotaExpiry.known || planExpiry.known;
  // 「不限期」只有在每一份还有余额的额度都明确永久时才成立；
  // 只要有一个包上游没给到期字段，就不能替它宣布永久。
  const expiryIncomplete = packages.some((item) => !item.expiresAt && !item.neverExpires
    && (item.unlimited || item.total > 0 || item.remaining > 0));
  const neverExpires = !expiresAt && !expiryIncomplete && (quotaExpiry.never || planExpiry.never);
  const expiryMs = expiresAt > 0 ? expiresAt - now : null;
  const daysToExpiry = expiryMs === null ? null : Math.floor(expiryMs / 86400000);
  const expiringSoon = expiryMs !== null && expiryMs > 0 && expiryMs <= 7 * 86400000;
  const expired = expiryMs !== null && expiryMs <= 0;
  // 「最近要到期的时间」：优先取最靠前的包到期日，其次顶层到期日。
  // 官方额度页就是这么排序的：包按到期由近到远，第一个就是下一次要过期的。
  let nextExpiry = 0;
  let nextExpiryName = '';
  for (const item of packages) {
    if (!item.expiresAt || item.expired) continue;
    if (!nextExpiry || item.expiresAt < nextExpiry) {
      nextExpiry = item.expiresAt;
      nextExpiryName = item.name;
    }
  }
  if (!nextExpiry && expiresAt > now) {
    nextExpiry = expiresAt;
    nextExpiryName = planName || '套餐额度';
  }
  for (const item of packages) {
    if (item.expiresAt === nextExpiry) item.next = true;
  }
  const nextDays = nextExpiry > 0 ? Math.floor((nextExpiry - now) / 86400000) : null;
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
    planEnd: toEpochMs(plan?.end_date),
    expiresAt,
    expiresKnown,
    expiryIncomplete,
    neverExpires,
    daysToExpiry,
    expiringSoon,
    expired,
    nextExpiry,
    nextExpiryName,
    nextExpiryDays: nextDays,
    nextExpirySoon: nextDays !== null && nextDays >= 0 && nextDays <= 7,
    unlimited,
    exceeded: rawQuota.isQuotaExceeded === true,
    ratio,
    usagePercent: Number(rawQuota.totalUsagePercentage) || 0,
    totals,
    packages,
    groups: groupPackages(packages),
    detailUrl: String(rawQuota.detailUrl || addOnBucket?.detailUrl || addOnBucket?.detail_url || ''),
    upgradeUrl: String(rawQuota.upgradeUrl || rawQuota.upgrade_url || ''),
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
