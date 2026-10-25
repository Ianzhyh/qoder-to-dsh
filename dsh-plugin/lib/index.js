/**
 * qoder-to-dsh —— 宿主端入口。
 *
 * 和传统「桥 + 控制台 + 插件」三进程方案不同，这里只有一个进程：
 *   - 凭据、目录、流式转发全部在插件内完成；
 *   - 不再监听第二个端口，也不会出现「桥在跑但插件连不上」的状态分裂；
 *   - 面板直接读插件内存态，数字与模型选择器同源。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION, PROVIDER, DISPLAY_NAME, REGIONS, DEFAULTS, PATHS } from '../../lib/config.mjs';
import { QoderAdapter } from '../../lib/adapter.mjs';
import { createTools } from '../../lib/tools.mjs';
import { createRouteTable, mountRoutes } from './routes.mjs';
import { QoderClient } from '../../lib/qoder-api.mjs';
import { invalidateDesktopScan, prewarmDesktopKeysAsync, scanDesktopAuth } from '../../lib/desktop-auth.mjs';
import { disposeChatTransport } from '../../lib/chat-transport.mjs';
import {
  appendUsage, clearUsage as clearUsageFile, creditsReport, isWritableDir, log as writeLog,
  localDayKey, readCheckin, readPrefs, readUsage, reconcileUsage, recentLogs, summarizeUsage, writeCheckin, writePrefs,
} from '../../lib/state.mjs';
import { beijingDateKey, beijingHour, buildCheckinAccounts, checkinCanClaim, claimCampaigns, summarizeCheckinAccounts } from '../../lib/checkin.mjs';
import { deviceAvailability } from '../../lib/umid.mjs';
import { toDirectory } from '../../lib/models.mjs';

export const name = 'qoder';
export const inject = ['llm'];

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function sanitizePrefs(input, current) {
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
    visible,
    pinned: typeof input?.pinned === 'string' ? input.pinned : current.pinned,
    includeAll: typeof input?.includeAll === 'boolean' ? input.includeAll : current.includeAll,
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
  let notifyCatalogUpdated = () => {};
  const client = new QoderClient({
    region: config.region,
    catalogTtlMs: config.catalogTtlMs,
    log,
    // 后台 stale-while-revalidate 拿到新目录后，让 DSH 的选择器跟着更新。
    onCatalogUpdated: () => notifyCatalogUpdated(),
    onAuthChange: () => {
      state.pendingDevice = null;
      adapter.invalidate();
      adapter.warmup().then(() => notifyAdaptersUpdated(), () => notifyAdaptersUpdated());
      setTimeout(() => {
        try { kickAutoCheckin(); } catch (error) { log('登录后触发自动签到失败', String(error?.message || error)); }
      }, 1500);
    },
  });

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

  async function buildChecks({ deep = false } = {}) {
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
        const result = await client.listCatalog({ refresh: true });
        checks.push({
          id: 'catalog',
          label: '模型目录',
          status: result.models.length ? 'pass' : 'fail',
          detail: `${result.models.length} 个模型 · ${Date.now() - started}ms${result.staleMs ? '（本次刷新失败，显示的是缓存）' : ''}${result.error ? ` · ${result.error}` : ''}`,
        });
      } catch (error) {
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
        const extras = await client.refreshExtras();
        const quota = extras && extras.quota;
        const total = Number(quota?.userQuota?.total || 0) + Number(quota?.addOnQuota?.total || 0);
        const left = Number(quota?.userQuota?.remaining || 0) + Number(quota?.addOnQuota?.remaining || 0);
        const percent = Number(quota?.totalUsagePercentage);
        const unit = /^credits?$/i.test(String(quota?.userQuota?.unit || '')) ? 'Credits' : (quota?.userQuota?.unit || 'credits');
        checks.push({
          id: 'quota',
          label: '账号额度',
          status: quota?.isQuotaExceeded ? 'warn' : 'pass',
          detail: total
            ? `剩余 ${left} / ${total} ${unit}${quota?.isQuotaExceeded ? ' · 已用尽' : ''}`
            : Number.isFinite(percent)
              ? `已用 ${Math.round(percent * 100)}%${quota?.isQuotaExceeded ? ' · 已用尽' : ''}`
              : '上游未返回额度数据',
        });
      } catch (error) {
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
    const usage = summarizeUsage(usageRecordsList, 14);
    const directory = (() => {
      try {
        return toDirectory(adapter.catalogCache.models, {
          visible: adapter.prefs.visible,
          pinned: adapter.prefs.pinned,
          contextWindows: adapter.prefs.contextWindowByModel,
        });
      } catch { return []; }
    })();
    const checks = deep ? await buildChecks({ deep }) : [];
    return {
      version: VERSION,
      provider: config.provider,
      displayName: config.displayName,
      region: status.region,
      regionLabel: status.regionLabel,
      signedIn: status.signedIn,
      account: status.account,
      token: status.token,
      extras: status.extras || null,
      extrasAt: status.extrasAt || 0,
      desktop: status.desktop || { available: false, candidates: [] },
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
        contextWindowByModel: adapter.prefs.contextWindowByModel || {},
        paramsByModel: adapter.prefs.paramsByModel || {},
      },
      customized: countOverrides(adapter.prefs),
      usage,
      recentFailures: usageRecordsList.filter((record) => !record.ok).slice(-8).reverse(),
      directory,
      checks,
      config: {
        catalogTtlMs: config.catalogTtlMs,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
        firstByteTimeoutMs: config.firstByteTimeoutMs,
        defaultMaxTokens: config.defaultMaxTokens,
        defaultTemperature: config.defaultTemperature ?? null,
        defaultReasoningEffort: config.defaultReasoningEffort || '',
        providerDefaultMaxTokens: DEFAULTS.providerMaxOutputTokens,
        dataDir: PATHS.prefs ? dirname(PATHS.prefs) : '',
        authPath: PATHS.auth,
        pluginDir: PLUGIN_DIR,
        credentialProtection: process.platform === 'win32' ? 'DPAPI' : 'AES-256-GCM',
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
    adapter.setPrefs(saved);
    adapter.setContextWindows(saved.contextWindowByModel);
    adapter.setModelParams(saved.paramsByModel);
    const notified = notifyAdaptersUpdated();
    return {
      prefs: {
        pinned: saved.pinned,
        visible: saved.visible,
        includeAll: saved.includeAll,
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
  let checkinState = readCheckin();
  const checkinRuns = new Map();
  let autoCheckinTimer = null;
  let autoCheckinKick = null;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function checkinAccounts() {
    // 不走 status()：那里会扫描本机账号，自动签到没必要为此阻塞事件循环。
    return buildCheckinAccounts({ activeAuth: client.auth, activeRegion: client.auth?.region || client.region });
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
      global: deviceAvailability('global'),
      cn: deviceAvailability('cn'),
    };
    const mapped = accounts.map((account) => {
      const saved = checkinState.results[account.key];
      const isToday = Boolean(saved && beijingDateKey(saved.checkedAt) === today);
      let status = isToday ? saved.status : 'idle';
      if (!isToday && hour < 10) status = 'waiting';
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
        deviceAvailable: device.available,
        deviceReason: device.reason || '',
        status,
        credits: isToday ? saved.credits : 0,
        message: isToday ? saved.message : (hour < 10 ? '10:00（UTC+8）后开放领取' : '今天还没领取'),
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
    return {
      auto: checkinState.auto && config.checkin && process.env.QODER_CHECKIN !== '0',
      autoConfigured: checkinState.auto,
      enabled: config.checkin && process.env.QODER_CHECKIN !== '0',
      lastRunAt: checkinState.lastRunAt,
      lastAutoAt: checkinState.lastAutoAt,
      today,
      hour,
      window: '每天 10:00（UTC+8）后开放',
      devices,
      accounts: mapped,
      summary,
    };
  }

  async function runCheckinInternal({ key = '', auto = false } = {}) {
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
      for (const account of targets) {
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
              getToken: async () => {
                if (account.active) {
                  await client.ensureAccessToken().catch(() => {});
                  return (client.auth && client.auth.accessToken) || account.accessToken || '';
                }
                return account.accessToken || rescanAccountToken(account);
              },
              refreshToken: async () => {
                if (account.active) {
                  await client.refreshAuth();
                  return (client.auth && client.auth.accessToken) || '';
                }
                return rescanAccountToken(account);
              },
            });
          } catch (error) {
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
        log(`签到 · ${REGIONS[account.region].label} · ${account.label}: ${record.status}${record.credits ? ` +${record.credits}` : ''}${record.message ? `（${record.message}）` : ''}`);
        await wait(350);
      }
      checkinState.lastRunAt = Date.now();
      if (auto) checkinState.lastAutoAt = checkinState.lastRunAt;
      try { checkinState = writeCheckin(checkinState); } catch (error) {
        log('保存签到状态失败', String(error?.message || error));
      }
      if (results.some((result) => result.status === 'claimed')) {
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
    const now = Date.now();
    if (beijingHour(now) < 10) return false;
    if (checkinState.lastAutoAt && now - checkinState.lastAutoAt < 20 * 60_000) return false;
    const accounts = checkinAccounts();
    if (!accounts.length) return false;
    const today = beijingDateKey(now);
    const needsUser = new Set(['device', 'login']);
    return accounts.some((account) => {
      const saved = checkinState.results[account.key];
      if (!saved || beijingDateKey(saved.checkedAt) !== today) return true;
      if (saved.status === 'claimed' || saved.status === 'already') return false;
      // 缺设备身份 / 登录失效需要用户操作，自动重试只会在整个白天重复打空请求。
      return !needsUser.has(saved.status);
    });
  }

  function kickAutoCheckin() {
    if (!autoCheckinDue()) return;
    runCheckinInternal({ auto: true }).catch((error) => log('自动签到失败', String(error?.message || error)));
  }

  function scheduleAutoCheckin() {
    if (!config.checkin) return;
    autoCheckinKick = setTimeout(kickAutoCheckin, 8000);
    if (autoCheckinKick.unref) autoCheckinKick.unref();
    autoCheckinTimer = setInterval(kickAutoCheckin, 20 * 60_000);
    if (autoCheckinTimer.unref) autoCheckinTimer.unref();
  }

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
      const summary = summarizeUsage(records, span);
      const from = summary.range.from || '';
      // 记录列表与上方统计必须使用同一个本地日窗口，否则切 7/30 天只变总数。
      const windowed = from ? records.filter((record) => localDayKey(record.at) >= from) : records;
      return {
        summary,
        recent: windowed.slice(-recent).reverse(),
      };
    },
    credits: async ({ range = '7d' } = {}) => creditsReport(usageRecords(), { range }),
    diagnostics: async () => ({ checks: await buildChecks({ deep: true }), logs: recentLogs(60) }),
    logs: async () => ({ lines: recentLogs(120) }),
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
      if (checkinState.auto) setTimeout(kickAutoCheckin, 100);
      return checkinSnapshot();
    },
    account: async () => {
      const data = await snapshot({});
      const extras = await client.refreshExtras().catch(() => null);
      return { ...data, extras: extras || data.extras || null };
    },
    pollDeviceAuth: async (id) => {
      if (!id) return { ok: false, error: 'missing device id' };
      const result = await client.pollDeviceAuth(id);
      if (result.status === 'ready') {
        state.pendingDevice = null;
        await directory({ refresh: true }).catch(() => {});
        notifyAdaptersUpdated();
      } else if (result.status === 'expired' || result.status === 'error' || result.ok === false) {
        if (!state.pendingDevice || state.pendingDevice.id === id) state.pendingDevice = null;
      }
      return result;
    },
    importPat: async (token, region) => {
      const result = await client.importPat(token, region || config.region);
      await directory({ refresh: true }).catch(() => {});
      notifyAdaptersUpdated();
      return result;
    },
    logout: async () => {
      const result = await client.logout();
      adapter.invalidate();
      adapter.catalogCache = { at: 0, models: [], error: '', staleMs: 0 };
      notifyAdaptersUpdated();
      return result;
    },
    test: async ({ model, prompt, maxTokens, reasoningEffort: requestedEffort }) => {
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
      const requested = Number(maxTokens) > 0
        ? Number(maxTokens)
        : (Number(perModel.maxTokens) > 0
          ? Number(perModel.maxTokens)
          : (Number(fallback.maxTokens) > 0 ? Number(fallback.maxTokens) : DEFAULTS.providerMaxOutputTokens));
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
          appendUsage({ ...record, ok: false, status: 'test-failed', error: message });
          return { ok: false, error: message };
        }
        appendUsage({ ...record, ok: true, status: 'test' });
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
          ok: false, status: 'test-failed',
          latencyMs: Date.now() - started, error: state.lastError,
        });
        return { ok: false, error: state.lastError };
      }
    },
    clearUsage: async () => {
      clearUsageFile();
      return { cleared: true };
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
          description: 'Qoder 接入：状态 / 登录 / 模型 / 用量 / 签到 / 诊断 / 刷新',
          input: { hint: 'status | models | usage | checkin [run] | login | logout | diagnose | refresh | test [model]' },
          async handler({ rawInput }) {
            const [arg = 'status', ...rest] = String(rawInput || '').trim().split(/\s+/);
            if (arg === 'status') {
              const data = await snapshot({});
              return {
                kind: 'success',
                text: [
                  `登录：${data.signedIn ? '已登录' : '未登录'}${data.signedIn ? `（${data.account?.name || data.account?.email || ''}）` : ''}`,
                  `区域：${data.regionLabel}`,
                  `路由：${data.route.registered ? '已注册' : '未注册'}${data.route.error ? `（${data.route.error}）` : ''}`,
                  `模型：${data.catalog.count} 个 / 可见 ${data.catalog.visibleCount} 个`,
                  `今日：${data.usage.today.requests} 次 · ${data.usage.today.tokens} tokens`,
                ].join('\n'),
              };
            }
            if (arg === 'models') {
              const data = await directory({});
              if (!data.models.length) return { kind: 'error', text: data.error || '目录为空，请先登录 Qoder。' };
              return {
                kind: 'success',
                text: data.models.slice(0, 60).map((model) => `${model.visible ? '✓' : '·'} ${model.id}${model.pinned ? '  [默认]' : ''}`).join('\n'),
              };
            }
            if (arg === 'usage') {
              const data = await controller.usage();
              const today = data.summary.today;
              return {
                kind: 'success',
                text: `今日 ${today.requests} 次 · ${today.tokens} tokens · 成功率 ${today.successRate == null ? '—' : `${Math.round(today.successRate * 100)}%`} · 平均首字 ${today.avgFirstByteMs}ms\n最近记录：${data.recent.length} 条（详情见面板）`,
              };
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
              return {
                kind: data.summary.errors ? 'error' : 'success',
                text: [
                  `自动签到：${data.auto ? '开启' : '关闭'} · ${data.window}`,
                  `今日已处理 ${data.summary.done}/${data.summary.total} 个账号${data.summary.credits ? ` · +${data.summary.credits} Credits` : ''}`,
                  ...lines,
                ].join('\n'),
              };
            }
            if (arg === 'diagnose') {
              const checks = await buildChecks({ deep: true });
              return {
                kind: checks.every((check) => check.status === 'pass') ? 'success' : 'error',
                text: checks.map((check) => `${check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗'} ${check.label}：${check.detail}`).join('\n'),
              };
            }
            if (arg === 'refresh') {
              const result = await controller.refreshCatalog();
              return {
                kind: result.error ? 'error' : 'success',
                text: result.error
                  ? `目录刷新失败，继续使用缓存：${result.error}（${result.models.length} 个模型）`
                  : `目录已刷新：${result.models.length} 个模型`,
              };
            }
            if (arg === 'login') {
              if (state.pendingDevice) {
                const result = await controller.pollDeviceAuth(state.pendingDevice.id);
                if (result.status === 'ready') return { kind: 'success', text: `登录成功：${result.account?.name || result.account?.email || ''}` };
                if (result.status === 'expired' || result.status === 'error' || result.ok === false) {
                  return { kind: 'error', text: `授权失败：${result.error || result.message || '会话已过期'}。请重新运行 /qoder login 发起授权。` };
                }
                const uri = result.verificationUri || state.pendingDevice.verificationUri || '';
                return { kind: 'success', text: `尚未完成授权。打开：\n${uri}\n完成后再次运行 /qoder login。` };
              }
              const started = await controller.beginDeviceAuth();
              const codeHint = started.userCode ? `，并输入代码 ${started.userCode}` : '';
              return {
                kind: 'success',
                text: `请在浏览器打开 ${started.verificationUri}${codeHint}（${Math.round(started.expiresIn / 60)} 分钟内有效）。完成后再次运行 /qoder login。`,
              };
            }
            if (arg === 'logout') {
              await controller.logout();
              return { kind: 'success', text: '已退出 Qoder，并清除本机保存的凭据。' };
            }
            if (arg === 'test') {
              const model = rest[0] || adapter.prefs.pinned || adapter.catalogCache.models[0]?.id;
              if (!model) return { kind: 'error', text: '目录里还没有可选模型。' };
              const result = await controller.test({ model, prompt: 'Reply with the single word: pong' });
              return result.ok
                ? { kind: 'success', text: `模型 ${model} 正常：${result.text.slice(0, 120)}（${result.latencyMs}ms）` }
                : { kind: 'error', text: `测试失败：${result.error}` };
            }
            return { kind: 'error', text: `未知子命令：${arg}` };
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
    try { adapter.invalidate(); } catch { /* ignore */ }
    try { disposeChatTransport(); } catch { /* ignore */ }
  }, 'qoder.dispose');
}

export default { name, inject, apply };
