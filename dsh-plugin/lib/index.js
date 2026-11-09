/**
 * qoder-to-dsh —— 宿主端入口。
 *
 * 和传统「桥 + 控制台 + 插件」三进程方案不同，这里只有一个进程：
 *   - 凭据、目录、流式转发全部在插件内完成；
 *   - 不再监听第二个端口，也不会出现「桥在跑但插件连不上」的状态分裂；
 *   - 面板直接读插件内存态，数字与模型选择器同源。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION, PROVIDER, DISPLAY_NAME, REGIONS, DEFAULTS, PATHS, PACKAGE_ROOT } from '../../lib/config.mjs';
import { effectiveProtocol } from '../../lib/client-env.mjs';
import { buildDiagBundle, clientChecks, clientDrift, inspectClient } from '../../lib/diagnostics.mjs';
import { QoderAdapter } from '../../lib/adapter.mjs';
import { createTools } from '../../lib/tools.mjs';
import { createRouteTable, mountRoutes } from './routes.mjs';
import { QoderClient } from '../../lib/qoder-api.mjs';
import { invalidateDesktopScan, prewarmDesktopKeysAsync, scanDesktopAuth } from '../../lib/desktop-auth.mjs';
import { readCredentialScheme } from '../../lib/secret-store.mjs';
import { disposeChatTransport } from '../../lib/chat-transport.mjs';
import {
  appendUsage, clearUsage as clearUsageFile, creditsReport, ensureUsageDaily, flushUsageSync,
  isProbe, isWritableDir, log as writeLog, localDayKey, readCheckin, readPrefs, readUsage,
  readUsageDaily, reconcileUsage, recentLogs, summarizeRequests, summarizeUsage, writeCheckin, writePrefs,
  readClientRuntime, writeClientRuntime, readCatalogCache,
} from '../../lib/state.mjs';
import {
  ADDON_VALIDITY_FALLBACK_DAYS, addonBatches, beijingDateKey, beijingHour, buildCheckinAccounts,
  checkinCanClaim, claimCampaigns, nextRunAt, summarizeCheckinAccounts,
} from '../../lib/checkin.mjs';
import { deviceAvailability } from '../../lib/umid.mjs';
import { normalizeQuota, quotaSummaryText } from '../../lib/quota.mjs';
import {
  applyAccountPrefs, mergeAccounts, publicAccountRow, readAccounts, syncKnownAccounts, writeAccounts,
} from '../../lib/accounts.mjs';
import {
  findPat, publicPatStore, readPatStore, removePat, upsertPat, writePatStore,
} from '../../lib/pat-store.mjs';
import { toDirectory } from '../../lib/models.mjs';
import { setLocale, tr } from '../../lib/i18n.mjs';

export const name = 'qoder';
export const inject = ['llm'];

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 已加载代码的版本来自 config；磁盘版本用于识别“升级了但宿主没重启”。 */
function installedVersion() {
  try {
    return String(JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

/** 每次快照都读磁盘版本：升级插件后无需重启就能发现“已在跑旧代码”。 */
function versionState() {
  const installed = installedVersion();
  return { installed, mismatch: Boolean(installed && installed !== VERSION) };
}

/** 诊断页额度结论：无数据是 warn，不是 pass。 */
export function quotaCheck(quota, extrasAt = 0, now = Date.now(), http = null) {
  const view = quota && Array.isArray(quota.groups) && quota.totals
    ? quota
    : normalizeQuota(quota, { at: extrasAt, now, http: http || {} });
  if (!view || !view.packages?.length) {
    const when = Number(extrasAt) > 0 ? `（上次成功：${new Date(Number(extrasAt)).toLocaleString('zh-CN')}）` : '';
    const quotaHttp = Number(http?.quota) || 0;
    const oldBuild = quotaHttp === 404 || quotaHttp === 405 ? `；额度接口返回 ${quotaHttp}，宿主可能是旧构建` : '';
    return {
      id: 'quota',
      label: '账号额度',
      status: 'warn',
      detail: `上游未返回额度数据${when}，无法确认剩余额度${oldBuild}。`,
    };
  }
  const unit = view.packages[0]?.unit || 'credits';
  const unitText = /^credits?$/i.test(String(unit)) ? 'Credits' : unit;
  const stale = Number(extrasAt) > 0 && now - Number(extrasAt) > 5 * 60_000;
  const empty = !view.unlimited && view.totals.total <= 0 && view.totals.remaining <= 0 && !(view.usagePercent > 0);
  const emptyWarning = (view.warnings || []).some((warning) => warning.code === 'empty');
  const oldBuild = (view.warnings || []).some((warning) => warning.code === 'oldBuild');
  let detail = quotaSummaryText(view);
  const unknownRemaining = view.packages.some((item) => !item.unlimited && item.remainingKnown === false);
  if (view.unlimited) detail = `不限量${view.totals.used ? ` · 已用 ${view.totals.used} ${unitText}` : ''}`;
  else if (view.totals.total > 0 && !unknownRemaining) detail = `剩余 ${view.totals.remaining} / ${view.totals.total} ${unitText}`;
  if (view.exceeded) detail += ' · 已用尽';
  if (oldBuild) detail += ' · 额度接口返回 404/405，宿主可能是旧构建';
  if (stale) detail += ` · 数据更新于 ${new Date(Number(extrasAt)).toLocaleString('zh-CN')}`;
  return {
    id: 'quota',
    label: '账号额度',
    status: view.exceeded || empty || emptyWarning || stale || oldBuild || unknownRemaining ? 'warn' : 'pass',
    detail,
  };
}

const asBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !/^(0|false|no|off)$/i.test(String(value));
};

export function resolveConfig(raw = {}) {
  const env = process.env;
  const region = String(raw.region || env.QODER_REGION || DEFAULTS.region) === 'cn' ? 'cn' : 'global';
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const defaultTemperature = (() => {
    const value = raw.defaultTemperature === undefined ? undefined : num(raw.defaultTemperature, undefined);
    return typeof value === 'number' ? Math.min(2, value) : undefined;
  })();
  return {
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    region,
    regionLabel: REGIONS[region].label,
    catalogTtlMs: num(raw.catalogTtlMs, DEFAULTS.catalogTtlMs),
    extrasTtlMs: num(raw.extrasTtlMs === undefined ? env.QODER_EXTRAS_TTL_MS : raw.extrasTtlMs, DEFAULTS.extrasTtlMs),
    streamIdleTimeoutMs: num(raw.streamIdleTimeoutMs, DEFAULTS.streamIdleTimeoutMs),
    firstByteTimeoutMs: num(raw.firstByteTimeoutMs, DEFAULTS.firstByteTimeoutMs),
    showCost: asBool(raw.showCost, true),
    defaultMaxTokens: Math.floor(num(raw.defaultMaxTokens, 0)),
    defaultTemperature,
    defaultReasoningEffort: typeof raw.defaultReasoningEffort === 'string' ? raw.defaultReasoningEffort : '',
    tools: asBool(raw.tools, true),
    commands: asBool(raw.commands, true),
    routes: asBool(raw.routes, true),
    checkin: asBool(raw.checkin, true),
  };
}

export function sanitizePrefs(input, current) {
  const known = new Set(['visible', 'pinned', 'includeAll', 'contextWindowByModel', 'paramsByModel', 'uiLocale']);
  // normalizePrefs 会保留未知顶层键，但保存时如果只回写已知键，升级后回滚
  // 或者未来版本写的字段会在一次保存后消失。这里把 current 里的未知键原样带回。
  const extras = {};
  for (const [key, value] of Object.entries(current || {})) {
    if (known.has(key) || key === 'at' || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    extras[key] = value;
  }
  const visible = input?.visible === null
    ? null
    : (Array.isArray(input?.visible)
      ? [...new Set(input.visible.map(String).filter(Boolean))]
      : current.visible);
  const contextWindowByModel = {};
  if (input?.contextWindowByModel && typeof input.contextWindowByModel === 'object') {
    for (const [id, value] of Object.entries(input.contextWindowByModel)) {
      const n = Number(value);
      if (id && Number.isSafeInteger(n) && n > 0) contextWindowByModel[id] = n;
    }
  } else {
    Object.assign(contextWindowByModel, current.contextWindowByModel || {});
  }
  const paramsByModel = {};
  if (input?.paramsByModel && typeof input.paramsByModel === 'object') {
    for (const [id, value] of Object.entries(input.paramsByModel)) {
      if (!value || typeof value !== 'object') continue;
      const out = {};
      if (typeof value.temperature === 'number' && Number.isFinite(value.temperature)) {
        out.temperature = Math.min(2, Math.max(0, value.temperature));
      }
      if (Number.isInteger(value.maxTokens) && value.maxTokens > 0) out.maxTokens = value.maxTokens;
      if (typeof value.reasoningEffort === 'string' && value.reasoningEffort) out.reasoningEffort = value.reasoningEffort;
      if (Object.keys(out).length) paramsByModel[id] = out;
    }
  } else {
    Object.assign(paramsByModel, current.paramsByModel || {});
  }
  return {
    ...extras,
    visible,
    pinned: typeof input?.pinned === 'string' ? input.pinned : current.pinned,
    includeAll: typeof input?.includeAll === 'boolean' ? input.includeAll : current.includeAll,
    uiLocale: input?.uiLocale === 'en' || input?.uiLocale === 'zh'
      ? input.uiLocale
      : (current.uiLocale === 'en' ? 'en' : 'zh'),
    contextWindowByModel,
    paramsByModel,
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const log = (message, detail) => {
    writeLog(`[qoder] ${message}`, detail);
  };

  const state = {
    route: { registered: false, provider: config.provider, error: '' },
    lastError: '',
    pendingDevice: null,
    startedAt: Date.now(),
    catalogError: '',
  };

  const prefs = readPrefs();
  setLocale(prefs.uiLocale);
  let notifyCatalogUpdated = () => {};
  let authChangeTimer = null;
  let checkinKickTimer = null;
  let disposed = false;
  const client = new QoderClient({
    region: config.region,
    catalogTtlMs: config.catalogTtlMs,
    extrasTtlMs: config.extrasTtlMs,
    log,
    // 后台 stale-while-revalidate 拿到新目录后，让 DSH 的选择器跟着更新。
    onAuthChange: () => {
      state.pendingDevice = null;
      adapter.invalidate();
      adapter.warmup().then(() => notifyAdaptersUpdated(), () => notifyAdaptersUpdated());
      if (authChangeTimer) clearTimeout(authChangeTimer);
      authChangeTimer = setTimeout(() => {
        authChangeTimer = null;
        if (disposed) return;
        try { kickAutoCheckin(); } catch (error) { log('登录后触发自动签到失败', String(error?.message || error)); }
      }, 1500);
      if (authChangeTimer.unref) authChangeTimer.unref();
    },
  });

  // 客户端版本漂移：升级 Qoder 后旧目录/旧令牌可能先被用到。只提示和刷新，
  // 不清凭据、不自动降级协议；是否重新登录由用户决定。
  const clientRuntime = (() => {
    const protocol = effectiveProtocol(config.region);
    const previous = readClientRuntime();
    const next = {
      appVersion: protocol.appVersion,
      cliVersion: protocol.cliVersion,
      protocolSource: protocol.source.cosy,
    };
    const drift = clientDrift(previous, next);
    try { writeClientRuntime(next); } catch (error) { log('保存客户端版本失败', String(error?.message || error)); }
    if (drift) {
      client.invalidateCatalog();
      log('Qoder 客户端已升级', `${drift.from || '旧版本'} → ${drift.to || '新版本'}；目录将在后台刷新`);
    }
    return { protocol, previous, current: next, drift };
  })();

  const adapter = new QoderAdapter({
    provider: config.provider,
    displayName: config.displayName,
    client,
    prefs,
    log,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    showCost: config.showCost,
    defaults: {
      maxTokens: config.defaultMaxTokens,
      temperature: config.defaultTemperature,
      reasoningEffort: config.defaultReasoningEffort,
    },
    getDefaultSelection: () => {
      try { return ctx.get('agentDefaultModel')?.currentSelection?.() || null; } catch { return null; }
    },
    resolveImage: async (ref) => {
      if (!ref?.attachmentId) return null;
      const attachments = ctx.get('attachments');
      if (!attachments) return null;
      const stored = await attachments.readImage(ref);
      const bytes = stored?.data ?? stored?.bytes ?? stored?.buffer;
      if (!bytes) return null;
      const mediaType = stored?.ref?.mediaType || ref.mediaType || 'image/png';
      return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
    },
  });

  // 后台刷新不一定有调用方在等：成功/失败都要同步到面板状态，不能只更新
  // client 自己的缓存，否则状态页会一直显示“上次成功”的旧目录。
  client.onCatalogUpdated = () => {
    state.catalogError = '';
    adapter.noteCatalogError('');
    notifyCatalogUpdated();
  };
  client.onCatalogError = (message) => {
    state.catalogError = String(message || '');
    adapter.noteCatalogError(state.catalogError);
  };

  // 把历史明细补成每日汇总；没有历史时不会创建空文件。
  // 传入已按当前目录校正的记录，避免旧免费模型的 Credits 在重建时被当成实扣。
  ensureUsageDaily(PATHS.usage, usageRecords()).catch((error) => log('重建每日用量汇总失败', String(error?.message || error)));

  const useService = (serviceName, fn) => {
    if (typeof ctx.inject === 'function') {
      ctx.inject([serviceName], (scope) => {
        const service = scope?.[serviceName] ?? scope?.get?.(serviceName);
        if (service) fn(service, scope);
      });
      return;
    }
    const service = ctx.get(serviceName);
    if (service) fn(service, ctx);
  };

  const llm = ctx.llm;
  const notifyAdaptersUpdated = () => {
    try {
      if (typeof llm?.emitAdaptersUpdated === 'function') {
        llm.emitAdaptersUpdated();
        return true;
      }
    } catch (error) {
      log('广播 llm/adapters-updated 失败（不影响本次变更）', error?.message || error);
    }
    return false;
  };
  notifyCatalogUpdated = () => { notifyAdaptersUpdated(); };

  // ── 原生模型路由 ──────────────────────────────────────────────────────
  try {
    llm.registerAdapter([config.provider], adapter);
    state.route = { registered: true, provider: config.provider, error: '' };
    log(`已注册原生模型路由 provider=${config.provider}`);
  } catch (error) {
    state.route = { registered: false, provider: config.provider, error: String(error?.message || error) };
    state.lastError = `注册 provider 失败：${state.route.error}`;
    log('注册 provider 失败', state.lastError);
  }

  // ── 运行态快照（工具 / 面板共用） ──────────────────────────────────────
  function usageRecords() {
    const catalog = adapter.catalogCache.models.length
      ? adapter.catalogCache.models
      : (client.catalogCache && client.catalogCache.models) || [];
    const freeIds = new Set(catalog.filter((model) => model.free === true).map((model) => model.id));
    return reconcileUsage(readUsage(), freeIds);
  }

  // 每日汇总覆盖被明细上限裁掉的历史；与 raw 明细按天二选一，避免重复计数。
  // seedRecords 用已校正的明细，保证免费模型的旧 Credits 不会在重建时变成实扣。
  const usageDaily = () => readUsageDaily(PATHS.usage, usageRecords());

  // 状态页必须显示实际生效的方式：DPAPI 在受限环境里会回退 AES，
  // 继续写死 “DPAPI” 会让用户误以为密钥没有落盘。
  function credentialProtection() {
    const scheme = readCredentialScheme(PATHS.auth);
    if (scheme === 'dpapi') return 'DPAPI';
    if (scheme === 'aes-256-gcm') return 'AES-256-GCM';
    if (scheme === 'missing') return process.platform === 'win32' ? 'DPAPI（登录后生效）' : 'AES-256-GCM';
    return '未知';
  }

  async function buildChecks({ deep = false, signal = null } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('诊断已取消');
    const checks = [];
    const status = client.status({ desktop: false });
    checks.push({
      id: 'auth',
      label: '登录凭据',
      status: status.signedIn ? 'pass' : 'fail',
      detail: status.signedIn
        ? `${status.account?.name || status.account?.email || '已登录'} · ${status.regionLabel}`
        : '尚未登录。到「账号」页使用设备授权或 PAT 登录。',
    });
    const restore = status.authRestore;
    if (restore && ['corrupt', 'invalid', 'import-failed'].includes(restore.state)) {
      checks.push({
        id: 'auth-restore',
        label: '凭据恢复',
        status: 'warn',
        detail: restore.state === 'corrupt'
          ? '本地凭据无法解密；不会自动切换账号，请到「账号」页重新授权。'
          : `本地凭据不可用：${restore.error || restore.state}；请重新授权。`,
      });
    }
    const scheme = readCredentialScheme(PATHS.auth);
    checks.push({
      id: 'credential',
      label: '凭据加密',
      status: scheme === 'unknown' || (process.platform === 'win32' && scheme === 'aes-256-gcm') ? 'warn' : 'pass',
      detail: scheme === 'unknown'
        ? '凭据文件无法解析，无法确认加密方式。'
        : process.platform === 'win32' && scheme === 'aes-256-gcm'
          ? 'DPAPI 不可用，已回退 AES-256-GCM（本机密钥与密文同目录）。功能可用，但建议确保数据目录仅本机用户可读。'
          : credentialProtection(),
    });
    const version = versionState();
    checks.push({
      id: 'version',
      label: '版本一致性',
      status: version.mismatch ? 'warn' : 'pass',
      detail: version.mismatch
        ? `已加载 v${VERSION}，磁盘 v${version.installed}；完全退出 dsh 再打开才会加载新代码。`
        : `v${VERSION}`,
    });
    const host = {
      llm: typeof ctx.llm?.registerAdapter === 'function',
      routes: config.routes ? Boolean(ctx.get?.('webServer')) : true,
      tools: typeof ctx.get?.('tools')?.register === 'function',
    };
    checks.push({
      id: 'host',
      label: '宿主能力',
      status: host.llm && host.routes && host.tools ? 'pass' : 'fail',
      detail: [
        host.llm ? 'llm.registerAdapter 可用' : 'llm.registerAdapter 缺失（dsh 版本过旧）',
        config.routes ? (host.routes ? 'webServer 可用' : 'webServer 缺失，面板数据面不会挂载') : '面板路由已关闭（不算失败）',
        host.tools ? 'tools 可用' : 'tools 缺失，斜杠命令/工具不可用',
      ].join(' · '),
      hint: host.llm ? '' : '升级 dsh 到 ≥ 0.2.1-rc.3 后完全重启。',
    });
    try {
      const clientDiag = clientChecks({
        region: status.region || config.region,
        auth: client.auth,
        protocol: clientRuntime.protocol,
        catalog: readCatalogCache(),
      });
      checks.push(...clientDiag.checks);
    } catch (error) {
      checks.push({
        id: 'qoder-client',
        label: 'Qoder 客户端',
        status: 'warn',
        detail: `客户端环境探测失败：${String(error?.message || error)}`,
      });
    }
    try {
      const pats = patSnapshot();
      checks.push({
        id: 'pat-store',
        label: 'PAT 凭据库',
        status: pats.error ? 'warn' : 'pass',
        detail: pats.error
          ? `无法读取：${pats.error}；原文件未删除。`
          : `${pats.count} 个已保存 PAT（只显示元数据，不包含令牌）`,
      });
    } catch (error) {
      checks.push({
        id: 'pat-store',
        label: 'PAT 凭据库',
        status: 'warn',
        detail: String(error?.message || error),
      });
    }
    if (status.signedIn) {
      const expired = status.token?.expiresAt && Number(status.token.expiresAt) <= Date.now();
      checks.push({
        id: 'token',
        label: '访问令牌',
        status: expired ? 'warn' : 'pass',
        detail: status.token?.needsRefresh
          ? '只有刷新令牌，首次请求会自动换取访问令牌。'
          : expired ? '已过期，下一次请求会自动尝试刷新。' : (status.token?.expiresLabel || '有效'),
      });
    }
    if (deep) {
      const started = Date.now();
      try {
        const result = await client.listCatalog({ refresh: true, signal });
        if (signal?.aborted) throw signal.reason || new Error('诊断已取消');
        checks.push({
          id: 'catalog',
          label: '模型目录',
          status: result.models.length ? 'pass' : 'fail',
          detail: `${result.models.length} 个模型 · ${Date.now() - started}ms${result.staleMs ? '（本次刷新失败，显示的是缓存）' : ''}${result.error ? ` · ${result.error}` : ''}`,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        checks.push({ id: 'catalog', label: '模型目录', status: 'fail', detail: String(error?.message || error) });
      }
    }
    checks.push({
      id: 'route',
      label: '原生模型路由',
      status: state.route.registered ? 'pass' : 'fail',
      detail: state.route.registered ? `provider=${state.route.provider}` : (state.route.error || '未注册'),
    });
    checks.push({
      id: 'storage',
      label: '本地状态目录',
      status: isWritableDir(PATHS.prefs) ? 'pass' : 'fail',
      detail: PATHS.prefs,
    });
    const prefs = adapter.prefs;
    const overrides = countOverrides(prefs);
    checks.push({
      id: 'prefs',
      label: '模型显示与参数',
      status: 'pass',
      detail: `${prefs.visible === null ? '全部模型可见' : `${(prefs.visible || []).length} 个模型可见`} · ${overrides} 个模型有自定义参数`,
    });
    try {
      const checkin = checkinSnapshot();
      checks.push({
        id: 'checkin',
        label: '每日签到',
        status: checkin.summary.errors ? 'warn' : 'pass',
        detail: checkin.summary.total
          ? `${checkin.summary.done}/${checkin.summary.total} 个账号今日已处理${checkin.summary.credits ? ` · +${checkin.summary.credits} Credits` : ''}${checkin.summary.errors ? ` · ${checkin.summary.errors} 个异常` : ''}`
          : '没有检测到可签到账号',
      });
    } catch (error) {
      checks.push({ id: 'checkin', label: '每日签到', status: 'warn', detail: String(error?.message || error) });
    }
    if (deep && status.signedIn) {
      try {
        const extras = await client.refreshExtras({ signal });
        if (signal?.aborted) throw signal.reason || new Error('诊断已取消');
        checks.push(quotaCheck(extras?.quotaView || extras?.quota, extras?.at || client.extrasAt, Date.now(), extras?.http));
      } catch (error) {
        if (signal?.aborted) throw error;
        checks.push({ id: 'quota', label: '账号额度', status: 'warn', detail: String(error?.message || error) });
      }
    }
    if (state.lastError) {
      checks.push({ id: 'last-error', label: '最近错误', status: 'warn', detail: state.lastError });
    }
    return checks;
  }

  async function snapshot({ signal, deep = false, desktop = true } = {}) {
    const status = client.status({ desktop });
    const usageRecordsList = usageRecords();
    const usage = summarizeUsage(usageRecordsList, 14, Date.now(), usageDaily());
    const directory = (() => {
      try {
        return toDirectory(adapter.catalogCache.models, {
          visible: adapter.prefs.visible,
          pinned: adapter.prefs.pinned,
          contextWindows: adapter.prefs.contextWindowByModel,
        });
      } catch { return []; }
    })();
    const checks = deep ? await buildChecks({ deep, signal }) : [];
    const version = versionState();
    return {
      version: VERSION,
      installedVersion: version.installed,
      versionMismatch: version.mismatch,
      provider: config.provider,
      displayName: config.displayName,
      region: status.region,
      regionLabel: status.regionLabel,
      client: {
        appVersion: clientRuntime.protocol.appVersion,
        cliVersion: clientRuntime.protocol.cliVersion,
        cosyVersion: clientRuntime.protocol.cosyVersion,
        oauthUa: clientRuntime.protocol.oauthUa,
        protocolSource: clientRuntime.protocol.source,
        upgrade: clientRuntime.drift,
      },
      signedIn: status.signedIn,
      account: status.account,
      token: status.token,
      authRestore: status.authRestore || null,
      extras: status.extras || null,
      extrasAt: status.extrasAt || 0,
      desktop: status.desktop || { available: false, candidates: [] },
      accounts: accountRows(),
      route: state.route,
      catalog: {
        count: adapter.catalogCache.models.length,
        visibleCount: directory.filter((model) => model.visible).length,
        at: adapter.catalogCache.at,
        error: adapter.catalogCache.error || state.catalogError,
        staleMs: adapter.catalogCache.staleMs || 0,
      },
      prefs: {
        pinned: adapter.prefs.pinned || '',
        visible: adapter.prefs.visible,
        includeAll: adapter.prefs.includeAll !== false,
        uiLocale: adapter.prefs.uiLocale === 'en' ? 'en' : 'zh',
        contextWindowByModel: adapter.prefs.contextWindowByModel || {},
        paramsByModel: adapter.prefs.paramsByModel || {},
      },
      customized: countOverrides(adapter.prefs),
      usage,
      recentFailures: usageRecordsList.filter((record) => !record.ok && !isProbe(record)).slice(-8).reverse(),
      directory,
      checks,
      config: {
        catalogTtlMs: config.catalogTtlMs,
        extrasTtlMs: config.extrasTtlMs,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
        firstByteTimeoutMs: config.firstByteTimeoutMs,
        defaultMaxTokens: config.defaultMaxTokens,
        defaultTemperature: config.defaultTemperature ?? null,
        defaultReasoningEffort: config.defaultReasoningEffort || '',
        providerDefaultMaxTokens: DEFAULTS.providerMaxOutputTokens,
        dataDir: PATHS.prefs ? dirname(PATHS.prefs) : '',
        authPath: PATHS.auth,
        pluginDir: PLUGIN_DIR,
        credentialProtection: credentialProtection(),
      },
      runtime: { node: process.version, pid: process.pid, uptimeMs: Date.now() - state.startedAt },
      lastError: state.lastError,
    };
  }

  async function directory({ refresh = false } = {}) {
    try {
      await adapter.catalog({ refresh });
      state.catalogError = '';
    } catch (error) {
      state.catalogError = String(error?.message || error);
      state.lastError = state.catalogError;
    }
    const models = toDirectory(adapter.catalogCache.models, {
      visible: adapter.prefs.visible,
      pinned: adapter.prefs.pinned,
      contextWindows: adapter.prefs.contextWindowByModel,
    });
    return {
      at: adapter.catalogCache.at,
      staleMs: adapter.catalogCache.staleMs || 0,
      error: adapter.catalogCache.error || state.catalogError || '',
      models,
    };
  }

  function clampContextOverrides(map) {
    if (!map || !Object.keys(map).length) return;
    const limits = new Map(toDirectory(adapter.catalogCache.models || [])
      .map((model) => [model.id, Number(model.contextWindowMax) || 0]));
    for (const [id, value] of Object.entries(map)) {
      const limit = limits.get(id) || 0;
      if (limit > 0 && value > limit) map[id] = limit;
    }
  }

  async function savePrefs(input) {
    const saved = sanitizePrefs(input || {}, adapter.prefs);
    clampContextOverrides(saved.contextWindowByModel);
    writePrefs(saved);
    setLocale(saved.uiLocale);
    adapter.setPrefs(saved);
    adapter.setContextWindows(saved.contextWindowByModel);
    adapter.setModelParams(saved.paramsByModel);
    const notified = notifyAdaptersUpdated();
    return {
      prefs: {
        pinned: saved.pinned,
        visible: saved.visible,
        includeAll: saved.includeAll,
        uiLocale: saved.uiLocale,
        contextWindowByModel: saved.contextWindowByModel || {},
        paramsByModel: saved.paramsByModel || {},
      },
      customized: countOverrides(saved),
      notified,
    };
  }

  function countOverrides(prefs) {
    const ids = new Set([
      ...Object.keys(prefs.contextWindowByModel || {}),
      ...Object.keys(prefs.paramsByModel || {}),
    ]);
    return ids.size;
  }

  // ── 每日签到（多账号） ────────────────────────────────────────────────
  // 账号展示偏好与已见账号快照共用 accounts.json，必须在 checkinAccounts 之前初始化。
  let accountState = readAccounts();
  let checkinState = readCheckin();
  const checkinRuns = new Map();
  const checkinAbort = new AbortController();
  let autoCheckinTimer = null;
  let autoCheckinKick = null;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function checkinAccounts() {
    // 不走 status()：那里会扫描本机账号，自动签到没必要为此阻塞事件循环。
    const rows = buildCheckinAccounts({ activeAuth: client.auth, activeRegion: client.auth?.region || client.region });
    // 官方客户端同区只保留一份登录态，再登录会覆盖上一份。用已见账号快照补回，
    // 列表才不会因为上游覆盖而突然少一行（缺失的标 missing，不参与签到）。
    const synced = syncKnownAccounts(rows, accountState);
    if (synced.changed) {
      try {
        accountState = writeAccounts(synced.state);
      } catch (error) {
        log('保存已见账号快照失败', String(error?.message || error));
      }
    }
    return synced.rows;
  }

  /**
   * 首次启用时把「领取账本」补出来：签到结果里最近一次 + 运行日志里更早的领取。
   * 日志行没有 uid，只能按「区域 + 昵称」对回账号；对不上的宁可丢掉——
   * 差额会以「到期未知」批次出现，而不是编一个日期。
   */
  function seedCheckinLedger() {
    if (checkinState.ledger.length) return;
    const rows = checkinAccounts();
    const seeded = [];
    const seen = new Set();
    const push = (entry) => {
      if (!entry.at || !entry.credits) return;
      const dedupe = `${entry.key}:${beijingDateKey(entry.at)}:${entry.credits}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      seeded.push(entry);
    };
    for (const row of Object.values(checkinState.results)) {
      if ((row.status === 'claimed' || row.status === 'already') && row.credits > 0) {
        push({ key: row.key, region: row.region, uidTail: row.uidTail || '', at: row.checkedAt, credits: row.credits, validityDays: 0 });
      }
    }
    try {
      const text = readFileSync(PATHS.log, 'utf8');
      const pattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z \[qoder\] 签到 · (Qoder 国际版|Qoder 国内版) · (.*?): (?:claimed|already)(?: \+(\d+))/gm;
      for (const match of text.matchAll(pattern)) {
        const at = Date.parse(`${match[1]}Z`);
        const credits = Number(match[4]) || 0;
        if (!Number.isFinite(at) || !credits) continue;
        const region = match[2] === 'Qoder 国内版' ? 'cn' : 'global';
        const label = match[3].trim();
        const row = rows.find((item) => item.region === region
          && (item.label === label || accountState.aliases[item.key] === label));
        if (!row) continue;
        push({ key: row.key, region, uidTail: row.uidTail || '', at, credits, validityDays: 0 });
      }
    } catch { /* 日志读不到就只用 results */ }
    if (seeded.length) {
      try {
        checkinState = writeCheckin({ ...checkinState, ledger: seeded });
        log(`已从签到结果与运行日志回填 ${seeded.length} 条领取账本（用于推算加购额度到期）`);
      } catch { /* 保底不阻塞启动 */ }
    }
  }
  seedCheckinLedger();

  /**
   * 当前账号的加购额度分批视图（额度卡「每日赠送」用）。
   * remaining 取自额度视图的 addOnQuota；账本按当前账号过滤。
   */
  function addonBatchesForActive() {
    try {
      const view = client.extras && client.extras.quotaView;
      const addOn = (view && view.packages || []).find((item) => item.source === 'addOnQuota');
      const remaining = addOn ? Math.max(0, Number(addOn.remaining) || 0) : 0;
      if (!remaining) return null;
      const region = client.auth && client.auth.region ? client.auth.region : config.region;
      const uid = String(client.auth && client.auth.user ? client.auth.user.id || '' : '');
      const key = `${region}:${uid || 'active'}`;
      return addonBatches({
        ledger: (checkinState.ledger || []).filter((item) => item.key === key),
        remaining,
        fallbackDays: ADDON_VALIDITY_FALLBACK_DAYS,
      });
    } catch {
      return null;
    }
  }

  // ── 账号展示偏好（别名/顺序/隐藏） ──────────────────────────────────
  function accountRows() {
    const rows = checkinAccounts();
    const applied = applyAccountPrefs(rows, accountState);
    const expose = (row) => {
      const pub = publicAccountRow(row);
      return pub ? { ...pub, regionLabel: REGIONS[pub.region]?.label || '' } : null;
    };
    const active = rows.find((row) => row.active);
    return {
      accounts: applied.visible.map(expose).filter(Boolean),
      hidden: applied.hidden.map(expose).filter(Boolean),
      total: applied.all.length,
      activeKey: active ? active.key : '',
      current: accountState.current || (active ? active.key : ''),
      prefs: {
        order: [...accountState.order],
        aliases: { ...accountState.aliases },
        hidden: Object.keys(accountState.hidden),
      },
    };
  }

  // 用量账本只存 uid 尾号；渲染时映射回别名/昵称，绝不把完整 uid 再写进账本。
  function accountLabelMap() {
    const map = new Map();
    for (const row of checkinAccounts()) {
      const label = accountState.aliases[row.key] || row.label || '';
      const uid = String(row.uid || '');
      if (label && uid) map.set(`uid:${uid.slice(-8)}`, label);
    }
    return map;
  }

  function activePatContext() {
    return {
      activeUid: String(client.auth?.user?.id || ''),
      activeRegion: client.auth?.region || config.region,
      activeSource: client.auth?.source || '',
    };
  }

  function patSnapshot(store = readPatStore()) {
    const snapshot = publicPatStore(store, activePatContext());
    for (const item of snapshot.entries) {
      const raw = (store.entries || []).find((entry) => entry.id === item.id);
      const alias = raw ? accountState.aliases[`${raw.region}:${raw.uid}`] : '';
      if (alias) item.label = alias;
    }
    return snapshot;
  }

  /**
   * 非激活账号不持有插件自己的令牌轮换状态，只能只读重读官方存储拿最新访问令牌。
   * 这样既能在官方客户端刷新后恢复签到，也不会因为插件刷新 drt- 影响官方客户端。
   */
  function rescanAccountToken(account) {
    if (!account || account.active) return '';
    try {
      invalidateDesktopScan();
      const fresh = scanDesktopAuth({ force: true })
        .filter((candidate) => candidate.valid && candidate.accessToken && candidate.region === account.region)
        .filter((candidate) => (account.uid
          ? String(candidate.uid || '') === account.uid
          : (!account.kind || candidate.kind === account.kind) && (!account.file || candidate.file === account.file)))
        .filter((candidate) => !candidate.expiresAt || candidate.expiresAt > Date.now() + 30_000)
        .sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0))[0];
      if (!fresh) return '';
      account.accessToken = fresh.accessToken;
      account.expiresAt = Number(fresh.expiresAt) || account.expiresAt;
      return fresh.accessToken;
    } catch {
      return '';
    }
  }

  function checkinSnapshot() {
    const now = Date.now();
    const today = beijingDateKey(now);
    const hour = beijingHour(now);
    const accounts = checkinAccounts();
    const devices = {
      global: {
        ...deviceAvailability('global'),
        note: 'Qoder 国际版按设备去重：同一台设备每天通常只有列表里第一个账号能领到 100 Credits；这不是插件故障。',
      },
      cn: deviceAvailability('cn'),
    };
    const mapped = accounts.map((account) => {
      const saved = checkinState.results[account.key];
      const isToday = Boolean(saved && beijingDateKey(saved.checkedAt) === today);
      let status = isToday ? saved.status : 'idle';
      if (!isToday && hour < 10) status = 'waiting';
      if (account.missing) status = 'login';
      const device = devices[account.region] || { available: false };
      return {
        key: account.key,
        label: account.label,
        region: account.region,
        regionLabel: REGIONS[account.region].label,
        kind: account.kind,
        sourceLabel: account.sourceLabel,
        current: account.active,
        uidTail: account.uidTail,
        expiresAt: account.expiresAt,
        tokenReady: account.tokenReady,
        missing: account.missing === true,
        deviceAvailable: device.available,
        deviceReason: device.reason || '',
        deviceSource: device.source || '',
        deviceVersion: device.version || '',
        status,
        credits: isToday ? saved.credits : 0,
        message: account.missing
          ? '本机已没有这个账号的登录态（客户端同区只保留一份），重新登录后恢复。'
          : isToday ? saved.message : (hour < 10 ? '10:00（UTC+8）后开放领取' : '今天还没领取'),
        checkedAt: saved ? saved.checkedAt : 0,
        today: isToday,
        canClaim: checkinCanClaim({
          status,
          tokenReady: account.tokenReady,
          deviceAvailable: device.available,
        }),
      };
    });
    const summary = summarizeCheckinAccounts(mapped);
    const autoActive = checkinState.auto && config.checkin && process.env.QODER_CHECKIN !== '0';
    return {
      auto: autoActive,
      autoConfigured: checkinState.auto,
      enabled: config.checkin && process.env.QODER_CHECKIN !== '0',
      lastRunAt: checkinState.lastRunAt,
      lastAutoAt: checkinState.lastAutoAt,
      nextRunAt: autoActive
        ? nextRunAt({ auto: true, results: checkinState.results, lastAutoAt: checkinState.lastAutoAt }, accounts, now)
        : 0,
      today,
      hour,
      window: '每天 10:00（UTC+8）后开放',
      devices,
      accounts: mapped,
      summary,
    };
  }

  async function runCheckinInternal({ key = '', auto = false } = {}) {
    if (disposed || checkinAbort.signal.aborted) return { ...checkinSnapshot(), ok: false, error: '插件已卸载', results: [] };
    const runKey = key || '*';
    const running = checkinRuns.get(runKey);
    if (running) return running;
    const accounts = checkinAccounts();
    const targets = key ? accounts.filter((account) => account.key === key) : accounts;
    if (key && !targets.length) {
      return { ...checkinSnapshot(), ok: false, error: '账号不存在或已从本机移除，请刷新后重试', results: [] };
    }
    if (!targets.length) return { ...checkinSnapshot(), results: [] };
    const task = (async () => {
      const now = Date.now();
      const results = [];
      // 一次签到可能跑多个账号、持续数秒；期间换号时不能用新账号的令牌
      // 去执行旧账号的领取，否则会把 B 的今日权益记到 A 的条目上。
      const runAuthGeneration = client.authGeneration;
      const runAuthUid = String(client.auth?.user?.id || '');
      for (const account of targets) {
        // 卸载/热重载后不再继续为剩余账号发请求；已发出的这一笔仍记录并落盘。
        if (disposed || checkinAbort.signal.aborted) break;
        const saved = checkinState.results[account.key];
        const doneToday = saved
          && beijingDateKey(saved.checkedAt) === beijingDateKey(now)
          && (saved.status === 'claimed' || saved.status === 'already');
        let result = null;
        if (doneToday) {
          result = saved;
        } else {
          try {
            result = await claimCampaigns({
              region: account.region,
              now,
              signal: checkinAbort.signal,
              getToken: async () => {
                if (account.active) {
                  if (client.authGeneration !== runAuthGeneration
                    || String(client.auth?.user?.id || '') !== runAuthUid) {
                    return account.accessToken || '';
                  }
                  await client.ensureAccessToken().catch(() => {});
                  if (client.authGeneration !== runAuthGeneration) return account.accessToken || '';
                  return (client.auth && client.auth.accessToken) || account.accessToken || '';
                }
                return account.accessToken || rescanAccountToken(account);
              },
              refreshToken: async () => {
                if (account.active) {
                  if (client.authGeneration !== runAuthGeneration
                    || String(client.auth?.user?.id || '') !== runAuthUid) return '';
                  await client.refreshAuth();
                  if (client.authGeneration !== runAuthGeneration) return '';
                  return (client.auth && client.auth.accessToken) || '';
                }
                return rescanAccountToken(account);
              },
            });
          } catch (error) {
            if (disposed || checkinAbort.signal.aborted) break;
            result = {
              status: 'error',
              credits: 0,
              message: String(error?.message || error).slice(0, 240),
              checkedAt: now,
              campaignEndAt: 0,
            };
          }
        }
        const record = {
          key: account.key,
          label: account.label,
          region: account.region,
          kind: account.kind,
          uidTail: account.uidTail,
          status: result.status,
          credits: Number(result.credits) || 0,
          message: String(result.message || '').slice(0, 240),
          checkedAt: Number(result.checkedAt) || now,
          campaignEndAt: Number(result.campaignEndAt) || 0,
        };
        checkinState.results[account.key] = record;
        results.push(record);
        // 领取账本（append-only）：加购额度「领取后 N 天有效」是滚动的，
        // 逐笔到期只能靠这笔账还原；already 也记（额度同样进了池子）。
        if ((record.status === 'claimed' || record.status === 'already') && record.credits > 0) {
          checkinState.ledger.push({
            key: account.key,
            region: account.region,
            uidTail: account.uidTail || '',
            at: record.checkedAt,
            credits: record.credits,
            validityDays: Math.max(0, Number(result.validityDays) || 0),
          });
        }
        log(`签到 · ${REGIONS[account.region].label} · ${account.label}: ${record.status}${record.credits ? ` +${record.credits}` : ''}${record.message ? `（${record.message}）` : ''}`);
        if (disposed || checkinAbort.signal.aborted) break;
        await wait(350);
      }
      checkinState.lastRunAt = Date.now();
      if (auto) checkinState.lastAutoAt = checkinState.lastRunAt;
      try { checkinState = writeCheckin(checkinState); } catch (error) {
        log('保存签到状态失败', String(error?.message || error));
      }
      if (!disposed && !checkinAbort.signal.aborted && results.some((result) => result.status === 'claimed')) {
        client.refreshExtras().catch(() => {});
      }
      return { ...checkinSnapshot(), results };
    })().catch((error) => {
      log('签到失败', String(error?.message || error));
      return { ...checkinSnapshot(), results: [], error: String(error?.message || error) };
    });
    const tracked = task.finally(() => { checkinRuns.delete(runKey); });
    checkinRuns.set(runKey, tracked);
    return tracked;
  }

  function autoCheckinDue() {
    if (!config.checkin || process.env.QODER_CHECKIN === '0' || !checkinState.auto) return false;
    const accounts = checkinAccounts();
    if (!accounts.length) return false;
    const now = Date.now();
    return now >= nextRunAt({
      auto: true,
      results: checkinState.results,
      lastAutoAt: checkinState.lastAutoAt,
    }, accounts, now);
  }

  function kickAutoCheckin() {
    if (disposed || !autoCheckinDue()) return;
    runCheckinInternal({ auto: true }).catch((error) => log('自动签到失败', String(error?.message || error)));
  }

  function scheduleAutoCheckin() {
    if (!config.checkin) return;
    autoCheckinKick = setTimeout(kickAutoCheckin, 8000);
    if (autoCheckinKick.unref) autoCheckinKick.unref();
    autoCheckinTimer = setInterval(kickAutoCheckin, 60_000);
    if (autoCheckinTimer.unref) autoCheckinTimer.unref();
  }

  const badRequest = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
  };

  const controller = {
    status: async ({ deep, rescan } = {}) => {
      if (rescan) invalidateDesktopScan();
      return snapshot({ deep });
    },
    directory,
    usage: async ({ days = 14, limit = 80 } = {}) => {
      const records = usageRecords();
      const span = Math.min(30, Math.max(7, Number(days) || 14));
      const recent = Math.min(200, Math.max(20, Number(limit) || 80));
      const summary = summarizeUsage(records, span, Date.now(), usageDaily());
      const labels = accountLabelMap();
      summary.byAccount = (summary.byAccount || []).map((item) => ({ ...item, label: labels.get(item.account) || '' }));
      const from = summary.range.from || '';
      // 记录列表与上方统计必须使用同一个本地日窗口，否则切 7/30 天只变总数。
      const windowed = from ? records.filter((record) => localDayKey(record.at) >= from) : records;
      return {
        summary,
        recent: windowed.slice(-recent).reverse(),
      };
    },
    requests: async ({ days = 14, limit = 80, model = '', onlyFailures = false, onlyActionable = false } = {}) => {
      const labels = accountLabelMap();
      const result = summarizeRequests(usageRecords(), { days, limit, model, onlyFailures, onlyActionable });
      return {
        ...result,
        items: result.items.map((item) => ({ ...item, accountLabel: labels.get(item.account) || '' })),
      };
    },
    credits: async ({ range = '7d' } = {}) => creditsReport(usageRecords(), { range, daily: usageDaily() }),
    diagnostics: async ({ signal, bundle = false } = {}) => {
      const checks = await buildChecks({ deep: true, signal });
      const result = { checks, logs: recentLogs(60) };
      if (bundle) {
        const status = await snapshot({ deep: false, desktop: false });
        result.bundle = buildDiagBundle({
          status,
          checks,
          protocol: clientRuntime.protocol,
          info: inspectClient(status.region || config.region),
        });
      }
      return result;
    },
    logs: async ({ lines = 120, query = '' } = {}) => {
      const count = Math.min(300, Math.max(20, Number(lines) || 120));
      const needle = String(query || '').trim().toLowerCase();
      const all = recentLogs(count);
      return {
        lines: needle ? all.filter((line) => String(line).toLowerCase().includes(needle)) : all,
        query: needle,
        total: all.length,
      };
    },
    refreshCatalog: async () => {
      const result = await directory({ refresh: true });
      notifyAdaptersUpdated();
      return result;
    },
    savePrefs,
    beginDeviceAuth: async (region) => {
      const started = await client.beginDeviceAuth(region || config.region);
      state.pendingDevice = { ...started, startedAt: Date.now() };
      return started;
    },
    importDesktop: async (input) => {
      const options = typeof input === 'string' ? { region: input } : (input || {});
      const result = await client.importDesktop(options);
      await directory({ refresh: true }).catch(() => {});
      notifyAdaptersUpdated();
      return result;
    },
    checkin: async () => checkinSnapshot(),
    runCheckin: async ({ key } = {}) => runCheckinInternal({ key: String(key || '') }),
    saveCheckinConfig: async ({ auto } = {}) => {
      if (typeof auto !== 'boolean') return { ...checkinSnapshot(), ok: false, error: 'auto 必须是布尔值' };
      checkinState.auto = auto;
      try { checkinState = writeCheckin(checkinState); } catch (error) {
        log('保存签到设置失败', String(error?.message || error));
      }
      if (checkinState.auto) {
        if (checkinKickTimer) clearTimeout(checkinKickTimer);
        checkinKickTimer = setTimeout(() => {
          checkinKickTimer = null;
          if (!disposed) kickAutoCheckin();
        }, 100);
        if (checkinKickTimer.unref) checkinKickTimer.unref();
      }
      return checkinSnapshot();
    },
    account: async ({ force = false } = {}) => {
      const data = await snapshot({});
      const extras = await client.refreshExtras({ force }).catch(() => null);
      const merged = extras || data.extras || null;
      return { ...data, extras: merged ? { ...merged, addonBatches: addonBatchesForActive() } : null };
    },
    accounts: async () => accountRows(),
    saveAccounts: async (patch = {}) => {
      accountState = writeAccounts(mergeAccounts(accountState, patch));
      return accountRows();
    },
    switchAccount: async ({ key } = {}) => {
      const wanted = String(key || '');
      if (!wanted) {
        const error = new Error('缺少账号 key');
        error.statusCode = 400;
        throw error;
      }
      const target = checkinAccounts().find((row) => row.key === wanted);
      if (!target) {
        const error = new Error('账号不存在或已失效；请重新扫描本机登录');
        error.statusCode = 400;
        throw error;
      }
      if (target.active) {
        accountState = writeAccounts({ ...accountState, current: wanted });
        return accountRows();
      }
      if (!['app', 'cli'].includes(target.kind)) {
        const error = new Error('该账号来自插件登录，无法通过本机登录切换；请重新授权');
        error.statusCode = 400;
        throw error;
      }
      const result = await client.importDesktop({
        region: target.region,
        uid: target.uid,
        kind: target.kind,
        file: target.file,
      });
      let warning = '';
      try {
        accountState = writeAccounts({ ...accountState, current: wanted });
      } catch (error) {
        // 切换已经成功；记住当前账号失败只影响下次启动的记忆，不能报成切换失败。
        warning = `当前账号未写入 accounts.json：${String(error?.message || error)}`;
        log('保存当前账号失败', String(error?.message || error));
      }
      await directory({ refresh: true }).catch(() => {});
      notifyAdaptersUpdated();
      return { ...accountRows(), result, ...(warning ? { warning } : {}) };
    },
    pats: async () => patSnapshot(),
    switchPat: async ({ id } = {}) => {
      const store = readPatStore();
      if (store.error) throw badRequest(`PAT 凭据库无法读取：${store.error}`);
      const entry = findPat(store, id);
      if (!entry) throw badRequest('PAT 不存在；刷新列表后重试');
      const result = await client.importPat(entry.pat, entry.region);
      const next = upsertPat(store, { ...entry, lastUsedAt: Date.now() });
      let warning = '';
      try {
        await writePatStore(next);
      } catch (error) {
        // 切换已经成功；凭据库只影响下次能否免粘贴，不能把登录结果报成失败。
        warning = `上次使用时间未写入凭据库：${String(error?.message || error)}`;
        log('更新 PAT 上次使用时间失败', String(error?.message || error));
      }
      await directory({ refresh: true }).catch(() => {});
      notifyAdaptersUpdated();
      return { ...patSnapshot(next), result, ...(warning ? { warning } : {}) };
    },
    deletePat: async ({ id } = {}) => {
      const store = readPatStore();
      if (store.error) throw badRequest(`PAT 凭据库无法读取：${store.error}`);
      const entry = findPat(store, id);
      if (!entry) throw badRequest('PAT 不存在；刷新列表后重试');
      const active = activePatContext();
      if (active.activeSource === 'pat'
        && entry.region === active.activeRegion
        && entry.uid === active.activeUid) {
        throw badRequest('当前账号正在使用这条 PAT；请先切换账号或退出登录，再删除');
      }
      const next = removePat(store, id);
      await writePatStore(next);
      return patSnapshot(next);
    },
    pollDeviceAuth: async (id) => {
      if (!id) return { ok: false, error: 'missing device id' };
      const result = await client.pollDeviceAuth(id);
      if (result.status === 'ready') {
        state.pendingDevice = null;
        // 目录刷新可能横跨三个网关；不能让它拖住授权轮询，否则客户端先超时，
        // 会把已经成功的登录误报成“授权超时”。
        directory({ refresh: true }).catch(() => {});
        notifyAdaptersUpdated();
      } else if (result.status === 'expired' || result.status === 'error' || result.ok === false) {
        if (!state.pendingDevice || state.pendingDevice.id === id) state.pendingDevice = null;
      }
      return result;
    },
    importPat: async (token, region) => {
      const value = String(token || '').trim();
      const result = await client.importPat(value, region || config.region);
      let savedPat = false;
      if (/^pt-/.test(value)) {
        try {
          const auth = client.auth || {};
          const store = readPatStore();
          if (store.error) throw new Error(store.error);
          const next = upsertPat(store, {
            region: auth.region || region || config.region,
            pat: value,
            uid: auth.user?.id || '',
            name: auth.user?.name || '',
            email: auth.user?.email || '',
            avatarUrl: auth.user?.avatarUrl || '',
            userType: auth.userType || '',
            organizationId: auth.organizationId || '',
            organizationName: auth.organizationName || '',
            label: auth.user?.name || auth.user?.email || '',
            lastUsedAt: Date.now(),
          });
          await writePatStore(next);
          savedPat = true;
        } catch (error) {
          // PAT 已经生效；保存到凭据库失败只影响“下次免粘贴”，不把登录判失败。
          log('保存 PAT 到凭据库失败', String(error?.message || error));
        }
      }
      await directory({ refresh: true }).catch(() => {});
      notifyAdaptersUpdated();
      return { ...result, savedPat };
    },
    refreshToken: async () => {
      if (!client.auth) throw badRequest('尚未登录 Qoder，无法刷新令牌');
      await client.refreshAuth();
      return { ...(await snapshot({ desktop: false })), refreshed: true };
    },
    logout: async () => {
      const result = await client.logout();
      try { accountState = writeAccounts({ ...accountState, current: '' }); } catch (error) {
        log('清除当前账号记录失败', String(error?.message || error));
      }
      adapter.invalidate();
      adapter.catalogCache = { at: 0, models: [], error: '', staleMs: 0 };
      notifyAdaptersUpdated();
      return result;
    },
    test: async ({ model, prompt, maxTokens, reasoningEffort: requestedEffort, signal }) => {
      if (!model) return { ok: false, error: '请选择一个模型' };
      const text = String(prompt || '').trim().slice(0, 8000) || '用一句话介绍你自己。';
      const perModel = adapter.prefs.paramsByModel?.[model] || {};
      const fallback = adapter.defaults || {};
      const raw = adapter.catalogCache.models.find((item) => item && item.id === model);
      const supportedEfforts = Array.isArray(raw?.reasoning_efforts) ? raw.reasoning_efforts : [];
      let reasoningEffort = typeof perModel.reasoningEffort === 'string' && perModel.reasoningEffort
        ? perModel.reasoningEffort
        : fallback.reasoningEffort;
      if (requestedEffort) {
        if (!supportedEfforts.length) return { ok: false, error: '当前模型不支持思考档位' };
        if (!supportedEfforts.includes(requestedEffort)) {
          return { ok: false, error: `当前模型只支持 ${supportedEfforts.join(' / ')}，请换一个档位` };
        }
        reasoningEffort = requestedEffort;
      }
      const cap = Number(raw?.max_output_tokens ?? 0) || 0;
      const requestedMax = Number(maxTokens);
      const requested = Number.isFinite(requestedMax) && requestedMax > 0
        ? Math.floor(requestedMax)
        : (Number(perModel.maxTokens) > 0
          ? Math.floor(Number(perModel.maxTokens))
          : (Number(fallback.maxTokens) > 0 ? Math.floor(Number(fallback.maxTokens)) : DEFAULTS.providerMaxOutputTokens));
      // 试跑与真实对话使用同一份已保存参数：只按模型上限收敛，不再额外截断。
      const budget = Math.max(16, cap ? Math.min(requested, cap) : requested);
      const temperature = typeof perModel.temperature === 'number' ? perModel.temperature : fallback.temperature;
      const started = Date.now();
      try {
        const result = await client.test({
          model,
          prompt: text,
          maxTokens: budget,
          contextWindow: adapter.contextWindowFor(model),
          temperature,
          reasoningEffort,
          signal,
          firstByteTimeoutMs: config.firstByteTimeoutMs,
          idleTimeoutMs: config.streamIdleTimeoutMs,
        });
        const usage = result.usage || null;
        const cached = Number(usage?.prompt_tokens_details?.cached_tokens) || 0;
        const reasoningTokens = Number(usage?.completion_tokens_details?.reasoning_tokens) || 0;
        const latencyMs = Date.now() - started;
        const billed = Number(usage?.credits) || 0;
        const original = Math.max(Number(usage?.original_credits) || 0, billed);
        const billable = usage?.billable !== false;
        const record = {
          at: started,
          model,
          client: client.auth?.source || 'unknown',
          account: client.accountStamp().account,
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || 0,
          totalTokens: usage?.total_tokens || 0,
          cachedTokens: cached,
          reasoningTokens,
          credits: billable ? billed : 0,
          originalCredits: original,
          savedCredits: Math.max(0, original - (billable ? billed : 0)),
          billable,
          latencyMs,
          firstByteMs: result.firstByteMs || 0,
        };
        if (!String(result.text || '').trim() && !String(result.reasoning || '').trim()) {
          const message = 'Qoder 返回了空回复（没有正文或思考内容）';
          state.lastError = message;
          appendUsage({ ...record, ok: false, status: 'test-failed', error: message, probe: true });
          return { ok: false, error: message };
        }
        appendUsage({ ...record, ok: true, status: 'test', probe: true });
        return {
          ok: true,
          model,
          text: result.text,
          reasoning: result.reasoning || '',
          usage,
          latencyMs,
          firstByteMs: result.firstByteMs || 0,
          reasoningEffort: reasoningEffort || '',
        };
      } catch (error) {
        state.lastError = String(error?.message || error);
        appendUsage({
          at: started, model, client: client.auth?.source || 'unknown',
          account: client.accountStamp().account,
          ok: false, status: 'test-failed', probe: true,
          latencyMs: Date.now() - started, error: state.lastError,
        });
        return { ok: false, error: state.lastError };
      }
    },
    clearUsage: async () => {
      const backups = clearUsageFile();
      // 告知备份路径：面板的提示要能告诉用户「还能找回」，而不是只报“已清空”。
      return { cleared: true, backups: Array.isArray(backups) ? backups : [] };
    },
  };

  // ── 工具 ──────────────────────────────────────────────────────────────
  if (config.tools) {
    useService('tools', (tools) => {
      for (const definition of createTools({ snapshot })) {
        try { tools.register(definition); } catch (error) { log(`注册工具 ${definition.name} 失败`, error?.message || error); }
      }
    });
  }

  // ── 斜杠命令 ──────────────────────────────────────────────────────────
  if (config.commands) {
    useService('commands', (commands) => {
      try {
        commands.register({
          name: 'qoder',
          description: tr('Qoder 接入：状态 / 登录 / 模型 / 用量 / 签到 / 诊断 / 刷新'),
          input: { hint: 'status | models | usage | checkin [run] | login | logout | diagnose | refresh | test [model]' },
          async handler({ rawInput }) {
            const [first = 'status', ...rest] = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
            // `/qoder` 不带参数时按 status 处理：空字符串 split 后是 ['']，
            // 旧写法会把 arg 变成空串并回复“未知子命令：”。
            const arg = first || 'status';
            const reply = (kind, text) => ({ kind, text: tr(text) });
            if (arg === 'status') {
              const data = await snapshot({});
              return reply('success', [
                `登录：${data.signedIn ? '已登录' : '未登录'}${data.signedIn ? `（${data.account?.name || data.account?.email || ''}）` : ''}`,
                `区域：${data.regionLabel}`,
                `路由：${data.route.registered ? '已注册' : '未注册'}${data.route.error ? `（${data.route.error}）` : ''}`,
                `模型：${data.catalog.count} 个 / 可见 ${data.catalog.visibleCount} 个`,
                `今日：${data.usage.today.requests} 次 · ${data.usage.today.tokens} tokens`,
              ].join('\n'));
            }
            if (arg === 'models') {
              const data = await directory({});
              if (!data.models.length) return reply('error', data.error || '目录为空，请先登录 Qoder。');
              return reply('success', data.models.slice(0, 60).map((model) => `${model.visible ? '✓' : '·'} ${model.id}${model.pinned ? '  [默认]' : ''}`).join('\n'));
            }
            if (arg === 'usage') {
              const data = await controller.usage();
              const today = data.summary.today;
              return reply('success', `今日 ${today.requests} 次 · ${today.tokens} tokens · 成功率 ${today.successRate == null ? '—' : `${Math.round(today.successRate * 100)}%`} · 平均首字 ${today.avgFirstByteMs}ms\n最近记录：${data.recent.length} 条（详情见面板）`);
            }
            if (arg === 'checkin') {
              const data = rest[0] === 'run'
                ? await controller.runCheckin({})
                : await controller.checkin();
              const lines = data.accounts.map((account) => {
                const state = account.today
                  ? (account.status === 'claimed' ? `今日已领 +${account.credits}` : account.status === 'already' ? '今日已领' : account.status)
                  : '今天还没领取';
                return `${account.current ? '★' : '·'} ${account.label}（${account.regionLabel}）: ${state}${account.message ? ` · ${account.message}` : ''}`;
              });
              return reply(data.summary.errors ? 'error' : 'success', [
                `自动签到：${data.auto ? '开启' : '关闭'} · ${data.window}`,
                `今日已处理 ${data.summary.done}/${data.summary.total} 个账号${data.summary.credits ? ` · +${data.summary.credits} Credits` : ''}`,
                ...lines,
              ].join('\n'));
            }
            if (arg === 'diagnose') {
              const checks = await buildChecks({ deep: true });
              return reply(
                checks.every((check) => check.status === 'pass') ? 'success' : 'error',
                checks.map((check) => `${check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗'} ${check.label}：${check.detail}`).join('\n'),
              );
            }
            if (arg === 'refresh') {
              const result = await controller.refreshCatalog();
              return reply(
                result.error ? 'error' : 'success',
                result.error
                  ? `目录刷新失败，继续使用缓存：${result.error}（${result.models.length} 个模型）`
                  : `目录已刷新：${result.models.length} 个模型`,
              );
            }
            if (arg === 'login') {
              if (state.pendingDevice) {
                const result = await controller.pollDeviceAuth(state.pendingDevice.id);
                if (result.status === 'ready') return reply('success', `登录成功：${result.account?.name || result.account?.email || ''}`);
                if (result.status === 'expired' || result.status === 'error' || result.ok === false) {
                  return reply('error', `授权失败：${result.error || result.message || '会话已过期'}。请重新运行 /qoder login 发起授权。`);
                }
                const uri = result.verificationUri || state.pendingDevice.verificationUri || '';
                return reply('success', `尚未完成授权。打开：\n${uri}\n完成后再次运行 /qoder login。`);
              }
              const started = await controller.beginDeviceAuth();
              const codeHint = started.userCode ? `，并输入代码 ${started.userCode}` : '';
              return reply('success', `请在浏览器打开 ${started.verificationUri}${codeHint}（${Math.round(started.expiresIn / 60)} 分钟内有效）。完成后再次运行 /qoder login。`);
            }
            if (arg === 'logout') {
              await controller.logout();
              return reply('success', '已退出 Qoder，并清除本机保存的凭据。');
            }
            if (arg === 'test') {
              const model = rest[0] || adapter.prefs.pinned || adapter.catalogCache.models[0]?.id;
              if (!model) return reply('error', '目录里还没有可选模型。');
              const result = await controller.test({ model, prompt: 'Reply with the single word: pong' });
              return result.ok
                ? reply('success', `模型 ${model} 正常：${result.text.slice(0, 120)}（${result.latencyMs}ms）`)
                : reply('error', `测试失败：${result.error}`);
            }
            return reply('error', `未知子命令：${arg}`);
          },
        });
      } catch (error) {
        log('注册 /qoder 命令失败', error?.message || error);
      }
    });
  }

  // ── 面板数据面 ────────────────────────────────────────────────────────
  if (config.routes) {
    useService('webServer', (webServer) => {
      const routes = createRouteTable({ controller, log });
      const dispose = mountRoutes(webServer, routes, log);
      ctx.effect(() => dispose, 'qoder.panel-routes');
    });
  }

  // ── 每日自动签到 ──────────────────────────────────────────────────────
  scheduleAutoCheckin();
  ctx.effect(() => () => {
    if (autoCheckinKick) clearTimeout(autoCheckinKick);
    if (autoCheckinTimer) clearInterval(autoCheckinTimer);
  }, 'qoder.checkin-auto');

  // 桌面端 DPAPI key 在后台子进程里解，首次签到/账号页扫描不再卡主线程。
  prewarmDesktopKeysAsync().catch(() => {});

  // ── 启动预热（不阻塞插件加载） ─────────────────────────────────────────
  if (client.auth) {
    adapter.warmup().then(() => notifyAdaptersUpdated(), (error) => {
      state.catalogError = String(error?.message || error);
      log('启动目录预热失败', state.catalogError);
    });
  } else {
    log('尚未登录 Qoder，等待用户在面板完成授权');
  }

  ctx.effect(() => () => {
    disposed = true;
    try { checkinAbort.abort(new Error('插件已卸载')); } catch { /* ignore */ }
    if (authChangeTimer) clearTimeout(authChangeTimer);
    if (checkinKickTimer) clearTimeout(checkinKickTimer);
    if (autoCheckinKick) clearTimeout(autoCheckinKick);
    if (autoCheckinTimer) clearInterval(autoCheckinTimer);
    try { client.dispose(); } catch { /* ignore */ }
    try { adapter.dispose(); } catch { /* ignore */ }
    try { adapter.invalidate(); } catch { /* ignore */ }
    // 卸载/热重载时把最后 20ms 去抖窗口里的用量同步落盘。
    try { flushUsageSync(); } catch { /* ignore */ }
    try { disposeChatTransport(); } catch { /* ignore */ }
  }, 'qoder.dispose');
}

export default { name, inject, apply };
