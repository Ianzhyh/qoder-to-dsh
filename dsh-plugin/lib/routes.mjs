/**
 * 面板同源数据面。
 *
 * 读接口只暴露非敏感元数据（账号名/套餐/计数/延迟），永远不返回 token。
 * 写接口额外要求 `x-qoder-panel: 1`：带自定义头会触发跨站预检，而预检
 * 不会被放行，等于用最小成本挡掉 CSRF。
 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, '请求体不是有效的 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError(400, '请求体必须是 JSON 对象');
  return parsed;
}

const guard = (req) => req.headers['x-qoder-panel'] === '1';

function allowRead(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  sendJson(res, 405, { ok: false, error: 'method not allowed' });
  return false;
}

export function createRouteTable({ controller, log = () => {} }) {
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      log('panel route failed', error?.message || error);
      const status = Number(error?.statusCode) || 500;
      if (!res.headersSent) sendJson(res, status, { ok: false, error: String(error?.message || error) });
      else try { res.end(); } catch { /* ignore */ }
    }
  };

  return [
    {
      kind: 'exact',
      path: '/qoder/status',
      handler: wrap(async (req, res) => {
        if (!allowRead(req, res)) return;
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const deep = url.searchParams.get('deep') === '1';
        const rescan = url.searchParams.get('rescan') === '1';
        sendJson(res, 200, { ok: true, ...(await controller.status({ deep, rescan })) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/models',
      handler: wrap(async (req, res) => {
        if (!allowRead(req, res)) return;
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const refresh = url.searchParams.get('refresh') === '1';
        sendJson(res, 200, { ok: true, ...(await controller.directory({ refresh })) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/usage',
      handler: wrap(async (req, res) => {
        if (!allowRead(req, res)) return;
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const days = Number(url.searchParams.get('days')) || 14;
        const limit = Number(url.searchParams.get('limit')) || 80;
        sendJson(res, 200, { ok: true, ...(await controller.usage({ days, limit })) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/credits',
      handler: wrap(async (req, res) => {
        if (!allowRead(req, res)) return;
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        sendJson(res, 200, { ok: true, ...(await controller.credits({ range: url.searchParams.get('range') || '7d' })) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/diagnostics',
      handler: wrap(async (req, res) => {
        if (!allowRead(req, res)) return;
        sendJson(res, 200, { ok: true, ...(await controller.diagnostics()) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/account',
      handler: wrap(async (req, res) => {
        if (!allowRead(req, res)) return;
        sendJson(res, 200, { ok: true, ...(await controller.account()) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/checkin',
      handler: wrap(async (req, res) => {
        if (!allowRead(req, res)) return;
        sendJson(res, 200, { ok: true, ...(await controller.checkin()) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/checkin/run',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...(await controller.runCheckin({ key: String(body?.key || '') })) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/checkin/config',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        const body = await readJsonBody(req);
        if (typeof body.auto !== 'boolean') throw httpError(400, 'auto 必须是布尔值');
        sendJson(res, 200, { ok: true, ...(await controller.saveCheckinConfig({ auto: body.auto })) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/logs',
      handler: wrap(async (req, res) => {
        if (!allowRead(req, res)) return;
        sendJson(res, 200, { ok: true, ...(await controller.logs()) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/catalog/refresh',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        sendJson(res, 200, { ok: true, ...(await controller.refreshCatalog()) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/prefs',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...(await controller.savePrefs(body)) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/auth/device',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...(await controller.beginDeviceAuth(String(body?.region || ''))) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/auth/poll',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...(await controller.pollDeviceAuth(String(body?.id || ''))) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/auth/pat',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...(await controller.importPat(String(body?.token || ''), String(body?.region || ''))) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/auth/import-desktop',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...(await controller.importDesktop(body)) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/auth/logout',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        sendJson(res, 200, { ok: true, ...(await controller.logout()) });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/test',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          ...(await controller.test({
            model: String(body?.model || ''),
            prompt: String(body?.prompt || ''),
            maxTokens: Number(body?.maxTokens) || 0,
            reasoningEffort: String(body?.reasoningEffort || ''),
          })),
        });
      }),
    },
    {
      kind: 'exact',
      path: '/qoder/usage/clear',
      handler: wrap(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-qoder-panel header' });
        sendJson(res, 200, { ok: true, ...(await controller.clearUsage()) });
      }),
    },
  ];
}

export function mountRoutes(target, routes, log = () => {}) {
  const webServer = typeof target?.register === 'function' ? target : target?.get?.('webServer');
  if (!webServer) {
    log('webServer 服务不可用，Qoder 面板数据面未挂载');
    return () => {};
  }
  const disposers = [];
  for (const route of routes) {
    try {
      disposers.push(webServer.register({ kind: route.kind, path: route.path, handler: route.handler }));
    } catch (error) {
      log(`挂载路由 ${route.path} 失败`, error?.message || error);
    }
  }
  log(`已挂载 ${disposers.length}/${routes.length} 条 Qoder 面板路由`);
  return () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* ignore */ } } };
}
