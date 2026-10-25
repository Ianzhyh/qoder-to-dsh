import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beijingDateKey, beijingHour, campaignEndMs, campaignStartMs, checkinCanClaim, claimCampaigns,
  inCampaignWindow, summarizeCampaigns, summarizeCheckinAccounts,
} from '../lib/checkin.mjs';

const now = Date.UTC(2026, 9, 25, 4, 0, 0);
const sec = (ts) => Math.floor(ts / 1000);
const benefit = (overrides = {}) => ({
  actionType: 'CLAIM_BENEFIT',
  claimStatus: 'CLAIMABLE',
  campaignId: 'campaign-1',
  benefit: { amount: 100 },
  startAt: sec(now) - 3600,
  endAt: sec(now) + 3600,
  ...overrides,
});

test('Beijing date/hour helpers use UTC+8', () => {
  assert.equal(beijingDateKey(Date.UTC(2026, 9, 24, 17, 0, 0)), '2026-10-25');
  assert.equal(beijingDateKey(Date.UTC(2026, 9, 25, 15, 59, 0)), '2026-10-25');
  assert.equal(beijingDateKey(Date.UTC(2026, 9, 25, 16, 0, 0)), '2026-10-26');
  assert.equal(beijingHour(Date.UTC(2026, 9, 25, 2, 0, 0)), 10);
  assert.equal(campaignStartMs(benefit()), (sec(now) - 3600) * 1000);
  assert.equal(campaignEndMs(benefit()), (sec(now) + 3600) * 1000);
});

test('campaign window is inclusive at start and exclusive at end', () => {
  const campaign = { startAt: 100, endAt: 200 };
  assert.equal(inCampaignWindow(campaign, 100_000), true);
  assert.equal(inCampaignWindow(campaign, 199_999), true);
  assert.equal(inCampaignWindow(campaign, 200_000), false);
  assert.equal(inCampaignWindow(campaign, 99_999), false);
  assert.equal(inCampaignWindow({}, now), true, '没有窗口字段时不过滤');
});

function fakeDevice() {
  return {
    ready: true,
    version: 'test',
    reason: '',
    headers: {
      'Cosy-ClientType': '10',
      'Cosy-MachineId': 'machine-id-fixture',
      'Cosy-MachineToken': 'machine-token-fixture',
    },
  };
}

test('claimCampaigns claims a claimable benefit with device headers', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/campaigns/') && options.method === 'POST') {
      return new Response(JSON.stringify({
        status: 'CLAIMED', benefit: { amount: 100 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ campaigns: [benefit()] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await claimCampaigns({
      region: 'cn',
      getToken: async () => 'token-fixture',
      now,
      deviceProvider: async () => fakeDevice(),
    });
    assert.equal(result.status, 'claimed');
    assert.equal(result.credits, 100);
    assert.equal(result.message, '签到成功 +100 Credits');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /openapi\.qoder\.com\.cn\/sash\/api\/v1\/me\/campaigns$/);
    assert.match(calls[1].url, /\/campaigns\/campaign-1\/claim$/);
    assert.equal(calls[0].options.headers.authorization, 'Bearer token-fixture');
    assert.equal(calls[0].options.headers['Cosy-MachineToken'], 'machine-token-fixture');
    assert.ok(!JSON.stringify(result).includes('token-fixture'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('claimCampaigns refreshes the active token once on 401', async () => {
  const originalFetch = globalThis.fetch;
  let getCount = 0;
  let refreshCount = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/campaigns/') && options.method === 'POST') {
      return new Response(JSON.stringify({ data: { status: 'CLAIMED', benefit: { amount: 50 } } }), { status: 200 });
    }
    getCount += 1;
    if (getCount === 1) return new Response('{"error":"expired"}', { status: 401 });
    assert.equal(options.headers.authorization, 'Bearer new-token');
    return new Response(JSON.stringify({ campaigns: [benefit()] }), { status: 200 });
  };
  try {
    const result = await claimCampaigns({
      region: 'global',
      getToken: async () => 'old-token',
      refreshToken: async () => { refreshCount += 1; return 'new-token'; },
      now,
      deviceProvider: async () => fakeDevice(),
    });
    assert.equal(refreshCount, 1);
    assert.equal(getCount, 2);
    assert.equal(result.status, 'claimed');
    assert.equal(result.credits, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('claimCampaigns does not call the network without a device identity', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}'); };
  try {
    const result = await claimCampaigns({
      region: 'global',
      getToken: async () => 'token-fixture',
      now,
      deviceProvider: async () => ({ ready: false, reason: 'missing runtime-info', headers: {}, version: '' }),
    });
    assert.equal(result.status, 'device');
    assert.match(result.message, /runtime-info/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('summarizeCampaigns separates claimable, claimed, pending and other campaign types', () => {  const payload = {
    campaignUrl: 'https://qoder.com/campaign',
    campaigns: [
      benefit(),
      benefit({ campaignId: 'claimed', claimStatus: 'CLAIMED', benefit: { amount: 100 } }),
      benefit({ campaignId: 'other-type', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' }),
      benefit({ campaignId: 'expired', claimStatus: 'CLAIMABLE', startAt: sec(now) - 7200, endAt: sec(now) - 3600 }),
    ],
  };
  const summary = summarizeCampaigns(payload, now);
  assert.equal(summary.benefits.length, 3, 'VIEW_DETAILS 不算领取活动');
  assert.deepEqual(summary.claimable.map((item) => item.campaignId), ['campaign-1']);
  assert.deepEqual(summary.claimed.map((item) => item.campaignId), ['claimed']);
  assert.equal(summary.pending, false);
  assert.equal(summary.campaignUrl, 'https://qoder.com/campaign');
  assert.equal(summary.endAt, (sec(now) + 3600) * 1000);

  const pending = summarizeCampaigns({ campaigns: [benefit({ claimStatus: 'PENDING' })] }, now);
  assert.equal(pending.claimable.length, 0);
  assert.equal(pending.pending, true);

  const empty = summarizeCampaigns({ campaigns: [] }, now);
  assert.equal(empty.benefits.length, 0);
  assert.equal(empty.claimable.length, 0);
});

test('checkin summary separates waiting, unavailable and pending accounts', () => {
  const summary = summarizeCheckinAccounts([
    { today: true, status: 'claimed', credits: 100 },
    { today: true, status: 'already', credits: 50 },
    { today: false, status: 'idle', credits: 0 },
    { today: true, status: 'pending', credits: 0 },
    { today: false, status: 'waiting', credits: 0 },
    { today: true, status: 'unavailable', credits: 0 },
    { today: true, status: 'device', credits: 0 },
    { today: true, status: 'login', credits: 0 },
  ]);
  assert.equal(summary.total, 8);
  assert.equal(summary.done, 2);
  assert.equal(summary.claimed, 1);
  assert.equal(summary.already, 1);
  assert.equal(summary.credits, 150);
  assert.equal(summary.pending, 1, '只有 idle 是真正的待领取');
  assert.equal(summary.notOpen, 1, 'pending 是活动未下发/未开放，不能算待领取');
  assert.equal(summary.waiting, 1);
  assert.equal(summary.unavailable, 1);
  assert.equal(summary.errors, 2);

  const empty = summarizeCheckinAccounts([]);
  assert.deepEqual(empty, {
    total: 0, done: 0, claimed: 0, already: 0, credits: 0,
    pending: 0, notOpen: 0, waiting: 0, unavailable: 0, errors: 0,
  });
});

test('checkinCanClaim blocks closed windows but allows retrying a stale failure', () => {
  const base = { tokenReady: true, deviceAvailable: true };
  assert.equal(checkinCanClaim({ ...base, status: 'idle' }), true);
  assert.equal(checkinCanClaim({ ...base, status: 'pending' }), true);
  assert.equal(checkinCanClaim({ ...base, status: 'error' }), true);
  assert.equal(checkinCanClaim({ ...base, status: 'device' }), true, '设备恢复后允许重试旧失败');
  assert.equal(checkinCanClaim({ ...base, status: 'login' }), true, '重新登录后允许重试旧失败');
  assert.equal(checkinCanClaim({ ...base, status: 'waiting' }), false);
  assert.equal(checkinCanClaim({ ...base, status: 'unavailable' }), false);
  assert.equal(checkinCanClaim({ ...base, status: 'claimed' }), false);
  assert.equal(checkinCanClaim({ ...base, status: 'already' }), false);
  assert.equal(checkinCanClaim({ tokenReady: false, deviceAvailable: true, status: 'error' }), false);
  assert.equal(checkinCanClaim({ tokenReady: true, deviceAvailable: false, status: 'error' }), false);
});
