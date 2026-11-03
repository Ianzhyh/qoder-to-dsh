/**
 * Qoder 上游的「任务」身份。
 *
 * 官方客户端的一条用户提示只建一次 AgentLifecycle：整个工具循环里的每次
 * 模型调用共用同一个 request_set_id / business.id / begin_at，第一次调用
 * stage=start，成功返回后变成 processing；只有 request_id / chat_record_id
 * 每次调用是新的。网关若给每个请求都造一套新身份，一次 265 步的任务会被
 * 上游记成 265 条对话，很快撞到 Billing daily count（code 110）。
 *
 * 这里按「会话 + 最后一条 user 消息」归并任务：工具循环里最后一条 user
 * 不变，任务就不变；用户发下一条消息才换任务。会话 id 优先用宿主给的
 * session id，没有就用「账号 + 模型 + 首条 user」的摘要，避免把系统提示
 * 的变化算成新会话。所有 id 都只在本机生成，不把宿主 id 原样发给上游。
 */
import { createHash } from 'node:crypto';

const DEFAULT_MAX = 512;
const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000;
const HASH_TEXT_LIMIT = 4000;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
    else if (block.type === 'tool-call') parts.push(`[tool ${block.name || ''}]`);
    else if (block.type) parts.push(`[${block.type}]`);
  }
  return parts.join('\n');
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function clip(value) {
  const text = String(value || '');
  return text.length > HASH_TEXT_LIMIT ? text.slice(0, HASH_TEXT_LIMIT) : text;
}

/** 32 位 hex → UUID v4 形状；仅用于让上游看到合法 UUID。 */
export function uuidFromHex(hex) {
  const h = String(hex || '').padEnd(32, '0').slice(0, 32);
  const variant = '89ab'[Number.parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 会话摘要：账号 + 模型 + 首条 user；刻意不含 system，宿主中途改提示不切会话。 */
export function conversationSeed({ account = '', model = '', messages = [] } = {}) {
  const firstUser = (Array.isArray(messages) ? messages : []).find((message) => message?.role === 'user');
  const firstAny = firstUser || (Array.isArray(messages) ? messages : []).find((message) => message?.role !== 'system');
  return [account, model, clip(textOfContent(firstAny?.content))].join('\u0000');
}

export function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

export function taskNameOf(message) {
  const text = textOfContent(message?.content).replace(/\s+/g, ' ').trim();
  return text ? (text.length > 10 ? text.slice(0, 10) : text) : 'chat';
}

/**
 * @param {object} options
 * @param {number} options.max 最多保留多少个任务
 * @param {number} options.idleMs 最后一次调用后多久丢弃
 * @param {() => number} options.now 可注入时钟（测试用）
 */
export function createTaskRegistry({ max = DEFAULT_MAX, idleMs = DEFAULT_IDLE_MS, now = Date.now } = {}) {
  const tasks = new Map();

  const sweep = (at) => {
    for (const [key, task] of tasks) {
      if (at - task.used <= idleMs) break;
      tasks.delete(key);
    }
  };

  const touch = (key, task) => {
    tasks.delete(key);
    tasks.set(key, task);
  };

  return {
    forRequest({ account = '', model = '', messages = [], sessionId = '' } = {}) {
      const at = now();
      sweep(at);
      const session = sessionId
        ? uuidFromHex(digest(`named\u0000${sessionId}`))
        : uuidFromHex(digest(`conv\u0000${conversationSeed({ account, model, messages })}`));
      const index = lastUserIndex(messages);
      const prompt = index >= 0 ? messages[index] : null;
      const key = digest([session, index, clip(textOfContent(prompt?.content))].join('\u0000'));
      let task = tasks.get(key);
      if (!task) {
        task = {
          key,
          id: uuidFromHex(digest(`task\u0000${key}\u0000${at}`)),
          sessionId: session,
          beginAt: at,
          answered: false,
          name: taskNameOf(prompt),
          used: at,
        };
      }
      task.used = at;
      touch(key, task);
      while (tasks.size > max) tasks.delete(tasks.keys().next().value);
      return task;
    },
    markAnswered(key) {
      const task = tasks.get(key);
      if (task) task.answered = true;
    },
    size() {
      return tasks.size;
    },
    clear() {
      tasks.clear();
    },
    snapshot() {
      return [...tasks.values()].map((task) => ({ ...task }));
    },
  };
}
