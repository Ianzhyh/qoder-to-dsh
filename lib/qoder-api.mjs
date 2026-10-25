/**
 * Qoder 上游客户端（单进程）。
 *
 * 负责：官方桌面/CLI 登录态导入、OAuth 设备授权、PAT、令牌刷新、COSY 签名、
 * 模型目录、agent_chat_generation SSE 信封解包。上游返回的内层帧本身就是
 * OpenAI chat.completion.chunk，所以这里只做信封拆解，不做协议翻译。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';

import { PATHS, REGIONS, DEFAULTS } from './config.mjs';
import { CosySession, qoderEncode } from './qoder-sign.mjs';
import { createFirstByteGuard } from './request-guard.mjs';
import { requestStream } from './chat-transport.mjs';
import {
  authFromCandidate, findDesktopCandidate, invalidateDesktopScan, pickDesktopAuth, publicDesktopCandidates, scanDesktopAuth,
} from './desktop-auth.mjs';
import { readEncryptedJson, writeEncryptedJsonAsync } from './secret-store.mjs';
import { readCatalogCache, removeFile, writeCatalogCache } from './state.mjs';

const BASE_PROMPT = JSON.parse(readFileSync(new URL('./baseprompt.json', import.meta.url), 'utf8'));
// messages/tools 每次请求都会被真实内容整体替换；模板里不再保留 59KB 的副本。
const CHAT_TEMPLATE = { ...BASE_PROMPT };
delete CHAT_TEMPLATE.messages;
delete CHAT_TEMPLATE.tools;

const CATALOG_PATH = '/algo/api/v2/model/list?Encode=1';
const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
const DEFAULT_SYSTEM = 'You are a helpful assistant.';
const DEFAULT_USER_TYPE = 'personal_professional_trial';

export class QoderAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QoderAuthError';
    this.code = 'AUTH';
  }
}

function cfgOf(region) {
  return REGIONS[region] || REGIONS.global;
}

function epochOf(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : fallback;
}

function expiresFrom(data) {
  if (data?.expires_in) return Date.now() + Number(data.expires_in);
  if (data?.expires_at) return epochOf(data.expires_at) || (Date.now() + 30 * 86400_000);
  return Date.now() + 30 * 86400_000;
}

function userFromInfo(info, fallback = {}) {
  return {
    id: String(info?.id || info?.user_id || fallback.id || ''),
    name: String(info?.name || fallback.name || ''),
    email: String(info?.email || fallback.email || ''),
    avatarUrl: String(info?.avatarUrl || info?.avatar_url || fallback.avatarUrl || ''),
  };
}

function publicAccount(auth) {
  if (!auth) return null;
  return {
    uid: auth.user?.id || '',
    name: auth.user?.name || '',
    email: auth.user?.email || '',
    avatarUrl: auth.user?.avatarUrl || '',
    plan: auth.plan || '',
    credits: auth.credits ?? null,
    userType: auth.userType || '',
    source: auth.source || 'desktop',
    sourceLabel: {
      desktop: 'Qoder 桌面端', cli: 'Qoder CLI', oauth: '浏览器授权', pat: 'PAT', token: '访问令牌',
    }[auth.source] || auth.source || '未知',
  };
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 25_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, ok: res.ok, text, data };
}

function httpsJson({ url, method = 'GET', headers, body, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, text, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      const error = new Error('Qoder upstream timeout');
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });
    if (body) req.write(body);
    req.end();
  });
}

async function readWithTimeout(reader, timeoutMs, label) {
  if (!timeoutMs) return reader.read();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Qoder ${Math.max(1, Math.round(timeoutMs / 1000))} 秒内没有收到${label}`);
      error.code = 'IDLE_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function contextInfo(raw) {
  const box = raw?.context_config && typeof raw.context_config === 'object' ? raw.context_config : {};
  const entries = Object.values(box)
    .map((value) => ({ tokens: Number(value?.token_count) || 0, isDefault: value?.is_default === true }))
    .filter((entry) => entry.tokens > 0);
  const maxInput = Number(raw?.max_input_tokens) || 0;
  // context_config 才是用户可选的上下文档位（官方文档：200K/400K/1M）。
  // max_input_tokens 是旧字段，不能拿来砍掉合法档位；只在没有 context_config 时兜底。
  const optionTokens = [...new Set(entries.map((entry) => entry.tokens))].sort((a, b) => a - b);
  const options = optionTokens.length ? optionTokens : (maxInput > 0 ? [maxInput] : []);
  const preferredRaw = entries.find((entry) => entry.isDefault)?.tokens || maxInput || options[0] || 0;
  const preferred = preferredRaw > 0
    ? (options.length && !options.includes(preferredRaw)
      ? (preferredRaw > options[options.length - 1] ? options[options.length - 1] : preferredRaw)
      : preferredRaw)
    : 0;
  return {
    context: preferred,
    contextMax: Math.max(preferred, ...options, maxInput, 0),
    contextOptions: options,
    maxInput,
  };
}

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function effortsOf(raw) {
  const enabled = raw?.thinking_config?.enabled;
  const box = enabled && typeof enabled === 'object' ? (enabled.efforts || enabled) : null;
  if (box && typeof box === 'object' && !Array.isArray(box)) {
    const present = EFFORT_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(box, key));
    if (present.length) {
      const preferred = present.find((key) => box[key]?.is_default === true) || '';
      return { efforts: present, default: preferred };
    }
  }
  if (Array.isArray(raw?.reasoning_efforts)) {
    const efforts = [...new Set(raw.reasoning_efforts.map(String).filter(Boolean))];
    return { efforts, default: String(raw.default_reasoning_effort || '') };
  }
  if (raw?.is_reasoning === true) return { efforts: ['low', 'medium', 'high'], default: 'medium' };
  return { efforts: [], default: '' };
}

function priceOf(raw) {
  const promotion = raw?.promotion;
  const current = Number(raw?.price_factor);
  const base = Number(
    promotion?.before_promotion_price_factor
    ?? raw?.original_price_factor
    ?? raw?.price_factor,
  );
  const discounted = Number(promotion?.discount_factor);
  const active = promotion?.active === true && Number.isFinite(discounted) && discounted > 0;
  // price_factor 才是当前生效价（免费模型为 0）；original_price_factor 只是划线原价。
  const effective = active ? base * discounted : (Number.isFinite(current) ? current : base);
  return {
    credits: Number.isFinite(effective) ? Number(effective.toFixed(4)) : null,
    free: raw?.is_free === true || (Number.isFinite(effective) && effective === 0),
    promoActive: active,
    discount: active ? discounted : null,
  };
}

export function normalizeCatalog(payload) {
  const list = Array.isArray(payload?.chat) ? payload.chat : [];
  const models = [];
  const rawById = new Map();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.key || raw.id || '').trim();
    if (!id || raw.enable === false) continue;
    const { context, contextMax, contextOptions, maxInput } = contextInfo(raw);
    const { efforts, default: defaultEffort } = effortsOf(raw);
    const price = priceOf(raw);
    models.push({
      id,
      key: id,
      name: String(raw.display_name || raw.name || id),
      description: String(raw.description || ''),
      vendor: String(raw.vendor || raw.provider || ''),
      context_window: context,
      context_window_max: contextMax,
      context_window_options: contextOptions,
      max_input_tokens: maxInput,
      max_output_tokens: Number(raw.max_output_tokens || raw.max_output_token || 0) || 0,
      supports_images: raw.is_vl === true,
      supports_reasoning: raw.is_reasoning === true,
      reasoning_efforts: efforts,
      default_reasoning_effort: defaultEffort,
      credits: price.credits,
      free: price.free,
      promotion_active: price.promoActive,
      discount: price.discount,
      official: true,
      badge: price.promoActive && price.discount ? `谷时 ${Math.round(price.discount * 100)}%` : String(raw.badge || ''),
      status: String(raw.status || ''),
    });
    rawById.set(id, raw);
  }
  return { models, rawById };
}

export class QoderClient {
  constructor({
    region = 'global',
    catalogTtlMs = DEFAULTS.catalogTtlMs,
    log = () => {},
    onAuthChange = () => {},
    onCatalogUpdated = () => {},
    transport = requestStream,
  } = {}) {
    this.region = REGIONS[region] ? region : 'global';
    this.catalogTtlMs = catalogTtlMs;
    this.log = log;
    this.onAuthChange = onAuthChange;
    this.onCatalogUpdated = onCatalogUpdated;
    this.transport = transport;
    this.auth = null;
    this.authWrite = Promise.resolve();
    this.session = null;
    this.pendingDevices = new Map();
    this.catalogCache = { at: 0, models: [], error: '', staleMs: 0 };
    this.catalogGeneration = 0;
    this.catalogInflight = null;
    this.rawById = new Map();
    this.extras = null;
    this.extrasAt = 0;
    this.extrasPromise = null;
    this.extrasGeneration = 0;
    this.loadStoredAuth();
    this.loadDiskCatalog();
  }

  loadStoredAuth() {
    try {
      const stored = readEncryptedJson(PATHS.auth);
      if (stored?.accessToken || stored?.refreshToken) {
        this.auth = stored;
        this.region = REGIONS[stored.region] ? stored.region : this.region;
        return;
      }
    } catch (error) {
      this.log('读取本地加密凭据失败，将尝试导入官方客户端登录态', String(error?.message || error));
    }
    // 首次使用：只读导入本机已登录的 Qoder 桌面端/CLI，免去重复授权。
    try {
      const candidate = pickDesktopAuth(this.region);
      if (candidate) {
        this.setAuth(authFromCandidate(candidate), { silent: true, persist: true });
        this.log(`已导入本机 Qoder ${candidate.regionLabel} 登录态（${candidate.kind}）`);
      }
    } catch (error) {
      this.log('导入本机 Qoder 登录态失败', String(error?.message || error));
    }
  }

  loadDiskCatalog() {
    try {
      const cached = readCatalogCache();
      if (cached && cached.schema === 4 && cached.region === this.region && cached.models.length) {
        this.catalogCache = { at: cached.at, models: cached.models, error: '', staleMs: 0 };
      }
    } catch { /* cache is optional */ }
  }

  setAuth(auth, { silent = false, persist = true, source = '' } = {}) {
    const sameAccount = Boolean(auth && this.auth
      && auth.region === this.auth.region
      && String(auth.user?.id || '') === String(this.auth.user?.id || '')
      && Boolean(auth.user?.id || this.auth.user?.id));
    this.auth = auth ? { ...auth, ...(source ? { source } : {}), updatedAt: Date.now() } : null;
    this.session = null;
    if (!sameAccount) {
      // 旧账号的在途额度请求不能写回新账号的缓存，也不能被新账号复用。
      this.extrasGeneration += 1;
      this.extrasPromise = null;
      this.extras = null;
      this.extrasAt = 0;
    }
    if (persist) this.#queueAuthWrite(this.auth);
    if (!silent) this.onAuthChange?.();
  }

  /**
   * 凭据写入串成一条异步队列：令牌刷新不再同步等 PowerShell DPAPI 落盘，
   * 登录类操作会调用 flushAuthWrite() 等到真正写完再向用户报成功。
   */
  #queueAuthWrite(auth) {
    this.authWrite = this.authWrite
      .then(() => writeEncryptedJsonAsync(PATHS.auth, auth))
      .catch((error) => this.log('保存加密凭据失败', String(error?.message || error)));
    return this.authWrite;
  }

  async flushAuthWrite() {
    await this.authWrite;
  }

  sessionForAuth() {
    if (!this.auth?.accessToken) throw new QoderAuthError('尚未登录 Qoder');
    if (!this.session) {
      this.session = new CosySession({
        uid: this.auth.user?.id || '',
        nickname: this.auth.user?.name || '',
        accessToken: this.auth.accessToken,
        refreshToken: this.auth.refreshToken || '',
        userType: this.auth.userType || DEFAULT_USER_TYPE,
        organizationId: this.auth.organizationId || '',
        organizationName: this.auth.organizationName || '',
      });
    }
    return this.session;
  }

  status({ desktop = true } = {}) {
    const cfg = cfgOf(this.region);
    // 桌面端扫描会读多个账号文件（Windows 首次还要 DPAPI）；
    // 只有面板/账号相关路径需要它，诊断与工具不必为它阻塞。
    const candidates = desktop ? publicDesktopCandidates() : null;
    const desktopInfo = candidates
      ? { available: candidates.some((candidate) => candidate.valid), candidates }
      : null;
    if (!this.auth) {
      return {
        signedIn: false,
        region: this.region,
        regionLabel: cfg.label,
        account: null,
        token: null,
        ...(desktopInfo ? { desktop: desktopInfo } : {}),
      };
    }
    const expiresAt = Number(this.auth.expiresAt) || 0;
    const expiresInMs = expiresAt ? expiresAt - Date.now() : null;
    const account = publicAccount(this.auth);
    const planName = this.extras?.plan
      && String(this.extras.plan.plan_tier_name || this.extras.plan.planName || this.extras.plan.name || '');
    if (planName) account.plan = planName;
    const quota = this.extras?.quota;
    if (quota) {
      const remaining = Number(quota.userQuota?.remaining || 0) + Number(quota.addOnQuota?.remaining || 0);
      if (remaining > 0) account.credits = remaining;
    }
    return {
      signedIn: true,
      region: this.region,
      regionLabel: cfg.label,
      account,
      token: {
        source: this.auth.source || 'desktop',
        expiresAt,
        expiresInMs,
        expiresLabel: expiresAt ? new Date(expiresAt).toLocaleString('zh-CN') : '',
        expired: Boolean(expiresAt && expiresAt <= Date.now()),
        needsRefresh: !this.auth.accessToken,
      },
      ...(desktopInfo ? { desktop: desktopInfo } : {}),
      extras: this.extras,
      extrasAt: this.extrasAt,
    };
  }

  async refreshAuth() {
    const auth = this.auth;
    if (!auth) throw new QoderAuthError('尚未登录 Qoder');
    const cfg = cfgOf(auth.region || this.region);
    const ua = cfg.ua;
    // 桌面端/CLI 凭据优先重新只读读取官方存储：Qoder 的 refresh token 每次
    // 刷新都会轮换，若插件拿同一份 drt- 去刷新，可能让官方客户端下次刷新失败。
    if (auth.source === 'desktop' || auth.source === 'cli') {
      try {
        invalidateDesktopScan();
        const myUid = String(auth.user?.id || '');
        const candidates = scanDesktopAuth({ force: true })
          .filter((candidate) => candidate.valid && candidate.accessToken && candidate.region === auth.region)
          .filter((candidate) => (myUid
            ? String(candidate.uid || '') === myUid
            : candidate.kind === (auth.source === 'desktop' ? 'app' : 'cli')))
          .sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
        const freshest = candidates[0];
        if (freshest && freshest.accessToken !== auth.accessToken) {
          const next = authFromCandidate(freshest);
          // 只同步同一账号的令牌：令牌轮换不是登录状态变化，不能清目录、触发自动签到。
          this.setAuth(next, { silent: true });
          this.log('Qoder 桌面端令牌已更新，跟随切换');
          return next;
        }
      } catch (error) {
        this.log('重新读取桌面端令牌失败，尝试刷新', String(error?.message || error));
      }
    }
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': ua };
    let result = null;
    if (String(auth.refreshToken || '').startsWith('drt-')) {
      result = await fetchJson(`${cfg.oauthBase}/api/v1/deviceToken/refresh`, {
        method: 'POST', headers, body: JSON.stringify({ refresh_token: auth.refreshToken }),
      });
    } else if (auth.refreshToken) {
      result = await fetchJson(`${cfg.oauthBase}/api/v1/jobToken/refresh`, {
        method: 'POST', headers, body: JSON.stringify({ refresh_token: auth.refreshToken }),
      });
      if (!result.ok && auth.personalToken) {
        result = await fetchJson(`${cfg.oauthBase}/api/v1/jobToken/exchange`, {
          method: 'POST', headers, body: JSON.stringify({ personal_token: auth.personalToken }),
        });
      }
    }
    if (!result) throw new QoderAuthError('登录已过期且没有可用的刷新令牌，请在面板重新授权');
    if (!result.ok || !(result.data?.token || result.data?.device_token)) {
      const detail = result.data?.message || result.text || `HTTP ${result.status}`;
      throw new QoderAuthError(`刷新 Qoder 登录失败：${String(detail).slice(0, 200)}`);
    }
    const data = result.data;
    const next = {
      ...auth,
      accessToken: data.token || data.device_token,
      refreshToken: data.refresh_token || auth.refreshToken,
      expiresAt: expiresFrom(data),
      updatedAt: Date.now(),
    };
    this.setAuth(next, { silent: true });
    this.log('Qoder 登录令牌已刷新');
    return next;
  }

  async ensureAccessToken() {
    if (!this.auth) throw new QoderAuthError('尚未登录 Qoder。请到「设置 → Qoder → 账号」授权。');
    const expiresAt = Number(this.auth.expiresAt) || 0;
    const expiring = expiresAt && expiresAt - Date.now() < 120_000;
    if (!this.auth.accessToken || expiring) {
      if (this.auth.refreshToken || this.auth.personalToken) {
        try { await this.refreshAuth(); } catch (error) {
          if (!this.auth.accessToken || (expiresAt && expiresAt <= Date.now())) throw error;
          this.log('令牌刷新失败，继续使用尚未过期的访问令牌', String(error?.message || error));
        }
      } else if (!this.auth.accessToken || (expiresAt && expiresAt <= Date.now())) {
        throw new QoderAuthError('Qoder 登录已过期，且没有刷新令牌。请重新导入本机登录或重新授权。');
      }
    }
    return this.auth;
  }

  async fetchCatalog({ retried = false } = {}) {
    await this.ensureAccessToken();
    const cfg = cfgOf(this.auth.region || this.region);
    const signBody = qoderEncode(Buffer.from('{}'));
    let lastError = null;
    for (const gateway of cfg.gateways) {
      const url = gateway + CATALOG_PATH;
      const headers = this.sessionForAuth().headers(signBody, url, {
        modelKey: '', sse: false, accept: 'application/json',
      });
      try {
        const res = await httpsJson({ url, method: 'GET', headers, body: signBody });
        if (res.status === 401 || res.status === 403) {
          if (retried) throw new QoderAuthError('Qoder 登录态已失效，请重新授权');
          await this.refreshAuth();
          return this.fetchCatalog({ retried: true });
        }
        if (!res.ok || !res.data) throw new Error(`HTTP ${res.status} ${String(res.text || '').slice(0, 200)}`);
        return normalizeCatalog(res.data);
      } catch (error) {
        if (error instanceof QoderAuthError) throw error;
        lastError = error;
        if (/401|403/.test(String(error?.message || ''))) throw error;
      }
    }
    throw lastError || new Error('Qoder 模型目录不可用');
  }

  #catalogSnapshot(staleMs = 0) {
    return {
      models: this.catalogCache.models,
      at: this.catalogCache.at,
      staleMs,
      error: this.catalogCache.error || '',
    };
  }

  #startCatalogFetch() {
    if (this.catalogInflight) return this.catalogInflight;
    const generation = this.catalogGeneration;
    const job = (async () => {
      try {
        const { models, rawById } = await this.fetchCatalog();
        // 账号切换/退出后旧请求才算完成：结果必须丢弃，不能覆盖新账号的目录。
        if (generation !== this.catalogGeneration) return this.#catalogSnapshot(0);
        this.rawById = rawById;
        this.catalogCache = { at: Date.now(), models, error: '', staleMs: 0 };
        try { writeCatalogCache(this.region, models); } catch { /* cache is optional */ }
        try { this.onCatalogUpdated?.(models); } catch { /* 监听方失败不影响目录 */ }
        return this.#catalogSnapshot(0);
      } catch (error) {
        if (generation !== this.catalogGeneration) return this.#catalogSnapshot(0);
        const message = String(error?.message || error);
        this.catalogCache = { ...this.catalogCache, error: message };
        if (this.catalogCache.models.length) {
          return this.#catalogSnapshot(Math.max(0, Date.now() - this.catalogCache.at));
        }
        throw error;
      }
    })().finally(() => {
      if (this.catalogInflight === job) this.catalogInflight = null;
    });
    this.catalogInflight = job;
    job.catch(() => { /* 后台刷新可能没人 await；错误已记录在 catalogCache */ });
    return job;
  }

  #withSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason || new Error('aborted'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason || new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * stale-while-revalidate：有目录就先返回，过期只触发后台刷新。
   * 这样 prepareCall / 模型选择器不会为了目录再等一个上游往返；
   * 显式 refresh 以及首次无缓存时仍然等待真实结果。
   */
  async listCatalog({ refresh = false, signal } = {}) {
    if (!this.auth) {
      return { models: [], at: 0, staleMs: 0, error: '尚未登录 Qoder' };
    }
    const age = Math.max(0, Date.now() - this.catalogCache.at);
    const cached = this.catalogCache.models.length > 0;
    if (!refresh && cached) {
      if (age >= this.catalogTtlMs && !this.catalogInflight) {
        this.#startCatalogFetch().catch((error) => {
          this.log('目录后台刷新失败', String(error?.message || error));
        });
      }
      return this.#catalogSnapshot(age < this.catalogTtlMs ? 0 : age);
    }
    return this.#withSignal(this.#startCatalogFetch(), signal);
  }

  invalidateCatalog() {
    this.catalogGeneration += 1;
    // 旧账号的在途请求结果会被 generation 丢弃；允许新账号立即发起自己的刷新。
    this.catalogInflight = null;
    this.catalogCache = { at: 0, models: [], error: '', staleMs: 0 };
    this.rawById = new Map();
  }

  rawModel(id) {
    // 进程重启后目录来自磁盘缓存，rawById 是空的；按需从缓存模型重建，
    // 否则首个请求会退化成 is_vl/is_reasoning 全 false 的最小配置。
    if (!this.rawById.size && this.catalogCache.models.length) {
      this.rawById = new Map(this.catalogCache.models.map((model) => [model.id, model]));
    }
    return this.rawById.get(id) || null;
  }

  buildChatBody(payload, raw) {
    const body = JSON.parse(JSON.stringify(CHAT_TEMPLATE));
    const messages = Array.isArray(payload.messages) ? payload.messages.map((message) => ({ ...message })) : [];
    if (!messages.length || messages[0].role !== 'system') {
      messages.unshift({ role: 'system', content: DEFAULT_SYSTEM });
    }
    const prompt = (() => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role !== 'user') continue;
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
          return message.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n');
        }
      }
      return '';
    })();
    const now = Date.now();
    const requestId = randomUUID();
    body.messages = messages;
    body.request_id = requestId;
    body.chat_record_id = requestId;
    body.request_set_id = randomUUID();
    body.session_id = randomUUID();
    body.stream = true;
    body.agent_id = 'agent_common';
    body.aliyun_user_type = this.auth?.userType || DEFAULT_USER_TYPE;
    body.model_config = {
      ...(body.model_config || {}),
      key: payload.model,
      display_name: raw?.display_name || raw?.name || payload.model,
      model: '',
      format: 'openai',
      is_vl: raw?.is_vl === true || raw?.supports_images === true,
      is_reasoning: raw?.is_reasoning === true || raw?.supports_reasoning === true,
      api_key: '',
      url: '',
      source: 'system',
      // 上下文选择必须写回请求，否则网关仍按旧的 max_input_tokens 截断。
      max_input_tokens: Number(payload.contextWindow) || Number(raw?.context_window) || Number(raw?.max_input_tokens) || 180000,
    };
    // 对齐 Qoder CLI：默认 32K；即使 baseprompt 以后变化也不会退回“未指定”。
    const parameters = { max_tokens: DEFAULTS.providerMaxOutputTokens, ...(body.parameters || {}) };
    if (Number(payload.max_tokens) > 0) parameters.max_tokens = Number(payload.max_tokens);
    if (payload.reasoning_effort) parameters.reasoning_effort = payload.reasoning_effort;
    body.parameters = parameters;
    body.tools = Array.isArray(payload.tools) ? payload.tools : [];
    body.chat_context = body.chat_context || {};
    body.chat_context.text = { ...(body.chat_context.text || {}), text: prompt };
    body.chat_context.extra = body.chat_context.extra || {};
    body.chat_context.extra.originalContent = {
      ...(body.chat_context.extra.originalContent || {}),
      text: prompt,
    };
    body.chat_context.extra.modelConfig = { ...body.model_config };
    body.business = {
      ...(body.business || {}),
      id: randomUUID(),
      begin_at: now,
      name: (prompt || 'chat').slice(0, 30),
      product: 'cli',
      type: 'agent',
      stage: 'start',
    };
    return body;
  }

  async chat(payload, { signal } = {}) {
    await this.ensureAccessToken();
    const model = String(payload?.model || '');
    if (!model) throw new Error('缺少模型 id');
    let raw = this.rawModel(model);
    if (!raw) {
      try {
        await this.listCatalog({});
        raw = this.rawModel(model);
      } catch { /* fall back to minimal model config */ }
    }
    const body = this.buildChatBody(payload, raw);
    const bodyText = qoderEncode(Buffer.from(JSON.stringify(body), 'utf8'));
    const cfg = cfgOf(this.auth.region || this.region);
    const signedPath = '/api/v2/service/pro/sse/agent_chat_generation';
    const headersFor = () => this.sessionForAuth().headers(bodyText, cfg.gateway + CHAT_PATH, {
      modelKey: model, sse: true, accept: 'text/event-stream',
    });
    let res = null;
    let lastError = null;
    for (const gateway of cfg.gateways) {
      try {
        res = await this.transport(gateway + CHAT_PATH, {
          method: 'POST',
          headers: headersFor(),
          body: bodyText,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => '');
        try {
          await this.refreshAuth();
          res = await this.transport(gateway + CHAT_PATH, {
            method: 'POST', headers: headersFor(), body: bodyText, signal,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new QoderAuthError(`Qoder 登录失效：${text.slice(0, 160) || error.message}`);
        }
      }
      if (res.ok) break;
      if (res.status >= 500) { // 网关故障时尝试下一个域名
        lastError = new Error(`HTTP ${res.status}`);
        res.drain?.();
        continue;
      }
      break;
    }
    if (!res) throw lastError || new Error('连接 Qoder 失败');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        body: null,
        firstByteAt: 0,
        text: async () => text,
      };
    }
    return {
      ok: true,
      status: res.status,
      firstByteAt: 0,
      body: this.#translate(res.body, { signal, model }),
      text: async () => '',
    };
  }

  #translate(upstreamBody, { signal, model }) {
    const self = this;
    let upstreamReader = null;
    return new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let buffer = '';
        let closed = false;
        let firstPacketAt = 0;
        const push = (text) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(text)); } catch { closed = true; }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* ignore */ }
        };
        const handleData = (data) => {
          let outer;
          try { outer = JSON.parse(data); } catch { return; }
          const status = outer?.statusCodeValue;
          if (status != null && Number(status) !== 200) {
            const detail = typeof outer.body === 'string' ? outer.body : JSON.stringify(outer).slice(0, 500);
            push(`data: ${JSON.stringify({ error: { message: String(detail).slice(0, 800), code: status } })}\n\n`);
            close();
            return;
          }
          const innerText = outer?.body;
          if (typeof innerText !== 'string') return;
          if (innerText === '[DONE]') {
            push('data: [DONE]\n\n');
            close();
            return;
          }
          let inner;
          try { inner = JSON.parse(innerText); } catch { return; }
          // 上游偶发会下发字面量 null / 非对象帧；直接丢弃，不能转成 `data: null`。
          if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return;
          if (inner.usage) {
            self.lastUsage = inner.usage;
            self.onUsageMeta?.(inner.usage);
          }
          if (!firstPacketAt) firstPacketAt = Date.now();
          push(`data: ${JSON.stringify(inner)}\n\n`);
        };
        try {
          const reader = upstreamReader = upstreamBody.getReader();
          if (signal) {
            if (signal.aborted) { await reader.cancel().catch(() => {}); close(); return; }
            signal.addEventListener('abort', () => {
              reader.cancel().catch(() => {});
              close();
            }, { once: true });
          }
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data) handleData(data);
              if (closed) break;
            }
            if (closed) break;
          }
          if (!closed && buffer.trim().startsWith('data:')) {
            handleData(buffer.trim().slice(5).trim());
          }
          if (!closed) {
            push('data: [DONE]\n\n');
            close();
          }
          if (firstPacketAt) self.lastFirstByteAt = firstPacketAt;
        } catch (error) {
          if (!closed) {
            push(`data: ${JSON.stringify({ error: { message: `Qoder 流中断：${error?.message || error}` } })}\n\n`);
            close();
          }
        }
      },
      cancel() {
        if (upstreamReader) upstreamReader.cancel().catch(() => {});
        else upstreamBody.cancel().catch(() => {});
      },
    });
  }

  async test({
    model,
    prompt = 'Reply with the single word: pong',
    maxTokens = 512,
    temperature,
    reasoningEffort,
    contextWindow,
    signal,
    firstByteTimeoutMs = DEFAULTS.firstByteTimeoutMs,
    idleTimeoutMs = DEFAULTS.streamIdleTimeoutMs,
  } = {}) {
    const started = Date.now();
    const body = {
      model,
      messages: [
        { role: 'system', content: DEFAULT_SYSTEM },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      stream: true,
    };
    if (Number(contextWindow) > 0) body.contextWindow = Number(contextWindow);
    if (typeof temperature === 'number') body.temperature = temperature;
    if (typeof reasoningEffort === 'string' && reasoningEffort) body.reasoning_effort = reasoningEffort;
    const requestGuard = createFirstByteGuard({ signal, timeoutMs: firstByteTimeoutMs, label: '首包' });
    let res;
    try {
      res = await this.chat(body, { signal: requestGuard.signal });
    } catch (error) {
      requestGuard.dispose();
      if (requestGuard.timedOut) {
        const timeout = new Error(`Qoder ${Math.max(1, Math.round(firstByteTimeoutMs / 1000))} 秒内没有返回首包`);
        timeout.code = 'FIRST_BYTE_TIMEOUT';
        throw timeout;
      }
      throw error;
    }
    if (!res.ok) {
      requestGuard.dispose();
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${String(text).slice(0, 300)}`);
    }
    let reader = null;
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let usage = null;
    let firstByteMs = 0;
    let firstChunk = true;
    try {
      reader = res.body.getReader();
      for (;;) {
        const timeoutMs = firstChunk
          ? (firstByteTimeoutMs || idleTimeoutMs)
          : idleTimeoutMs;
        const { done, value } = await readWithTimeout(
          reader,
          timeoutMs,
          firstChunk ? '首包' : '后续数据',
        );
        if (done) break;
        if (!firstByteMs) firstByteMs = Date.now() - started;
        if (firstChunk) {
          firstChunk = false;
          requestGuard.clear();
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const frame = JSON.parse(data);
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) continue;
            if (frame.error) {
              const err = typeof frame.error === 'object' ? frame.error : { message: String(frame.error) };
              throw new Error(err.message || 'upstream error');
            }
            const delta = frame.choices?.[0]?.delta;
            if (delta?.content) text += delta.content;
            if (delta?.reasoning_content) reasoning += delta.reasoning_content;
            else if (delta?.reasoning) reasoning += delta.reasoning;
            if (frame.usage) usage = frame.usage;
          } catch (error) {
            if (error?.message && !/JSON/i.test(error.message)) throw error;
          }
        }
      }
    } catch (error) {
      if (requestGuard.timedOut) {
        const timeout = new Error(`Qoder ${Math.max(1, Math.round(firstByteTimeoutMs / 1000))} 秒内没有返回首包`);
        timeout.code = 'FIRST_BYTE_TIMEOUT';
        throw timeout;
      }
      throw error;
    } finally {
      requestGuard.dispose();
      if (reader) await reader.cancel().catch(() => {});
    }
    return { text, reasoning, usage, firstByteMs, latencyMs: Date.now() - started };
  }

  async beginDeviceAuth(region = this.region) {
    const targetRegion = REGIONS[region] ? region : this.region;
    const cfg = cfgOf(targetRegion);
    const verifier = Array.from(randomBytes(64), (byte) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[byte % 66]).join('');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const nonce = cfg.nonceDashed ? randomUUID() : randomBytes(16).toString('hex');
    let machineId = '';
    const machinePath = join(homedir(), cfg.homeDir, '.auth', 'machine_id');
    if (existsSync(machinePath)) {
      try { machineId = readFileSync(machinePath, 'utf8').trim(); } catch { /* ignore */ }
    }
    if (!machineId) machineId = randomUUID();
    const query = new URLSearchParams({
      challenge,
      challenge_method: 'S256',
      nonce,
      client_id: cfg.clientId,
      machine_id: machineId,
    });
    if (cfg.sendRedirectUri) query.set('redirect_uri', cfg.redirectUri);
    const authUrl = `${cfg.origin}/device/selectAccounts?${query.toString()}`;
    const id = randomUUID();
    this.pendingDevices.set(id, { verifier, nonce, region: targetRegion, createdAt: Date.now(), authUrl });
    for (const [key, value] of this.pendingDevices) {
      if (Date.now() - value.createdAt > 10 * 60_000) this.pendingDevices.delete(key);
    }
    return { id, userCode: '', verificationUri: authUrl, expiresIn: 600, interval: 2 };
  }

  async pollDeviceAuth(id) {
    const pending = this.pendingDevices.get(String(id || ''));
    if (!pending) return { ok: false, error: '授权会话已过期，请重新发起', status: 'expired' };
    if (Date.now() - pending.createdAt > 10 * 60_000) {
      this.pendingDevices.delete(String(id));
      return { ok: false, error: '授权会话已过期，请重新发起', status: 'expired' };
    }
    const cfg = cfgOf(pending.region);
    const query = new URLSearchParams({
      nonce: pending.nonce,
      verifier: pending.verifier,
      challenge_method: 'S256',
    });
    const res = await fetchJson(`${cfg.oauthBase}/api/v1/deviceToken/poll?${query.toString()}`, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'QoderWork' },
      timeoutMs: 20_000,
    });
    if (res.status === 202 || res.status === 404) {
      return { ok: true, status: 'pending', message: '等待浏览器完成 Qoder 设备授权' };
    }
    if (!res.ok || !res.data) {
      return { ok: false, status: 'error', error: `HTTP ${res.status} ${String(res.text || '').slice(0, 200)}` };
    }
    const token = res.data.token || res.data.device_token || '';
    if (!token) return { ok: true, status: 'pending', message: '等待授权令牌' };
    const info = await this.fetchUserInfo(cfg, token).catch(() => null);
    const auth = {
      schemaVersion: 1,
      region: pending.region,
      accessToken: token,
      refreshToken: res.data.refresh_token || '',
      expiresAt: expiresFrom(res.data),
      user: userFromInfo(info, { id: res.data.user_id || '' }),
      userType: info?.user_type || DEFAULT_USER_TYPE,
      organizationId: info?.organization_id || info?.organizationId || '',
      organizationName: info?.organization_name || info?.organizationName || '',
      source: 'oauth',
      updatedAt: Date.now(),
    };
    this.region = pending.region;
    this.setAuth(auth);
    this.invalidateCatalog();
    this.pendingDevices.delete(String(id));
    await this.flushAuthWrite();
    return { ok: true, status: 'ready', account: publicAccount(auth) };
  }

  async importPat(token, region = this.region) {
    const value = String(token || '').trim();
    if (!value) throw new Error('请输入 PAT');
    this.region = REGIONS[region] ? region : this.region;
    const cfg = cfgOf(this.region);
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': cfg.ua };
    let accessToken = '';
    let refreshToken = '';
    let expiresAt = 0;
    let personalToken = '';
    if (value.startsWith('pt-')) {
      const res = await fetchJson(`${cfg.oauthBase}/api/v1/jobToken/exchange`, {
        method: 'POST', headers, body: JSON.stringify({ personal_token: value }),
      });
      if (!res.ok || !res.data?.token) throw new Error(`PAT 交换失败：HTTP ${res.status} ${String(res.text || '').slice(0, 200)}`);
      accessToken = res.data.token;
      refreshToken = res.data.refresh_token || '';
      expiresAt = expiresFrom(res.data);
      personalToken = value;
    } else if (value.startsWith('drt-')) {
      refreshToken = value;
    } else if (/^(dt|jt)-/.test(value)) {
      accessToken = value;
    } else {
      throw new Error('无法识别的令牌：PAT 应以 pt- 开头，访问令牌以 dt-/jt- 开头');
    }
    const draft = {
      schemaVersion: 1,
      region: this.region,
      accessToken,
      refreshToken,
      expiresAt,
      personalToken,
      user: { id: '', name: '', email: '', avatarUrl: '' },
      userType: DEFAULT_USER_TYPE,
      organizationId: '',
      organizationName: '',
      source: personalToken ? 'pat' : 'token',
      updatedAt: Date.now(),
    };
    if (!accessToken) {
      this.setAuth(draft, { silent: true });
      try { await this.refreshAuth(); } catch (error) {
        this.setAuth(null, { silent: true });
        throw new Error(`仅提供了刷新令牌，但刷新失败：${error.message}`);
      }
    } else {
      this.setAuth(draft, { silent: true });
    }
    const info = await this.fetchUserInfo(cfg, this.auth.accessToken).catch(() => null);
    if (info) {
      this.setAuth({
        ...this.auth,
        user: userFromInfo(info, this.auth.user),
        userType: info.user_type || this.auth.userType,
        organizationId: info.organization_id || info.organizationId || this.auth.organizationId,
        organizationName: info.organization_name || info.organizationName || this.auth.organizationName,
      });
    }
    this.invalidateCatalog();
    this.onAuthChange?.();
    await this.flushAuthWrite();
    return { ok: true, status: 'ready', account: publicAccount(this.auth) };
  }

  async fetchUserInfo(cfg, token) {
    const res = await fetchJson(`${cfg.oauthBase}/api/v1/userinfo`, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': cfg.ua, authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
    });
    if (!res.ok || !res.data) throw new Error(`userinfo HTTP ${res.status}`);
    return res.data;
  }

  async importDesktop(input = {}) {
    const options = typeof input === 'string' ? { region: input } : (input || {});
    const region = String(options.region || '');
    const uid = String(options.uid || '');
    const kind = String(options.kind || '');
    const file = String(options.file || '');
    invalidateDesktopScan();
    const valid = scanDesktopAuth({ force: true })
      .filter((candidate) => candidate.valid && (candidate.accessToken || candidate.refreshToken));
    if (!valid.length) throw new Error('没有找到本机已登录的 Qoder 账号');
    let preferred = null;
    if (uid || kind || file) {
      preferred = findDesktopCandidate({ region, uid, kind, file });
      if (!preferred) throw new Error('没有找到指定的本机账号；请在 Qoder 客户端登录后重新扫描');
    } else {
      preferred = region
        ? valid.find((candidate) => candidate.region === region) || valid[0]
        : pickDesktopAuth(this.region) || valid[0];
    }
    const auth = authFromCandidate(preferred);
    this.region = auth.region;
    this.setAuth(auth);
    this.invalidateCatalog();
    await this.flushAuthWrite();
    return { ok: true, status: 'ready', account: publicAccount(this.auth), region: auth.region };
  }

  async logout() {
    await this.flushAuthWrite();
    removeFile(PATHS.auth);
    this.auth = null;
    this.session = null;
    this.extrasGeneration += 1;
    this.extrasPromise = null;
    this.extras = null;
    this.invalidateCatalog();
    this.onAuthChange?.();
    return { ok: true };
  }

  /**
   * 套餐/积分是“锦上添花”的展示信息：失败不影响对话，也不阻塞面板。
   * 面板、诊断、签到会并发读取，合并成一次上游请求，避免额度被重复刷新。
   */
  async refreshExtras() {
    const generation = this.extrasGeneration;
    if (this.extrasPromise && this.extrasPromise.generation === generation) {
      return this.extrasPromise.promise;
    }
    const task = this.#fetchExtras(generation);
    const entry = { generation, promise: task };
    this.extrasPromise = entry;
    task.finally(() => {
      if (this.extrasPromise === entry) this.extrasPromise = null;
    }).catch(() => {});
    return task;
  }

  async #fetchExtras(generation) {
    if (!this.auth) return null;
    if (generation !== this.extrasGeneration) return null;
    const cfg = cfgOf(this.auth.region || this.region);
    if (!this.auth.accessToken) {
      if (!this.auth.refreshToken && !this.auth.personalToken) return this.extras;
      try {
        await this.refreshAuth();
      } catch (error) {
        this.log('读取账号信息前刷新令牌失败', String(error?.message || error));
        return this.extras;
      }
      if (generation !== this.extrasGeneration) return null;
      if (!this.auth.accessToken) return this.extras;
    }
    const read = (bearer) => {
      const headers = { accept: 'application/json', 'user-agent': cfg.ua, authorization: `Bearer ${bearer}` };
      return Promise.allSettled([
        fetchJson(`${cfg.oauthBase}/api/v2/user/plan`, { headers, timeoutMs: 12_000 }),
        fetchJson(`${cfg.oauthBase}/api/v2/quota/usage`, { headers, timeoutMs: 12_000 }),
      ]);
    };
    const unauthorized = (result) => result.status === 'fulfilled'
      && (result.value.status === 401 || result.value.status === 403);
    let settled = await read(this.auth.accessToken);
    if ((unauthorized(settled[0]) || unauthorized(settled[1]))
      && (this.auth.refreshToken || this.auth.personalToken)) {
      try {
        const next = await this.refreshAuth();
        if (next?.accessToken) settled = await read(next.accessToken);
      } catch (error) {
        this.log('刷新账号信息前更新令牌失败', String(error?.message || error));
      }
    }
    const [plan, quota] = settled;
    const extras = {
      plan: plan.status === 'fulfilled' && plan.value.ok ? plan.value.data : null,
      quota: quota.status === 'fulfilled' && quota.value.ok ? quota.value.data : null,
      at: Date.now(),
    };
    if (generation === this.extrasGeneration) {
      this.extras = extras;
      this.extrasAt = Date.now();
    }
    return extras;
  }
}
