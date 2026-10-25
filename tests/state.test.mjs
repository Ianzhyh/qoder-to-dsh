import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendUsage, clearUsage, creditsReport, flushUsage, normalizeCheckin, normalizePrefs,
  normalizeUsageRecord, readUsage, reconcileUsage, redact, summarizeUsage,
} from '../lib/state.mjs';

test('normalizePrefs keeps the three visibility intents distinct', () => {
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
    { at: now, model: 'alpha', promptTokens: 100, completionTokens: 50, totalTokens: 150, credits: 0.2, cachedTokens: 20, reasoningTokens: 10, latencyMs: 1000, firstByteMs: 100, ok: true },
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
  assert.equal(summary.totals.reasoningTokens, 10);
  assert.equal(summary.totals.avgFirstByteMs, 73);
  assert.deepEqual(summary.byModel.map((item) => item.model), ['alpha', 'beta']);
  const alpha = summary.byModel[0];
  assert.equal(alpha.requests, 2);
  assert.equal(alpha.tokens, 200);
  assert.equal(alpha.successRate, 0.5);
  assert.equal(alpha.avgLatencyMs, 750);
  assert.equal(alpha.share, 200 / 300);
  assert.equal(summary.byModel[1].share, 100 / 300);
  assert.equal(summary.days[summary.days.length - 1].credits, 0.3);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redact removes token prefixes and bearer values', () => {
  const text = redact('Authorization: Bearer dt-abcdefghijklmnopqrstuvwxyz\nrt=drt-abcdefghijklmnopqrstuvwxyz');
  assert.ok(!text.includes('dt-abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!text.includes('drt-abcdefghijklmnopqrstuvwxyz'));
  assert.ok(text.includes('<token>'));
});
