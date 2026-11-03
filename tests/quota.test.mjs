import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupPackages, isNeverExpires, normalizeQuota, quotaSummaryText } from '../lib/quota.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'quota-observations.json'), 'utf8'));

test('normalizes the observed two-bucket responses', () => {
  const global = normalizeQuota(fixture.global.quota, {
    plan: fixture.global.plan,
    auth: { user: { id: 'user-global' } },
    at: 1_793_611_670_000,
    now: 1_793_611_670_000,
  });
  assert.equal(global.planName, 'Pro Trial');
  assert.equal(global.packages.length, 2);
  assert.equal(global.totals.total, 1800);
  assert.equal(global.totals.remaining, 352);
  assert.equal(global.totals.used, 1448);
  assert.equal(global.unlimited, false);
  assert.equal(global.exceeded, false);
  assert.equal(global.expiresAt, 1793625334967);
  assert.equal(global.detailUrl, 'https://qoder.com/account/usage');
  assert.equal(global.warnings.length, 0);

  const cn = normalizeQuota(fixture.cn.quota, {
    plan: fixture.cn.plan,
    auth: { user: { id: 'user-cn' } },
    at: 1_793_611_670_000,
    now: 1_793_611_670_000,
  });
  assert.equal(cn.planName, 'Free');
  assert.equal(cn.totals.total, 1300);
  assert.equal(cn.totals.remaining, 1072);
  assert.equal(cn.expiresAt, 0, '9999 年到期视为不限期');
  assert.equal(cn.planEnd, 0);
});

test('unlimited and negative totals never leak a fake balance', () => {
  const view = normalizeQuota({
    isQuotaExceeded: false,
    userQuota: { total: -1, used: 42, remaining: -1, unit: 'credits' },
  });
  assert.equal(view.unlimited, true);
  assert.equal(view.totals.total, 0);
  assert.equal(view.totals.remaining, 0);
  assert.equal(view.packages[0].total, -1);
  assert.match(quotaSummaryText(view), /不限量/);
  assert.equal(isNeverExpires(253402214400000), true);
  assert.equal(isNeverExpires(1793625334967), false);
});

test('groups same-name packages by expiry, nearest first, no expiry last', () => {
  const packages = [
    { id: 'a', name: '套餐', total: 100, remaining: 80, used: 20, unit: 'credits', expiresAt: 0, unlimited: false },
    { id: 'b', name: '套餐', total: 100, remaining: 90, used: 10, unit: 'credits', expiresAt: 200, unlimited: false },
    { id: 'c', name: '套餐', total: 100, remaining: 100, used: 0, unit: 'credits', expiresAt: 100, unlimited: false },
    { id: 'd', name: '加量包', total: 50, remaining: 50, used: 0, unit: 'credits', expiresAt: 100, unlimited: false },
  ];
  const groups = groupPackages(packages);
  assert.deepEqual(groups.map((group) => group.expiresAt), [100, 100, 200, 0]);
  const same = groups.filter((group) => group.name === '套餐' && group.expiresAt === 100);
  assert.equal(same.length, 1);
  assert.equal(same[0].total, 100);
});

test('future package arrays are accepted and grouped', () => {
  const view = normalizeQuota({
    quotas: [
      { id: 'p1', name: 'Pro', total: 500, remaining: 400, used: 100, unit: 'credits', expiresAt: 1000 },
      { id: 'p2', name: 'Pro', total: 500, remaining: 450, used: 50, unit: 'credits', expiresAt: 2000 },
    ],
    totalUsagePercentage: 0.15,
  });
  assert.equal(view.packages.length, 2);
  assert.equal(view.totals.total, 1000);
  assert.equal(view.totals.remaining, 850);
  assert.equal(view.groups.length, 2);
  assert.deepEqual(view.groups.map((group) => group.expiresAt), [1000, 2000]);
});

test('account mismatch and old-build responses become warnings', () => {
  const view = normalizeQuota(fixture.global.quota, {
    auth: { user: { id: 'someone-else' } },
    http: { quota: 404 },
    at: 1,
    now: 1_000_000,
  });
  assert.ok(view.warnings.some((warning) => warning.code === 'accountMismatch'));
  assert.ok(view.warnings.some((warning) => warning.code === 'oldBuild'));
  assert.ok(view.warnings.some((warning) => warning.code === 'stale'));
});

test('quota expiry marks the 7-day window and expired packs', () => {
  const now = Date.now();
  const soon = normalizeQuota({
    userQuota: { total: 10, remaining: 5, used: 5, unit: 'credits' },
    expiresAt: now + 3 * 86400000,
  }, { now });
  assert.equal(soon.daysToExpiry, 3);
  assert.equal(soon.expiringSoon, true);
  assert.equal(soon.expired, false);

  const expired = normalizeQuota({
    userQuota: { total: 10, remaining: 0, used: 10, unit: 'credits' },
    expiresAt: now - 2 * 86400000,
  }, { now });
  assert.equal(expired.expired, true);
  assert.equal(expired.expiringSoon, false);
  assert.equal(expired.daysToExpiry, -2);

  const justExpired = normalizeQuota({
    userQuota: { total: 10, remaining: 0, used: 10, unit: 'credits' },
    expiresAt: now - 3600000,
  }, { now });
  assert.equal(justExpired.expired, true, '过期不足一天也必须标 expired');
  assert.equal(justExpired.expiringSoon, false);
  assert.equal(justExpired.daysToExpiry, -1);
});

test('missing payload stays missing instead of a fake zero', () => {
  assert.equal(normalizeQuota(null), null);
  const unknownRemaining = normalizeQuota({ userQuota: { total: 10, used: 0 } });
  assert.equal(unknownRemaining.packages[0].remainingKnown, false, '只有 total 没有 remaining 时不能当成 0');
  assert.match(quotaSummaryText(unknownRemaining), /剩余未知/);
  const empty = normalizeQuota({ userQuota: null, addOnQuota: null });
  assert.equal(empty.packages.length, 0);
  assert.ok(empty.warnings.some((warning) => warning.code === 'empty'));
  const noFields = normalizeQuota({ totalUsagePercentage: 0.3 });
  assert.equal(noFields.packages.length, 0);
  assert.ok(noFields.warnings.some((warning) => warning.code === 'empty'));
  assert.match(quotaSummaryText(noFields), /没有返回可用额度/);
});

test('enterprise orgResourcePackage is normalized as a real package', () => {
  const view = normalizeQuota({
    userId: 'u-ent',
    userType: 'enterprise',
    isQuotaExceeded: false,
    expiresAt: 1_800_000_000_000,
    orgResourcePackage: {
      used: 91,
      remaining: 17761,
      percentage: 0.01,
      unit: 'credits',
      cap: 17852,
      available: true,
    },
  }, {
    auth: { user: { id: 'u-ent' } },
    now: 1_793_611_670_000,
  });
  assert.equal(view.packages.length, 1);
  assert.equal(view.packages[0].name, '企业额度');
  assert.equal(view.packages[0].source, 'orgResourcePackage');
  assert.equal(view.totals.total, 17852);
  assert.equal(view.totals.used, 91);
  assert.equal(view.totals.remaining, 17761);
  assert.equal(view.warnings.some((warning) => warning.code === 'empty'), false);
  assert.match(quotaSummaryText(view), /剩余 17761/);

  const unlimited = normalizeQuota({
    orgResourcePackage: { cap: -1, used: 10, remaining: 0, unit: 'credits' },
  });
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.packages[0].unlimited, true);
});

test('dedicated resource packages carry the only reliable expiry and drive nextExpiry', () => {
  const now = Date.UTC(2026, 10, 3, 1, 0, 0);
  const view = normalizeQuota({
    displayMode: 'qoder',
    qoderUsage: {
      userId: 'u-pro',
      userType: 'personal_pro',
      // 永久额度仍然用 9999 年哨兵；不能把它当成“已到期”。
      expiresAt: 253402214400000,
      userQuota: { total: 1000, used: 100, remaining: 900, unit: 'credits' },
      addOnQuota: { total: 500, used: 0, remaining: 500, unit: 'credits' },
      dedicatedResourcePackages: [
        { id: 'p-late', name: '新用户礼包', total: 100, used: 0, remaining: 100, expiresAt: now + 30 * 86400000 },
        { id: 'p-soon', name: '周年活动包', total: 200, used: 20, remaining: 180, expiresAt: now + 3 * 86400000 },
        { id: 'p-empty', name: '空包', total: 0, used: 0, remaining: 0, expiresAt: now + 86400000 },
      ],
    },
  }, { auth: { user: { id: 'u-pro' } }, now });

  assert.equal(view.packages.length, 4, '两个基础桶 + 两个非空资源包');
  const dedicated = view.packages.filter((item) => item.source === 'dedicated');
  assert.deepEqual(dedicated.map((item) => item.name).sort(), ['新用户礼包', '周年活动包'].sort());
  assert.equal(dedicated.every((item) => item.expiresAt > 0), true);
  assert.equal(view.expiresAt, 0, '9999 年哨兵视为不限期');
  assert.equal(view.nextExpiry, now + 3 * 86400000);
  assert.equal(view.nextExpiryName, '周年活动包');
  assert.equal(view.nextExpiryDays, 3);
  assert.equal(view.nextExpirySoon, true);
  assert.equal(view.groups[0].name, '周年活动包', '按到期由近到远排序');
});

test('snake_case usage payloads and second-level expiry are accepted', () => {
  const now = Date.UTC(2026, 10, 3, 0, 0, 0);
  const view = normalizeQuota({
    user_type: 'personal_pro',
    expires_at: 253402214400000,
    user_quota: { total: 100, used: 10, remaining: 90, unit: 'credits' },
    add_on_quota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
    dedicated_resource_packages: [
      { id: 's1', name: '秒级到期包', total: 50, used: 0, remaining: 50, expires_at: 1800000000 },
    ],
  }, { now });

  const pack = view.packages.find((item) => item.source === 'dedicated');
  assert.equal(pack.expiresAt, 1_800_000_000_000, '秒级 epoch 要换算成毫秒');
  assert.equal(view.nextExpiry, 1_800_000_000_000);
  assert.equal(view.nextExpiryDays, Math.floor((1_800_000_000_000 - now) / 86400000));
});

test('missing expiry is not reported as unlimited', () => {
  const now = Date.UTC(2026, 10, 3, 0, 0, 0);
  // 真实账号的形态：顶层是 9999 哨兵，但 addOnQuota 完全没有到期字段。
  const view = normalizeQuota({
    expiresAt: 253402214400000,
    userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
    addOnQuota: { total: 1500, used: 961, remaining: 539, unit: 'credits' },
  }, { plan: { end_date: 0 }, now });

  assert.equal(view.expiresAt, 0, '哨兵不产生具体日期');
  assert.equal(view.expiresKnown, true, '哨兵本身是“上游给了字段”');
  assert.equal(view.expiryIncomplete, true, '加量包没有到期字段');
  assert.equal(view.neverExpires, false, '有包未知时不能宣布整体永久');
  assert.equal(view.packages.find((item) => item.source === 'addOnQuota').neverExpires, false);
  assert.equal(view.packages.find((item) => item.source === 'addOnQuota').expiresKnown, false);

  // 每一份都明确永久时才允许显示不限期。
  const allNever = normalizeQuota({
    expiresAt: 253402214400000,
    userQuota: { total: 100, used: 0, remaining: 100, unit: 'credits', expiresAt: 253402214400000 },
    addOnQuota: { total: 10, used: 0, remaining: 10, unit: 'credits', expiresAt: 253402214400000 },
  }, { plan: { end_date: 0 }, now });
  assert.equal(allNever.expiryIncomplete, false);
  assert.equal(allNever.neverExpires, true);
});
