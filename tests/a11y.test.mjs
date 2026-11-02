import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'dsh-plugin', 'lib', 'client.js'), 'utf8');

test('every panel tab has a tab/panel id pair', () => {
  const tabsBlock = /const tabs = \[([\s\S]*?)\n      \];/.exec(source)?.[1] || '';
  const ids = [...tabsBlock.matchAll(/\['([a-z]+)', '/g)].map((match) => match[1]);
  assert.ok(ids.length >= 9, `tabs 解析失败：${ids.join(',')}`);
  for (const id of ids) {
    assert.ok(source.includes(`id: \`qdr-\${id}-tab\``), `tab ${id} 缺少 id`);
    assert.ok(source.includes(`'aria-controls': \`qdr-\${id}-panel\``), `tab ${id} 缺少 aria-controls`);
    const hasPanel = source.includes(`panelProps('${id}'`)
      || source.includes(`id: 'qdr-${id}-panel'`)
      || (id === 'checkin' && source.includes(`'aria-labelledby': 'qdr-checkin-tab'`))
      || (id === 'trial' && source.includes(`'aria-labelledby': 'qdr-trial-tab'`));
    assert.ok(hasPanel, `panel ${id} 缺少 id/aria-labelledby`);
  }
});

test('panel styles avoid decorative gradients and respect reduced motion', () => {
  assert.ok(!/gradient\(/i.test(source), '面板不应使用渐变');
  assert.ok(source.includes('prefers-reduced-motion'), '必须尊重 reduced motion');
  assert.ok(source.includes('prefers-reduced-transparency'), '必须尊重 reduced transparency');
  assert.ok(source.includes('role: \'tablist\''), '页签需要 tablist 语义');
  assert.ok(source.includes('role: \'tabpanel\''), '面板需要 tabpanel 语义');
});
