/**
 * 客户端安装/协议/缓存诊断与脱敏诊断包。
 *
 * 只读：不启动客户端、不写 APPDATA、不接触令牌。诊断包里的邮箱和 uid
 * 都会截断，令牌样式统一替换成 <token>。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REGIONS } from './config.mjs';
import {
  appDataInfo, effectiveProtocol, findClient, installRoots, launcherState,
  readAppStatus, readEndpointCache, readUmidCache, versionDirs,
} from './client-env.mjs';
import { findRuntimeInfo, machineIdPath } from './umid.mjs';
import { desktopScanEnabled } from './desktop-auth.mjs';
import { readCatalogCache } from './state.mjs';
import { normalizeQuota } from './quota.mjs';

function rootExeNames(root) {
  try {
    return readdirSync(root).filter((name) => /\.exe$/i.test(name));
  } catch { return []; }
}

export function inspectClient(region) {
  const target = region === 'cn' ? 'cn' : 'global';
  const client = findClient(target);
  const roots = installRoots(target);
  const state = launcherState(target);
  const protocol = effectiveProtocol(target, { client });
  const appData = appDataInfo(target);
  const appStatus = readAppStatus(target);
  const umidCache = readUmidCache(target);
  const endpoint = readEndpointCache(target);
  const runtimeInfo = findRuntimeInfo(target);
  const machineId = machineIdPath(target);
  const versions = client?.root ? versionDirs(client.root).map((dir) => dir.split(/[\\/]/).pop()) : [];
  const rootExes = client?.root ? rootExeNames(client.root) : [];
  const exeProducts = new Set();
  for (const name of rootExes) {
    if (/^qoder(?:\s*cn)?\.exe$/i.test(name)) exeProducts.add(/cn/i.test(name) ? 'cn' : 'global');
  }
  return {
    region: target,
    client,
    roots,
    state,
    protocol,
    appData,
    appStatus,
    umidCache,
    endpoint,
    runtimeInfo,
    machineId: { path: machineId, exists: existsSync(machineId) },
    versions,
    rootExes,
    // 同一个安装目录里同时出现国际版/国内版 exe：自动更新可能把两套 resources 覆盖。
    mixedProducts: exeProducts.size > 1,
  };
}

function check(id, label, status, detail, hint = '') {
  return { id, label, status, detail, ...(hint ? { hint } : {}) };
}

export function clientDrift(previous, next) {
  if (!previous || !next) return null;
  if (!previous.appVersion && !previous.cliVersion) return null;
  if (!next.appVersion && !next.cliVersion) return null;
  if (previous.appVersion === next.appVersion && previous.cliVersion === next.cliVersion) return null;
  return {
    from: previous.appVersion || previous.cliVersion,
    to: next.appVersion || next.cliVersion,
    fromCli: previous.cliVersion || '',
    toCli: next.cliVersion || '',
  };
}

export function clientChecks({ region, auth = null, protocol = null, catalog = null, now = Date.now(), info: providedInfo = null } = {}) {
  const target = region === 'cn' ? 'cn' : 'global';
  const info = providedInfo || inspectClient(target);
  const checks = [];
  const cfg = REGIONS[target];

  if (!desktopScanEnabled()) {
    checks.push(check('desktop-scan', '本机账号扫描', 'na',
      '已通过 QODER_SCAN_DESKTOP=0 关闭本机官方客户端扫描；请用浏览器授权或 PAT 登录。',
      '需要自动导入本机桌面端/CLI 登录时，移除该环境变量后重启 dsh。'));
  }

  const manifest = info.client?.manifest || null;
  if (!info.client?.exists) {
    checks.push(check('qoder-client', 'Qoder 客户端', 'fail',
      `未找到 ${cfg.label}安装目录；可通过 QODER_INSTALL_DIR 显式指定。`,
      '打开 Qoder 客户端或设置安装目录环境变量后点「重新检查」。'));
  } else if (!manifest) {
    checks.push(check('qoder-client', 'Qoder 客户端', 'warn',
      `找到 ${info.client.root || '安装目录'}，但读不到 resources/umid/manifest.json。`,
      '客户端可能在重装中；重新打开客户端后再试。'));
  } else {
    const warnings = [];
    if (info.versions.length > 1) warnings.push(`保留 ${info.versions.length} 个版本目录（${info.versions.join(' / ')}）`);
    if (info.mixedProducts) warnings.push('同一目录出现国际版/国内版 exe，自动更新可能互相覆盖');
    checks.push(check('qoder-client', 'Qoder 客户端', warnings.length ? 'warn' : 'pass',
      `${info.client.root} · app ${manifest.appVersion || '未知'} · cli ${manifest.cliVersion || '未知'}${warnings.length ? ` · ${warnings.join('；')}` : ''}`,
      warnings.length ? '把两个版本分别装到独立目录，并清理共用的更新缓存。' : ''));
  }

  const manifestCli = String(manifest?.cliVersion || '');
  const cosyVersion = String(protocol?.cosyVersion || '');
  const source = protocol?.source?.cosy || 'unknown';
  if (!manifestCli) {
    checks.push(check('client-protocol', 'COSY 协议版本', 'warn',
      `客户端未提供 CLI 版本，插件使用兜底 ${cosyVersion}（来源 ${source}）。`,
      '升级插件或重新安装客户端后再检查。'));
  } else if (cosyVersion !== manifestCli) {
    checks.push(check('client-protocol', 'COSY 协议版本', 'warn',
      `插件发送 ${cosyVersion}，客户端内置 ${manifestCli}；版本不一致可能导致 430/401。`,
      `设置 QODER_COSY_VERSION=${manifestCli} 或升级插件后重启 dsh。`));
  } else {
    checks.push(check('client-protocol', 'COSY 协议版本', 'pass',
      `${cosyVersion}（来源 ${source}） · UA ${protocol?.oauthUa || '—'}`));
  }

  if (info.runtimeInfo && info.machineId.exists) {
    checks.push(check('umid', '设备身份', 'pass', `runtime-info 可用 · ${info.runtimeInfo}`));
  } else if (info.umidCache && info.machineId.exists) {
    checks.push(check('umid', '设备身份', 'warn',
      'runtime-info 不可用，签到将使用 umid-cache.json 兜底。',
      '重新打开 Qoder 客户端让 runtime-info 恢复；缓存兜底可能受活动风控限制。'));
  } else {
    checks.push(check('umid', '设备身份', 'fail',
      `缺少 ${!info.machineId.exists ? 'auth.machine-id' : 'runtime-info.exe'}，无法领取每日活动。`,
      '在对应地区 Qoder 客户端登录并保持安装完整。'));
  }

  const authFile = info.appData.dir ? join(info.appData.dir, 'auth.v1.dat') : '';
  if (info.appData.dir && existsSync(authFile)) {
    const sourceText = info.appData.source === 'location' ? '（数据目录已搬迁，按 location.v1.json 找到）' : '';
    checks.push(check('app-data-dir', '客户端数据目录', 'pass', `${info.appData.dir}${sourceText}`));
  } else if (info.appData.dir) {
    checks.push(check('app-data-dir', '客户端数据目录', 'warn',
      `找到数据目录 ${info.appData.dir}，但没有 auth.v1.dat；客户端可能未登录。`,
      '在 Qoder 客户端登录后，面板点「重新扫描」。'));
  } else {
    const nonWindows = process.platform !== 'win32';
    checks.push(check('app-data-dir', '客户端数据目录', nonWindows ? 'na' : 'fail',
      nonWindows
        ? '桌面端凭据导入目前仅支持 Windows；macOS / Linux 请用 qodercli 登录后导入，或使用浏览器授权 / PAT。'
        : `APPDATA 下没有 ${cfg.appDir}，location.v1.json 也没有可用目标。`,
      // QODER_AUTH_FILE 从来没有任何代码读取，让用户去设一个无效变量只会白折腾。
      nonWindows ? '这不是故障：CLI / PAT 路径仍然可用。' : '重新安装客户端并在其中登录，或用 PAT 登录。'));
  }

  const cache = catalog;
  if (!cache) {
    checks.push(check('cache-account', '目录缓存', 'warn', '还没有目录缓存；首次刷新后生成。'));
  } else if (!cache.models?.length) {
    checks.push(check('cache-account', '目录缓存', 'fail', '目录缓存为空或损坏，模型选择器可能为空。', '点「刷新目录」重建缓存。'));
  } else {
    const authUid = String(auth?.user?.id || '');
    const same = !authUid || cache.account === authUid || cache.account === `email:${auth?.user?.email || ''}`;
    const stale = Number(cache.schema) < 6 || (manifestCli && cache.cliVersion && cache.cliVersion !== manifestCli);
    if (!same) {
      checks.push(check('cache-account', '目录缓存', 'warn',
        '目录缓存属于另一个账号，已保留但会在后台刷新；不会把旧账号目录当成当前模型。',
        '点「刷新目录」立即重建。'));
    } else if (stale) {
      checks.push(check('cache-account', '目录缓存', 'warn',
        `目录来自旧客户端版本（schema ${cache.schema || 0} · cli ${cache.cliVersion || '未知'}），后台刷新中。`,
        '不需要手动清缓存；刷新完成后版本会更新。'));
    } else {
      checks.push(check('cache-account', '目录缓存', 'pass',
        `${cache.models.length} 个模型 · ${new Date(Number(cache.at) || now).toLocaleString('zh-CN')}`));
    }
  }

  if (info.endpoint?.url) {
    checks.push(check('endpoint', '推理端点', 'pass', `${info.endpoint.url}（客户端 endpoint cache）`));
  } else {
    checks.push(check('endpoint', '推理端点', 'warn',
      `没有可用的 endpoint cache，使用静态候选 ${cfg.gateways[0] || '—'}。`,
      '打开 Qoder 客户端让它写入 endpoint cache；静态候选仍可用。'));
  }

  return { checks, info };
}

function maskEmail(value) {
  const text = String(value || '');
  const at = text.indexOf('@');
  if (at <= 0) return text ? '<email>' : '';
  return `${text.slice(0, 1)}***@${text.slice(at + 1)}`;
}

function maskUid(value) {
  const text = String(value || '');
  return text ? `…${text.slice(-6)}` : '';
}

function sanitizeText(value) {
  return String(value)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (email) => maskEmail(email))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (uid) => `…${uid.slice(-6)}`)
    .replace(/\b(pt|dt|jt|jrt|drt|jot)-[A-Za-z0-9._-]{6,}/g, '<token>')
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer <token>')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '<token>');
}

function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = sanitizeDeep(child);
    return out;
  }
  return value;
}

export function buildDiagBundle({ status = {}, checks = [], protocol = null, info = null } = {}) {
  const client = info || {};
  const manifest = client.client?.manifest || {};
  const quota = normalizeQuota(status.extras?.quota, {
    plan: status.extras?.plan,
    auth: status.account ? { user: { id: status.account.uid } } : null,
    at: status.extrasAt,
  });
  const bundle = {
    at: new Date().toISOString(),
    plugin: { version: status.version || '', installedVersion: status.installedVersion || '', region: status.region || '' },
    signedIn: Boolean(status.signedIn),
    account: status.account ? {
      name: String(status.account.name || ''),
      email: maskEmail(status.account.email),
      uid: maskUid(status.account.uid),
      source: status.account.source || '',
      plan: status.account.plan || '',
    } : null,
    client: {
      appVersion: manifest.appVersion || protocol?.appVersion || '',
      cliVersion: manifest.cliVersion || protocol?.cliVersion || '',
      cosyVersion: protocol?.cosyVersion || '',
      oauthUa: protocol?.oauthUa || '',
      protocolSource: protocol?.source || {},
      installRoot: client.client?.root || '',
      manifestPath: manifest.path || '',
      versions: client.versions || [],
      mixedProducts: client.mixedProducts === true,
      dataDir: client.appData?.dir || '',
      dataDirSource: client.appData?.source || '',
      appStatus: client.appStatus ? { loggedIn: client.appStatus.logged_in === true, version: client.appStatus.version || '' } : null,
      umidSource: client.runtimeInfo ? 'runtime-info' : (client.umidCache ? 'umid-cache' : ''),
      endpoint: client.endpoint?.url || '',
    },
    catalog: status.catalog ? {
      count: Number(status.catalog.count) || 0,
      at: Number(status.catalog.at) || 0,
      error: String(status.catalog.error || ''),
    } : null,
    quota: quota ? {
      planName: quota.planName,
      totals: quota.totals,
      unlimited: quota.unlimited,
      exceeded: quota.exceeded,
      expiresAt: quota.expiresAt,
      warnings: quota.warnings.map((warning) => warning.code),
    } : null,
    checks: (checks || []).map((item) => ({
      id: item.id, label: item.label, status: item.status, detail: String(item.detail || ''), hint: item.hint || '',
    })),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  const parsed = sanitizeDeep(bundle);
  parsed.redacted = true;
  return parsed;
}
