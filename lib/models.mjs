const NON_CHAT = [
  /embedding/i,
  /rerank/i,
  /moderation/i,
  /whisper/i,
  /tts/i,
  /image[-_]?gen/i,
  /vision[-_]?only/i,
];

export function isChatModel(id) {
  return !NON_CHAT.some((pattern) => pattern.test(String(id)));
}

/**
 * 只剥掉用户从别处抄来的上下文档位后缀，不做别名猜测。
 * 例：`deepseek-v4.1-flash[1m]` → `deepseek-v4.1-flash`。
 */
export function normalizeModelId(id) {
  return String(id || '')
    .trim()
    .replace(/\s*\[(?:1m|2m|200k|400k)\]\s*$/i, '')
    .replace(/-(?:1m|2m)$/i, '');
}

export function shortCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  // 999949 会被 Math.round(n/1000) 进位成 1000，显示成 "1000K"，与旁边的 "1M"
  // 两种量纲并存。所以先算 K 值，进位到 1000 就改用 M。
  if (n >= 10_000) {
    const k = Math.round(n / 1000);
    if (k < 1000) return `${k}K`;
    return `${Math.round(n / 100_000) / 10}M`;
  }
  return String(n);
}

function lengths(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
}

function contextOf(model) {
  return Number(model?.context_window ?? model?.contextWindow ?? 0) || 0;
}

function contextCapOf(model) {
  return Number(model?.max_input_tokens ?? model?.maxInputTokens ?? 0) || 0;
}

function contextMaxOf(model) {
  const explicit = Number(model?.context_window_max ?? model?.contextWindowMax ?? 0) || 0;
  const rawMax = Math.max(explicit, ...lengths(model?.context_window_options ?? model?.contextWindowOptions), 0);
  if (rawMax > 0) return rawMax;
  // 只有没有 context_config 的旧目录才退回到 max_input_tokens 当上限。
  return contextCapOf(model);
}

function contextOptionsOf(model, max = contextMaxOf(model)) {
  const options = lengths(model?.context_window_options ?? model?.contextWindowOptions)
    .filter((tokens) => max <= 0 || tokens <= max);
  if (max > 0 && !options.includes(max)) options.push(max);
  return options.sort((a, b) => a - b);
}

export function effectiveContextWindow(model, override = 0) {
  const current = contextOf(model);
  const wanted = Number(override) > 0 ? Number(override) : current;
  const max = contextMaxOf(model);
  return max && wanted > max ? max : wanted;
}

export function describeModel(model, contextOverride = 0) {
  const bits = [];
  const context = shortCount(effectiveContextWindow(model, contextOverride));
  if (context) bits.push(`上下文 ${context}`);
  const output = shortCount(model?.max_output_tokens ?? model?.maxTokens);
  if (output) bits.push(`输出 ${output}`);
  if (model?.supports_images === true || model?.images === true) bits.push('图片');
  if (model?.supports_reasoning === true || model?.reasoning === true) bits.push('思考');
  return bits.join(' · ');
}

export function modelCostLabel(model) {
  if (model?.free === true) return '免费';
  const credits = Number(model?.credits);
  if (Number.isFinite(credits) && credits > 0) return `×${credits}`;
  return '';
}

function effortIds(model) {
  if (!Array.isArray(model?.reasoning_efforts)) return null;
  return [...new Set(model.reasoning_efforts.map((e) => String(e || '').trim()).filter(Boolean))];
}

export function toAdapterModel(model, { contextWindow = 0, showCost = true } = {}) {
  const id = String(model.id);
  const name = String(model.name || id);
  const cost = showCost ? modelCostLabel(model) : '';
  const context = effectiveContextWindow(model, contextWindow) || undefined;
  const maxTokens = Number(model.max_output_tokens ?? model.maxTokens ?? 0) || undefined;
  const images = model.supports_images === true || model.images === true;
  const reasoning = model.supports_reasoning === true || model.reasoning === true;
  const efforts = effortIds(model);
  return {
    id,
    name: cost ? `${name} · ${cost}` : name,
    ...(describeModel(model, contextWindow) ? { description: describeModel(model, contextWindow) } : {}),
    ...(context ? { contextWindow: context } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    inputModalities: images ? ['text', 'image'] : ['text'],
    ...(reasoning ? { reasoning: true } : {}),
    ...(efforts && efforts.length ? { reasoningEfforts: efforts } : {}),
    ...(typeof model.default_reasoning_effort === 'string' && model.default_reasoning_effort
      ? { defaultReasoningEffort: model.default_reasoning_effort }
      : {}),
  };
}

/**
 * 目录 + 面板显示偏好 → 选择器模型列表。
 *
 * 三种意图分开表达，不能混：
 *   - visible === null：未设置白名单 → 全显示；
 *   - visible === []：白名单为空 → 全不显示（面板的“全不选”）；
 *   - pinned/当前默认模型：无论偏好如何都保留，避免正在用的模型消失。
 */
export function toAdapterModels(catalog, {
  visible = null,
  pinned = '',
  contextWindows = {},
  includeAll = true,
  showCost = true,
} = {}) {
  const allow = visible === null ? null : new Set(visible.map(String));
  const seen = new Set();
  const out = [];
  for (const raw of catalog || []) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || !isChatModel(raw.id)) continue;
    if (seen.has(raw.id)) continue;
    const kept = raw.id === pinned;
    if (!kept && allow && !allow.has(raw.id)) continue;
    if (!kept && !includeAll && raw.official === false) continue;
    seen.add(raw.id);
    out.push(toAdapterModel(raw, { contextWindow: contextWindows[raw.id] || 0, showCost }));
  }
  return out;
}

/** 面板用的完整目录（保留上下文档位、价格、促销、官方标记等显示字段）。 */
export function toDirectory(catalog, prefs = {}) {
  return (catalog || [])
    .filter((model) => model && typeof model.id === 'string' && model.id && isChatModel(model.id))
    .map((model) => {
      const contextMax = contextMaxOf(model);
      const auto = contextOf(model);
      const contextWindow = effectiveContextWindow(model, prefs.contextWindows?.[model.id] || 0);
      return {
        id: model.id,
        name: model.name || model.id,
        vendor: model.vendor || '',
        description: model.description || '',
        contextWindow,
        contextWindowAuto: contextMax > 0 ? Math.min(auto || contextMax, contextMax) : auto,
        contextWindowMax: contextMax,
        contextWindowOptions: contextOptionsOf(model, contextMax),
        maxOutputTokens: Number(model.max_output_tokens ?? model.maxTokens ?? 0) || 0,
        supportsImages: model.supports_images === true,
        supportsReasoning: model.supports_reasoning === true,
        reasoningEfforts: effortIds(model) || [],
        defaultReasoningEffort: model.default_reasoning_effort || '',
        // 上游没给价格时是 null；Number(null) === 0 且 isFinite(0) 为真，
        // 旧写法会让"价格未知"渲染成"×0 Credits"，看起来像免费。
        credits: model.credits === null || model.credits === undefined
          ? null
          : (Number.isFinite(Number(model.credits)) ? Number(model.credits) : null),
        free: model.free === true,
        promotionActive: model.promotion_active === true,
        promotionEndsAt: Number(model.promotion_ends_at) || 0,
        discount: Number.isFinite(Number(model.discount)) && Number(model.discount) > 0
          ? Number(model.discount)
          : null,
        official: model.official !== false,
        badge: model.badge || '',
        status: model.status || '',
        pinned: prefs.pinned === model.id,
        // 与 toAdapterModels 保持一致：默认模型即使不在白名单里也会保留在选择器中。
        visible: prefs.visible === null
          ? true
          : (prefs.visible || []).includes(model.id) || prefs.pinned === model.id,
      };
    });
}
