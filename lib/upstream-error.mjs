/**
 * Qoder 上游错误语义。
 *
 * 只做纯解析，不依赖网络/文件。错误可能来自 HTTP body、信封里的 message
 * 字符串、或转义过的 JSON；这里统一折叠后交给适配器分类与重试策略。
 */

export const CODE = {
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA_EXCEEDED',
  INVALID: 'INVALID_REQUEST',
  SERVER: 'SERVER',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  ABORTED: 'ABORTED',
  EMPTY: 'EMPTY_RESPONSE',
  CONTEXT: 'CONTEXT_WINDOW_EXCEEDED',
};

const HARD_QUOTA = /insufficient[_\s-]?quota|quota.{0,24}(exceed|exhaust|limit)|out of credits|no credits|insufficient.{0,12}(credit|balance)|余额不足|额度.{0,8}(用尽|不足)|积分不足/i;

/** 只用于匹配：折叠 `\"` / `\\` 等转义，不用于展示。 */
export function normalizeErrorText(input) {
  let out = String(input ?? '');
  for (let i = 0; i < 2; i += 1) {
    out = out.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return out;
}

export function isModelQueue(value) {
  return /\b10605\b|\bisQueued\b|retryAfterSeconds|retry_after_ms|retryAfterMs|模型排队|排队中/i.test(normalizeErrorText(value));
}

export function isDailyCap(value) {
  return /billing daily count exceeded|daily (?:request )?count (?:exceeded|limit)|"?code"?\s*[:=]\s*"?110\b|\bcode\s+110\b/i.test(normalizeErrorText(value));
}

export function isTerminalSession(value) {
  return /\b12153\b|TOKEN_EXPIRE|Offline user session not found/i.test(normalizeErrorText(value));
}

export function isVersionGate(value) {
  return /version_too_low|version too low|客户端版本过低|版本过低/i.test(normalizeErrorText(value));
}

export function isContentAudit(value) {
  return /DataInspectionFailed|content inspection|内容审核|安全审核/i.test(normalizeErrorText(value));
}

export function isTrialRestricted(value) {
  return /trial account.{0,40}(restricted|not allowed|limit)|试用账号.{0,20}(受限|限制|不支持)|"?code"?\s*[:=]\s*"?114\b|\bcode\s+114\b/i.test(normalizeErrorText(value));
}

function isAuthCode(value) {
  return /"code"?\s*[:=]\s*"?105\b|\bcode\s+105\b/i.test(normalizeErrorText(value));
}

function isQuotaCode(value) {
  return /"code"?\s*[:=]\s*"?112\b|\bcode\s+112\b/i.test(normalizeErrorText(value));
}

export function classifyError(message, status) {
  const text = normalizeErrorText(message);
  if (isModelQueue(text)) return CODE.RATE_LIMIT;
  if (isDailyCap(text)) return CODE.QUOTA;
  if (isTerminalSession(text)) return CODE.AUTH;
  if (status === 430 || isVersionGate(text)) return CODE.INVALID;
  if (isContentAudit(text)) return CODE.INVALID;
  if (isTrialRestricted(text)) return CODE.INVALID;
  // 403 也可能是额度/日限；先识别硬额度，避免被 401/403 的 AUTH 分支吃掉。
  if (status === 402 || HARD_QUOTA.test(text) || isQuotaCode(text)) return CODE.QUOTA;
  if (status === 401 || status === 403) return CODE.AUTH;
  if (isAuthCode(text)) return CODE.AUTH;
  if (/unauthori[sz]ed|invalid.?token|token.{0,12}(expired|invalid)|login required|未登录|登录失效/i.test(text)) return CODE.AUTH;
  if (status === 408) return CODE.TIMEOUT;
  if (status === 429 || /rate.?limit|too many requests|frequency|限流/i.test(text)) return CODE.RATE_LIMIT;
  if (/quota|insufficient|credits?|余额|额度|积分/i.test(text)) return CODE.QUOTA;
  if (/context|token.{0,12}(limit|exceed)|maximum context|过长/i.test(text)) return CODE.CONTEXT;
  if (status === 400 || status === 422 || /invalid.?request|参数/i.test(text)) return CODE.INVALID;
  if (status >= 500) return CODE.SERVER;
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(text)) return CODE.TIMEOUT;
  if (/fetch failed|ECONN|socket|network|terminated|prematurely|aborted|ENOTFOUND|EAI_AGAIN|getaddrinfo|ENETUNREACH|EHOSTUNREACH/i.test(text)) return CODE.TRANSPORT;
  return 'PROVIDER_ERROR';
}

function setPositive(out, key, value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) out[key] = out[key] == null ? n : Math.max(out[key], n);
}

/** 解析数字/小秒或 HTTP-date；非法、过期、超过 1 小时都返回 null。 */
export function parseRetryAfterHeader(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const seconds = Number(text);
  let ms = null;
  if (Number.isFinite(seconds)) ms = seconds > 0 ? Math.round(seconds * 1000) : null;
  else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - now;
  }
  return Number.isFinite(ms) && ms > 0 && ms <= 3_600_000 ? ms : null;
}

function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

/**
 * 从任意一层错误对象/字符串里提取 message/code/isQueued 与重试时间。
 * 解析被转义的 message JSON，但深度受限，避免恶意/循环结构。
 */
export function extractErrorEnvelope(input) {
  const out = { message: '', code: null, isQueued: false, retryAfterMs: null, retryAfterSeconds: null };
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      if (/^[\[{]/.test(text)) {
        try { visit(JSON.parse(text), depth + 1); return; } catch { /* 继续按普通文本解析 */ }
      }
      const normalized = normalizeErrorText(text);
      if (!out.message) out.message = text.slice(0, 800);
      if (out.code == null) {
        const code = /"code"?\s*[:=]\s*"?([A-Za-z0-9_-]{1,24})"?/i.exec(normalized)?.[1];
        if (code) out.code = code;
      }
      if (/\bisQueued\b/i.test(normalized)) out.isQueued = true;
      const ms = /"?retry_?after_ms"?\s*[:=]\s*"?(\d+)/i.exec(normalized)?.[1];
      if (ms) setPositive(out, 'retryAfterMs', ms);
      const seconds = /"?retry_?after(?:_?seconds)?"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(normalized)?.[1];
      if (seconds) setPositive(out, 'retryAfterSeconds', seconds);
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, depth + 1);
      return;
    }
    // 嵌套错误优先，保证 error.message 覆盖外层泛化文案。
    if (value.error != null) visit(value.error, depth + 1);
    if (value.data != null) visit(value.data, depth + 1);
    if (value.body != null) visit(value.body, depth + 1);
    if (typeof value.message === 'string' && /^[\[{]/.test(value.message.trim())) {
      visit(value.message, depth + 1);
    }
    if (!out.message) {
      for (const key of ['message', 'msg', 'detail', 'error_description']) {
        if (typeof value[key] === 'string' && value[key]) { out.message = value[key].slice(0, 800); break; }
      }
    }
    if (out.code == null && value.code != null && typeof value.code !== 'object') out.code = String(value.code);
    if (value.isQueued === true || value.is_queued === true) out.isQueued = true;
    for (const key of ['retryAfterMs', 'retry_after_ms']) {
      if (value[key] != null) setPositive(out, 'retryAfterMs', value[key]);
    }
    for (const key of ['retryAfterSeconds', 'retry_after_seconds', 'retry_after']) {
      if (value[key] != null) setPositive(out, 'retryAfterSeconds', value[key]);
    }
  };
  visit(input);
  return out;
}

export function retryAfterFrom({ info = null, headers = null, isQueued = false, now = Date.now() } = {}) {
  if (info?.retryAfterMs != null) {
    const ms = Number(info.retryAfterMs);
    if (Number.isFinite(ms) && ms > 0 && ms <= 3_600_000) return Math.round(ms);
  }
  if (info?.retryAfterSeconds != null) {
    const ms = Math.round(Number(info.retryAfterSeconds) * 1000);
    if (Number.isFinite(ms) && ms > 0 && ms <= 3_600_000) return ms;
  }
  const headerMs = parseRetryAfterHeader(headerOf(headers, 'retry-after'), now);
  if (headerMs) return headerMs;
  if (isQueued || info?.isQueued) return 5000;
  return null;
}
