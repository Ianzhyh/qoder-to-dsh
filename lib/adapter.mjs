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
import { isChatModel, normalizeModelId, toAdapterModels } from './models.mjs';
import { createTaskRegistry } from './task-identity.mjs';
import { trimImages, textChars } from './request-budget.mjs';
import { createFirstByteGuard } from './request-guard.mjs';
import { tr } from './i18n.mjs';
import {
  CODE, classifyError, errorAction, extractErrorEnvelope, retryAfterFrom,
  isModelQueue, isDailyCap, isTerminalSession, isVersionGate, isContentAudit, isTrialRestricted,
} from './upstream-error.mjs';

export { CODE, classifyError };

const ERROR_HINTS = {
  [CODE.AUTH]: 'Qoder 登录态已失效：到「设置 → Qoder → 账号」重新授权。',
  [CODE.QUOTA]: 'Qoder 额度不足：到账号页查看套餐与 Credits，或换一个免费模型。',
  [CODE.RATE_LIMIT]: '触发 Qoder 频率限制：稍等再试，或换一个模型。',
  [CODE.CONTEXT]: '上下文超出该模型上限：压缩对话，或换上下文更大的模型。',
  [CODE.INVALID]: 'Qoder 拒绝了请求参数：换一个思考档位或恢复默认参数后再试。',
  [CODE.MODEL_NOT_FOUND]: '该模型不在当前 Qoder 目录：刷新目录后重选，或确认账号是否有这个模型的权限。',
  [CODE.TOOL_CALL_LEAK]: '模型把工具调用写成了正文而不是结构化调用；已阻止把这一轮当成完成，请重试。',
  [CODE.TRANSPORT]: '与 Qoder 的连接中断：检查网络或代理后重试。',
  [CODE.TIMEOUT]: 'Qoder 响应超时：稍后重试，或换一个模型。',
};

export function errorHint(code, detail = '') {
  let hint = ERROR_HINTS[code] || '';
  if (code === CODE.RATE_LIMIT && isModelQueue(detail)) hint = 'Qoder 模型正在排队，稍后会自动重试。';
  else if (code === CODE.QUOTA && isDailyCap(detail)) hint = 'Qoder 今日请求次数已达上限，明天再试或换一个免费模型。';
  else if (code === CODE.AUTH && isTerminalSession(detail)) hint = 'Qoder 服务端会话已失效，刷新令牌无效；请在账号页重新授权。';
  else if (code === CODE.INVALID && (isVersionGate(detail) || /\b430\b/.test(String(detail)))) hint = 'Qoder 客户端版本过低；请升级 qoder-to-dsh 或 Qoder CLI。';
  else if (code === CODE.INVALID && isContentAudit(detail)) hint = 'Qoder 内容审核拒绝了这次请求，原样重试不会成功。';
  else if (code === CODE.INVALID && isTrialRestricted(detail)) hint = '当前账号的试用权益受限；换免费模型或升级套餐后再试。';
  else if (code === CODE.INVALID && /illegal API invocation|unapproved channel|first message/i.test(String(detail))) {
    hint = 'Qoder 上游拦截了这次请求的来源或模板；稍等原样重试一次，仍失败请复制诊断报告反馈。';
  }
  return tr(hint);
}

/** 宿主可能把会话 id 放在不同位置；拿不到时任务注册表会用消息摘要兜底。 */
function hostSessionId(options) {
  const direct = options?.sessionId
    || options?.session?.id
    || options?.metadata?.sessionId
    || options?.metadata?.session_id
    || options?.request?.sessionId;
  if (direct) return String(direct);
  const headers = options?.request?.headers || options?.headers;
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === 'x-deepseek-harness-session-id' && value) return String(value);
    }
  }
  return '';
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

function emptyFailure(sawReasoning) {
  return {
    message: sawReasoning
      ? 'Qoder 只返回了思考内容，没有生成正文或工具调用 —— 可重试。'
      : 'Qoder 回复结束但没有任何内容',
    code: CODE.EMPTY,
  };
}

export function mapFinishReason(reason, sawToolCall, sawVisible, sawReasoning = false) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return sawToolCall ? { kind: 'tool-calls' } : { kind: 'error', failure: emptyFailure(sawReasoning) };
    case 'length':
      if (!sawVisible) return { kind: 'error', failure: emptyFailure(sawReasoning) };
      return { kind: 'max-tokens' };
    case 'content_filter':
      return { kind: 'error', failure: { message: 'Qoder 以 content_filter 结束本次回复', code: CODE.INVALID } };
    case 'stop':
      if (sawToolCall) return { kind: 'tool-calls' };
      if (!sawVisible) return { kind: 'error', failure: emptyFailure(sawReasoning) };
      return { kind: 'stop' };
    default:
      if (sawToolCall) return { kind: 'tool-calls' };
      if (!sawVisible) return { kind: 'error', failure: emptyFailure(sawReasoning) };
      return { kind: 'stop' };
  }
}

function textOf(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('');
}

function bump(stats, key) {
  if (!stats || typeof stats !== 'object') return;
  stats[key] = (Number(stats[key]) || 0) + 1;
}

/** 未知内容块降级成带标签的文本，宁可多一段说明，也不静默丢工具结果。 */
function describeBlock(block) {
  const label = String(block?.type || 'block');
  try {
    const text = JSON.stringify(block);
    return `[${label}] ${text.length > 1600 ? `${text.slice(0, 1600)}…` : text}`;
  } catch {
    return `[${label}]`;
  }
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

export async function toWireMessage(message, resolveImage, stats = null) {
  const role = message.role === 'developer' ? 'system' : message.role;
  // DSH 的常规形态是 block 数组；但调用方直接传字符串时也必须原样带过去，
  // 否则 user/tool 消息会变成空内容（上游只看到空白）。
  const blocks = Array.isArray(message.content)
    ? message.content
    : (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []);
  if (role === 'tool') {
    const imageCount = blocks.filter((b) => b?.type === 'image').length;
    if (imageCount) bump(stats, 'toolImages');
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('') || '(no output)';
    const failed = message.isError === true || message.is_error === true
      || blocks.some((b) => b?.isError === true || b?.is_error === true);
    if (failed) bump(stats, 'toolErrors');
    // OpenAI tool 消息没有 is_error 字段；用文本前缀把失败语义保留给模型。
    const suffix = imageCount
      ? `\n[工具返回了 ${imageCount} 张图片；tool 消息不支持图片，已省略]`
      : '';
    return {
      role,
      tool_call_id: String(message.toolCallId || message.tool_call_id || message.source?.callId || ''),
      content: `${failed ? '[tool error] ' : ''}${text}${suffix}`,
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
      } else if (block?.type === 'reasoning') {
        // Qoder 不接受把历史思考当正文回放；这里保持丢弃，但要可见。
        bump(stats, 'droppedReasoning');
      } else if (block?.type) {
        bump(stats, 'unknownBlocks');
        textParts.push(describeBlock(block));
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
  const hasUnknown = blocks.some((b) => b?.type && !['text', 'image'].includes(b.type));
  if (!hasImage && !hasUnknown) return { role, content: textOf(blocks) };
  const parts = (await Promise.all(blocks.map(async (block) => {
    if (block?.type === 'text' && block.text) return { type: 'text', text: block.text };
    if (block?.type === 'image') {
      const url = await resolveImage(block.attachment).catch(() => null);
      return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[图片无法读取]' };
    }
    if (block?.type) {
      bump(stats, 'unknownBlocks');
      return { type: 'text', text: describeBlock(block) };
    }
    return null;
  }))).filter(Boolean);
  if (!parts.length) parts.push({ type: 'text', text: '' });
  return { role, content: parts };
}

/** OpenAI 形状的工具名只接受字母数字下划线连字符。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 工具名在本地先拦一道。
 *
 * Qoder 网关对含点号、斜杠、空格或超长的工具名返回确定性 400，但通常不说是哪个工具，
 * 表现成"这轮对话突然失败"。重名不算错——历史里重复带同一批工具是常态，toWireTools 会去重。
 */
export function findInvalidTool(options) {
  const seen = new Set();
  const all = [];
  for (const tool of options?.tools || []) all.push(tool);
  for (const update of options?.toolHistory?.updates || []) {
    for (const tool of update?.additions || []) all.push(tool);
  }
  for (const tool of all) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    if (!TOOL_NAME_RE.test(tool.name)) {
      return `工具名 ${JSON.stringify(tool.name)} 不合法：只允许字母、数字、下划线和连字符，长度 1–64。这类名字会被 Qoder 网关拒掉整轮请求，已在本机拦下。`;
    }
  }
  return '';
}

export function toWireTools(options, stats = null) {
  const byName = new Map();
  const add = (tool) => {
    if (!tool || typeof tool.name !== 'string' || !tool.name) {
      if (tool) bump(stats, 'skippedTools');
      return;
    }
    if (byName.has(tool.name)) return;
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
let translatorSeq = 0;

export class StreamTranslator {
  constructor({ headers = null, idPrefix = '', inputChars = 0 } = {}) {
    this.nextIndex = 0;
    this.text = null;
    this.reasoning = null;
    this.tools = new Map();
    this.order = [];
    this.usage = null;
    this.finalUsage = null;
    this.inputChars = Math.max(0, Number(inputChars) || 0);
    this.finishReason = undefined;
    this.sawToolCall = false;
    this.error = null;
    // 上游是否有明确的收尾标记。缺 finish_reason 又缺 [DONE]，说明连接在半路被关掉了。
    this.done = false;
    this.headers = headers || {};
    // 上游没给 tool_call.id 时用它合成；固定 call_0 会在多轮会话里撞 id。
    this.idPrefix = idPrefix || `call_${Date.now().toString(36)}${++translatorSeq}`;
  }

  get sawContent() {
    return this.text !== null || this.reasoning !== null || this.sawToolCall;
  }

  get sawReasoning() {
    return this.reasoning !== null;
  }

  pushLine(line) {
    const out = [];
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return out;
    const body = trimmed.slice(5).trim();
    if (!body) return out;
    if (body === '[DONE]') {
      this.done = true;
      return out;
    }
    let frame;
    try { frame = JSON.parse(body); } catch { return out; }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return out;
    if (frame.usage) this.usage = frame.usage;
    // choices: [] 也是“没有可用的 choice”：错误帧若带空数组会被漏判成正常帧，
    // 最终只报一个笼统的 EMPTY_RESPONSE/TRANSPORT，code 与重试时间全部丢失。
    const hasChoices = Array.isArray(frame.choices) && frame.choices.length > 0;
    if (frame.error != null || (frame.code != null && !hasChoices)) {
      const info = extractErrorEnvelope(frame);
      const code = info.code ?? frame.code;
      const rawMessage = info.message
        || (typeof frame.message === 'string' && frame.message)
        || (typeof frame.msg === 'string' && frame.msg)
        || 'Qoder 在流中途报错';
      const numeric = Number(code);
      // 只把看起来像 HTTP 状态码的值交给 classifyError；10605 这类业务码
      // 交给文本规则处理，不能被当成 500。
      const status = Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : 0;
      const retryAfterMs = retryAfterFrom({
        info,
        headers: this.headers,
        isQueued: info.isQueued || isModelQueue(rawMessage),
      });
      this.error = {
        message: code != null ? `${rawMessage}（code ${code}）` : rawMessage,
        ...(status ? { status } : {}),
        ...(retryAfterMs ? { retryAfterMs } : {}),
      };
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
      if (!entry.id) entry.id = `${this.idPrefix}_${wireIndex}`;
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
    let toolIssue = '';
    let validToolCount = 0;
    for (const { kind, index } of this.order) {
      if (kind === 'text' && this.text) {
        out.push({ type: 'block-end', index, block: { type: 'text', text: this.text.text } });
      } else if (kind === 'reasoning' && this.reasoning) {
        out.push({ type: 'block-end', index, block: { type: 'reasoning', text: this.reasoning.text } });
      } else if (kind === 'tool-call') {
        for (const entry of this.tools.values()) {
          if (entry.index !== index) continue;
          if (!entry.name) {
            toolIssue ||= `Qoder 返回了没有名称的工具调用（index ${index}），已阻止写入会话。`;
            continue;
          }
          if (!TOOL_NAME_RE.test(entry.name)) {
            toolIssue ||= `Qoder 返回的工具名不合法（index ${index}）：只允许字母、数字、下划线和连字符。`;
            continue;
          }
          const args = entry.args || '{}';
          try { JSON.parse(args); } catch {
            toolIssue ||= `Qoder 返回的工具参数不是完整 JSON（index ${index}），已阻止写入会话。`;
            continue;
          }
          if (!entry.id) entry.id = `${this.idPrefix}_${index}`;
          validToolCount += 1;
          out.push({
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: args },
          });
        }
      }
    }
    let usage = mapUsage(this.usage);
    if (!usage) {
      // 断流/取消/上游省略 usage 时不能把账本记成 0：按字符数估算，
      // 并在记录里标 estimated，避免和真实计费混在一起。
      const outputChars = (this.text?.text?.length || 0)
        + (this.reasoning?.text?.length || 0)
        + [...this.tools.values()].reduce((sum, entry) => sum + entry.args.length, 0);
      const ratio = Number(DEFAULTS.estimateCharsPerToken) || 4;
      const inputTokens = Math.max(1, Math.round(this.inputChars / ratio));
      const outputTokens = Math.max(0, Math.round(outputChars / ratio));
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimated: true,
      };
      // finally 里落账用的是 translator.usage；估算值必须单独保存，
      // 否则 DSH 收到估算、本地账本仍记 0。
      this.finalUsage = usage;
    }
    if (usage) out.push({ type: 'usage', usage });
    if (this.error) {
      const code = classifyError(this.error.message, this.error.status);
      const hint = errorHint(code, this.error.message);
      out.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: hint ? `${this.error.message} —— ${hint}` : this.error.message,
            code,
            ...(this.error.status ? { status: this.error.status } : {}),
            ...(this.error.retryAfterMs > 0 ? { providerRetryAfterMs: this.error.retryAfterMs } : {}),
          },
        },
      });
      return out;
    }
    // 既没收到 finish_reason，也没收到 [DONE]：连接是在半路被关掉的。
    // 旧实现落到 mapFinishReason 的 default 分支，只要有内容就返回 stop，
    // 半截回答被当成成功，上游不重试、用户也不知道少了一段。
    // 这个判断必须先于 toolIssue：半截工具参数是断流的后果，不是模型参数错误。
    if (!this.finishReason && !this.done) {
      out.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: this.sawContent
              ? 'Qoder 流在结束原因之前中断，回复可能不完整 —— 可重试。'
              : 'Qoder 流在收到任何内容之前中断 —— 可重试。',
            code: CODE.TRANSPORT,
          },
        },
      });
      return out;
    }
    if (process.env.QODER_LEAK_DETECT !== '0'
      && validToolCount === 0
      && this.text?.text
      && TOOL_CALL_LEAK_RE.test(this.text.text)) {
      out.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'Qoder 把工具调用写成了正文（检测到 DSML / <function=…> / 工具调用回声），已阻止把这一轮当成完成；请重试。',
            code: CODE.TOOL_CALL_LEAK,
          },
        },
      });
      return out;
    }
    if (toolIssue) {
      // 默认 fail-fast；QODER_INVALID_TOOL_POLICY=drop 时丢弃坏调用，
      // 但仍插入一条可见文本，避免模型以为工具已经执行成功。
      if (process.env.QODER_INVALID_TOOL_POLICY === 'drop') {
        this.nextIndex = appendWarning(out, this.nextIndex, `[工具调用已丢弃] ${toolIssue}`);
        out.push({
          type: 'finish',
          reason: validToolCount > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
        });
        return out;
      }
      out.push({ type: 'finish', reason: { kind: 'error', failure: { message: toolIssue, code: CODE.INVALID } } });
      return out;
    }
    out.push({
      type: 'finish',
      reason: mapFinishReason(
        this.finishReason,
        validToolCount > 0,
        this.text !== null || validToolCount > 0,
        this.sawReasoning,
      ),
    });
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

// 模型偶尔把工具调用写成正文（DSML、<function=…>、Qoder 自己的回声标记）。
// 这种回合如果按 stop 收尾，coding agent 会以为任务已经完成。
const TOOL_CALL_LEAK_RE = /\[assistant 请求调用工具\]|｜DSML｜|<DSML|<function(?:_calls)?=|<\/?tool_call|<\|tool_call\|>/i;

function appendWarning(out, nextIndex, text) {
  out.push({ type: 'block-start', index: nextIndex, blockType: 'text' });
  out.push({ type: 'block-end', index: nextIndex, block: { type: 'text', text } });
  return nextIndex + 1;
}

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
    this.tasks = createTaskRegistry({
      max: Number(DEFAULTS.taskMax) || 512,
      idleMs: Number(DEFAULTS.taskIdleMs) || 2 * 60 * 60 * 1000,
    });
    this.disposed = false;
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
      retryableCodes: [CODE.RATE_LIMIT, CODE.SERVER, CODE.TRANSPORT, CODE.TIMEOUT, CODE.EMPTY, CODE.TOOL_CALL_LEAK],
      initialDelayMs: 600,
      maxDelayMs: 60_000,
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

  noteCatalogError(message) {
    this.catalogCache = { ...this.catalogCache, error: String(message || '') };
  }

  async warmup() {
    try { await this.catalog({ refresh: false }); } catch { /* 面板会显示错误 */ }
  }

  async catalog({ refresh = false, signal } = {}) {
    const result = await this.client.listCatalog({ refresh, signal });
    this.catalogCache = {
      // 刷新失败时上游返回的是缓存时间；不能用 Date.now() 冒充“刚刚刷新成功”。
      // 连缓存时间都没有（0）时也保持 0，让面板明确显示“未知”，而不是伪造新鲜度。
      at: Number(result?.at) || 0,
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
    const wanted = normalizeModelId(model);
    const fallbackContext = () => ({ context: { contextWindow: this.contextWindowFor(wanted) } });
    let catalog;
    try {
      catalog = await this.catalog({ signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return { provider, id: wanted, name: wanted, ...fallbackContext() };
    }
    const hit = catalog.find((item) => item && item.id === wanted);
    if (!hit) return { provider, id: wanted, name: wanted, ...fallbackContext() };
    const contextWindows = this.prefs.contextWindowByModel || {};
    const [mapped] = toAdapterModels([hit], {
      visible: null,
      pinned: wanted,
      contextWindows,
      includeAll: true,
      showCost: this.showCost,
    });
    if (!mapped) return { provider, id: wanted, name: wanted, ...fallbackContext() };

    let levels = Array.isArray(hit.reasoning_efforts) && hit.reasoning_efforts.length
      ? [...new Set(hit.reasoning_efforts.map(String).filter(Boolean))]
      : (hit.supports_reasoning === true ? [...FALLBACK_EFFORTS] : []);
    // 旧选择里保存的档位即使不在新目录里也要先保留，避免 dsh 直接拒绝。
    const saved = this.#savedSelection();
    const savedEffort = saved && saved.provider === provider && saved.model === wanted
      && typeof saved.reasoningEffort === 'string' ? saved.reasoningEffort : '';
    if (mapped.reasoning && savedEffort && EFFORT_NAMES[savedEffort] && !levels.includes(savedEffort)) {
      levels = [...levels, savedEffort].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    }

    const perModel = this.prefs.paramsByModel?.[wanted] || {};
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
      id: wanted,
      name: mapped.name || wanted,
      ...(mapped.description ? { description: mapped.description } : {}),
      context: { contextWindow: mapped.contextWindow || this.contextWindowFor(wanted) },
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
      // 卸载后晚到的图片不再写回缓存，避免热重载后留下 48MB 的孤儿。
      if (dataUrl && !this.disposed) {
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
    const selected = wanted > 0 ? wanted : (fallback > 0 ? fallback : DEFAULTS.fallbackContextWindow);
    return max > 0 && selected > max ? max : selected;
  }

  dispose() {
    this.disposed = true;
    this.imageCache.clear();
    this.imageInflight.clear();
    this.imageCacheChars = 0;
    this.tasks.clear();
  }

  /**
   * 目录热时拒绝目录外模型；目录冷/过旧时透传，交给上游裁决。
   * 这样既不会把已下架模型静默发出去，也不会误杀刚上线的新模型。
   */
  modelPreflight(model) {
    if (process.env.QODER_SKIP_MODEL_PREFLIGHT === '1' || DEFAULTS.modelPreflight === false) return '';
    const cache = this.catalogCache;
    const at = Number(cache?.at) || 0;
    const fresh = at > 0 && Date.now() - at < 24 * 60 * 60 * 1000;
    if (!fresh || !cache?.models?.length || this.catalogClientStale) return '';
    if (cache.models.some((item) => item && item.id === model)) return '';
    return `模型 “${model}” 不在当前 Qoder 目录（可能已下架，或当前账号没有该模型）。请刷新目录后重选；如果刚上线，可设 QODER_SKIP_MODEL_PREFLIGHT=1 跳过本地校验。`;
  }

  async *stream(options) {
    const model = normalizeModelId(options.model);
    const signal = options.signal;
    const authGeneration = this.client.authGeneration;
    const stamp = this.client.accountStamp?.() || { account: '' };
    if (!isChatModel(model)) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: tr(`Qoder 不接受模型 “${model}”`), code: CODE.INVALID } } };
      return;
    }
    const preflight = this.modelPreflight(model);
    if (preflight) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: tr(preflight), code: CODE.MODEL_NOT_FOUND } } };
      return;
    }
    const toolIssue = findInvalidTool(options);
    if (toolIssue) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: tr(toolIssue), code: CODE.INVALID } } };
      return;
    }

    let payload;
    try {
      const messages = [];
      if (typeof options.system === 'string' && options.system.length) {
        messages.push({ role: 'system', content: options.system });
      }
      const resolveImage = (ref) => this.resolveImageCached(ref);
      const wireStats = {};
      messages.push(...await Promise.all((options.messages || []).map((message) => toWireMessage(message, resolveImage, wireStats))));
      const wire = sanitizeWire(messages, wireStats);
      const tools = toWireTools(options, wireStats);
      const rawMaxImages = process.env.QODER_MAX_IMAGES;
      const maxImages = rawMaxImages === undefined || rawMaxImages === ''
        ? DEFAULTS.maxImagesPerRequest
        : Math.max(0, Number(rawMaxImages) || 0);
      const rawMaxBytes = process.env.QODER_MAX_BODY_BYTES;
      const maxBodyBytes = rawMaxBytes === undefined || rawMaxBytes === ''
        ? DEFAULTS.maxBodyBytes
        : Math.max(1024, Number(rawMaxBytes) || DEFAULTS.maxBodyBytes);
      // 预算不能只看 messages：tools 和 chat_context 也在真实请求体里，
      // 而且发送前会做 base64（约 4/3）。这里先把 messages 之外的字节估进去，
      // 再交给 trimImages 按「编码后」体积裁剪。
      const lastUserText = (() => {
        for (let index = wire.length - 1; index >= 0; index -= 1) {
          const message = wire[index];
          if (!message || message.role !== 'user') continue;
          if (typeof message.content === 'string') return message.content;
          if (Array.isArray(message.content)) {
            return message.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n');
          }
          return '';
        }
        return '';
      })();
      const extraBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
        + Buffer.byteLength(lastUserText, 'utf8') * 2
        + 4096;
      const budget = trimImages(wire, { maxImages, maxBytes: maxBodyBytes, extraBytes });
      if (budget.dropped) {
        this.log('请求体图片已裁剪', {
          images: budget.images,
          dropped: budget.dropped,
          droppedByCount: budget.droppedByCount,
          droppedByBytes: budget.droppedByBytes,
          bytes: budget.bytes,
          encodedBytes: budget.encodedBytes,
          extraBytes,
        });
      }
      if (budget.encodedBytes > maxBodyBytes) {
        const size = Math.round(budget.encodedBytes / 1024 / 1024);
        const hint = budget.images === 0
          ? '图片已裁尽仍超限，主要是工具定义或历史文本体积过大；请减少工具或压缩历史后再试。'
          : '请减少图片、工具定义或压缩历史后再试。';
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: tr(`请求体编码后约 ${size} MiB，超过 Qoder 单次请求上限；${hint}`),
              code: CODE.INVALID,
            },
          },
        };
        return;
      }
      payload = { model, messages: budget.messages, stream: true, ...(options.forceLegacy ? { forceLegacy: true } : {}) };
      payload.task = this.tasks.forRequest({
        account: stamp.account || '',
        model,
        messages: options.messages || [],
        sessionId: hostSessionId(options),
      });
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
      yield { type: 'finish', reason: { kind: 'error', failure: { message: tr(`请求组装失败：${error?.message || error}`), code: CODE.INVALID } } };
      return;
    }

    const startedAt = Date.now();
    let firstByteMs = 0;
    let finishEmitted = false;
    let accountSwitched = false;
    let abortedClean = false;
    const requestGuard = createFirstByteGuard({
      signal,
      timeoutMs: this.firstByteTimeoutMs,
      label: '首包',
    });
    let res;
    let askReleased = false;
    const releaseAsk = () => {
      if (askReleased || !res || !payload?.task?.id) return;
      askReleased = true;
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      Promise.resolve(this.client.releaseAsk?.({
        requestSetId: payload.task.id,
        modelKey: model,
        elapsedMs,
        protocol: payload.forceLegacy ? 'legacy' : '',
      })).catch(() => {});
    };
    try {
      res = await this.client.chat(payload, { signal: requestGuard.signal });
    } catch (error) {
      const aborted = signal?.aborted === true;
      accountSwitched = authGeneration !== this.client.authGeneration;
      const timedOut = !aborted && !accountSwitched && requestGuard.timedOut;
      const failureCode = accountSwitched
        ? CODE.ABORTED
        : timedOut
          ? CODE.TIMEOUT
          : aborted || error?.code === 'ACCOUNT_SWITCHED'
            ? CODE.ABORTED
            : (error?.code === 'AUTH' ? CODE.AUTH : classifyError(error?.message, 0));
      const hint = errorHint(failureCode, error?.message);
      const failure = accountSwitched
        ? { message: '账号已切换或已退出，本次请求已取消；请确认当前账号后重试。', code: CODE.ABORTED }
        : timedOut
          ? { message: `Qoder ${Math.max(1, Math.round(this.firstByteTimeoutMs / 1000))} 秒内没有返回首包 —— 已停止等待，可重试。`, code: CODE.TIMEOUT }
          : aborted || error?.code === 'ACCOUNT_SWITCHED'
            ? { message: error?.code === 'ACCOUNT_SWITCHED' ? String(error.message || '已取消') : '已取消', code: CODE.ABORTED }
            : { message: `连接 Qoder 失败：${error?.message || error}${hint ? ` —— ${hint}` : ''}`, code: failureCode };
      failure.message = tr(failure.message);
      requestGuard.dispose();
      const record = {
        at: startedAt, model, account: stamp.account, client: this.client.auth?.source || 'unknown',
        ok: false,
        status: accountSwitched ? 'aborted' : timedOut ? 'stream-error' : aborted || error?.code === 'ACCOUNT_SWITCHED' ? 'aborted' : failureCode === CODE.AUTH ? 'auth' : 'transport',
        latencyMs: Date.now() - startedAt, firstByteMs, error: failure.message,
        errorCode: failure.code || '',
        errorAction: errorAction(failure.code, failure.message),
      };
      this.#recordUsage(record);
      finishEmitted = true;
      releaseAsk();
      yield {
        type: 'finish',
        reason: { kind: accountSwitched ? 'error' : (aborted || error?.code === 'ACCOUNT_SWITCHED') && !timedOut ? 'aborted' : 'error', failure },
      };
      return;
    }

    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      requestGuard.dispose();
      const info = extractErrorEnvelope(text);
      let detail = info.message || text;
      let codeLabel = info.code;
      if (!info.message && text) {
        try {
          const parsed = JSON.parse(text);
          detail = parsed?.error?.message || parsed?.msg || parsed?.message || text;
          const rawCode = parsed?.error?.code ?? parsed?.code;
          codeLabel = rawCode == null ? null : String(rawCode);
        } catch { /* keep text */ }
      }
      // 430 是版本门：用当前客户端版本签名被拒时，自动退回上一版 COSY 再试一次。
      // 只重试一次，且不改变用户的 QODER_PROTOCOL 设置。
      if (res.status === 430 && !options.__legacyRetried && process.env.QODER_PROTOCOL !== 'legacy') {
        this.log('Qoder 返回 430，使用上一版 COSY 重试一次');
        yield* this.stream({ ...options, __legacyRetried: true, forceLegacy: true });
        return;
      }
      const retryAfterMs = retryAfterFrom({ info, headers: res.headers, isQueued: info.isQueued || isModelQueue(text) });
      accountSwitched = authGeneration !== this.client.authGeneration;
      const failureCode = accountSwitched
        ? CODE.ABORTED
        : signal?.aborted ? CODE.ABORTED : classifyError(`${detail} ${codeLabel || ''}`, res.status);
      const hint = errorHint(failureCode, `${detail} ${codeLabel ? `code ${codeLabel}` : ''}`);
      const message = accountSwitched
        ? '账号已切换或已退出，本次请求已取消；请确认当前账号后重试。'
        : `Qoder ${res.status}：${String(detail || '').slice(0, 400)}${codeLabel ? `（code ${codeLabel}）` : ''}${hint ? ` —— ${hint}` : ''}`;
      this.log(`chat failed model=${model} status=${res.status}`, String(detail || '').slice(0, 200));
      this.#recordUsage({
        at: startedAt, model, account: stamp.account, client: this.client.auth?.source || 'unknown',
        ok: false, status: accountSwitched ? 'aborted' : `http-${res.status}`,
        latencyMs: Date.now() - startedAt, firstByteMs, error: String(detail || '').slice(0, 300),
        errorCode: failureCode,
        errorAction: errorAction(failureCode, `${detail} ${codeLabel || ''}`),
      });
      finishEmitted = true;
      releaseAsk();
      yield {
        type: 'finish',
        reason: {
          kind: accountSwitched ? 'error' : signal?.aborted ? 'aborted' : 'error',
          failure: {
            message,
            code: failureCode,
            ...(res.status ? { status: res.status } : {}),
            ...(retryAfterMs ? { providerRetryAfterMs: retryAfterMs } : {}),
          },
        },
      };
      return;
    }

    const inputChars = textChars(payload.messages) + JSON.stringify(payload.tools || []).length;
    const translator = new StreamTranslator({ headers: res.headers || {}, inputChars });
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
        if (chunk.type === 'finish') {
          // 先置位再 yield：消费方在 finish 处 return() 时不会执行下一行。
          finishEmitted = true;
          // 真实客户端在取消/换号/首包超时后会直接关闭转译流，适配器看到的是
          // “正常结束但没有 finish_reason”，会误报成 TRANSPORT。这里按真实原因
          // 纠正 finish，重试策略、提示和用量状态才准确。
          if (authGeneration !== this.client.authGeneration) {
            accountSwitched = true;
            chunk.reason = {
              kind: 'error',
              failure: {
                message: '账号已切换或已退出，本次请求已取消；请确认当前账号后重试。',
                code: CODE.ABORTED,
              },
            };
          } else if (signal?.aborted) {
            abortedClean = true;
            chunk.reason = { kind: 'aborted', failure: { message: '已取消', code: CODE.ABORTED } };
          } else if (requestGuard.timedOut && !translator.sawContent) {
            chunk.reason = {
              kind: 'error',
              failure: {
                message: `Qoder ${Math.max(1, Math.round(this.firstByteTimeoutMs / 1000))} 秒内没有返回首包 —— 已停止等待，可重试。`,
                code: CODE.TIMEOUT,
              },
            };
          }
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            terminalFailure = chunk.reason.failure;
          } else if (payload?.task?.key) {
            // 这一轮有完整收尾：下一次同任务调用应带 stage=processing。
            this.tasks.markAnswered(payload.task.key);
          }
          releaseAsk();
        }
        if (chunk.type === 'finish' && chunk.reason?.failure?.message) {
          chunk.reason.failure.message = tr(chunk.reason.failure.message);
        }
        yield chunk;
      }
    } catch (error) {
      failed = true;
      const aborted = signal?.aborted === true;
      accountSwitched = authGeneration !== this.client.authGeneration;
      const timedOut = !accountSwitched && (error?.code === 'IDLE_TIMEOUT'
        || error?.code === 'FIRST_BYTE_TIMEOUT'
        || requestGuard.timedOut);
      const requestCancelled = accountSwitched || error?.code === 'ACCOUNT_SWITCHED';
      const timeoutMessage = requestGuard.timedOut
        ? `Qoder ${Math.max(1, Math.round(this.firstByteTimeoutMs / 1000))} 秒内没有返回首包`
        : (error?.message || 'Qoder 等待数据超时');
      failure = accountSwitched
        ? { kind: 'error', failure: { message: '账号已切换或已退出，本次请求已取消；请确认当前账号后重试。', code: CODE.ABORTED } }
        : requestCancelled
          ? { kind: 'aborted', failure: { message: error?.code === 'ACCOUNT_SWITCHED' ? String(error.message || '已取消') : '已取消', code: CODE.ABORTED } }
          : aborted && !timedOut
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
            // 中断路径也必须过和 finish() 同一道校验：半截 JSON 或空名称的
            // 工具调用写进会话后，下游无法执行，只会把错误延后到更远的地方。
            if (!entry.name || !TOOL_NAME_RE.test(entry.name)) continue;
            const args = entry.args || '{}';
            try { JSON.parse(args); } catch { continue; }
            if (!entry.id) entry.id = `${translator.idPrefix}_${entry.index}`;
            yield { type: 'block-end', index, block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: args } };
          }
        }
      }
      this.log(`stream interrupted model=${model}`, error?.message || error);
      finishEmitted = true;
      releaseAsk();
      if (failure?.message) failure.message = tr(failure.message);
      yield { type: 'finish', reason: failure };
    } finally {
      requestGuard.dispose();
      if (reader) await reader.cancel().catch(() => {});
      try { res.close?.(); } catch { /* 已结束 */ }
      const usage = translator.usage || {};
      // 上游省略 usage 时 finish() 会生成估算值；它和上游原始 usage 字段名不同，
      // 账本必须单独取，不能继续读 usage.prompt_tokens（那会永远是 0）。
      const estimatedUsage = translator.finalUsage || null;
      const recordFailure = failure?.failure || terminalFailure || translator.error || null;
      const status = accountSwitched || abortedClean || failure?.kind === 'aborted'
        ? 'aborted'
        : (failed || terminalFailure || translator.error) ? 'stream-error' : finishEmitted ? 'ok' : 'aborted';
      // 上游对免费模型也会返回 credits（原价估算），只有 billable !== false 才是实扣。
      const billed = Number(usage.credits ?? 0) || 0;
      const original = Number(usage.original_credits ?? usage.credits ?? 0) || 0;
      const billable = usage.billable !== false;
      this.#recordUsage({
        at: startedAt,
        model,
        account: stamp.account,
        client: this.client.auth?.source || 'unknown',
        promptTokens: estimatedUsage ? Number(estimatedUsage.inputTokens) || 0 : Number(usage.prompt_tokens ?? 0) || 0,
        completionTokens: estimatedUsage ? Number(estimatedUsage.outputTokens) || 0 : Number(usage.completion_tokens ?? 0) || 0,
        totalTokens: estimatedUsage ? Number(estimatedUsage.totalTokens) || 0 : Number(usage.total_tokens ?? 0) || 0,
        cachedTokens: estimatedUsage ? 0 : Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0,
        reasoningTokens: estimatedUsage ? 0 : Number(usage.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
        credits: billable ? billed : 0,
        originalCredits: Math.max(original, billed),
        savedCredits: Math.max(0, original - (billable ? billed : 0)),
        billable,
        latencyMs: Date.now() - startedAt,
        firstByteMs,
        ok: status === 'ok',
        status,
        error: String(recordFailure?.message || ''),
        errorCode: String(recordFailure?.code || ''),
        errorAction: errorAction(recordFailure?.code, recordFailure?.message || ''),
        ...(estimatedUsage || usage.estimated === true ? { estimated: true } : {}),
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
