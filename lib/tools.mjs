const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

function textTool({ name, description, parameters, execute, timeoutMs }) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    execute,
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

const fmt = (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}k` : String(Number(n) || 0));
const pct = (n) => (Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—');

function tokenLine(token) {
  if (token?.needsRefresh) return '待换取访问令牌（首次请求自动刷新）';
  if (!token?.expiresAt) return '有效期未知';
  const left = Number(token.expiresAt) - Date.now();
  if (left <= 0) return '已过期（下次请求自动刷新）';
  const hours = Math.floor(left / 3600_000);
  return hours >= 1 ? `剩余 ${hours} 小时` : `剩余 ${Math.max(1, Math.round(left / 60_000))} 分钟`;
}

/**
 * 只读工具。登录/退出必须由用户在面板里完成，避免 agent 代替用户授权。
 */
export function createTools({ snapshot }) {
  return [
    textTool({
      name: 'qoder_status',
      description: '查看 Qoder 在 dsh 中的接入状态：是否已登录、账号与套餐、令牌有效期、原生模型路由是否注册、可用模型数量、今日用量。排查“Qoder 模型不出现在选择器里”时先调用它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, exec) {
        const state = await snapshot({ signal: exec?.signal, desktop: false });
        const lines = [];
        lines.push(`登录：${state.signedIn ? `已登录（${state.account?.name || state.account?.email || '账号'}）` : '未登录'}`);
        if (state.signedIn) {
          lines.push(`  区域：${state.regionLabel || state.region}`);
          const plan = state.account?.plan
            || state.extras?.plan?.plan_tier_name
            || state.extras?.plan?.planName
            || state.extras?.plan?.name
            || '';
          if (plan) lines.push(`  套餐：${plan}`);
          lines.push(`  令牌：${tokenLine(state.token)}（${state.token?.source || '未知来源'}）`);
        }
        lines.push(`路由：${state.route?.registered ? `已注册（provider=${state.route.provider}）` : '未注册'}${state.route?.error ? `，错误：${state.route.error}` : ''}`);
        lines.push(`模型：目录 ${state.catalog?.count ?? 0} 个，选择器可见 ${state.catalog?.visibleCount ?? '—'} 个${state.catalog?.error ? `（目录错误：${state.catalog.error}）` : ''}`);
        lines.push(`今日：${state.usage?.today?.requests ?? 0} 次请求，${fmt(state.usage?.today?.tokens ?? 0)} tokens，实扣 ${state.usage?.today?.credits ?? 0} Credits，成功率 ${pct(state.usage?.today?.successRate)}`);
        if (state.lastError) lines.push(`最近错误：${state.lastError}`);
        return lines.join('\n');
      },
    }),
    textTool({
      name: 'qoder_models',
      description: '列出 Qoder 当前目录里的模型，以及它们在 dsh 模型选择器中是否可见。参数 query 可按 id/名称过滤；limit 默认 40。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '按模型 id 或显示名过滤' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const state = await snapshot({ signal: exec?.signal, desktop: false });
        const query = String(args?.query || '').toLowerCase();
        const limit = Math.min(100, Math.max(1, Number(args?.limit) || 40));
        const models = (state.directory || [])
          .filter((model) => !query || model.id.toLowerCase().includes(query) || String(model.name).toLowerCase().includes(query))
          .slice(0, limit);
        if (!models.length) return state.signedIn ? '目录里没有匹配的模型。' : '尚未登录 Qoder，请先在「设置 → Qoder → 账号」授权。';
        const lines = models.map((model) => {
          const bits = [];
          if (model.contextWindow) bits.push(`上下文 ${fmt(model.contextWindow)}`);
          if (model.supportsImages) bits.push('图片');
          if (model.supportsReasoning) bits.push('思考');
          if (model.free) bits.push('免费');
          else if (model.credits != null) bits.push(`×${model.credits}`);
          if (model.pinned) bits.push('默认');
          return `${model.visible ? '✓' : '·'} ${model.id}  ${model.name !== model.id ? `(${model.name})` : ''}${bits.length ? `  — ${bits.join(' · ')}` : ''}`;
        });
        return [`共 ${state.directory.length} 个模型，显示 ${models.length} 个（✓ = 选择器可见）：`, ...lines].join('\n');
      },
    }),
    textTool({
      name: 'qoder_usage',
      description: '查看 Qoder 在 dsh 中的本地调用统计：今日请求 / tokens / 实扣与已省 Credits / 平均延迟 / 成功率，最近 14 天趋势和最近失败。不含对话内容。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, exec) {
        const state = await snapshot({ signal: exec?.signal, desktop: false });
        const today = state.usage?.today || {};
        const lines = [
          `今日：${today.requests || 0} 次 · ${fmt(today.tokens || 0)} tokens · 实扣 ${today.credits || 0} Credits${today.savedCredits ? ` · 已省 ${today.savedCredits} Credits` : ''} · 成功率 ${pct(today.successRate)} · 平均首字 ${today.avgFirstByteMs || 0}ms · 平均总耗时 ${today.avgLatencyMs || 0}ms`,
        ];
        const days = (state.usage?.days || []).filter((day) => day.requests > 0).slice(-14);
        if (days.length) {
          lines.push('近 14 天：');
          for (const day of days) lines.push(`  ${day.date}  ${day.requests} 次 · ${fmt(day.tokens)} tokens${day.failures ? ` · ${day.failures} 失败` : ''}`);
        }
        const failures = (state.recentFailures || []).slice(0, 5);
        if (failures.length) {
          lines.push('最近失败：');
          for (const item of failures) lines.push(`  ${new Date(item.at).toLocaleString()} ${item.model} ${item.status} ${item.error || ''}`.trim());
        }
        return lines.join('\n');
      },
    }),
    textTool({
      name: 'qoder_diagnose',
      description: '检查 Qoder 接入的完整链路：凭据、令牌刷新、目录、原生路由、用量文件、网络延迟。返回每项结论与可执行的下一步。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 90_000,
      async execute(_args, exec) {
        const result = await snapshot({ signal: exec?.signal, deep: true, desktop: false });
        const lines = result.checks.map((check) => `${check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗'} ${check.label}：${check.detail}`);
        return lines.join('\n');
      },
    }),
  ];
}
