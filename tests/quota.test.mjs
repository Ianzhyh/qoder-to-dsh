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
