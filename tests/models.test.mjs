import test from 'node:test';
import assert from 'node:assert/strict';

import { toAdapterModels, toDirectory } from '../lib/models.mjs';
import { normalizeCatalog } from '../lib/qoder-api.mjs';

const catalog = [
  {
    id: 'alpha', name: 'Alpha', context_window: 100000, context_window_max: 200000,
    context_window_options: [100000, 200000], supports_images: true, supports_reasoning: true,
    reasoning_efforts: ['low', 'high'], official: true, credits: 0.5, free: false,
  },
  {
    id: 'beta', name: 'Beta', context_window: 1000000, context_window_max: 1000000,
    context_window_options: [1000000], supports_images: false, supports_reasoning: false,
    reasoning_efforts: [], official: true, credits: 0, free: true,
  },
  {
    id: 'gamma', name: 'Gamma', context_window: 8000, context_window_max: 8000,
    context_window_options: [], supports_images: false, supports_reasoning: false,
    reasoning_efforts: [], official: false, credits: null, free: false,
  },
];

test('visible=null shows the full catalog by default', () => {
  const models = toAdapterModels(catalog, { visible: null });
  assert.deepEqual(models.map((model) => model.id), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(models[0].inputModalities, ['text', 'image']);
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'high']);
});

test('visible array filters, pinned is always kept, empty array hides all except pinned', () => {
  assert.deepEqual(
    toAdapterModels(catalog, { visible: ['beta'], pinned: 'alpha' }).map((model) => model.id),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    toAdapterModels(catalog, { visible: [], pinned: 'beta' }).map((model) => model.id),
    ['beta'],
  );
});

test('context override is clamped to the model maximum', () => {
  const [alpha] = toAdapterModels(catalog, { visible: null, contextWindows: { alpha: 9_000_000 } });
  assert.equal(alpha.contextWindow, 200000);
});

test('context_config options are not capped by the legacy max_input_tokens field', () => {
  const wide = {
    ...catalog[0],
    context_window: 200000,
    context_window_max: 1000000,
    context_window_options: [200000, 400000, 1000000],
    max_input_tokens: 180000,
  };
  const [model] = toAdapterModels([wide], { visible: null, contextWindows: { alpha: 1000000 } });
  assert.equal(model.contextWindow, 1000000, '选择 1M 时不能被 180K 旧字段砍掉');
  const [entry] = toDirectory([wide], { contextWindows: { alpha: 1000000 } });
  assert.equal(entry.contextWindow, 1000000);
  assert.equal(entry.contextWindowAuto, 200000);
  assert.equal(entry.contextWindowMax, 1000000);
  assert.deepEqual(entry.contextWindowOptions, [200000, 400000, 1000000]);
});

test('includeAll=false hides unofficial models unless pinned', () => {
  assert.deepEqual(
    toAdapterModels(catalog, { visible: null, includeAll: false }).map((model) => model.id),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    toAdapterModels(catalog, { visible: null, includeAll: false, pinned: 'gamma' }).map((model) => model.id),
    ['alpha', 'beta', 'gamma'],
  );
});

test('showCost=false keeps the selector label free of price suffixes', () => {
  const [priced] = toAdapterModels(catalog, { visible: null });
  assert.equal(priced.name, 'Alpha · ×0.5');
  const [plain] = toAdapterModels(catalog, { visible: null, showCost: false });
  assert.equal(plain.name, 'Alpha');
});

test('directory keeps the full catalog and marks visible/pinned flags', () => {
  const directory = toDirectory(catalog, { visible: ['alpha'], pinned: 'alpha' });
  assert.equal(directory.length, 3);
  assert.equal(directory[0].visible, true);
  assert.equal(directory[0].pinned, true);
  assert.equal(directory[1].visible, false);
  assert.equal(directory[1].free, true);
  assert.equal(directory[2].official, false);
});

test('directory marks the pinned model visible even when it is outside the whitelist', () => {
  const directory = toDirectory(catalog, { visible: ['beta'], pinned: 'alpha' });
  assert.equal(directory.find((model) => model.id === 'alpha').visible, true);
  assert.equal(directory.find((model) => model.id === 'beta').visible, true);
  assert.equal(directory.find((model) => model.id === 'gamma').visible, false);
});

test('directory exposes context options, output cap and promotion fields', () => {
  const [alpha] = toDirectory([{
    ...catalog[0],
    max_output_tokens: 64_000,
    promotion_active: true,
    discount: 0.8,
    status: 'idle',
    badge: '谷时 80%',
  }], { contextWindows: { alpha: 400_000 } });
  assert.deepEqual(alpha.contextWindowOptions, [100000, 200000]);
  assert.equal(alpha.contextWindow, 200000, 'override 仍按模型上限收敛');
  assert.equal(alpha.contextWindowMax, 200000);
  assert.equal(alpha.maxOutputTokens, 64000);
  assert.equal(alpha.promotionActive, true);
  assert.equal(alpha.discount, 0.8);
  assert.equal(alpha.badge, '谷时 80%');
  assert.equal(alpha.status, 'idle');
});

test('normalizeCatalog exposes context_config options and ignores the legacy input cap', () => {
  const { models } = normalizeCatalog({
    chat: [
      {
        key: 'capped', display_name: 'Capped', max_input_tokens: 180000,
        context_config: {
          a: { token_count: 200000, is_default: true },
          b: { token_count: 400000 },
          c: { token_count: 1000000 },
        },
      },
      {
        key: 'legacy', display_name: 'Legacy', max_input_tokens: 96000,
      },
    ],
  });
  const capped = models.find((model) => model.id === 'capped');
  assert.equal(capped.context_window, 200000);
  assert.equal(capped.context_window_max, 1000000);
  assert.deepEqual(capped.context_window_options, [200000, 400000, 1000000]);
  assert.equal(capped.max_input_tokens, 180000);
  const legacy = models.find((model) => model.id === 'legacy');
  assert.equal(legacy.context_window, 96000);
  assert.equal(legacy.context_window_max, 96000);
  assert.deepEqual(legacy.context_window_options, [96000]);
});
