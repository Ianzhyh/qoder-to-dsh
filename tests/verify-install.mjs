/**
 * 安装自检：`npm run verify`
 *
 * 只做只读检查 + 可选的在线探活，回答一个具体问题：
 * 「这个插件是不是真的被 dsh 加载了，而不是只躺在 node_modules 里？」
 *
 * 之所以需要它：dsh 里「装包」和「选 bundle」是两件事。
 * `package.json` 的 dependencies 有包名，只代表 pnpm 装下来了；
 * 只有 dsh.profile.bundles 里也出现包名，Loader 才会插入条目。
 * 只做前者时，插件完全不加载，也不报任何错——正是本仓库踩过的坑。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(here, '..');

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(DSH_HOME, 'profiles', PROFILE);

const results = [];
const check = (ok, label, detail = '', hint = '') => {
  results.push({ ok, label, detail, hint });
};

const readJson = (path) => {
  try {
    // 编辑器/PowerShell 写出的 UTF-8 BOM 会让 JSON.parse 直接失败，
    // 那种情况下报「没有依赖」是误导，所以先剥掉 BOM。
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
};

const manifest = readJson(join(PACKAGE_ROOT, 'package.json'));
const PKG_NAME = manifest?.name || 'qoder-to-dsh';

// ── 1. 包本身 ────────────────────────────────────────────────────────────────
check(Boolean(manifest), '读取 package.json', PACKAGE_ROOT);
check(Boolean(manifest?.dsh?.bundle?.patch), '声明 bundle patch', manifest?.dsh?.bundle?.patch || '缺少 dsh.bundle.patch');
check(existsSync(join(PACKAGE_ROOT, 'cordis.patch.yml')), 'patch 文件存在', 'cordis.patch.yml');
check(Boolean(manifest?.dsh?.client?.platform), '声明 client 平台', manifest?.dsh?.client?.platform || '缺少 dsh.client.platform');

// patch 里的 name 必须与真实包名一致，否则 Loader 静默跳过这一行。
let patchName = null;
try {
  const patch = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8');
  patchName = /^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/m.exec(patch)?.[1] || null;
} catch { /* 已在上一项报过 */ }
check(
  patchName === PKG_NAME,
  'patch 里的 name 与包名一致',
  `patch=${patchName || '未读到'} · package=${PKG_NAME}`,
  '不一致时 dsh 会把该 Loader 行当作未知包静默跳过，不报错。',
);

// 展示元数据：缺了不影响运行，但插件列表里只剩裸包名和默认图标。
const iconPath = manifest?.icon ? join(PACKAGE_ROOT, manifest.icon) : join(PACKAGE_ROOT, 'icon.svg');
check(existsSync(iconPath), '展示图标存在', iconPath);
const hasLocale = ['en', 'zh'].every((lang) =>
  existsSync(join(PACKAGE_ROOT, 'locale', `${lang}.json`)));
check(hasLocale, '展示文案 locale/en.json + locale/zh.json', 'meta.title / meta.description');

// ── 2. profile 是否真的选中了它 ──────────────────────────────────────────────
const profileManifest = readJson(join(PROFILE_DIR, 'package.json'));
check(Boolean(profileManifest), `读取 profile: ${PROFILE}`, PROFILE_DIR);

const dependency = profileManifest?.dependencies?.[PKG_NAME];
const bundles = profileManifest?.dsh?.profile?.bundles || [];
const selected = bundles.includes(PKG_NAME);

check(Boolean(dependency), 'profile 已声明依赖', dependency || `dependencies 里没有 ${PKG_NAME}`);
check(
  selected,
  'profile 已选中 bundle',
  selected ? `bundles[${bundles.indexOf(PKG_NAME)}]` : `dsh.profile.bundles 里没有 ${PKG_NAME}`,
  '只有依赖没有 bundle 选择 => 插件完全不加载。用 dsh 设置→插件 安装，或 plugin_manager install_bundle。',
);

// link: 安装时确认软链指向本仓库，而不是另一份旧拷贝。
if (dependency && /^link:/i.test(dependency)) {
  const target = dependency.slice(5);
  const resolved = isAbsolute(target) ? target : resolve(PROFILE_DIR, target);
  const same = resolve(resolved).toLowerCase() === resolve(PACKAGE_ROOT).toLowerCase();
  check(same, 'link: 指向本仓库', `${relative(PROFILE_DIR, resolved) || resolved}`, same ? '' : `当前仓库是 ${PACKAGE_ROOT}`);
}

// ── 3. 运行态（可选）：dsh 起没起、路由通不通 ────────────────────────────────
const baseURL = process.env.DSH_WEB_URL || 'http://127.0.0.1:9432';
let live = null;
if (!process.argv.includes('--offline')) {
  try {
    const res = await fetch(`${baseURL}/qoder/status`, {
      signal: AbortSignal.timeout(Number(process.env.QODER_VERIFY_TIMEOUT_MS || 8000)),
    });
    live = res.ok ? await res.json() : null;
  } catch { live = null; }
}

if (live) {
  check(true, 'dsh 运行中，面板路由可达', baseURL);
  check(Boolean(live.signedIn), 'Qoder 已登录', live.signedIn
    ? `${live.account?.name || live.account?.email || ''} · ${live.regionLabel} · 来源 ${live.account?.sourceLabel || live.account?.source || '未知'}`
    : '尚未登录，打开 设置 → Qoder 完成授权');
  check(Boolean(live.route?.registered), '原生模型路由已注册', live.route?.registered
    ? `provider=${live.route.provider}`
    : (live.route?.error || '未注册'));
  check((live.catalog?.count || 0) > 0, '模型目录非空', `${live.catalog?.count || 0} 个模型 · 可见 ${live.catalog?.visibleCount || 0} 个`);
  check(!live.catalog?.error, '目录最近一次刷新无错误', live.catalog?.error || 'ok');
} else if (!process.argv.includes('--offline')) {
  check(false, 'dsh 运行中，面板路由可达', baseURL, 'dsh 没启动时这一步会失败，可以用 npm run verify -- --offline 跳过。');
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const ok = results.every((r) => r.ok);
const pad = Math.max(...results.map((r) => r.label.length));
console.log(`\nqoder-to-dsh 安装自检 · profile=${PROFILE}\n`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(pad)}  ${r.detail || ''}`);
  if (!r.ok && r.hint) console.log(`        ${' '.repeat(pad)}  -> ${r.hint}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${ok ? '全部通过' : `${failed} 项未通过`}（共 ${results.length} 项）\n`);
process.exit(ok ? 0 : 1);
