/**
 * Qoder → DSH LLM 适配器。
 *
 * 只做词汇翻译：DSH GenerateOptions ↔ OpenAI Chat Completions，
 * OpenAI SSE 帧 → DSH StreamChunk。上游协议由 lib/qoder-api.mjs 负责。
 *
 * 消息净化、usage 桶算法、StreamTranslator 状态机的行为对齐 dsh 内置
 * 适配器；这部分思路来自 MIT 许可的 workbuddy-to-dsh，见 NOTICE.md。
 */
import { appendUsage } from './state.mjs';
import { DEFAULTS } from './config.mjs';
import { isChatModel, toAdapterModels } from './models.mjs';
import { createFirstByteGuard } from './request-guard.mjs';

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

const ERROR_HINTS = {
  [CODE.AUTH]: 'Qoder 登录态已失效：到「设置 → Qoder → 账号」重新授权。',
  [CODE.QUOTA]: 'Qoder 额度不足：到账号页查看套餐与 Credits，或换一个免费模型。',
  [CODE.RATE_LIMIT]: '触发 Qoder 频率限制：稍等再试，或换一个模型。',
  [CODE.CONTEXT]: '上下文超出该模型上限：压缩对话，或换上下文更大的模型。',
  [CODE.INVALID]: 'Qoder 拒绝了请求参数：换一个思考档位或恢复默认参数后再试。',
  [CODE.TRANSPORT]: '与 Qoder 的连接中断：检查网络或代理后重试。',
};

export function classifyError(message, status) {
  const text = String(message || '');
  if (/isQueued|retryAfterSeconds|"code"\s*:\s*"?10605|排队/i.test(text)) return CODE.RATE_LIMIT;
  if (status === 401 || status === 403) return CODE.AUTH;
  if (/unauthori[sz]ed|invalid.?token|token.{0,12}(expired|invalid)|login required|未登录|登录失效/i.test(text)) return CODE.AUTH;
  if (/quota|insufficient|credits?|余额|额度|积分/i.test(text)) return CODE.QUOTA;
  if (status === 429 || /rate.?limit|too many requests|frequency|限流/i.test(text)) return CODE.RATE_LIMIT;
  if (/context|token.{0,12}(limit|exceed)|maximum context|过长/i.test(text)) return CODE.CONTEXT;
  if (status === 400 || status === 422 || /invalid.?request|参数/i.test(text)) return CODE.INVALID;
  if (status >= 500) return CODE.SERVER;
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(text)) return CODE.TIMEOUT;
  if (/fetch failed|ECONN|socket|network|terminated|prematurely|aborted/i.test(text)) return CODE.TRANSPORT;
  return 'PROVIDER_ERROR';
}

export function errorHint(code, detail = '') {
  if (code === CODE.INVALID && /illegal API invocation|unapproved channel|first message/i.test(String(detail))) {
    return 'Qoder 上游拦截了这次请求的来源或模板；稍等原样重试一次，仍失败请复制诊断报告反馈。';
  }
  return ERROR_HINTS[code] || '';
}

function maxAlias(values) {
  let best = 0;
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/** OpenAI usage → DSH TokenUsage（三个互斥计费桶，桶和必须等于 total）。 */
export function mapUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hasPrompt = raw.prompt_tokens != null || raw.input_tokens != null;
  const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  const cacheRead = maxAlias([
    raw.prompt_tokens_details?.cached_tokens,
    raw.prompt_cache_hit_tokens,
    raw.cache_read_tokens,
    raw.cache_read_input_tokens,
    raw.cached_tokens,
  ]);
  const cacheWrite = maxAlias([
    raw.prompt_tokens_details?.cache_write_tokens,
    raw.prompt_cache_write_tokens,
    raw.cache_creation_input_tokens,
  ]);
  const totalRaw = Number(raw.total_tokens ?? 0) || 0;
  let input;
  if (!hasPrompt && totalRaw > 0) {
    input = Math.max(0, totalRaw - output - cacheRead - cacheWrite);
  } else {
    const miss = Number(raw.prompt_cache_miss_tokens);
    const missConsistent = Number.isFinite(miss) && miss >= 0 && miss + cacheRead + cacheWrite === promptTokens;
    input = missConsistent ? miss : Math.max(0, promptTokens - cacheRead - cacheWrite);
  }
  const total = totalRaw || input + output + cacheRead + cacheWrite;
  const reasoning = Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens ?? 0) || 0;
  const usage = { inputTokens: input, outputTokens: output, totalTokens: total };
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
  if (reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

export function mapFinishReason(reason, sawToolCall, sawContent) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'content_filter':
      return { kind: 'error', failure: { message: 'Qoder 以 content_filter 结束本次回复', code: CODE.INVALID } };
    case 'stop':
      if (sawToolCall) return { kind: 'tool-calls' };
      if (!sawContent) return { kind: 'error', failure: { message: 'Qoder 回复结束但没有任何内容', code: CODE.EMPTY } };
      return { kind: 'stop' };
    default:
      if (sawToolCall) return { kind: 'tool-calls' };
      if (!sawContent) return { kind: 'error', failure: { message: 'Qoder 回复结束但没有任何内容', code: CODE.EMPTY } };
      return { kind: 'stop' };
  }
}

function textOf(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('');
}

/**
 * 去掉上游一定会拒绝的空助手轮、孤儿工具结果和不完整的工具组。
 *
 * 关键点不是“这个 tool_call_id 在历史里出现过”，而是 OpenAI/DeepSeek 的
 * 硬约束：`role: "tool"` 必须紧跟在**声明它的那条** assistant.tool_calls
 * 之后，且组内不能插入 user/system/assistant。跨 provider 切换、上下文压缩
 * 或模型变更提示都可能把历史拆成不合法顺序；这里按组处理：
 *   - 只接受当前打开的那个工具组里的 ID；
 *   - 组内重复/未知 ID 直接丢掉；
 *   - 组被下一条非 tool 消息关闭时，如果还有未答复的 call，整组丢掉，
 *     避免上游报 “assistant tool_calls 没有对应 tool message”；
 *   - 空 ID / 空 name 的 tool call 先过滤，对应结果自然变成孤儿被丢掉。
 * `stats` 只记录计数，不包含任何消息内容。
 */
export function sanitizeWire(messages, stats = null) {
  const bump = (key, amount = 1) => {
    if (!stats) return;
    stats[key] = (stats[key] || 0) + amount;
  };
  const kept = [];
  let pending = null;

  const closeGroup = () => {
    if (!pending) return;
    if (pending.answered.size < pending.callIds.size) {
      // 未答完的工具组整体剔除：保留会触发另一类 400。
      const start = pending.startIndex;
      let removedTools = 0;
      for (let index = kept.length - 1; index >= start; index -= 1) {
        if (kept[index].role === 'tool') {
          kept.splice(index, 1);
          removedTools += 1;
        } else if (index === start) {
          kept.splice(index, 1);
        }
      }
      bump('droppedToolGroups');
      bump('droppedTools', removedTools);
    }
    pending = null;
  };

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      bump('droppedMessages');
      continue;
    }
    if (message.role === 'tool') {
      const id = String(message.tool_call_id || '');
      if (!pending || !id || !pending.callIds.has(id) || pending.answered.has(id)) {
        bump('orphanTools');
        continue;
      }
      pending.answered.add(id);
      kept.push(message);
      continue;
    }
    closeGroup();
    if (message.role === 'assistant') {
      const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const calls = rawCalls.filter((call) => {
        const id = String(call?.id || '');
        const name = String(call?.function?.name || '');
        return Boolean(id && name);
      });
      if (calls.length !== rawCalls.length) bump('droppedToolCalls', rawCalls.length - calls.length);
      const content = message.content;
      const hasText = (typeof content === 'string' && content.length > 0)
        || (Array.isArray(content) && content.some((part) => (
          (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
          || part?.type === 'image_url'
        )));
      if (!hasText && !calls.length) {
        bump('droppedMessages');
        continue;
      }
      const out = calls.length === rawCalls.length
        ? { ...message }
        : { ...message, ...(calls.length ? { tool_calls: calls } : {}) };
      if (!calls.length) delete out.tool_calls;
      else if (out.content == null) out.content = '';
      kept.push(out);
      if (calls.length) {
        pending = {
          startIndex: kept.length - 1,
          callIds: new Set(calls.map((call) => String(call.id))),
          answered: new Set(),
        };
      }
      continue;
    }
    kept.push(message);
  }
  closeGroup();
  return kept;
}

export async function toWireMessage(message, resolveImage) {
  const role = message.role === 'developer' ? 'system' : message.role;
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (role === 'tool') {
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('') || '(no output)';
    return {
      role,
      tool_call_id: String(message.toolCallId || message.tool_call_id || message.source?.callId || ''),
      content: text,
    };
  }
  if (role === 'assistant') {
    const textParts = [];
    const toolCalls = [];
    const imageRefs = [];
    for (const block of blocks) {
      if (block?.type === 'text') textParts.push(block.text || '');
      else if (block?.type === 'tool-call') {
        toolCalls.push({
          id: String(block.id || block.toolCallId || block.callId || block.source?.callId || ''),
          type: 'function',
          function: {
            name: String(block.name || block.toolName || ''),
            arguments: String(block.arguments ?? block.args ?? '{}'),
          },
        });
      } else if (block?.type === 'image' && block.offloaded !== true) {
        imageRefs.push(resolveImage(block.attachment).catch(() => null));
      }
    }
    const imageParts = (await Promise.all(imageRefs)).filter(Boolean)
      .map((url) => ({ type: 'image_url', image_url: { url } }));
    const text = textParts.join('');
    // Qoder 的 OpenAI 兼容转换器在 content 为 null 时会丢掉整条 assistant
    // 的 tool_calls，随后上游只看到 tool 消息就报 400。空字符串是安全值。
    const out = imageParts.length
      ? { role, content: [...(text ? [{ type: 'text', text }] : []), ...imageParts] }
      : { role, content: text };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return out;
  }
  const hasImage = blocks.some((b) => b?.type === 'image' && b.offloaded !== true);
  if (!hasImage) return { role, content: textOf(blocks) };
  const parts = (await Promise.all(blocks.map(async (block) => {
    if (block?.type === 'text' && block.text) return { type: 'text', text: block.text };
    if (block?.type === 'image') {
      const url = await resolveImage(block.attachment).catch(() => null);
      return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[图片无法读取]' };
    }
    return null;
  }))).filter(Boolean);
  if (!parts.length) parts.push({ type: 'text', text: '' });
  return { role, content: parts };
}

export function toWireTools(options) {
  const byName = new Map();
  const add = (tool) => {
    if (!tool || typeof tool.name !== 'string' || !tool.name || byName.has(tool.name)) return;
    byName.set(tool.name, {
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      },
    });
  };
  for (const tool of options.tools || []) add(tool);
  for (const update of options.toolHistory?.updates || []) {
    for (const tool of update.additions || []) add(tool);
  }
  return [...byName.values()];
}

/** OpenAI SSE `data:` 帧 → DSH 流块。 */
export class StreamTranslator {
  constructor() {
    this.nextIndex = 0;
    this.text = null;
    this.reasoning = null;
    this.tools = new Map();
    this.order = [];
    this.usage = null;
    this.finishReason = undefined;
    this.sawToolCall = false;
    this.error = null;
  }

  get sawContent() {
    return this.text !== null || this.reasoning !== null || this.sawToolCall;
  }

  pushLine(line) {
    const out = [];
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return out;
    const body = trimmed.slice(5).trim();
    if (!body || body === '[DONE]') return out;
    let frame;
    try { frame = JSON.parse(body); } catch { return out; }
    if (frame.usage) this.usage = frame.usage;
    if (frame.error && typeof frame.error === 'object') {
      const err = frame.error;
      const message = (typeof err.message === 'string' && err.message)
        || (typeof frame.message === 'string' && frame.message)
        || (typeof err.type === 'string' && err.type)
        || 'Qoder 在流中途报错';
      const code = err.code ?? frame.code;
      this.error = { message: code != null ? `${message}（code ${code}）` : message };
      return out;
    }
    const choice = frame.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta || {};
    const reasoningDelta = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : delta.reasoning;
    if (typeof reasoningDelta === 'string' && reasoningDelta.length) {
      if (!this.reasoning) {
        this.reasoning = { index: this.nextIndex++, text: '' };
        this.order.push({ kind: 'reasoning', index: this.reasoning.index });
        out.push({ type: 'block-start', index: this.reasoning.index, blockType: 'reasoning' });
      }
      this.reasoning.text += reasoningDelta;
      out.push({ type: 'reasoning-delta', index: this.reasoning.index, text: reasoningDelta });
    }
    if (typeof delta.content === 'string' && delta.content.length) {
      if (!this.text) {
        this.text = { index: this.nextIndex++, text: '' };
        this.order.push({ kind: 'text', index: this.text.index });
        out.push({ type: 'block-start', index: this.text.index, blockType: 'text' });
      }
      this.text.text += delta.content;
      out.push({ type: 'text-delta', index: this.text.index, text: delta.content });
    }
    for (const call of delta.tool_calls || []) {
      const wireIndex = Number.isInteger(call.index) ? call.index : 0;
      let entry = this.tools.get(wireIndex);
      if (!entry) {
        entry = { index: this.nextIndex++, id: '', name: '', args: '' };
        this.tools.set(wireIndex, entry);
        this.sawToolCall = true;
        this.order.push({ kind: 'tool-call', index: entry.index });
        out.push({ type: 'block-start', index: entry.index, blockType: 'tool-call' });
      }
      if (call.id) entry.id = String(call.id);
      if (!entry.id) entry.id = `call_${wireIndex}`;
      if (call.function?.name) entry.name += String(call.function.name);
      const argsDelta = call.function?.arguments;
      if (typeof argsDelta === 'string' && argsDelta.length) {
        entry.args += argsDelta;
        out.push({
          type: 'tool-call-delta',
          index: entry.index,
          id: entry.id,
          ...(entry.name ? { name: entry.name } : {}),
          argumentsDelta: argsDelta,
        });
      }
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  finish() {
    const out = [];
    for (const { kind, index } of this.order) {
      if (kind === 'text' && this.text) {
        out.push({ type: 'block-end', index, block: { type: 'text', text: this.text.text } });
      } else if (kind === 'reasoning' && this.reasoning) {
        out.push({ type: 'block-end', index, block: { type: 'reasoning', text: this.reasoning.text } });
      } else if (kind === 'tool-call') {
        for (const entry of this.tools.values()) {
          if (entry.index !== index) continue;
          out.push({
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args || '{}' },
          });
        }
      }
    }
    const usage = mapUsage(this.usage);
    if (usage) out.push({ type: 'usage', usage });
    if (this.error) {
      out.push({
        type: 'finish',
        reason: { kind: 'error', failure: { message: this.error.message, code: classifyError(this.error.message) } },
      });
      return out;
    }
    out.push({ type: 'finish', reason: mapFinishReason(this.finishReason, this.sawToolCall, this.sawContent) });
    return out;
  }
}

const EFFORT_NAMES = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};
const EFFORT_ORDER = Object.keys(EFFORT_NAMES);
const FALLBACK_EFFORTS = ['low', 'medium', 'high'];

export class QoderAdapter {
  constructor(options) {
    this.provider = options.provider;
    this.displayName = options.displayName || 'Qoder';
    this.client = options.client;
    this.resolveImage = options.resolveImage || (async () => null);
    this.log = options.log || (() => {});
    this.getDefaultSelection = typeof options.getDefaultSelection === 'function' ? options.getDefaultSelection : () => null;
    this.defaults = options.defaults || {};
    this.prefs = options.prefs || { visible: null, pinned: '', includeAll: true, contextWindowByModel: {}, paramsByModel: {} };
    this.catalogCache = { at: 0, models: [], error: '', staleMs: 0 };
    this.streamIdleTimeoutMs = Number(options.streamIdleTimeoutMs) || 0;
    this.firstByteTimeoutMs = Number(options.firstByteTimeoutMs) || 0;
    this.showCost = options.showCost !== false;
    this.onUsage = typeof options.onUsage === 'function' ? options.onUsage : null;
    this.imageCache = new Map();
    this.imageCacheChars = 0;
    this.imageInflight = new Map();
  }

  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  imageRequestPricing() {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image?.width, height: image?.height, maxBytes: image?.bytes };
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: [CODE.RATE_LIMIT, CODE.SERVER, CODE.TRANSPORT, CODE.TIMEOUT],
      initialDelayMs: 600,
      maxDelayMs: 10_000,
      jitterRatio: 0.2,
    };
  }

  setPrefs(prefs) {
    this.prefs = prefs || this.prefs;
  }

  setContextWindows(map) {
    this.prefs = { ...this.prefs, contextWindowByModel: map || {} };
  }

  contextWindowsSnapshot() {
    return { ...(this.prefs.contextWindowByModel || {}) };
  }

  setModelParams(map) {
    this.prefs = { ...this.prefs, paramsByModel: map || {} };
  }

  modelParamsSnapshot() {
    return { ...(this.prefs.paramsByModel || {}) };
  }

  invalidate() {
    this.catalogCache = { at: 0, models: [], error: '', staleMs: 0 };
    try { this.client.invalidateCatalog?.(); } catch { /* ignore */ }
  }

  async warmup() {
    try { await this.catalog({ refresh: false }); } catch { /* 面板会显示错误 */ }
  }

  async catalog({ refresh = false, signal } = {}) {
    const result = await this.client.listCatalog({ refresh, signal });
    this.catalogCache = {
      // 刷新失败时上游返回的是缓存时间；不能用 Date.now() 冒充“刚刚刷新成功”。
      at: Number(result?.at) || Date.now(),
      models: Array.isArray(result?.models) ? result.models : [],
      error: String(result?.error || ''),
      staleMs: Number(result?.staleMs) || 0,
    };
    return this.catalogCache.models;
  }

  #savedSelection() {
    try {
      const selection = this.getDefaultSelection?.();
      return selection && typeof selection === 'object' ? selection : null;
    } catch { return null; }
  }

  async listModels(provider = this.provider) {
    let models;
    try {
      models = await this.catalog();
    } catch (error) {
      this.catalogCache.error = String(error?.message || error);
      throw error;
    }
    const saved = this.#savedSelection();
    const pinned = this.prefs.pinned || (saved?.provider === provider ? saved.model : '');
    return toAdapterModels(models, {
      visible: this.prefs.visible ?? null,
      pinned,
      contextWindows: this.prefs.contextWindowByModel || {},
      includeAll: this.prefs.includeAll !== false,
      showCost: this.showCost,
    }).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
    }));
  }

  async resolveModel(provider, model, signal) {
    let catalog;
    try {
      catalog = await this.catalog({ signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return { provider, id: model, name: model };
    }
    const hit = catalog.find((item) => item && item.id === model);
    if (!hit) return { provider, id: model, name: model };
    const contextWindows = this.prefs.contextWindowByModel || {};
    const [mapped] = toAdapterModels([hit], {
      visible: null,
      pinned: model,
      contextWindows,
      includeAll: true,
      showCost: this.showCost,
    });
    if (!mapped) return { provider, id: model, name: model };

    let levels = Array.isArray(hit.reasoning_efforts) && hit.reasoning_efforts.length
      ? [...new Set(hit.reasoning_efforts.map(String).filter(Boolean))]
      : (hit.supports_reasoning === true ? [...FALLBACK_EFFORTS] : []);
    // 旧选择里保存的档位即使不在新目录里也要先保留，避免 dsh 直接拒绝。
    const saved = this.#savedSelection();
    const savedEffort = saved && saved.provider === provider && saved.model === model
      && typeof saved.reasoningEffort === 'string' ? saved.reasoningEffort : '';
    if (mapped.reasoning && savedEffort && EFFORT_NAMES[savedEffort] && !levels.includes(savedEffort)) {
      levels = [...levels, savedEffort].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    }

    const perModel = this.prefs.paramsByModel?.[model] || {};
    const configuredMax = Number(perModel.maxTokens) > 0
      ? Number(perModel.maxTokens)
      : (Number(this.defaults.maxTokens) > 0 ? Number(this.defaults.maxTokens) : 0);
    const modelMaxOutput = Number(hit.max_output_tokens ?? hit.maxTokens ?? 0) || 0;
    // 与 Qoder CLI 对齐：有配置按配置（受模型上限收敛）；否则模型上限；再否则 32K。
    const defaultMaxTokens = configuredMax
      ? (modelMaxOutput ? Math.min(configuredMax, modelMaxOutput) : configuredMax)
      : (modelMaxOutput || DEFAULTS.providerMaxOutputTokens);
    const configuredEffort = (typeof perModel.reasoningEffort === 'string' && perModel.reasoningEffort)
      || (typeof this.defaults.reasoningEffort === 'string' && this.defaults.reasoningEffort)
      || '';
    const officialDefault = typeof hit.default_reasoning_effort === 'string' ? hit.default_reasoning_effort : '';
    const preferred = configuredEffort && levels.includes(configuredEffort) ? configuredEffort : officialDefault;
    const defaultEffort = (preferred && levels.includes(preferred))
      ? preferred
      : (['medium', 'high'].find((effort) => levels.includes(effort)) || levels[levels.length - 1]);

    return {
      provider,
      id: model,
      name: mapped.name || model,
      ...(mapped.description ? { description: mapped.description } : {}),
      ...(mapped.contextWindow ? { context: { contextWindow: mapped.contextWindow } } : {}),
      ...(defaultMaxTokens ? { defaultMaxTokens } : {}),
      ...(mapped.inputModalities ? { inputModalities: mapped.inputModalities } : {}),
      ...(levels.length
        ? { reasoning: { efforts: levels.map((id) => ({ id, name: EFFORT_NAMES[id] || id })), defaultEffort } }
        : {}),
    };
  }

  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  async resolveImageCached(ref) {
    if (!ref?.attachmentId) return null;
    const key = `${ref.attachmentId}\u0000${ref.mediaType || ''}\u0000${ref.bytes ?? ''}`;
    const cached = this.imageCache.get(key);
    if (cached !== undefined) {
      this.imageCache.delete(key);
      this.imageCache.set(key, cached);
      return cached;
    }
    const inflight = this.imageInflight.get(key);
    if (inflight) return inflight;
    const task = (async () => {
      const dataUrl = await this.resolveImage(ref).catch(() => null);
      if (dataUrl) {
        this.imageCache.set(key, dataUrl);
        this.imageCacheChars += dataUrl.length;
        while (this.imageCacheChars > 48 * 1024 * 1024 && this.imageCache.size > 1) {
          const [oldestKey, oldestUrl] = this.imageCache.entries().next().value;
          this.imageCache.delete(oldestKey);
          this.imageCacheChars -= oldestUrl.length;
        }
      }
      return dataUrl;
    })();
    this.imageInflight.set(key, task);
    try { return await task; } finally { this.imageInflight.delete(key); }
  }

  contextWindowFor(model) {
    const raw = this.catalogCache.models.find((item) => item && item.id === model);
    const max = Number(raw?.context_window_max ?? 0) || 0;
    const wanted = Number(this.prefs.contextWindowByModel?.[model]) || 0;
    const fallback = Number(raw?.context_window ?? 0) || 0;
    const selected = wanted > 0 ? wanted : fallback;
    return max > 0 && selected > max ? max : selected;
  }

  async *stream(options) {
    const model = String(options.model || '');
    const signal = options.signal;
    if (!isChatModel(model)) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `Qoder 不接受模型 “${model}”`, code: CODE.INVALID } } };
      return;
    }

    let payload;
    try {
      const messages = [];
      if (typeof options.system === 'string' && options.system.length) {
        messages.push({ role: 'system', content: options.system });
      }
      const resolveImage = (ref) => this.resolveImageCached(ref);
      messages.push(...await Promise.all((options.messages || []).map((message) => toWireMessage(message, resolveImage))));
      const wireStats = {};
      payload = { model, messages: sanitizeWire(messages, wireStats), stream: true };
      payload.contextWindow = this.contextWindowFor(model);
      if (Object.keys(wireStats).length) {
        this.log('消息序列已清洗', wireStats);
      }
      if (process.env.QODER_LOG_WIRE === '1') {
        this.log('wire sequence', payload.messages.map((message) => {
          const calls = Array.isArray(message.tool_calls)
            ? `[${message.tool_calls.map((call) => call.id).join(',')}]`
            : '';
          return `${message.role}${calls}${message.tool_call_id ? `@${message.tool_call_id}` : ''}`;
        }).join(' | '));
      }
      const tools = toWireTools(options);
      if (tools.length) payload.tools = tools;
      const perModel = this.prefs.paramsByModel?.[model] || {};
      const hasCallerTemp = typeof options.temperature === 'number';
      const temperature = hasCallerTemp
        ? options.temperature
        : (typeof perModel.temperature === 'number' ? perModel.temperature : this.defaults.temperature);
      if (typeof temperature === 'number') payload.temperature = temperature;
      const callerMax = typeof options.maxTokens === 'number' && options.maxTokens > 0;
      let maxTokens = callerMax
        ? options.maxTokens
        : (Number(perModel.maxTokens) > 0 ? Number(perModel.maxTokens) : this.defaults.maxTokens);
      const rawHit = this.catalogCache.models.find((item) => item && item.id === model);
      if (!(typeof maxTokens === 'number' && maxTokens > 0)) {
        maxTokens = Number(rawHit?.max_output_tokens ?? rawHit?.maxTokens ?? 0) || DEFAULTS.providerMaxOutputTokens;
      }
      const modelMax = Number(rawHit?.max_output_tokens ?? rawHit?.maxTokens ?? 0) || 0;
      if (modelMax && typeof maxTokens === 'number' && maxTokens > modelMax) maxTokens = modelMax;
      if (typeof maxTokens === 'number' && maxTokens > 0) payload.max_tokens = maxTokens;
      const effort = (typeof options.reasoningEffort === 'string' && options.reasoningEffort)
        || (typeof perModel.reasoningEffort === 'string' && perModel.reasoningEffort)
        || this.defaults.reasoningEffort;
      if (effort) payload.reasoning_effort = effort;
      if (Array.isArray(options.stop) && options.stop.length) payload.stop = options.stop;
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `请求组装失败：${error?.message || error}`, code: CODE.INVALID } } };
      return;
    }

    const startedAt = Date.now();
    let firstByteMs = 0;
    const requestGuard = createFirstByteGuard({
      signal,
      timeoutMs: this.firstByteTimeoutMs,
      label: '首包',
    });
    let res;
    try {
      res = await this.client.chat(payload, { signal: requestGuard.signal });
    } catch (error) {
      const aborted = signal?.aborted === true;
      const timedOut = !aborted && requestGuard.timedOut;
      const failureCode = timedOut
        ? CODE.TIMEOUT
        : aborted
          ? CODE.ABORTED
          : (error?.code === 'AUTH' ? CODE.AUTH : classifyError(error?.message, 0));
      const hint = errorHint(failureCode, error?.message);
      const failure = timedOut
        ? { message: `Qoder ${Math.max(1, Math.round(this.firstByteTimeoutMs / 1000))} 秒内没有返回首包 —— 已停止等待，可重试。`, code: CODE.TIMEOUT }
        : aborted
          ? { message: '已取消', code: CODE.ABORTED }
          : { message: `连接 Qoder 失败：${error?.message || error}${hint ? ` —— ${hint}` : ''}`, code: failureCode };
      requestGuard.dispose();
      const record = {
        at: startedAt, model, client: this.client.auth?.source || 'unknown',
        ok: false,
        status: timedOut ? 'stream-error' : aborted ? 'aborted' : failureCode === CODE.AUTH ? 'auth' : 'transport',
        latencyMs: Date.now() - startedAt, firstByteMs, error: failure.message,
      };
      this.#recordUsage(record);
      yield {
        type: 'finish',
        reason: { kind: aborted && !timedOut ? 'aborted' : 'error', failure },
      };
      return;
    }

    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      requestGuard.dispose();
      let detail = text;
      let codeLabel = null;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.msg || parsed?.message || text;
        const rawCode = parsed?.error?.code ?? parsed?.code;
        codeLabel = rawCode == null ? null : String(rawCode);
      } catch { /* keep text */ }
      const failureCode = signal?.aborted ? CODE.ABORTED : classifyError(`${detail} ${codeLabel || ''}`, res.status);
      const hint = errorHint(failureCode, detail);
      const message = `Qoder ${res.status}：${String(detail || '').slice(0, 400)}${codeLabel ? `（code ${codeLabel}）` : ''}${hint ? ` —— ${hint}` : ''}`;
      this.log(`chat failed model=${model} status=${res.status}`, String(detail || '').slice(0, 200));
      this.#recordUsage({
        at: startedAt, model, client: this.client.auth?.source || 'unknown',
        ok: false, status: `http-${res.status}`,
        latencyMs: Date.now() - startedAt, firstByteMs, error: String(detail || '').slice(0, 300),
      });
      yield {
        type: 'finish',
        reason: {
          kind: signal?.aborted ? 'aborted' : 'error',
          failure: { message, code: failureCode, ...(res.status ? { status: res.status } : {}) },
        },
      };
      return;
    }

    const translator = new StreamTranslator();
    const decoder = new TextDecoder();
    let tail = '';
    let reader = null;
    let failed = false;
    let failure = null;
    let terminalFailure = null;
    let awaitingFirstChunk = true;
    try {
      reader = res.body.getReader();
      const readNext = async () => {
        const isFirst = awaitingFirstChunk;
        const timeoutMs = isFirst
          ? (this.firstByteTimeoutMs || this.streamIdleTimeoutMs)
          : this.streamIdleTimeoutMs;
        if (!timeoutMs) return reader.read();
        let timer = null;
        const idle = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(isFirst
              ? `Qoder ${Math.max(1, Math.round(timeoutMs / 1000))} 秒内没有返回首包`
              : `Qoder ${Math.max(1, Math.round(timeoutMs / 1000))} 秒没有返回数据`);
            error.code = isFirst ? 'FIRST_BYTE_TIMEOUT' : 'IDLE_TIMEOUT';
            reject(error);
          }, timeoutMs);
        });
        try { return await Promise.race([reader.read(), idle]); } finally { if (timer) clearTimeout(timer); }
      };
      for (;;) {
        const { done, value } = await readNext();
        if (done) break;
        if (awaitingFirstChunk) {
          awaitingFirstChunk = false;
          requestGuard.clear();
          firstByteMs = Date.now() - startedAt;
        }
        tail += decoder.decode(value, { stream: true });
        const lines = tail.split('\n');
        tail = lines.pop() ?? '';
        for (const line of lines) {
          for (const chunk of translator.pushLine(line)) yield chunk;
        }
        if (tail.length > 200_000) tail = tail.slice(-8192);
      }
      if (tail.trim()) {
        for (const chunk of translator.pushLine(tail)) yield chunk;
      }
      for (const chunk of translator.finish()) {
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') terminalFailure = chunk.reason.failure;
        yield chunk;
      }
    } catch (error) {
      failed = true;
      const aborted = signal?.aborted === true;
      const timedOut = error?.code === 'IDLE_TIMEOUT'
        || error?.code === 'FIRST_BYTE_TIMEOUT'
        || requestGuard.timedOut;
      const timeoutMessage = requestGuard.timedOut
        ? `Qoder ${Math.max(1, Math.round(this.firstByteTimeoutMs / 1000))} 秒内没有返回首包`
        : (error?.message || 'Qoder 等待数据超时');
      failure = aborted && !timedOut
        ? { kind: 'aborted', failure: { message: '已取消', code: CODE.ABORTED } }
        : timedOut
          ? { kind: 'error', failure: { message: `${timeoutMessage} —— 已停止等待，可重试。`, code: CODE.TIMEOUT } }
          : { kind: 'error', failure: { message: `Qoder 流中断：${error?.message || error}`, code: CODE.TRANSPORT } };
      for (const { kind, index } of translator.order) {
        if (kind === 'text' && translator.text) yield { type: 'block-end', index, block: { type: 'text', text: translator.text.text } };
        else if (kind === 'reasoning' && translator.reasoning) yield { type: 'block-end', index, block: { type: 'reasoning', text: translator.reasoning.text } };
        else if (kind === 'tool-call') {
          for (const entry of translator.tools.values()) {
            if (entry.index !== index) continue;
            yield { type: 'block-end', index, block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args || '{}' } };
          }
        }
      }
      this.log(`stream interrupted model=${model}`, error?.message || error);
      yield { type: 'finish', reason: failure };
    } finally {
      requestGuard.dispose();
      if (reader) await reader.cancel().catch(() => {});
      const usage = translator.usage || {};
      const recordFailure = failure?.failure || terminalFailure || translator.error || null;
      const status = failure?.kind === 'aborted'
        ? 'aborted'
        : (failed || terminalFailure || translator.error) ? 'stream-error' : 'ok';
      // 上游对免费模型也会返回 credits（原价估算），只有 billable !== false 才是实扣。
      const billed = Number(usage.credits ?? 0) || 0;
      const original = Number(usage.original_credits ?? usage.credits ?? 0) || 0;
      const billable = usage.billable !== false;
      this.#recordUsage({
        at: startedAt,
        model,
        client: this.client.auth?.source || 'unknown',
        promptTokens: Number(usage.prompt_tokens ?? 0) || 0,
        completionTokens: Number(usage.completion_tokens ?? 0) || 0,
        totalTokens: Number(usage.total_tokens ?? 0) || 0,
        cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0,
        reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
        credits: billable ? billed : 0,
        originalCredits: Math.max(original, billed),
        savedCredits: Math.max(0, original - (billable ? billed : 0)),
        billable,
        latencyMs: Date.now() - startedAt,
        firstByteMs,
        ok: status === 'ok',
        status,
        error: String(recordFailure?.message || ''),
      });
    }
  }

  #recordUsage(record) {
    try {
      const list = appendUsage(record);
      this.onUsage?.(record, list);
    } catch (error) {
      this.log('usage log failed', String(error?.message || error));
    }
  }
}
