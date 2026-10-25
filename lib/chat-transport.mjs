/**
 * 聊天 SSE 的持久连接传输。
 *
 * Node 自带的 fetch（undici）默认约 4 秒就回收空闲连接；两条聊天消息之间
 * 通常超过 4 秒，于是每条消息都要重新做 TCP + TLS 握手。官方 CLI 这类
 * 长期运行的客户端会复用连接，这里用 Agent 保持同样的行为。
 *
 * 返回值刻意对齐 fetch 的最小面：ok / status / body(Web ReadableStream) /
 * text() / drain()，上游客户端只依赖这些字段。
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const agentOptions = { keepAlive: true, maxSockets: 8, maxFreeSockets: 4, scheduling: 'lifo' };
const gatewayAgent = new https.Agent(agentOptions);
const httpAgent = new http.Agent(agentOptions);

/** 插件卸载/热重载时释放空闲连接；进行中的请求由各自信号负责。 */
export function disposeChatTransport() {
  for (const agent of [gatewayAgent, httpAgent]) {
    try { agent.destroy(); } catch { /* ignore */ }
  }
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('aborted');
}

function responseOf(res) {
  const status = res.statusCode || 0;
  let webBody = null;
  let textPromise = null;

  const collectText = () => new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });

  const readText = () => {
    if (textPromise) return textPromise;
    if (webBody) {
      textPromise = (async () => {
        const reader = webBody.getReader();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks).toString('utf8');
      })();
    } else {
      textPromise = collectText();
    }
    return textPromise;
  };

  return {
    ok: status >= 200 && status < 300,
    status,
    get body() {
      if (!webBody) webBody = Readable.toWeb(res);
      return webBody;
    },
    text: readText,
    /** 换网关前把 5xx 响应读空，避免 keep-alive 连接被半截响应占住。 */
    drain() {
      if (webBody) webBody.cancel().catch(() => {});
      else res.resume();
    },
  };
}

export function requestStream(url, { method = 'POST', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error(`unsupported protocol ${target.protocol}`));
      return;
    }
    const transport = target.protocol === 'http:' ? http : https;
    const agent = target.protocol === 'http:' ? httpAgent : gatewayAgent;
    const requestHeaders = body == null
      ? { ...headers }
      : { ...headers, 'content-length': Buffer.byteLength(body) };

    let settled = false;
    const req = transport.request(target, { method, headers: requestHeaders, agent }, (res) => {
      settled = true;
      resolve(responseOf(res));
    });

    const onAbort = () => {
      const error = abortReason(signal);
      req.destroy(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    // 先挂 error 监听：已取消的信号会在下面立刻 destroy，不能让它变成未捕获 error。
    req.on('response', (res) => {
      res.on('end', cleanup);
      res.on('close', cleanup);
    });
    req.on('error', (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (body != null) req.write(body);
    req.end();
  });
}
