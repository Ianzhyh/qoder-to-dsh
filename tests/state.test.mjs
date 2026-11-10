import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendUsage, clearUsage, creditsReport, ensureUsageDaily, flushUsage, isProbe, localDayKey,
  normalizeCheckin, normalizePrefs, normalizeUsageRecord, readUsage, readUsageDaily,
  reconcileUsage, redact, summarizeRequests, summarizeUsage, usageDailyPath,
} from '../lib/state.mjs';

test('normalizePrefs keeps the three visibility intents distinct', () => {
  assert.equal(normalizePrefs({ uiLocale: 'en' }).uiLocale, 'en');
  assert.equal(normalizePrefs({ uiLocale: 'fr' }).uiLocale, 'zh');
  assert.equal(normalizePrefs({ visible: null }).visible, null);
  assert.deepEqual(normalizePrefs({ visible: [] }).visible, []);
  assert.deepEqual(normalizePrefs({ visible: ['a', 'a', 'b'] }).visible, ['a', 'b']);
  const prefs = normalizePrefs({
    visible: null,
    pinned: 'model-a',
    contextWindowByModel: { a: 100000, b: -1 },
    paramsByModel: { a: { temperature: 9, maxTokens: 10, reasoningEffort: 'high' } },
  });
  assert.equal(prefs.pinned, 'model-a');
  assert.deepEqual(prefs.contextWindowByModel, { a: 100000 });
  assert.deepEqual(prefs.paramsByModel, { a: { temperature: 2, maxTokens: 10, reasoningEffort: 'high' } });
});

test('summarizeRequests exposes estimated records without changing success status', () => {
  const now = Date.now();
  const result = summarizeRequests([
    { at: now, model: 'auto', ok: true, status: 'ok', estimated: true, promptTokens: 12, completionTokens: 3, totalTokens: 15 },
  ], { days: 7, limit: 20, now });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].estimated, true);
  assert.equal(result.items[0].ok, true);
  assert.equal(result.items[0].promptTokens, 12);
});

test('summarizeRequests filters failures that need manual action', () => {
  const now = Date.now();
  const records = [
    { at: now, model: 'auto', ok: false, status: 'http-429', errorAction: 'retry' },
    { at: now, model: 'auto', ok: false, status: 'http-402', errorAction: 'switch' },
    { at: now, model: 'auto', ok: false, status: 'http-400', errorAction: 'fail' },
    { at: now, model: 'auto', ok: true, status: 'ok' },
  ];
  const result = summarizeRequests(records, { days: 7, limit: 20, onlyActionable: true, now });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.errorAction).sort(), ['fail', 'switch']);
  assert.equal(result.total, 2);
});

test('usage records carry credits and reject invalid timestamps', () => {
  assert.equal(normalizeUsageRecord({ at: 0 }), null);
  const record = normalizeUsageRecord({
    at: 1_700_000_000_000, model: 'auto', promptTokens: 10, completionTokens: 5,
    totalTokens: 15, credits: 0.0123, latencyMs: 100, firstByteMs: 20, ok: true,
  });
  assert.equal(record.credits, 0.0123);
  assert.equal(record.totalTokens, 15);
  assert.equal(record.ok, true);
});

test('summarizeUsage produces 14 buckets and today totals', () => {
  const now = Date.parse('2026-10-25T12:00:00+08:00');
  const summary = summarizeUsage([
    { at: now, totalTokens: 100, credits: 0.1, latencyMs: 1000, firstByteMs: 100, ok: true },
    { at: now - 1000, totalTokens: 50, credits: 0.05, latencyMs: 500, firstByteMs: 50, ok: false },
    { at: now - 86400000, totalTokens: 70, credits: 0, latencyMs: 700, firstByteMs: 70, ok: true },
  ], 14, now);
  assert.equal(summary.days.length, 14);
  assert.equal(summary.today.requests, 2);
  assert.equal(summary.today.tokens, 150);
  assert.equal(summary.today.failures, 1);
  assert.equal(summary.today.avgLatencyMs, 750);
  assert.equal(summary.today.successRate, 0.5);
  assert.equal(summary.today.credits, 0.15);
  assert.equal(summary.days[summary.days.length - 1].requests, 2);
});

test('summarizeUsage aggregates a window and per-model breakdown', () => {
  const now = Date.parse('2026-10-25T12:00:00+08:00');
  const summary = summarizeUsage([
    { at: now, model: 'alpha', promptTokens: 100, completionTokens: 50, totalTokens: 150, credits: 0.2, savedCredits: 0.02, cachedTokens: 20, reasoningTokens: 10, latencyMs: 1000, firstByteMs: 100, ok: true },
    { at: now - 2000, model: 'alpha', totalTokens: 50, credits: 0.1, latencyMs: 500, firstByteMs: 50, ok: false },
    { at: now - 86400000, model: 'beta', promptTokens: 80, completionTokens: 20, totalTokens: 100, credits: 0.05, latencyMs: 700, firstByteMs: 70, ok: true },
    { at: now - 40 * 86400000, model: 'old', totalTokens: 999, credits: 9, ok: true },
  ], 7, now);
  assert.equal(summary.range.days, 7);
  assert.equal(summary.totals.requests, 3, '窗口外记录不计入 totals');
  assert.equal(summary.totals.tokens, 300);
  assert.equal(summary.totals.failures, 1);
  assert.equal(summary.totals.credits, 0.35);
  assert.equal(summary.totals.cachedTokens, 20);
  assert.equal(summary.totals.cacheHitRate, 20 / 180);
  assert.equal(summary.totals.reasoningTokens, 10);
  assert.equal(summary.totals.avgFirstByteMs, 73);
  assert.deepEqual(summary.byModel.map((item) => item.model), ['alpha', 'beta']);
  const alpha = summary.byModel[0];
  assert.equal(alpha.requests, 2);
  assert.equal(alpha.tokens, 200);
  assert.equal(alpha.successRate, 0.5);
  assert.equal(alpha.cacheHitRate, 0.2);
  assert.equal(alpha.avgLatencyMs, 750);
  assert.equal(alpha.share, 200 / 300);
  assert.equal(summary.byModel[1].share, 100 / 300);
  assert.equal(summary.days[summary.days.length - 1].credits, 0.3);
  assert.equal(summary.days[summary.days.length - 1].savedCredits, 0.02);
});

test('creditsReport builds range series and a 12-month heatmap', () => {
  const now = new Date(2026, 9, 25, 12, 0, 0).getTime();
  const at = (month, day) => new Date(2026, month, day, 10, 0, 0).getTime();
  const records = [
    { at: at(9, 25), model: 'alpha', client: 'desktop', totalTokens: 100, credits: 0.5, ok: true },
    { at: at(9, 24), model: 'alpha', client: 'desktop', totalTokens: 60, credits: 0.3, ok: true },
    { at: at(9, 17), model: 'beta', client: 'cli', totalTokens: 40, credits: 0.2, ok: false },
    { at: at(8, 15), model: 'beta', client: 'cli', totalTokens: 200, credits: 2.5, ok: true },
    { at: at(0, 10), model: 'old', client: 'desktop', totalTokens: 500, credits: 9, ok: true },
  ];
  const report = creditsReport(records, { now, range: '7d' });
  assert.equal(report.range.key, '7d');
  assert.equal(report.range.from, '2026-10-19');
  assert.equal(report.range.to, '2026-10-25');
  assert.equal(report.range.days, 7);
  assert.equal(report.days.length, 7);
  assert.equal(report.totals.requests, 2);
  assert.equal(report.totals.credits, 0.8);
  assert.equal(report.days[report.days.length - 1].credits, 0.5);
  assert.deepEqual(report.series.model.map((item) => item.key), ['alpha']);
  assert.equal(report.series.model[0].credits, 0.8);
  assert.equal(report.series.model[0].points.length, 7);
  assert.deepEqual(report.series.client.map((item) => item.key), ['desktop']);
  assert.ok(report.heatmap.days.length >= 350 && report.heatmap.days.length <= 366);
  assert.equal(report.heatmap.totalCredits, 12.5);
  assert.ok(report.heatmap.days.some((day) => day.date === '2026-10-25' && day.credits === 0.5));

  const mtd = creditsReport(records, { now, range: 'mtd' });
  assert.equal(mtd.range.from, '2026-10-01');
  assert.equal(mtd.range.days, 25);
  assert.equal(mtd.totals.credits, 1);
  const lastMonth = creditsReport(records, { now, range: 'last-month' });
  assert.equal(lastMonth.range.from, '2026-09-01');
  assert.equal(lastMonth.range.to, '2026-09-30');
  assert.equal(lastMonth.range.days, 30);
  assert.equal(lastMonth.totals.credits, 2.5);
  const oneDay = creditsReport(records, { now, range: '1d' });
  assert.equal(oneDay.range.days, 1);
  assert.equal(oneDay.totals.credits, 0.5);
});

test('free-model usage only records billable credits and keeps the saved estimate', () => {
  const now = Date.now();
  const free = normalizeUsageRecord({
    at: now, model: 'dfmodel', totalTokens: 100, credits: 0.012,
    originalCredits: 0.012, savedCredits: 0.012, billable: false, ok: true,
  });
  assert.equal(free.credits, 0);
  assert.equal(free.savedCredits, 0.012);
  assert.equal(free.billable, false);

  const legacy = normalizeUsageRecord({ at: now, model: 'dfmodel', totalTokens: 100, credits: 0.02 });
  assert.equal(legacy.billable, undefined, '旧记录不伪造 billable 标记');
  const [fixed] = reconcileUsage([legacy, free], new Set(['dfmodel']));
  assert.equal(fixed.credits, 0);
  assert.equal(fixed.savedCredits, 0.02);
  assert.equal(fixed.billable, false);

  const discounted = normalizeUsageRecord({
    at: now, model: 'paid', credits: 0.07, originalCredits: 0.1, billable: true,
  });
  assert.equal(discounted.credits, 0.07);
  assert.ok(discounted.savedCredits > 0.029 && discounted.savedCredits < 0.031);

  const summary = summarizeUsage([free, discounted], 7, now);
  assert.equal(summary.today.credits, 0.07);
  assert.ok(summary.today.savedCredits > 0.041 && summary.today.savedCredits < 0.043);
  assert.equal(summary.totals.credits, 0.07);
});

test('credits report excludes non-billable models from the trend series', () => {
  const now = new Date(2026, 9, 25, 12, 0, 0).getTime();
  const report = creditsReport([
    { at: now, model: 'free', client: 'desktop', totalTokens: 100, credits: 0, savedCredits: 0.4, billable: false, ok: true },
    { at: now, model: 'paid', client: 'desktop', totalTokens: 100, credits: 0.5, ok: true },
  ], { now, range: '7d' });
  assert.equal(report.totals.credits, 0.5);
  assert.equal(report.totals.savedCredits, 0.4);
  assert.deepEqual(report.series.model.map((item) => item.key), ['paid']);
});

test('checkin state keeps results without credential fields and defaults auto on', () => {
  const empty = normalizeCheckin(null);
  assert.equal(empty.auto, true);
  assert.deepEqual(empty.results, {});

  const state = normalizeCheckin({
    auto: false,
    lastRunAt: 1234,
    results: {
      'global:uid-1': {
        label: '账号 A', region: 'global', kind: 'app', status: 'claimed', credits: 100,
        message: 'ok', checkedAt: 5678, accessToken: 'secret', machineToken: 'secret',
      },
      'cn:uid-2': { label: '账号 B', region: 'cn', status: 'not-a-status', credits: -5 },
      bad: null,
    },
  });
  assert.equal(state.auto, false);
  assert.equal(state.lastRunAt, 1234);
  assert.equal(state.results['global:uid-1'].credits, 100);
  assert.equal(state.results['global:uid-1'].region, 'global');
  assert.equal(state.results['global:uid-1'].status, 'claimed');
  assert.equal(state.results['cn:uid-2'].status, 'idle');
  assert.equal(state.results['cn:uid-2'].credits, 0);
  assert.equal(state.results['cn:uid-2'].region, 'cn');
  assert.ok(!JSON.stringify(state).includes('secret'));
});

test('usage records keep the client source used for Credits grouping', () => {
  const record = normalizeUsageRecord({ at: 1, model: 'auto', client: 'cli', totalTokens: 1 });
  assert.equal(record.client, 'cli');
  assert.equal(normalizeUsageRecord({ at: 1 }).client, 'unknown');
});

test('usage reads are cached and writes are coalesced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-usage-'));
  const path = join(dir, 'usage.json');
  const now = Date.now();
  writeFileSync(path, `${JSON.stringify([
    { at: now - 3000, model: 'a', totalTokens: 1, ok: true },
    { at: now - 2000, model: 'b', totalTokens: 2, ok: true },
  ], null, 2)}\n`);
  try {
    assert.deepEqual(readUsage(path).map((item) => item.model), ['a', 'b']);
    appendUsage({ at: now - 1000, model: 'c', totalTokens: 3, ok: true }, path);
    appendUsage({ at: now, model: 'd', totalTokens: 4, ok: true }, path);
    assert.deepEqual(readUsage(path).map((item) => item.model), ['a', 'b', 'c', 'd'], '追加后内存立即可见');
    await flushUsage(path);
    const raw = readFileSync(path, 'utf8');
    assert.ok(!raw.includes('\n  '), '用量文件使用紧凑 JSON');
    assert.deepEqual(JSON.parse(raw).map((item) => item.model), ['a', 'b', 'c', 'd']);

    writeFileSync(path, `${JSON.stringify([{ at: now, model: 'external', totalTokens: 5, ok: true }])}\n`);
    assert.deepEqual(readUsage(path).map((item) => item.model), ['external'], '外部改写后重新加载');

    appendUsage({ at: now + 1, model: 'e', totalTokens: 6, ok: true }, path);
    clearUsage(path);
    assert.deepEqual(readUsage(path), []);
    assert.equal(existsSync(path), false);
    // 清空必须留可回溯的备份，否则误点一次明细就永久消失。
    const backups = readdirSync(dir).filter((name) => name.startsWith('usage.json.bak-'));
    assert.equal(backups.length, 1, '清空后应留下一份 .bak-<stamp>');
    assert.ok(JSON.parse(readFileSync(join(dir, backups[0]), 'utf8')).length > 0, '备份里要有被清掉的记录');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing usage during an in-flight flush does not resurrect the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-usage-clear-'));
  const path = join(dir, 'usage.json');
  try {
    appendUsage({ at: Date.now(), model: 'race', tokens: 1, totalTokens: 1, ok: true }, path);
    const flushing = flushUsage(path);
    clearUsage(path);
    await flushing;
    assert.deepEqual(readUsage(path), []);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily rollup survives raw pruning, keeps probes out, and clears both files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-daily-'));
  const path = join(dir, 'usage.json');
  const now = Date.now();
  writeFileSync(path, `${JSON.stringify([
    { at: now, model: 'old', totalTokens: 10, credits: 0.1, ok: true },
  ])}\n`);
  try {
    appendUsage({ at: now, model: 'new', totalTokens: 20, credits: 0.2, ok: true }, path);
    appendUsage({ at: now, model: 'probe', totalTokens: 999, credits: 9, ok: true, status: 'test' }, path);
    await flushUsage(path);

    const daily = readUsageDaily(path);
    const key = localDayKey(now);
    assert.equal(daily.days[key].requests, 2, '试跑不能进入每日统计');
    assert.equal(daily.days[key].tokens, 30);
    assert.ok(Math.abs(daily.days[key].credits - 0.3) < 1e-9);
    assert.equal(isProbe({ status: 'test-failed' }), true);

    const report = creditsReport(readUsage(path), { now, range: '1d', daily });
    assert.equal(report.totals.requests, 2);
    assert.equal(report.probe.requests, 1);
    assert.equal(report.probe.tokens, 999);
    assert.equal(report.seriesPartial, false, '明细还在时以明细为准');

    clearUsage(path);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(usageDailyPath(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a day with pruned details uses the daily rollup instead of undercounting', () => {
  const now = Date.now();
  const key = localDayKey(now);
  const daily = {
    schema: 1,
    updatedAt: now,
    days: {
      [key]: {
        credits: 1, savedCredits: 0, promptTokens: 0, completionTokens: 0,
        cachedTokens: 0, reasoningTokens: 0, tokens: 100, requests: 10, failures: 1,
      },
    },
  };
  const report = creditsReport([{ at: now, model: 'm', totalTokens: 10, credits: 0.1, ok: true }], {
    now, range: '1d', daily,
  });
  assert.equal(report.totals.requests, 10);
  assert.equal(report.totals.credits, 1);
  assert.equal(report.totals.failures, 1);
  assert.equal(report.seriesPartial, true);
  assert.equal(report.days[0].source, 'daily');

  const summary = summarizeUsage([{ at: now, model: 'm', totalTokens: 10, credits: 0.1, ok: true }], 1, now, daily);
  assert.equal(summary.today.requests, 10);
  assert.equal(summary.totals.credits, 1);
  assert.equal(summary.seriesPartial, true);
});

test('byModel/byAccount shares use the detail total, not the daily rollup total', () => {
  // totals 在明细被裁剪时会改用 daily；byModel 只遍历明细。分母不统一时
  // 同页会同时出现「7 次」与「按模型合计 2 次」、占比合计 0.2857。
  const now = Date.now();
  const records = [
    { at: now, model: 'a', totalTokens: 100, ok: true },
    { at: now, model: 'a', totalTokens: 100, ok: true },
  ];
  const daily = {
    days: {
      [localDayKey(now)]: {
        credits: 0, savedCredits: 0, promptTokens: 700, completionTokens: 0,
        cachedTokens: 0, reasoningTokens: 0, tokens: 700, requests: 7, failures: 0,
      },
    },
  };
  const summary = summarizeUsage(records, 1, now, daily);
  assert.equal(summary.totals.requests, 7, 'totals 来自 daily');
  const modelRequests = summary.byModel.reduce((sum, item) => sum + item.requests, 0);
  assert.equal(modelRequests, 2, 'byModel 来自明细');
  const shareTotal = summary.byModel.reduce((sum, item) => sum + item.share, 0);
  assert.ok(Math.abs(shareTotal - 1) < 1e-9, `占比合计必须是 1，实际 ${shareTotal}`);
});

test('today failure breakdown is returned and excludes probes', () => {
  const now = Date.now();
  const records = [
    { at: now, model: 'a', ok: false, errorAction: 'retry', errorCode: 'TIMEOUT' },
    { at: now, model: 'b', ok: false, status: 'test-failed', errorAction: 'retry', probe: true },
  ];
  const summary = summarizeUsage(records, 1, now, null);
  // 面板的「今日请求」卡片靠这两个字段渲染「可重试 2 · 重新登录 1」。
  assert.equal(typeof summary.today.failureByAction, 'object');
  assert.deepEqual(summary.today.failureByAction, { retry: 1 }, '试跑不能进失败拆分');
  assert.equal(summary.today.failures, 1);
});

test('an aborted request is not "action needed"', async () => {
  const { isActionable } = await import('../lib/state.mjs');
  // adapter 给 ABORTED 写 errorAction:'fail'；用户主动取消不该长期留在
  // 「仅需处理」筛选里。
  assert.equal(isActionable({ ok: false, status: 'aborted', errorAction: 'fail', errorCode: 'ABORTED' }), false);
  assert.equal(isActionable({ ok: false, status: 'stream-error', errorAction: 'switch', errorCode: 'QUOTA_EXCEEDED' }), true);
  assert.equal(isActionable({ ok: true }), false);
});

test('ensureUsageDaily repairs a daily rollup that missed newer raw records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-daily-repair-'));
  const path = join(dir, 'usage.json');
  const now = Date.now();
  const key = localDayKey(now);
  writeFileSync(path, `${JSON.stringify([
    { at: now, model: 'a', totalTokens: 10, credits: 0.1, ok: true },
    { at: now, model: 'b', totalTokens: 20, credits: 0.2, ok: true },
  ])}\n`);
  writeFileSync(usageDailyPath(path), JSON.stringify({
    schema: 1,
    updatedAt: now,
    days: {
      [key]: {
        credits: 0.1, savedCredits: 0, promptTokens: 0, completionTokens: 0,
        cachedTokens: 0, reasoningTokens: 0, tokens: 10, requests: 1, failures: 0,
      },
    },
  }));
  try {
    const repaired = await ensureUsageDaily(path);
    assert.equal(repaired.days[key].requests, 2);
    assert.equal(repaired.days[key].tokens, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureUsageDaily can rebuild from reconciled free-model records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-daily-reconcile-'));
  const path = join(dir, 'usage.json');
  const now = Date.now();
  writeFileSync(path, `${JSON.stringify([
    { at: now, model: 'free-model', totalTokens: 10, credits: 9, ok: true },
  ])}\n`);
  try {
    const reconciled = [{
      at: now, model: 'free-model', totalTokens: 10, credits: 0,
      originalCredits: 9, savedCredits: 9, billable: false, ok: true,
    }];
    const daily = await ensureUsageDaily(path, reconciled);
    assert.equal(daily.days[localDayKey(now)].credits, 0, '免费模型的旧 Credits 不能算成实扣');
    assert.equal(daily.days[localDayKey(now)].savedCredits, 9);
    assert.equal(daily.days[localDayKey(now)].requests, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily rollup drops entries older than its 430-day window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-daily-prune-'));
  const path = join(dir, 'usage.json');
  const now = Date.now();
  const old = now - 431 * 24 * 3600 * 1000;
  try {
    appendUsage({ at: old, model: 'old', totalTokens: 1, credits: 1, ok: true }, path);
    appendUsage({ at: now, model: 'new', totalTokens: 2, credits: 0.2, ok: true }, path);
    await flushUsage(path);
    const daily = readUsageDaily(path);
    assert.equal(daily.days[localDayKey(old)], undefined);
    assert.equal(daily.days[localDayKey(now)].requests, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing usage during a daily flush does not resurrect either file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-daily-clear-'));
  const path = join(dir, 'usage.json');
  try {
    appendUsage({ at: Date.now(), model: 'race', totalTokens: 1, credits: 0.1, ok: true }, path);
    const flushing = flushUsage(path);
    clearUsage(path);
    await flushing;
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(usageDailyPath(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redact removes token prefixes and bearer values', () => {
  const text = redact('Authorization: Bearer dt-abcdefghijklmnopqrstuvwxyz+/=\nrt=drt-abcdefghijklmnopqrstuvwxyz\naccess_token=abcdefghijklmnop');
  assert.ok(!text.includes('dt-abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!text.includes('drt-abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!text.includes('abcdefghijklmnop'));
  assert.ok(text.includes('<token>'));
});

test('redact and log serialize object details instead of [object Object]', () => {
  // 旧实现 String(obj) 会把 wireStats 这类对象 detail 写成 [object Object]，
  // 日志里看不出裁剪了多少图片/字节。
  const detail = { images: 3, dropped: 2, bytes: 1234 };
  assert.equal(redact(detail), JSON.stringify(detail));
  assert.equal(redact(new Error('boom')).includes('boom'), true);
  assert.equal(redact(undefined), '');
  assert.equal(redact(42), '42');
});

test('creditsReport falls back to the default range for prototype keys', () => {
  const report = creditsReport([], { range: 'constructor', now: Date.parse('2026-10-25T12:00:00+08:00') });
  assert.equal(report.range.key, '7d');
  assert.equal(report.range.days, 7);
  assert.equal(report.range.label, '最近 7 天');
  assert.match(report.range.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(report.range.to, /^\d{4}-\d{2}-\d{2}$/);
});

test('normalizePrefs preserves unknown fields for forward/backward compatibility', () => {
  const prefs = normalizePrefs({
    visible: ['a'],
    futureFeature: { mode: 'x' },
    paramsByModel: { a: { temperature: 0.2, futureParam: 42 } },
  });
  assert.deepEqual(prefs.futureFeature, { mode: 'x' });
  assert.equal(prefs.paramsByModel.a.temperature, 0.2);
  assert.equal(prefs.paramsByModel.a.futureParam, 42);
  const poisoned = normalizePrefs(JSON.parse('{"__proto__":{"polluted":true},"visible":null}'));
  assert.equal(poisoned.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test('checkin ledger keeps one entry per account/day/credits', async () => {
  const { normalizeCheckin } = await import('../lib/state.mjs');
  // 去重按北京时间记日（账本与签到结果都用 UTC+8），所以「跨天」的样本必须是
  // 北京时间跨天：2026-11-07 12:00 与 2026-11-08 12:00 (UTC+8)。
  const bj = (day) => Date.UTC(2026, 10, day, 4, 0); // 12:00 +08:00
  const clean = normalizeCheckin({
    ledger: [
      { key: 'cn:u1', region: 'cn', at: bj(7), credits: 100, validityDays: 30 },
      { key: 'cn:u1', region: 'cn', at: bj(7), credits: 100, validityDays: 0 },
      { key: 'cn:u1', region: 'cn', at: bj(7), credits: 100, validityDays: 7 },
      { key: 'cn:u1', region: 'cn', at: bj(8), credits: 100, validityDays: 0 },
      { key: 'cn:u2', region: 'cn', at: bj(7), credits: 100, validityDays: 0 },
      { key: 'bad', at: 0, credits: 0 },
    ],
  });
  assert.equal(clean.ledger.length, 3, '同账号同天同额度去重，跨天/跨账号保留');
  assert.equal(clean.ledger[0].validityDays, 30, '第一次出现的有效期优先');
  assert.equal(clean.ledger.every((item) => item.at > 0 && item.credits > 0), true);
});

test('checkin ledger survives an out-of-range timestamp instead of crashing the plugin', async () => {
  const { normalizeCheckin } = await import('../lib/state.mjs');
  // 上游把秒/纳秒写进 at（1e17 / 1.7e18）会让 toISOString 抛 RangeError；
  // 这行在 apply() 里同步执行，一条坏记录就能让整个插件加载失败。
  const clean = normalizeCheckin({
    ledger: [
      { key: 'cn:u1', at: 1e17, credits: 100 },
      { key: 'cn:u1', at: 1.7e18, credits: 100 },
      { key: 'cn:u1', at: 8.64e15 + 1, credits: 100 },
      { key: 'cn:u1', at: Date.UTC(2026, 10, 7, 4, 0), credits: 100 },
    ],
  });
  assert.equal(clean.ledger.length, 1, '越界记录被丢弃，合法记录保留');
  assert.ok(clean.ledger[0].at > 0);
});

test('checkin ledger keeps both ends when it exceeds the cap', async () => {
  const { normalizeCheckin } = await import('../lib/state.mjs');
  // 只保留最后 N 条会让早期批次整体消失，差额被当成「到期未知」。
  const many = Array.from({ length: 800 }, (_, i) => ({
    key: 'cn:u1',
    at: Date.UTC(2026, 0, 1, 4, 0) + i * 86400000,
    credits: 10,
  }));
  const clean = normalizeCheckin({ ledger: many });
  assert.equal(clean.ledger.length, 500);
  assert.equal(clean.ledger[0].at, many[0].at, '最早的领取必须保留');
  assert.equal(clean.ledger[clean.ledger.length - 1].at, many[many.length - 1].at, '最新的领取必须保留');
});
