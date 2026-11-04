/**
 * 服务端文案（聊天错误、斜杠命令、只读工具）的中英翻译。
 *
 * 面板本身由 client.js 在渲染入口翻译；这里只处理不经 React 的文本。
 * 上游返回的原文、日志正文和诊断 JSON 字段名保持原样。
 */
let LOCALE = 'zh';

export function setLocale(value) {
  LOCALE = value === 'en' ? 'en' : 'zh';
}

export function getLocale() {
  return LOCALE;
}

const EN = Object.assign(Object.create(null), {
  'Qoder 接入：状态 / 登录 / 模型 / 用量 / 签到 / 诊断 / 刷新': 'Qoder integration: status / sign-in / models / usage / check-in / diagnostics / refresh',
  '查看 Qoder 在 dsh 中的接入状态：是否已登录、账号与套餐、令牌有效期、原生模型路由是否注册、可用模型数量、今日用量。排查“Qoder 模型不出现在选择器里”时先调用它。': "Show Qoder's integration status in dsh: sign-in, account and plan, token expiry, native model routing, available models, and today's usage. Call this first when Qoder models do not appear in the selector.",
  '列出 Qoder 当前目录里的模型，以及它们在 dsh 模型选择器中是否可见。参数 query 可按 id/名称过滤；limit 默认 40。': 'List models in the current Qoder catalog and whether they are visible in the dsh model selector. Use query to filter by id/name; limit defaults to 40.',
  '按模型 id 或显示名过滤': 'Filter by model id or display name',
  '查看 Qoder 在 dsh 中的本地调用统计：今日请求 / tokens / 实扣与已省 Credits / 平均延迟 / 成功率，最近 14 天趋势和最近失败。不含对话内容。': "Show local Qoder call stats in dsh: today's requests / tokens / billed and saved Credits / average latency / success rate, 14-day trend, and recent failures. No conversation content.",
  '检查 Qoder 接入的完整链路：凭据、令牌刷新、目录、原生路由、用量文件、网络延迟。返回每项结论与可执行的下一步。': 'Check the full Qoder integration path: credentials, token refresh, catalog, native routing, usage files, and network latency. Returns each result and the next step.',
  'Qoder 登录态已失效：到「设置 → Qoder → 账号」重新授权。': 'Qoder sign-in expired: reauthorize in Settings → Qoder → Account.',
  'Qoder 额度不足：到账号页查看套餐与 Credits，或换一个免费模型。': 'Qoder quota is insufficient: check your plan and Credits on the account page, or use a free model.',
  '触发 Qoder 频率限制：稍等再试，或换一个模型。': 'Qoder rate limit hit: wait and retry, or switch models.',
  '上下文超出该模型上限：压缩对话，或换上下文更大的模型。': 'Context exceeds this model limit: compact the conversation or switch to a larger-context model.',
  'Qoder 拒绝了请求参数：换一个思考档位或恢复默认参数后再试。': 'Qoder rejected the request parameters: change the reasoning effort or restore defaults.',
  '该模型不在当前 Qoder 目录：刷新目录后重选，或确认账号是否有这个模型的权限。': 'This model is not in the current Qoder catalog: refresh and reselect, or confirm the account has access.',
  '模型把工具调用写成了正文而不是结构化调用；已阻止把这一轮当成完成，请重试。': 'The model wrote a tool call as text instead of a structured call; the turn was not treated as complete. Retry.',
  '与 Qoder 的连接中断：检查网络或代理后重试。': 'The connection to Qoder dropped: check your network or proxy and retry.',
  'Qoder 响应超时：稍后重试，或换一个模型。': 'Qoder timed out: retry later or switch models.',
  'Qoder 模型正在排队，稍后会自动重试。': 'Qoder is queuing the request; it will retry automatically.',
  'Qoder 今日请求次数已达上限，明天再试或换一个免费模型。': 'The daily Qoder request cap is reached; try tomorrow or use a free model.',
  'Qoder 服务端会话已失效，刷新令牌无效；请在账号页重新授权。': 'The Qoder server session expired and refreshing the token will not help; reauthorize on the account page.',
  'Qoder 客户端版本过低；请升级 qoder-to-dsh 或 Qoder CLI。': 'The Qoder client version is too old; upgrade qoder-to-dsh or the Qoder CLI.',
  'Qoder 内容审核拒绝了这次请求，原样重试不会成功。': 'Qoder content review rejected this request; retrying unchanged will not help.',
  '当前账号的试用权益受限；换免费模型或升级套餐后再试。': 'This account has trial restrictions; use a free model or upgrade the plan.',
  'Qoder 上游拦截了这次请求的来源或模板；稍等原样重试一次，仍失败请复制诊断报告反馈。': 'Qoder blocked the request source or template upstream; retry once unchanged, then copy the diagnostics report if it still fails.',
  'Qoder 只返回了思考内容，没有生成正文或工具调用 —— 可重试。': 'Qoder returned reasoning only, with no text or tool call — retryable.',
  'Qoder 回复结束但没有任何内容': 'Qoder finished with no content',
  'Qoder 流在结束原因之前中断，回复可能不完整 —— 可重试。': 'The Qoder stream ended before a finish reason; the reply may be incomplete — retryable.',
  'Qoder 流在收到任何内容之前中断 —— 可重试。': 'The Qoder stream ended before any content — retryable.',
  'Qoder 把工具调用写成了正文（检测到 DSML / <function=…> / 工具调用回声），已阻止把这一轮当成完成；请重试。': 'Qoder wrote a tool call as text (DSML / <function=…> / tool-call echo); the turn was not treated as complete. Retry.',
  'Qoder 不接受模型': 'Qoder does not accept model',
  '请求组装失败：': 'Failed to assemble the request: ',
  '请求体编码后约': 'Encoded request body is about',
  'MiB，超过 Qoder 单次请求上限；': ' MiB, exceeding the Qoder per-request limit; ',
  '图片已裁尽仍超限，主要是工具定义或历史文本体积过大；请减少工具或压缩历史后再试。': 'Images are already trimmed; tool definitions or history are too large. Reduce tools or compact the history.',
  '请减少图片、工具定义或压缩历史后再试。': 'Reduce images or tool definitions, or compact the history.',
  '模型': 'Model',
  '不在当前 Qoder 目录（可能已下架，或当前账号没有该模型）。请刷新目录后重选；如果刚上线，可设 QODER_SKIP_MODEL_PREFLIGHT=1 跳过本地校验。': ' is not in the current Qoder catalog (removed or unavailable to this account). Refresh and reselect; if newly released, set QODER_SKIP_MODEL_PREFLIGHT=1.',
  '登录：': 'Sign-in: ',
  '已登录': 'signed in',
  '未登录': 'not signed in',
  '区域：': 'Region: ',
  '路由：': 'Routing: ',
  '已注册': 'registered',
  '未注册': 'not registered',
  '模型：': 'Models: ',
  '个 / 可见': ' / visible ',
  '今日：': 'Today: ',
  '今日 ': 'Today ',
  '今日': 'Today',
  '次 ·': ' requests ·',
  '目录为空，请先登录 Qoder。': 'The catalog is empty; sign in to Qoder first.',
  '成功率': 'success rate',
  '平均首字': 'avg first byte',
  '最近记录：': 'Recent records: ',
  '条（详情见面板）': ' (see the panel for details)',
  '自动签到：': 'Auto check-in: ',
  '开启': 'on',
  '关闭': 'off',
  '今日已处理': 'Handled today',
  '个账号': ' accounts',
  '今天还没领取': 'not claimed today',
  '今日已领': 'claimed today',
  '目录刷新失败，继续使用缓存：': 'Catalog refresh failed; using cache: ',
  '目录已刷新：': 'Catalog refreshed: ',
  '个模型': ' models',
  '登录成功：': 'Signed in: ',
  '授权失败：': 'Authorization failed: ',
  '会话已过期': 'session expired',
  '请重新运行 /qoder login 发起授权。': ' Run /qoder login again to start authorization.',
  '尚未完成授权。打开：': 'Authorization is not complete. Open: ',
  '完成后再次运行 /qoder login。': 'Run /qoder login again after completing it.',
  '请在浏览器打开': 'Open in the browser',
  '分钟内有效': ' minutes',
  '已退出 Qoder，并清除本机保存的凭据。': 'Signed out of Qoder and removed locally stored credentials.',
  '目录里还没有可选模型。': 'No selectable models in the catalog yet.',
  '模型': 'Model',
  '正常：': ' is healthy: ',
  '测试失败：': 'Test failed: ',
  '未知子命令：': 'Unknown subcommand: ',
  '，并输入代码': ', and enter code ',
  '分钟内有效': ' minutes',
  '（': ' (',
  '）': ')',
  '，': ', ',
  '。': '.',
  '：': ': ',
  '；': '; ',
  '待换取访问令牌（首次请求自动刷新）': 'Access token pending exchange (auto-refreshes on first request)',
  '有效期未知': 'expiry unknown',
  '已过期（下次请求自动刷新）': 'expired (auto-refreshes on the next request)',
  '剩余': 'Remaining ',
  '小时': 'h',
  '分钟': 'min',
  '套餐：': 'Plan: ',
  '令牌：': 'Token: ',
  '未知来源': 'unknown source',
  '模型：目录': 'Models: catalog ',
  '个，选择器可见': ', visible ',
  '个': '',
  '次请求，': ' requests, ',
  '实扣': 'billed',
  'Credits，成功率': ' Credits, success rate ',
  '最近错误：': 'Recent error: ',
  '目录里没有匹配的模型。': 'No matching models in the catalog.',
  '尚未登录 Qoder，请先在「设置 → Qoder → 账号」授权。': 'Not signed in to Qoder; authorize in Settings → Qoder → Account first.',
  '上下文': 'context',
  '图片': 'images',
  '思考': 'reasoning',
  '免费': 'free',
  '默认': 'default',
  '共': 'Total ',
  '个模型，显示': ' models, showing ',
  '个（✓ = 选择器可见）：': ' (✓ = visible in selector):',
  '近 14 天：': 'Last 14 days:',
  '失败': 'failed',
  '最近失败：': 'Recent failures:',
  '当前窗口没有需要手动处理的请求。': 'No requests need manual action in this window.',
  '当前窗口没有失败请求。': 'No failed requests in this window.',
  '当前窗口没有请求记录。': 'No requests in this window.',
  '暂无日志': 'No logs yet',
  '未知模型': 'Unknown model',
  '（空回复）': '(empty reply)',
  '（今天）': '(today)',
  '（推算）': '(inferred)',
  '今天': 'today',
  '天': 'days',
  '小时': 'h',
  '分钟': 'min',
  '秒': 's',
});

const RULES = [
  [/(\d{4})年(\d{1,2})月(\d{1,2})日/g, '$1-$2-$3'],
  [/(\d+) 次请求/g, '$1 requests'],
  [/(\d+) 次失败/g, '$1 failures'],
  [/(\d+) 个模型/g, '$1 models'],
  [/(\d+) 个账号/g, '$1 accounts'],
  [/(\d+) 次/g, '$1 times'],
  [/(\d+) 条/g, '$1 items'],
  [/(\d+) 个/g, '$1'],
  [/(\d+) 小时/g, '$1h'],
  [/(\d+) 分钟/g, '$1 min'],
  [/(\d+) 秒/g, '$1s'],
];

const PHRASES = Object.entries(EN)
  .filter(([zh]) => zh.length >= 2)
  .sort((a, b) => b[0].length - a[0].length);

const POST_RULES = [
  [/（/g, ' ('],
  [/）/g, ')'],
  [/，/g, ', '],
  [/。/g, '.'],
  [/：/g, ': '],
  [/；/g, '; '],
];

export function tr(value) {
  const text = String(value ?? '');
  if (LOCALE !== 'en' || !text) return text;
  if (EN[text] !== undefined) return EN[text];
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  for (const [zh, en] of PHRASES) {
    if (out.includes(zh)) out = out.split(zh).join(en);
  }
  for (const [pattern, replacement] of POST_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** 递归翻译对象/数组里的字符串（用于工具参数描述）。 */
export function trDeep(value) {
  if (typeof value === 'string') return tr(value);
  if (Array.isArray(value)) return value.map((item) => trDeep(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = trDeep(item);
    return out;
  }
  return value;
}

export const __test = { EN };
