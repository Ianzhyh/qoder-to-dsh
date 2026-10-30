// qoder-to-dsh —— DSH Web 客户端面板。
// 普通 lazy-CJS bundle：不依赖构建器，react 由 dsh 平台模块表提供。
(function () {
  function factory(require) {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;
    var React;
    try { React = require('react'); } catch (error) { React = globalThis.React; }
    if (!React) throw new Error('qoder-to-dsh: react is not available');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } = React;

    const PANEL_HEADERS = { 'x-qoder-panel': '1', 'content-type': 'application/json', accept: 'application/json' };
    const READ_HEADERS = { accept: 'application/json' };
    // 宿主半死时 fetch 可以一直挂着，按钮就永远 busy、晚到的响应还会盖掉新数据。
    // 自己带 signal 的调用（试跑的取消）沿用调用方的信号，其余统一 20 秒。
    const REQUEST_TIMEOUT_MS = 20_000;
    // 诊断/深度状态会同步刷新目录与额度：目录要按网关逐个重试（每个 20 秒），
    // 再用客户端的 20 秒去卡它只会得到“请求超时”，后端其实还在正常干活。
    const DEEP_TIMEOUT_MS = 90_000;
    // dsh 的 Web 兜底处理器在插件路由挂上之前对未命中路径回 404。刷新页面
    // 正好撞上这个启动窗口时，快速重试几次比把红字挂到下一轮轮询更好。
    const ROUTE_READY_RETRY_MS = [350, 800, 1300];

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // 上游给的额度链接只允许绝对 http/https；否则 javascript:/data:
    // 会直接变成可点击的注入点。
    function safeHref(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:' ? raw : '';
      } catch {
        return '';
      }
    }

    async function requestOnce(path, opts) {
      const { timeoutMs = REQUEST_TIMEOUT_MS, panel = false, ...init } = opts;
      const controller = init.signal ? null : new AbortController();
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const res = await fetch(path, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...init,
          signal: init.signal || controller.signal,
          headers: { ...(init.headers), ...(panel || init.body ? PANEL_HEADERS : READ_HEADERS) },
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        if (!res.ok) {
          const message = data && (data.error || data.message) || ('HTTP ' + res.status);
          const error = new Error(message);
          error.status = res.status;
          error.data = data;
          throw error;
        }
        return data || { ok: false, error: '空响应' };
      } catch (error) {
        if (controller && controller.signal.aborted) {
          const timeout = new Error('请求超时（' + (timeoutMs / 1000) + ' 秒未响应）');
          timeout.status = 0;
          throw timeout;
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function requestJson(path, options) {
      const opts = options || {};
      const panelRoute = typeof path === 'string' && path.startsWith('/qoder/');
      const retryable = String(opts.method || 'GET').toUpperCase() === 'GET'
        && !opts.signal
        && panelRoute;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await requestOnce(path, opts);
        } catch (error) {
          if (retryable && error && error.status === 404 && attempt < ROUTE_READY_RETRY_MS.length) {
            await delay(ROUTE_READY_RETRY_MS[attempt]);
            continue;
          }
          if (panelRoute && error && error.status === 404) {
            error.message = '插件接口还没就绪（HTTP 404）：如果刚升级插件，请完全退出并重启 dsh，再刷新本页。';
          }
          throw error;
        }
      }
    }

    const getJson = (path, options) => requestJson(path, options);
    const postJson = (path, body, extra) => requestJson(path, { method: 'POST', body: JSON.stringify(body || {}), ...extra });

    const documentVisible = (doc) => !doc || doc.visibilityState !== 'hidden';

    // 后台标签页不轮询；切回可见时立即补一次再恢复定时。初始就隐藏也要在
    // 第一次可见时启动（不能让「打开时就在后台」变成永久停更）。重复事件由
    // 状态翻转判定挡掉，避免一次切换触发多轮全量请求。
    function startVisibilityPoll(doc, onTick, intervalMs) {
      let timer = null;
      let visible = documentVisible(doc);
      const tick = () => {
        if (!documentVisible(doc)) return;
        try { onTick(); } catch { /* keep polling */ }
      };
      const stop = () => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
      const start = () => {
        stop();
        timer = setInterval(tick, intervalMs);
      };
      const onChange = () => {
        const next = documentVisible(doc);
        if (next === visible) return;
        visible = next;
        if (visible) {
          tick();
          start();
        } else {
          stop();
        }
      };
      if (visible) start();
      if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onChange);
      return () => {
        stop();
        if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onChange);
      };
    }

    function useVisibilityPoll(onTick, intervalMs, enabled) {
      const tickRef = useRef(onTick);
      tickRef.current = onTick;
      useEffect(() => {
        if (enabled === false) return undefined;
        return startVisibilityPoll(typeof document === 'undefined' ? null : document, () => tickRef.current(), intervalMs);
      }, [intervalMs, enabled]);
    }

    const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
    function compact(n) {
      const value = num(n);
      if (value >= 1_000_000) return (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (value >= 10_000) return (value / 1000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '') + 'K';
      return String(Math.round(value));
    }
    const pct = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n) * 100) + '%');
    // 与服务端 resolveModel 同一条公式：有插件默认先取默认值，再受模型输出
    // 上限收敛；否则用模型上限，最后才退回 Qoder CLI 的 32K。
    const autoOutputTokens = (pluginMaxTokens, modelMaxTokens, providerDefault) => {
      const cap = num(modelMaxTokens);
      const fallback = num(providerDefault) || 32000;
      const base = num(pluginMaxTokens) || cap || fallback;
      return cap > 0 ? Math.min(base, cap) : base;
    };
    const dayLabel = (date) => (date ? String(date).slice(5) : '');
    const money = (n) => {
      if (n === null || n === undefined) return '—';
      const value = Number(n);
      if (!Number.isFinite(value)) return '—';
      if (value >= 100) return String(Math.round(value));
      if (value >= 1) return value.toFixed(1).replace(/\.0$/, '');
      return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    };
    const creditsText = (n) => {
      const value = Number(n);
      if (!Number.isFinite(value)) return '0';
      return value.toFixed(3).replace(/\.?0+$/, '') || '0';
    };
    const rangeDateLabel = (date) => {
      if (!date) return '';
      const parts = String(date).split('-').map(Number);
      return parts.length === 3 ? `${parts[0]}年${parts[1]}月${parts[2]}日` : String(date);
    };
    const rangeLabel = (range) => {
      if (!range || !range.from) return '—';
      return range.from === range.to
        ? rangeDateLabel(range.from)
        : `${rangeDateLabel(range.from)} - ${rangeDateLabel(range.to)}`;
    };
    const chartPath = (points) => {
      if (!points.length) return '';
      if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
      let path = `M ${points[0].x} ${points[0].y}`;
      for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        path += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
      }
      return path;
    };
    const seriesColor = (index) => `var(--qdr-series-${index % 6})`;
    const stamp = (ts) => {
      if (!ts) return '—';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '—';
      const now = new Date();
      const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return d.toDateString() === now.toDateString() ? time : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${time}`;
    };
    const toEpochMs = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return null;
      // 上游的额度/套餐到期时间是秒级 epoch（官方客户端同样按 <1e10 判秒），
      // 直接塞给 Date 会显示成 1970 年。
      return n < 1e10 ? n * 1000 : n;
    };
    const dateLabel = (value) => {
      if (!value) return '';
      const epoch = toEpochMs(value);
      const d = new Date(epoch === null ? value : epoch);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN');
    };
    const duration = (ms) => {
      const value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return '—';
      return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${Math.round(value)}ms`;
    };
    const contextLabel = (n) => (Number(n) > 0 ? compact(n) : '—');
    const statusLabel = (value) => {
      const map = {
        ok: '成功', 'rate-limit': '限流', 'http-429': '限流', transport: '连接失败',
        timeout: '超时', aborted: '已取消', stream: '对话', 'stream-error': '流中断',
        test: '试跑', 'test-failed': '试跑失败', auth: '认证失败', 'http-401': '认证失败',
        'http-403': '认证失败', invalid: '请求无效', server: '上游错误', 'queue-full': '排队已满',
      };
      const key = String(value || '');
      if (map[key]) return map[key];
      if (/^http-\d+$/i.test(key)) return 'HTTP ' + key.slice(5);
      return key || '失败';
    };
    const checkinMeta = (status) => {
      const map = {
        claimed: { label: '今日已领', tone: 'green' },
        already: { label: '今日已领', tone: 'green' },
        pending: { label: '活动未下发', tone: 'amber' },
        waiting: { label: '10:00 后开放', tone: 'neutral' },
        idle: { label: '待领取', tone: 'neutral' },
        unavailable: { label: '无活动', tone: 'neutral' },
        device: { label: '缺设备身份', tone: 'amber' },
        login: { label: '需重新登录', tone: 'bad' },
        error: { label: '签到失败', tone: 'bad' },
      };
      return map[status] || map.idle;
    };
    const regionShort = (region) => (region === 'cn' ? '国内版' : '国际版');
    const clientLabel = (value) => ({
      desktop: '桌面端', cli: 'CLI', oauth: '浏览器授权', pat: 'PAT', token: 'PAT',
      test: '试跑', unknown: '未知来源',
    }[String(value || '')] || String(value || '未知来源'));
    const checkinAccountStatus = (account) => {
      if (!account) return '未知';
      if (account.status === 'claimed') return `今日已领 +${money(account.credits)}`;
      if (account.status === 'already') return '今日已领';
      return checkinMeta(account.status).label;
    };
    function versionNotice(loaded, installed) {
      if (!loaded || !installed || loaded === installed) return '';
      return `已加载 v${loaded}，磁盘 v${installed}；完全退出 dsh 再打开才会加载新代码。`;
    }
    function settingsNotice(notified, kind = 'params') {
      if (kind === 'display') {
        return notified
          ? '显示设置已保存，模型选择器会立即更新。'
          : '显示设置已保存；模型选择器刷新需完全退出 dsh，已保存的偏好不会丢失。';
      }
      return notified
        ? '模型参数已保存，下一次请求生效。'
        : '模型参数已保存，下一次请求生效；选择器元数据需完全退出 dsh 后刷新。';
    }
    function usageBadges(item) {
      const badges = [];
      if (item && item.probe === true) badges.push('试跑');
      const account = String(item && item.account || '');
      if (account && account !== 'unknown') badges.push(`账号 …${account.split(':').pop()}`);
      return badges;
    }
    function partialDataNote(data) {
      if (!data) return '';
      return data.seriesPartial || (data.heatmap && data.heatmap.partial)
        ? '部分历史来自每日汇总（明细已裁剪）'
        : '';
    }
    function accountIdentityNote(active, candidates) {
      const list = Array.isArray(candidates) ? candidates : [];
      const uid = String(active && active.uid || '');
      const name = (active && (active.name || active.email || active.uid)) || '当前账号';
      const known = Boolean(uid) && list.some((candidate) => String(candidate && candidate.uid || '') === uid);
      return {
        text: `插件当前使用 ${name}；本机检测到 ${list.length} 个账号。`,
        note: uid && !known ? '当前账号来自 PAT / 浏览器授权，不在本机桌面端登录列表中。' : '',
      };
    }
    function checkinNotice(data, key = '') {
      if (!data) return null;
      if (data.ok === false) return { tone: 'error', text: data.error || '签到失败，请刷新后重试' };
      const results = Array.isArray(data.results) ? data.results : [];
      const target = key ? results.find((item) => item.key === key) : null;
      const failures = results.filter((item) => !['claimed', 'already', 'unavailable', 'pending'].includes(item.status));
      if (target) {
        if (target.status === 'claimed') return { tone: 'ok', text: `${target.label} 签到成功 +${money(target.credits)} Credits` };
        if (['already', 'pending', 'unavailable'].includes(target.status)) return { tone: 'ok', text: `${target.label}：${target.message}` };
        return { tone: 'error', text: `${target.label}：${target.message || '签到失败'}` };
      }
      if (failures.length) {
        const detail = failures.slice(0, 3)
          .map((item) => `${item.label}${item.message ? `：${item.message}` : ''}`)
          .join('；');
        const prefix = data.summary && data.summary.credits
          ? `已领 +${money(data.summary.credits)} Credits，部分账号失败：`
          : '签到失败：';
        return {
          tone: 'error',
          text: `${prefix}${detail}${failures.length > 3 ? `（共 ${failures.length} 个）` : ''}`,
        };
      }
      if (data.summary && data.summary.credits) return { tone: 'ok', text: `签到完成，今日共 +${money(data.summary.credits)} Credits` };
      if (data.summary && data.summary.pending) return { tone: 'ok', text: '还有账号未领取，正在等待下一次自动重试。' };
      if (data.summary && data.summary.notOpen) return { tone: 'ok', text: '活动尚未下发，稍后会自动重试。' };
      if (data.summary && data.summary.unavailable) return { tone: 'ok', text: '当前没有可领取的签到活动。' };
      if (data.summary && data.summary.waiting) return { tone: 'ok', text: '活动每天 10:00（UTC+8）后开放。' };
      return { tone: 'ok', text: '签到流程已结束。' };
    }
    function quotaSummary(extras) {
      const quota = extras && extras.quota;
      if (!quota) return null;
      const user = quota.userQuota || null;
      const addOn = quota.addOnQuota || null;
      const hasFields = Boolean(
        (user && (user.total != null || user.remaining != null))
        || (addOn && (addOn.total != null || addOn.remaining != null)),
      );
      if (!hasFields) return null;
      const total = num(user && user.total) + num(addOn && addOn.total);
      const used = num(user && user.used) + num(addOn && addOn.used);
      const remaining = num(user && user.remaining) + num(addOn && addOn.remaining);
      const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : Math.min(1, Math.max(0, num(quota.totalUsagePercentage)));
      const at = Number(extras.at) || 0;
      return {
        total,
        used,
        remaining,
        ratio,
        unit: (user && user.unit) || (addOn && addOn.unit) || 'credits',
        exceeded: quota.isQuotaExceeded === true,
        expiresAt: quota.expiresAt || (extras.plan && extras.plan.end_date) || 0,
        user,
        addOn,
        detailUrl: safeHref(quota.detailUrl || (addOn && addOn.detailUrl) || ''),
        upgradeUrl: safeHref(quota.upgradeUrl || ''),
        planName: (extras.plan && (extras.plan.plan_tier_name || extras.plan.planName)) || '',
        planPaid: extras.plan && extras.plan.is_paid_plan === true,
        planEnd: extras.plan && extras.plan.end_date,
        at,
        stale: Boolean(at && Date.now() - at > 5 * 60_000),
      };
    }

    function Icon({ name, size = 16, strokeWidth = 1.7 }) {
      const common = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      };
      const paths = {
        refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
        check: ['M20 6 9 17l-5-5'],
        alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
        close: ['M18 6 6 18', 'M6 6l12 12'],
        search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.35-4.35'],
        external: ['M14 3h7v7', 'M10 14 21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
        copy: ['M8 8h11v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8Z', 'M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1'],
        pin: ['M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z'],
        trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5'],
        key: ['M21 2l-2 2', 'M15.5 8.5 19 5', 'M10.5 13.5a5 5 0 1 1-7 7 5 5 0 0 1 7-7Z', 'm10.5 13.5 3-3'],
        shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'm9 12 2 2 4-4'],
        bolt: ['M13 2 3 14h8l-1 8 10-12h-8l1-8Z'],
        chart: ['M3 3v18h18', 'm7 14 3-4 4 3 5-7'],
        server: ['M4 4h16v6H4Z', 'M4 14h16v6H4Z', 'M8 7h.01', 'M8 17h.01'],
        arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
        logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
        lock: ['M6 10V8a6 6 0 0 1 12 0v2', 'M5 10h14v11H5Z'],
        chip: ['M8 8h8v8H8Z', 'M4 9V7a3 3 0 0 1 3-3h2', 'M20 9V7a3 3 0 0 0-3-3h-2', 'M4 15v2a3 3 0 0 0 3 3h2', 'M20 15v2a3 3 0 0 1-3 3h-2'],
        chevron: ['m9 18 6-6-6-6'],
        swap: ['M4 7h13', 'm14 4 3 3-3 3', 'M20 17H7', 'm10 14-3 3 3 3'],
        calendar: ['M8 2v4', 'M16 2v4', 'M3 9h18', 'M4 4h16v17H4Z'],
        gift: ['M20 12v9H4v-9', 'M2 7h20v5H2Z', 'M12 22V7', 'M12 7c-2.5 0-4-1.5-4-3a2 2 0 0 1 4 0c0 1.5 1.5 3 4 3', 'M12 7c2.5 0 4-1.5 4-3a2 2 0 0 0-4 0c0 1.5-1.5 3-4 3'],
        dot: ['M12 12h.01'],
        spark: ['M12 3v4', 'M12 17v4', 'M4.2 7.2l2.8 2.8', 'M17 14l2.8 2.8', 'M3 12h4', 'M17 12h4', 'M4.2 16.8 7 14', 'M17 10l2.8-2.8'],
      };
      const list = paths[name] || paths.dot;
      return h('svg', common, ...list.map((d, index) => h('path', { key: index, d })));
    }

    function Badge({ children, tone = 'neutral', title }) {
      return h('span', { className: `qdr-badge qdr-badge-${tone}`, title }, children);
    }

    function Button({ children, variant = 'ghost', size = 'md', icon, onClick, disabled, title, type = 'button' }) {
      return h('button', {
        type, title, disabled, onClick,
        className: `qdr-btn qdr-btn-${variant}${size === 'sm' ? ' qdr-btn-sm' : ''}`,
      }, icon ? h(Icon, { name: icon, size: size === 'sm' ? 14 : 15 }) : null, h('span', null, children));
    }

    function Select({ value, options = [], onChange, disabled, ariaLabel, className, placeholder }) {
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);
      const triggerRef = useRef(null);
      const menuRef = useRef(null);
      const current = options.find((option) => String(option.value) === String(value));
      useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            try { triggerRef.current && triggerRef.current.focus(); } catch { /* ignore */ }
          }
        };
        document.addEventListener('mousedown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onPointer);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);
      useEffect(() => {
        if (!open || !menuRef.current) return;
        const target = menuRef.current.querySelector('.qdr-select-option-on') || menuRef.current.querySelector('.qdr-select-option');
        if (target) target.focus();
      }, [open]);
      const moveOption = (delta) => {
        if (!menuRef.current) return;
        const items = [...menuRef.current.querySelectorAll('.qdr-select-option')];
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        const next = items[(index + delta + items.length) % items.length];
        if (next) next.focus();
      };
      return h('div', {
        className: `qdr-select${open ? ' qdr-select-open' : ''}${className ? ` ${className}` : ''}`,
        ref: rootRef,
        onBlur: (event) => {
          if (!open) return;
          const next = event.relatedTarget;
          if (rootRef.current && next && !rootRef.current.contains(next)) setOpen(false);
        },
      },
        h('button', {
          type: 'button', ref: triggerRef, className: 'qdr-select-trigger',
          disabled, 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': ariaLabel,
          title: current ? `${current.label}${current.hint ? ` · ${current.hint}` : ''}` : '',
          onClick: () => { if (!disabled) setOpen((state) => !state); },
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!disabled) setOpen(true);
            }
          },
        },
        h('span', { className: 'qdr-select-value' }, current ? current.label : (placeholder || '请选择')),
        h(Icon, { name: 'chevron', size: 14 })),
        open ? h('div', { className: 'qdr-select-menu', role: 'listbox', 'aria-label': ariaLabel, ref: menuRef },
          options.map((option) => h('button', {
            type: 'button', role: 'option', key: String(option.value),
            'aria-selected': String(option.value) === String(value),
            className: `qdr-select-option${String(option.value) === String(value) ? ' qdr-select-option-on' : ''}`,
            onClick: () => {
              onChange && onChange(option.value);
              setOpen(false);
              requestAnimationFrame(() => { try { triggerRef.current && triggerRef.current.focus(); } catch { /* ignore */ } });
            },
            onKeyDown: (event) => {
              if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); triggerRef.current && triggerRef.current.focus(); return; }
              if (event.key === 'ArrowDown') { event.preventDefault(); moveOption(1); return; }
              if (event.key === 'ArrowUp') { event.preventDefault(); moveOption(-1); return; }
              if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                const items = menuRef.current ? [...menuRef.current.querySelectorAll('.qdr-select-option')] : [];
                const target = event.key === 'Home' ? items[0] : items[items.length - 1];
                if (target) target.focus();
              }
            },
          },
          h('span', { className: 'qdr-select-option-label' },
            option.label,
            option.hint ? h('span', { className: 'qdr-select-hint' }, option.hint) : null),
          String(option.value) === String(value) ? h(Icon, { name: 'check', size: 13 }) : null)))
          : null);
    }

    function Segmented({ value, options = [], onChange, ariaLabel, disabled }) {
      const [pill, setPill] = useState({ left: 0, width: 0, ready: false });
      const boxRef = useRef(null);
      const itemRefs = useRef({});
      useLayoutEffect(() => {
        const measure = () => {
          const box = boxRef.current;
          const node = itemRefs.current[value];
          if (!box || !node) return;
          const boxRect = box.getBoundingClientRect();
          const nodeRect = node.getBoundingClientRect();
          const left = Math.max(0, nodeRect.left - boxRect.left - box.clientLeft);
          setPill((previous) => (
            Math.abs(previous.left - left) < 0.5
            && Math.abs(previous.width - nodeRect.width) < 0.5
            && previous.ready
              ? previous
              : { left, width: nodeRect.width, ready: true }
          ));
        };
        measure();
        const raf = requestAnimationFrame(measure);
        let observer = null;
        if (typeof ResizeObserver === 'function' && boxRef.current) {
          observer = new ResizeObserver(measure);
          observer.observe(boxRef.current);
        }
        window.addEventListener('resize', measure);
        return () => {
          cancelAnimationFrame(raf);
          if (observer) observer.disconnect();
          window.removeEventListener('resize', measure);
        };
      }, [value]);
      return h('div', { className: 'qdr-segmented', role: 'radiogroup', 'aria-label': ariaLabel, ref: boxRef },
        h('span', {
          className: `qdr-segmented-pill${pill.ready ? ' qdr-segmented-pill-ready' : ''}`,
          'aria-hidden': 'true',
          style: { width: `${pill.width}px`, transform: `translateX(${pill.left}px)` },
        }),
        options.map(([id, label], index) => h('button', {
          key: id, type: 'button', role: 'radio', 'aria-checked': value === id, disabled,
          tabIndex: value === id ? 0 : -1,
          ref: (node) => { itemRefs.current[id] = node; },
          className: `qdr-segmented-item${value === id ? ' on' : ''}`,
          onClick: () => { if (!disabled) onChange && onChange(id); },
          onKeyDown: (event) => {
            if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
            const next = options[(index + step + options.length) % options.length];
            if (next) {
              onChange && onChange(next[0]);
              const node = itemRefs.current[next[0]];
              if (node) node.focus();
            }
          },
        }, label)));
    }

    function StatusDot({ tone = 'neutral' }) {
      return h('span', { className: `qdr-dot qdr-dot-${tone}` });
    }

    function Empty({ icon = 'bolt', title, detail, action }) {
      return h('div', { className: 'qdr-empty' },
        h('div', { className: 'qdr-empty-icon' }, h(Icon, { name: icon, size: 22 })),
        h('div', { className: 'qdr-empty-title' }, title),
        detail ? h('div', { className: 'qdr-empty-detail' }, detail) : null,
        action || null);
    }

    function Stat({ label, value, hint, tone }) {
      return h('div', { className: 'qdr-stat' },
        h('div', { className: 'qdr-stat-label' }, label),
        h('div', { className: `qdr-stat-value${tone ? ` qdr-stat-${tone}` : ''}` }, value),
        hint ? h('div', { className: 'qdr-stat-hint' }, hint) : null);
    }

    function Meter({ value, tone, label }) {
      const ratio = Math.min(1, Math.max(0, num(value)));
      return h('div', {
        className: `qdr-meter${tone ? ` qdr-meter-${tone}` : ''}`,
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': Math.round(ratio * 100),
        'aria-label': label || '额度使用进度',
      }, h('span', { className: 'qdr-meter-fill', style: { width: `${Math.max(ratio > 0 ? 1 : 0, ratio * 100)}%` } }));
    }

    function QuotaCard({ extras, signedIn, busy, onRefresh, onAccount, wide, checkin, checkinBusy, onCheckin, onRunCheckin }) {
      const info = quotaSummary(extras);
      const currentCheckin = checkin && checkin.accounts
        ? checkin.accounts.find((account) => account.current)
        : null;
      const checkinDone = Boolean(currentCheckin && (currentCheckin.status === 'claimed' || currentCheckin.status === 'already'));
      const checkinUnavailable = Boolean(currentCheckin && currentCheckin.status === 'unavailable');
      const checkinWaiting = Boolean(currentCheckin && currentCheckin.status === 'waiting');
      const checkinErrorState = Boolean(currentCheckin && currentCheckin.status === 'error');
      const checkinNeedsLogin = Boolean(currentCheckin && ['login', 'device'].includes(currentCheckin.status));
      const checkinAction = checkin
        ? h(Button, {
          size: 'sm',
          variant: checkinDone || checkinUnavailable || checkinWaiting || checkinNeedsLogin ? 'ghost' : 'secondary',
          icon: checkinDone ? 'check' : checkinNeedsLogin ? 'key' : checkinErrorState ? 'refresh' : 'gift',
          disabled: Boolean(checkinBusy) || checkinUnavailable || checkinWaiting,
          onClick: () => {
            if (checkinDone || checkinNeedsLogin) { if (onCheckin) onCheckin(); return; }
            if (onRunCheckin) onRunCheckin(); else if (onCheckin) onCheckin();
          },
        }, checkinBusy ? '签到中…'
          : checkinDone ? (currentCheckin.credits ? `今日已领 +${money(currentCheckin.credits)}` : '今日已签到')
            : checkinNeedsLogin ? '需登录'
              : checkinErrorState ? '重试签到'
                : checkinUnavailable ? '本期无活动'
                  : checkinWaiting ? '10:00 后开放' : '立即签到')
        : null;
      if (!signedIn) {
        return h('div', { className: `qdr-card qdr-quota${wide ? ' qdr-quota-wide' : ''}` },
          h('div', { className: 'qdr-card-head' },
            h('div', null,
              h('div', { className: 'qdr-card-title' }, '额度'),
              h('div', { className: 'qdr-card-sub' }, '登录后显示套餐额度、加量包和到期时间。'))),
          h('div', { className: 'qdr-quota-empty' }, '尚未连接 Qoder'));
      }
      if (!info) {
        return h('div', { className: `qdr-card qdr-quota${wide ? ' qdr-quota-wide' : ''}` },
          h('div', { className: 'qdr-card-head' },
            h('div', null,
              h('div', { className: 'qdr-card-title' }, '额度'),
              h('div', { className: 'qdr-card-sub' }, busy ? '正在读取账号额度…' : '上游额度还没读到。刷新账号信息即可获取。')),
            h(Button, { size: 'sm', icon: 'refresh', disabled: Boolean(busy), onClick: onRefresh }, busy ? '读取中…' : '刷新')),
          busy
            ? h('div', { className: 'qdr-skeleton', style: { marginTop: '12px' } },
              h('div', { className: 'qdr-skel-line qdr-skel-lg' }),
              h('div', { className: 'qdr-skel-line', style: { width: '45%' } }))
            : h('div', { className: 'qdr-quota-empty' }, '—'));
      }
      const tone = info.exceeded || info.ratio >= 0.9 ? 'bad' : info.ratio >= 0.7 ? 'warn' : 'ok';
      const percent = Math.round(info.ratio * 100);
      const unitText = /^credits?$/i.test(String(info.unit)) ? 'Credits' : info.unit;
      return h('div', { className: `qdr-card qdr-quota${wide ? ' qdr-quota-wide' : ''}` },
        h('div', { className: 'qdr-card-head' },
          h('div', null,
            h('div', { className: 'qdr-quota-title-row' },
              h('div', { className: 'qdr-card-title' }, '额度'),
              info.planName ? h(Badge, { tone: info.planPaid ? 'green' : 'accent' }, info.planName) : null,
              info.exceeded ? h(Badge, { tone: 'amber' }, '已用尽') : null,
              info.stale ? h(Badge, { tone: 'amber', title: '上游额度读取失败或尚未刷新' }, '数据可能已过期') : null),
            h('div', { className: 'qdr-card-sub' },
              info.expiresAt ? `到期 ${dateLabel(info.expiresAt)}` : '上游未提供到期时间',
              info.unit ? ` · 单位 ${unitText}` : '',
              info.at ? ` · 更新于 ${stamp(info.at)}` : '')),
          h('div', { className: 'qdr-card-actions' },
            checkinAction,
            h(Button, { size: 'sm', icon: 'refresh', disabled: Boolean(busy), onClick: onRefresh }, busy ? '读取中…' : '刷新'),
            onAccount ? h(Button, { size: 'sm', variant: 'ghost', onClick: onAccount }, '账号') : null)),
        h('div', { className: 'qdr-quota-big' },
          h('strong', null, money(info.remaining)),
          h('span', { className: 'qdr-quota-total' }, ` / ${money(info.total)} ${unitText}`),
          h('span', { className: `qdr-quota-pct qdr-quota-pct-${tone}` }, `${percent}% 已用`)),
        h(Meter, { value: info.ratio, tone, label: '账号额度使用进度' }),
        h('div', { className: 'qdr-quota-grid' },
          h('div', null,
            h('span', null, '套餐额度'),
            h('strong', null, info.user && info.user.total ? `${money(info.user.remaining)} / ${money(info.user.total)}` : '—')),
          h('div', null,
            h('span', null, '加量包'),
            h('strong', null, info.addOn && info.addOn.total ? `${money(info.addOn.remaining)} / ${money(info.addOn.total)}` : '无')),
          h('div', null,
            h('span', null, '已用'),
            h('strong', null, `${money(info.used)} ${unitText}`))),
        (info.detailUrl || info.upgradeUrl || info.planEnd) ? h('div', { className: 'qdr-quota-links' },
          info.planEnd ? h('span', { className: 'qdr-hint' }, `套餐周期至 ${dateLabel(info.planEnd)}`) : null,
          info.detailUrl ? h('a', { className: 'qdr-quota-link', href: safeHref(info.detailUrl), target: '_blank', rel: 'noreferrer noopener' }, '用量明细', h(Icon, { name: 'external', size: 12 })) : null,
          info.upgradeUrl ? h('a', { className: 'qdr-quota-link', href: safeHref(info.upgradeUrl), target: '_blank', rel: 'noreferrer noopener' }, '升级套餐', h(Icon, { name: 'external', size: 12 })) : null) : null);
    }

    function useTabs(initial) {
      const [tab, setTab] = useState(initial);
      return [tab, setTab];
    }

    function Sparkline({ days, label }) {
      const values = (days || []).map((day) => num(day.tokens));
      const max = Math.max(1, ...values);
      const total = values.reduce((sum, value) => sum + value, 0);
      if (!days || !days.length) return h(Empty, { icon: 'chart', title: '还没有用量数据', detail: '完成一次对话后，这里会显示 token 趋势。' });
      const rangeText = days.length === 7 ? '最近 7 天' : days.length === 30 ? '最近 30 天' : `最近 ${days.length} 天`;
      return h('div', { className: 'qdr-chart' },
        h('div', { className: 'qdr-chart-head' },
          h('div', null,
            h('div', { className: 'qdr-chart-title' }, label || rangeText),
            h('div', { className: 'qdr-chart-sub' }, `${compact(total)} tokens`)),
          h('div', { className: 'qdr-chart-peak' }, `峰值 ${compact(max)}`)),
        h('div', { className: 'qdr-bars', role: 'img', 'aria-label': `${rangeText} token 用量，合计 ${compact(total)}` },
          days.map((day) => h('div', { className: 'qdr-bar-col', key: day.date, title: `${day.date} · ${compact(day.tokens)} tokens · ${day.requests} 次` },
            h('div', { className: 'qdr-bar-track' },
              h('div', { className: `qdr-bar${day.failures ? ' qdr-bar-warn' : ''}`, style: { height: `${Math.max(4, (num(day.tokens) / max) * 100)}%` } }))),
          )),
        h('div', { className: 'qdr-chart-axis' },
          h('span', null, dayLabel(days[0] && days[0].date)),
          h('span', null, '今天')));
    }

    function CheckRow({ check }) {
      const tone = check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : 'bad';
      const icon = check.status === 'pass' ? 'check' : check.status === 'warn' ? 'alert' : 'close';
      return h('div', { className: 'qdr-check' },
        h('span', { className: `qdr-check-icon qdr-check-${tone}` }, h(Icon, { name: icon, size: 14 })),
        h('div', { className: 'qdr-check-body' },
          h('div', { className: 'qdr-check-label' }, check.label),
          h('div', { className: 'qdr-check-detail' }, check.detail)));
    }

    function modelBadges(model, customized) {
      const out = [];
      if (model.contextWindow) out.push({
        text: model.contextWindowOptions && model.contextWindowOptions.length > 1
          ? `${compact(model.contextWindow)} ctx · 可调`
          : compact(model.contextWindow) + ' ctx',
        tone: 'neutral',
        title: model.contextWindowOptions && model.contextWindowOptions.length
          ? '可选上下文：' + model.contextWindowOptions.map(contextLabel).join(' / ')
          : '',
      });
      if (model.maxOutputTokens) out.push({ text: '输出 ' + compact(model.maxOutputTokens), tone: 'neutral' });
      if (model.supportsImages) out.push({ text: '视觉', tone: 'neutral' });
      if (model.supportsReasoning) out.push({ text: (model.reasoningEfforts || []).join('/') || '思考', tone: 'violet' });
      if (model.free) out.push({ text: '免费', tone: 'green' });
      else if (model.credits !== null && model.credits !== undefined) out.push({ text: '×' + money(model.credits), tone: 'neutral' });
      if (model.promotionActive && model.discount) out.push({ text: `促销 ${Math.round(model.discount * 100)}%`, tone: 'amber' });
      if (model.badge && !(model.promotionActive && /^谷时/.test(model.badge))) out.push({ text: model.badge, tone: 'amber' });
      if (customized) out.push({ text: '自定义', tone: 'accent' });
      return out;
    }

    function ModelRow({ model, checked, pinned, expanded, customized, onToggle, onPin, onOpen }) {
      return h('div', { className: `qdr-model${checked || pinned ? '' : ' qdr-model-off'}${expanded ? ' qdr-model-expanded' : ''}` },
        h('label', { className: 'qdr-checkbox', title: pinned ? '默认模型会始终保留在 dsh 选择器中' : undefined },
          h('input', { type: 'checkbox', checked, onChange: onToggle, 'aria-label': `在 dsh 选择器中显示 ${model.name}` }),
          h('span', null)),
        h('button', {
          type: 'button', className: 'qdr-model-open', onClick: onOpen, 'aria-expanded': Boolean(expanded),
          'aria-label': `${expanded ? '收起' : '展开'} ${model.name} 的详情与参数`,
        },
        h('div', { className: 'qdr-model-main' },
          h('div', { className: 'qdr-model-title' },
            h('span', { className: 'qdr-model-name' }, model.name),
            model.pinned ? h(Badge, { tone: 'accent' }, '默认') : null,
            model.official === false ? h(Badge, { tone: 'neutral' }, '非官方') : null),
          h('div', { className: 'qdr-model-id' }, model.id),
          h('div', { className: 'qdr-model-badges' },
            modelBadges(model, customized).map((badge, index) => h(Badge, { key: index, tone: badge.tone, title: badge.title }, badge.text)))),
        h('span', { className: `qdr-chevron${expanded ? ' qdr-chevron-on' : ''}` }, h(Icon, { name: 'chevron', size: 14 }))),
        h('button', {
          type: 'button',
          className: `qdr-pin${pinned ? ' qdr-pin-on' : ''}`,
          onClick: onPin,
          title: pinned ? '当前默认模型' : '设为默认模型',
          'aria-label': pinned ? `取消 ${model.name} 的默认模型` : `把 ${model.name} 设为默认模型`,
        }, h(Icon, { name: 'pin', size: 15 })));
    }

    function ModelEditor({ model, overrideContext, overrideParams, pluginDefaults, busy, error, onSave, onReset, onTrial, onCopy, onDirtyChange }) {
      const options = Array.isArray(model.contextWindowOptions) ? model.contextWindowOptions : [];
      const autoContext = num(model.contextWindowAuto) || num(model.contextWindow);
      const maxContext = num(model.contextWindowMax);
      const rawSavedContext = num(overrideContext);
      // 旧版本可能把 1M 存进了偏好；按官方硬上限显示，保存时自然收敛。
      const savedContext = rawSavedContext > 0 && maxContext > 0
        ? Math.min(rawSavedContext, maxContext)
        : rawSavedContext;
      const params = overrideParams || {};
      const pluginTemperature = pluginDefaults && typeof pluginDefaults.temperature === 'number' && Number.isFinite(pluginDefaults.temperature)
        ? pluginDefaults.temperature : null;
      const pluginMaxTokens = pluginDefaults ? num(pluginDefaults.maxTokens) : 0;
      const providerMaxTokens = pluginDefaults && num(pluginDefaults.providerMaxTokens) > 0
        ? num(pluginDefaults.providerMaxTokens) : 32000;
      const pluginEffort = pluginDefaults && typeof pluginDefaults.reasoningEffort === 'string' ? pluginDefaults.reasoningEffort : '';
      const [context, setContext] = useState(savedContext ? String(savedContext) : 'auto');
      const [effort, setEffort] = useState(typeof params.reasoningEffort === 'string' ? params.reasoningEffort : '');
      const [temperature, setTemperature] = useState(typeof params.temperature === 'number' ? String(params.temperature) : '');
      const [maxTokens, setMaxTokens] = useState(Number(params.maxTokens) > 0 ? String(params.maxTokens) : '');

      useEffect(() => {
        setContext(savedContext ? String(savedContext) : 'auto');
      }, [model.id, savedContext]);
      useEffect(() => {
        setEffort(typeof params.reasoningEffort === 'string' ? params.reasoningEffort : '');
        setTemperature(typeof params.temperature === 'number' ? String(params.temperature) : '');
        setMaxTokens(Number(params.maxTokens) > 0 ? String(params.maxTokens) : '');
      }, [model.id, params.reasoningEffort, params.temperature, params.maxTokens]);

      const tempValue = temperature.trim();
      const tempNumber = Number(tempValue);
      const tempError = tempValue !== '' && (!Number.isFinite(tempNumber) || tempNumber < 0 || tempNumber > 2)
        ? '温度需要是 0–2 之间的数字' : '';
      const maxValue = maxTokens.trim();
      const maxNumber = Number(maxValue);
      const maxCap = num(model.maxOutputTokens);
      const rawContextValue = context === 'auto' ? 0 : Number(context);
      const contextValue = rawContextValue > 0 && maxContext > 0
        ? Math.min(rawContextValue, maxContext)
        : rawContextValue;
      // 上游目录常常不公布输出上限；至少用当前上下文窗口作为硬边界，避免填出无效值。
      const contextCeiling = contextValue || autoContext || maxContext || 0;
      const outputCeiling = maxCap || contextCeiling;
      const maxError = maxValue !== ''
        ? (!Number.isSafeInteger(maxNumber) || maxNumber <= 0
          ? '最大输出需要是正整数'
          : (outputCeiling && maxNumber > outputCeiling
            ? `不能超过${maxCap ? '模型上限' : '上下文窗口'} ${compact(outputCeiling)}`
            : ''))
        : '';
      const issues = [tempError, maxError].filter(Boolean);
      const nextParams = {};
      if (Number.isFinite(tempNumber) && tempValue !== '' && !tempError) nextParams.temperature = tempNumber;
      if (maxValue !== '' && !maxError) nextParams.maxTokens = maxNumber;
      if (effort) nextParams.reasoningEffort = effort;
      const savedTemp = typeof params.temperature === 'number' ? params.temperature : null;
      const savedMax = Number(params.maxTokens) > 0 ? Number(params.maxTokens) : 0;
      const dirty = contextValue !== savedContext
        || (nextParams.temperature === undefined ? null : nextParams.temperature) !== savedTemp
        || (nextParams.maxTokens || 0) !== savedMax
        || (nextParams.reasoningEffort || '') !== (params.reasoningEffort || '');
      const hasOverride = savedContext > 0 || Object.keys(params).length > 0;
      const effectiveContext = contextValue || autoContext;
      const autoEffort = pluginEffort && (model.reasoningEfforts || []).includes(pluginEffort)
        ? pluginEffort
        : (model.defaultReasoningEffort || '');
      const effectiveEffort = effort || autoEffort || '自动';
      const effectiveTemp = nextParams.temperature === undefined
        ? (pluginTemperature !== null ? `未指定（插件默认 ${pluginTemperature}）` : '未指定（不传）')
        : String(nextParams.temperature);
      const autoMaxTokens = autoOutputTokens(pluginMaxTokens, maxCap, providerMaxTokens);
      const autoMaxSource = pluginMaxTokens
        ? (maxCap && pluginMaxTokens > maxCap ? '插件默认（已按模型上限收敛）' : '插件默认')
        : (maxCap ? '模型上限' : 'Qoder 默认');
      const effectiveMaxText = nextParams.maxTokens
        ? compact(nextParams.maxTokens)
        : `${compact(autoMaxTokens)}（${autoMaxSource}）`;
      const temperaturePresets = [['', '自动'], ['0', '0'], ['0.3', '0.3'], ['0.7', '0.7'], ['1', '1']];
      const outputPresets = [['', `自动 · ${compact(autoMaxTokens)}`], ['4096', '4K'], ['8192', '8K'], ['16384', '16K'], ['32768', '32K']]
        .filter(([value]) => !value || !maxCap || Number(value) <= maxCap);
      if (maxCap) outputPresets.push([String(maxCap), `用上限 ${compact(maxCap)}`]);

      useEffect(() => {
        if (typeof onDirtyChange === 'function') onDirtyChange(Boolean(dirty));
      }, [dirty, onDirtyChange]);
      useEffect(() => () => {
        if (typeof onDirtyChange === 'function') onDirtyChange(false);
      }, [onDirtyChange]);

      const save = () => {
        if (issues.length || busy) return;
        onSave({
          contextWindow: contextValue,
          params: nextParams,
        });
      };

      return h('div', { className: 'qdr-editor' },
        h('div', { className: 'qdr-editor-head' },
          h('div', null,
            h('div', { className: 'qdr-editor-title' }, '模型参数'),
            h('div', { className: 'qdr-editor-sub' },
              '「自动」输出使用 Qoder CLI 默认 32K（插件或模型有更高默认时以它们为准）；温度「自动」不传，由上游决定。保存后对下一次请求生效；已开始会话的占用率显示不会回填。')),
          h('div', { className: 'qdr-editor-head-actions' },
            h(Button, { size: 'sm', variant: 'ghost', icon: 'copy', onClick: () => onCopy(model.id, '模型 id') }, '复制 id'),
            h(Button, { size: 'sm', variant: 'ghost', icon: 'bolt', onClick: () => onTrial(model) }, '去试跑'))),
        h('div', { className: 'qdr-editor-facts' },
          h(Badge, { tone: 'neutral' }, model.vendor || 'Qoder'),
          h(Badge, { tone: model.official === false ? 'neutral' : 'green' }, model.official === false ? '非官方' : '官方目录'),
          model.supportsImages ? h(Badge, { tone: 'neutral' }, '图片输入') : null,
          model.free ? h(Badge, { tone: 'green' }, '免费') : (model.credits !== null && model.credits !== undefined ? h(Badge, { tone: 'neutral' }, '×' + money(model.credits) + ' Credits') : null),
          model.promotionActive && model.discount ? h(Badge, { tone: 'amber' }, `促销 ${Math.round(model.discount * 100)}%`) : null,
          model.badge ? h(Badge, { tone: 'amber' }, model.badge) : null),
        h('div', { className: 'qdr-fields' },
          options.length ? h('div', { className: 'qdr-field' },
            h('span', { className: 'qdr-field-label' }, '上下文窗口'),
            h(Select, {
              value: context, disabled: Boolean(busy), ariaLabel: '上下文窗口',
              onChange: setContext,
              options: [
                { value: 'auto', label: `自动 · ${contextLabel(autoContext)}` },
                ...options.map((value) => ({ value: String(value), label: contextLabel(value) })),
                ...(savedContext && !options.includes(savedContext)
                  ? [{ value: String(savedContext), label: contextLabel(savedContext) }]
                  : []),
              ],
            }),
            h('span', { className: 'qdr-field-note' }, `官方上限 ${contextLabel(model.contextWindowMax || autoContext)}`)) : null,

          model.supportsReasoning && (model.reasoningEfforts || []).length ? h('div', { className: 'qdr-field' },
            h('span', { className: 'qdr-field-label' }, '默认思考档位'),
            h(Select, {
              value: effort, disabled: Boolean(busy), ariaLabel: '默认思考档位',
              onChange: setEffort,
              options: [
                { value: '', label: `自动${autoEffort ? ' · ' + autoEffort : ''}` },
                ...(model.reasoningEfforts || []).map((value) => ({ value, label: value })),
              ],
            }),
            h('span', { className: 'qdr-field-note' }, '自动 = 插件默认优先，否则跟随官方推荐；对话中仍可临时切换')) : null,

          h('div', { className: 'qdr-field' },
            h('span', { className: 'qdr-field-label' }, '默认温度'),
            h('input', {
              className: `qdr-input${tempError ? ' qdr-input-bad' : ''}`,
              type: 'number', min: 0, max: 2, step: 0.1, value: temperature,
              placeholder: pluginTemperature !== null ? `未指定 · 插件默认 ${pluginTemperature}` : '未指定', disabled: Boolean(busy),
              onChange: (event) => setTemperature(event.target.value),
              'aria-label': '默认温度',
            }),
            h('div', { className: 'qdr-presets', role: 'group', 'aria-label': '温度快捷值' },
              temperaturePresets.map(([value, label]) => h('button', {
                key: value || 'auto', type: 'button', disabled: Boolean(busy),
                className: `qdr-preset${temperature === value ? ' qdr-preset-on' : ''}`,
                'aria-pressed': temperature === value,
                onClick: () => setTemperature(value),
              }, label))),
            h('span', { className: `qdr-field-note${tempError ? ' qdr-field-bad' : ''}` },
              tempError || (pluginTemperature !== null
                ? `自动 = 插件默认 ${pluginTemperature}；dsh 显式传参时以请求为准`
                : '自动 = 不指定；Qoder CLI 聊天请求不传 temperature，由上游决定'))),

          h('div', { className: 'qdr-field' },
            h('span', { className: 'qdr-field-label' }, '最大输出 tokens'),
            h('input', {
              className: `qdr-input${maxError ? ' qdr-input-bad' : ''}`,
              type: 'number', min: 1, step: 256, value: maxTokens,
              placeholder: `自动 · ${compact(autoMaxTokens)}`,
              disabled: Boolean(busy),
              onChange: (event) => setMaxTokens(event.target.value),
              'aria-label': '最大输出 tokens',
            }),
            h('div', { className: 'qdr-presets', role: 'group', 'aria-label': '最大输出快捷值' },
              outputPresets.map(([value, label]) => h('button', {
                key: value || 'auto', type: 'button', disabled: Boolean(busy),
                className: `qdr-preset${maxTokens === value ? ' qdr-preset-on' : ''}`,
                'aria-pressed': maxTokens === value,
                onClick: () => setMaxTokens(value),
              }, label))),
            h('span', { className: `qdr-field-note${maxError ? ' qdr-field-bad' : ''}` },
              maxError || (maxCap
                ? `模型上限 ${compact(maxCap)}；自动 = ${compact(autoMaxTokens)}`
                : (pluginMaxTokens
                  ? `插件默认 ${compact(pluginMaxTokens)}；自动 = ${compact(autoMaxTokens)}`
                  : `Qoder CLI 默认 32K；自动 = ${compact(autoMaxTokens)}，可填更高（输入与输出共享上下文 ${compact(contextCeiling)}）`))))),
        h('div', { className: 'qdr-editor-effective' },
          h('span', null, '实际生效'),
          h('span', { className: 'qdr-editor-effective-value' },
            `${contextLabel(effectiveContext)} 上下文 · ${effectiveEffort} · 温度 ${effectiveTemp} · 输出 ${effectiveMaxText}`)),
        error ? h('div', { className: 'qdr-inline-warn', role: 'alert' }, error) : null,
        h('div', { className: 'qdr-editor-actions' },
          h(Button, {
            size: 'sm', variant: 'primary', disabled: Boolean(busy) || !dirty || issues.length > 0,
            onClick: save,
          }, busy ? '保存中…' : '保存参数'),
          h(Button, {
            size: 'sm', variant: 'ghost', icon: 'trash', disabled: Boolean(busy) || !hasOverride,
            onClick: onReset,
          }, '恢复默认'),
          h('span', { className: 'qdr-editor-hint' },
            dirty ? '有未保存的修改' : '已与已保存设置一致')));
    }

    function DeviceCard({ state, busy, onStart, onCancel, region, setRegion }) {
      const [now, setNow] = useState(Date.now());
      useEffect(() => {
        if (!state) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [state && state.id]);
      const left = state ? Math.max(0, Math.round((state.expiresAt - now) / 1000)) : 0;
      const expired = Boolean(state && left <= 0);
      if (!state) {
        return h('div', { className: 'qdr-card' },
          h('div', { className: 'qdr-card-head' },
            h('div', null,
              h('div', { className: 'qdr-card-title' }, '浏览器授权'),
              h('div', { className: 'qdr-card-sub' }, '不需要桌面端，也不会读取本机已有登录。')),
            h(Segmented, {
              value: region, onChange: setRegion, ariaLabel: '登录区域', disabled: Boolean(busy),
              options: [['global', '国际版'], ['cn', '国内版']],
            })),
          h('div', { className: 'qdr-card-foot' },
            h(Button, { variant: 'primary', icon: 'external', disabled: busy, onClick: () => onStart(region) }, '打开授权页')));
      }
      return h('div', { className: 'qdr-card qdr-device' },
        h('div', { className: 'qdr-card-head' },
          h('div', null,
            h('div', { className: 'qdr-card-title' }, expired ? '授权已过期' : '等待浏览器授权'),
            h('div', { className: 'qdr-card-sub' }, expired
              ? '这次授权会话已失效，重新发起即可获取新的链接。'
              : '在打开的页面里选择账号并确认，本页会自动完成登录。')),
          h('span', { className: 'qdr-live' },
            h(StatusDot, { tone: expired ? 'bad' : 'warn' }),
            expired ? '已过期' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)),
        expired ? null : h('a', { className: 'qdr-link', href: safeHref(state.verificationUri), target: '_blank', rel: 'noreferrer noopener' }, state.verificationUri),
        h('div', { className: 'qdr-device-foot' },
          h('span', { className: 'qdr-hint' }, expired
            ? '授权链接通常 10 分钟内有效。'
            : (state.message || '已在新窗口打开授权页；若被拦截，点击上面的链接。')),
          expired
            ? h(Button, { size: 'sm', variant: 'primary', icon: 'refresh', disabled: busy, onClick: () => onStart(region) }, '重新发起')
            : h(Button, { size: 'sm', disabled: busy, onClick: onCancel }, '取消')));
    }

    function TrialPanel({ models, signedIn, pinned, presetModel, onUsage, onLogin, onCopy }) {
      const all = models || [];
      const visible = all.filter((model) => model.visible);
      const list = visible.length ? visible : all;
      const preferred = presetModel || pinned || (list[0] && list[0].id) || (all[0] && all[0].id) || '';
      const [modelId, setModelId] = useState(preferred);
      const [prompt, setPrompt] = useState('用一句话介绍你自己。');
      const [busy, setBusy] = useState(false);
      const [elapsed, setElapsed] = useState(0);
      const [result, setResult] = useState(null);
      const [error, setError] = useState('');
      const [effort, setEffort] = useState('');
      const alive = useRef(true);
      const abortRef = useRef(null);
      useEffect(() => () => { alive.current = false; if (abortRef.current) abortRef.current.abort(); }, []);
      useEffect(() => {
        if (!busy) { setElapsed(0); return undefined; }
        const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
        return () => clearInterval(timer);
      }, [busy]);
      useEffect(() => {
        if (presetModel) setModelId(presetModel);
      }, [presetModel]);
      // 目录刷新/换号后模型集合可能变化但数量不变（例如同数量的模型被替换），
      // 只盯 all.length 会让试跑停在一个已经不存在的 id 上，下一次请求直接 400。
      const model = all.find((item) => item.id === modelId) || null;
      const efforts = model && Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
      const modelSignature = all.map((item) => item.id).join('\u0000');
      const effortSignature = efforts.join('\u0000');
      useEffect(() => {
        if (modelId && all.some((item) => item.id === modelId)) return;
        const next = pinned || (list[0] && list[0].id) || (all[0] && all[0].id) || '';
        if (next) setModelId(next);
      }, [modelSignature, pinned]); // eslint-disable-line react-hooks/exhaustive-deps
      useEffect(() => {
        // 试跑默认用最低档，避免一次连通性检查先等十几秒思考；用户可切回已保存档位。
        setEffort(efforts[0] || '');
      }, [modelId, effortSignature]);
      const run = async () => {
        if (busy) return;
        if (!modelId) return setError('先选择一个模型');
        if (!prompt.trim()) return setError('先写一句要发送的内容');
        setBusy(true);
        setError('');
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const data = await postJson('/qoder/test', {
            model: modelId,
            prompt: prompt.trim(),
            ...(effort ? { reasoningEffort: effort } : {}),
          }, { signal: controller.signal });
          if (!alive.current) return;
          if (!data.ok) throw new Error(data.error || '试跑失败');
          setResult({ ...data, at: Date.now(), modelName: model ? model.name : modelId });
          onUsage && onUsage();
        } catch (err) {
          if (!alive.current) return;
          if (err && err.name === 'AbortError') setError('已取消本次试跑。');
          else setError(String(err.message || err));
        } finally {
          abortRef.current = null;
          if (alive.current) setBusy(false);
        }
      };
      if (!signedIn) {
        return h('div', { className: 'qdr-panel' },
          h(Empty, {
            icon: 'bolt', title: '登录后才能试跑',
            detail: '试跑会真实调用 Qoder 模型，并记录到用量统计。',
            action: h(Button, { variant: 'primary', icon: 'key', onClick: onLogin }, '去账号页登录'),
          }));
      }
      const quick = ['回复 pong', '用三句话解释什么是上下文窗口', '写一个 JS 防抖函数，并说明边界情况'];
      const usage = result && result.usage;
      const cachedTokens = usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens;
      const reasoningTokens = Number(usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
      const tokensPerSecond = usage && result.latencyMs
        ? ((Number(usage.completion_tokens) || 0) / (result.latencyMs / 1000)).toFixed(1)
        : '';
      const usageBits = usage ? [
        ['输入', compact(usage.prompt_tokens || 0)],
        ['输出', compact(usage.completion_tokens || 0)],
        ['合计', compact(usage.total_tokens || 0)],
        ...(cachedTokens ? [['缓存', compact(cachedTokens)]] : []),
        ['首字', duration(result.firstByteMs)],
        ['耗时', duration(result.latencyMs)],
        ['速度', tokensPerSecond ? `${tokensPerSecond} tok/s` : '—'],
      ] : [];
      const generationMs = result ? Math.max(0, (result.latencyMs || 0) - (result.firstByteMs || 0)) : 0;
      const effortIsLowest = Boolean(effort && efforts.length && effort === efforts[0]);
      return h('div', { className: 'qdr-panel' },
        h('div', { className: 'qdr-card qdr-trial' },
          h('div', { className: 'qdr-card-head' },
            h('div', null,
              h('div', { className: 'qdr-card-title' }, '试跑'),
              h('div', { className: 'qdr-card-sub' }, '用当前模型发一次真实请求；默认最低思考档位，结果会计入用量。')),
            model ? h('div', { className: 'qdr-trial-price' },
              model.free ? h(Badge, { tone: 'green' }, '免费')
                : (model.credits !== null && model.credits !== undefined ? h(Badge, { tone: 'neutral' }, '×' + money(model.credits) + ' Credits') : null),
              model.contextWindow ? h(Badge, { tone: 'neutral' }, contextLabel(model.contextWindow) + ' ctx') : null) : null),
          h('div', { className: 'qdr-trial-form' },
            h('div', { className: 'qdr-field' },
              h('span', { className: 'qdr-field-label' }, '模型'),
              h(Select, {
                value: modelId, disabled: Boolean(busy), ariaLabel: '试跑模型',
                onChange: setModelId,
                placeholder: '目录里还没有可用模型',
                options: list.map((item) => ({ value: item.id, label: item.name, hint: item.id })),
              })),
            efforts.length ? h('div', { className: 'qdr-field' },
              h('span', { className: 'qdr-field-label' }, '本次思考档位'),
              h(Select, {
                value: effort, disabled: Boolean(busy), ariaLabel: '本次思考档位',
                onChange: setEffort,
                options: [
                  { value: '', label: `跟随已保存${model.defaultReasoningEffort ? ` · ${model.defaultReasoningEffort}` : ''}` },
                  ...efforts.map((value) => ({ value, label: value })),
                ],
              }),
              h('span', { className: 'qdr-field-note' },
                `默认最低档 ${efforts[0]}，避免等待过久；本次选择不保存`)) : null,
            h('label', { className: 'qdr-field qdr-field-wide' },
              h('span', { className: 'qdr-field-label' }, '发送内容'),
              h('textarea', {
                className: 'qdr-textarea', rows: 3, value: prompt, maxLength: 8000, disabled: Boolean(busy),
                placeholder: '写点什么试试这条链路…',
                onChange: (event) => setPrompt(event.target.value),
                onKeyDown: (event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    run();
                  }
                },
                'aria-label': '试跑发送内容',
              })),
            h('div', { className: 'qdr-trial-quick' },
              quick.map((text) => h('button', {
                key: text, type: 'button', className: 'qdr-chip', disabled: Boolean(busy),
                onClick: () => setPrompt(text),
              }, text)))),
          h('div', { className: 'qdr-trial-actions' },
            h(Button, { variant: 'primary', icon: 'bolt', disabled: Boolean(busy) || !modelId || !prompt.trim(), onClick: run },
              busy ? `等待上游… ${elapsed}s` : '运行'),
            busy ? h(Button, { size: 'sm', variant: 'ghost', icon: 'close', onClick: () => { if (abortRef.current) abortRef.current.abort(); } }, '取消') : null,
            h('span', { className: 'qdr-hint' }, busy ? '可随时取消；会同时中止上游等待（已产生的用量仍可能计费）。' : 'Ctrl/⌘ + Enter 运行 · 消耗 Qoder Credits · 不发送工具调用')),
          error ? h('div', { className: 'qdr-banner qdr-banner-error', role: 'alert' },
            h(Icon, { name: 'alert', size: 15 }), h('span', null, error)) : null),
        result ? h('div', { className: 'qdr-card qdr-trial-result' },
          h('div', { className: 'qdr-card-head' },
            h('div', null,
              h('div', { className: 'qdr-card-title' }, '回复'),
              h('div', { className: 'qdr-card-sub' }, `${result.modelName || result.model || ''}${result.reasoningEffort ? ` · 档位 ${result.reasoningEffort}` : ''} · ${stamp(result.at)} · 本次请求`)),
            h('div', { className: 'qdr-card-actions' },
              h(Button, {
                size: 'sm', variant: 'ghost', icon: 'copy', disabled: !result.text,
                onClick: () => onCopy(result.text || '', '回复'),
              }, '复制'))),
          result.reasoning ? h('details', { className: 'qdr-thinking' },
            h('summary', null, `思考过程 · ${result.reasoning.length} 字`),
            h('pre', null, result.reasoning)) : null,
          h('div', { className: 'qdr-answer' }, result.text || '（空回复）'),
          h('div', { className: 'qdr-trial-usage' },
            usageBits.map(([label, value]) => h('span', { key: label },
              h('span', { className: 'qdr-trial-usage-label' }, label),
              h('strong', null, value))),
            result.reasoning && usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens
              ? h('span', null, h('span', { className: 'qdr-trial-usage-label' }, '思考'),
                h('strong', null, compact(usage.completion_tokens_details.reasoning_tokens)))
              : null),
          generationMs > 1500 ? h('div', { className: 'qdr-trial-speed-note' },
            h(Icon, { name: 'bolt', size: 12 }),
            h('span', null,
              `首字 ${duration(result.firstByteMs)}；其余 ${duration(generationMs)} 花在${reasoningTokens ? `思考（${compact(reasoningTokens)} tokens）与` : ''}输出上。${effortIsLowest ? '已经是当前模型最低档；想更快可换非思考模型或缩短输出。' : '想更快可降低本次思考档位、换非思考模型或缩短输出。'}`)) : null)
          : h('div', { className: 'qdr-card qdr-trial-empty' },
            h(Empty, {
              icon: 'bolt', title: '还没有试跑记录',
              detail: '选择一个模型，发一句话，就能看到真实回复、思考过程、token 用量与首字延迟。',
            })));
    }

    const CREDIT_RANGES = [['1d', '1天'], ['7d', '7天'], ['30d', '30天'], ['mtd', '月初至今'], ['last-month', '上个月']];
    const shortDate = (date) => {
      const parts = String(date || '').split('-').map(Number);
      return parts.length === 3 ? `${parts[1]}月${parts[2]}日` : String(date || '');
    };

    function CreditsHeatmap({ data, busy, onRefresh, error }) {
      const [selected, setSelected] = useState(null);
      if (!data) {
        if (error) return h(Empty, {
          icon: 'chart', title: 'Credits 热力图读取失败', detail: error,
          action: h(Button, { size: 'sm', icon: 'refresh', onClick: onRefresh }, '重试'),
        });
        return h('div', { className: 'qdr-card qdr-credits-heat-card' },
          h('div', { className: 'qdr-card-head' },
            h('div', null,
              h('div', { className: 'qdr-card-title' }, 'Credits 消耗热力图'),
              h('div', { className: 'qdr-card-sub' }, '近一年每日实际扣费分布'))),
          h('div', { className: 'qdr-skeleton', style: { marginTop: '10px' } },
            h('div', { className: 'qdr-skel-line', style: { height: '68px', width: '100%' } }),
            h('div', { className: 'qdr-skel-line', style: { width: '40%' } })));
      }
      const days = Array.isArray(data.days) ? data.days : [];
      const max = num(data.max);
      const cells = [];
      if (days.length) {
        const first = new Date(`${days[0].date}T00:00:00`);
        for (let i = 0; i < first.getDay(); i += 1) cells.push(null);
        for (const day of days) cells.push({ ...day, parsed: new Date(`${day.date}T00:00:00`) });
        while (cells.length % 7 !== 0) cells.push(null);
      }
      const weeks = [];
      for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
      const months = [];
      let lastMonth = -1;
      weeks.forEach((week, index) => {
        const first = week.find(Boolean);
        if (!first) return;
        const month = first.parsed.getMonth();
        if (month !== lastMonth) {
          months.push({ index, label: `${month + 1}月` });
          lastMonth = month;
        }
      });
      const level = (credits) => {
        const value = Number(credits) || 0;
        if (value <= 0 || max <= 0) return 0;
        return Math.max(1, Math.min(4, Math.ceil((value / max) * 4)));
      };
      return h('div', { className: 'qdr-card qdr-credits-heat-card' },
        h('div', { className: 'qdr-card-head' },
          h('div', null,
            h('div', { className: 'qdr-card-title' }, 'Credits 消耗热力图'),
            h('div', { className: 'qdr-card-sub' }, `近一年每日实际扣费分布 · ${rangeLabel({ from: data.from, to: data.to })}`)),
          h('div', { className: 'qdr-card-actions' },
            h(Badge, { tone: 'green' }, `近一年 ${creditsText(data.totalCredits)} Credits`),
            h(Button, { size: 'sm', variant: 'ghost', icon: 'refresh', disabled: Boolean(busy), onClick: onRefresh }, busy ? '更新中…' : '刷新'))),
        days.length ? h('div', { className: 'qdr-heat' },
          h('div', { className: 'qdr-heat-months', style: { gridTemplateColumns: `repeat(${weeks.length}, var(--qdr-heat-cell))` }, 'aria-hidden': 'true' },
            months.map((month) => h('span', { key: month.index, style: { gridColumnStart: month.index + 1 } }, month.label))),
          h('div', {
            className: 'qdr-heat-grid', role: 'img',
            'aria-label': `近一年 Credits 热力图，${rangeLabel({ from: data.from, to: data.to })} 合计 ${creditsText(data.totalCredits)} Credits，共 ${days.filter((day) => Number(day.credits) > 0).length} 天有消耗`,
          },
            cells.map((cell, index) => h('span', {
              key: index,
              'aria-hidden': 'true',
              className: `qdr-heat-cell${cell ? ` qdr-heat-${level(cell.credits)}` : ' qdr-heat-empty'}`,
              style: cell ? { cursor: 'pointer' } : undefined,
              title: cell ? `${cell.date} · ${creditsText(cell.credits)} Credits · ${cell.requests} 次请求` : '',
              onPointerDown: cell ? () => setSelected({ ...cell }) : undefined,
            }))),
          h('div', { className: 'qdr-heat-foot' },
            h('span', null, `${rangeDateLabel(data.from)} - ${rangeDateLabel(data.to)}`),
            h('div', { className: 'qdr-heat-legend' },
              h('span', null, '少'),
              [0, 1, 2, 3, 4].map((value) => h('i', { key: value, className: `qdr-heat-${value}` })),
              h('span', null, '多'))),
          selected ? h('div', { className: 'qdr-heat-selected', 'aria-live': 'polite' },
            h(Icon, { name: 'calendar', size: 12 }),
            h('span', null, `${rangeDateLabel(selected.date)} · ${creditsText(selected.credits)} Credits · ${selected.requests} 次请求`)) : null)
          : h('div', { className: 'qdr-quiet' }, '近一年还没有 Credits 消耗记录。'));
    }

    function CreditsChart({ data, mode, range, busy, onMode, onRange, onRefresh, modelLabel, error }) {
      const [hover, setHover] = useState(null);
      const [showInfo, setShowInfo] = useState(false);
      if (!data) {
        if (error) return h(Empty, {
          icon: 'chart', title: 'Credits 趋势读取失败', detail: error,
          action: h(Button, { size: 'sm', icon: 'refresh', onClick: onRefresh }, '重试'),
        });
        return h('div', { className: 'qdr-card qdr-credits-card' },
          h('div', { className: 'qdr-card-head' },
            h('div', null,
              h('div', { className: 'qdr-card-title' }, 'Credits 消耗'),
              h('div', { className: 'qdr-card-sub' }, '按天统计 · 正在读取…'))),
          h('div', { className: 'qdr-skeleton', style: { marginTop: '10px' } },
            h('div', { className: 'qdr-skel-line qdr-skel-lg' }),
            h('div', { className: 'qdr-skel-line', style: { height: '150px', width: '100%' } })));
      }
      const days = Array.isArray(data.days) ? data.days : [];
      const groups = mode === 'all'
        ? [{ key: 'all', label: '全部', credits: data.totals.credits, points: days.map((day) => day.credits) }]
        : ((data.series && data.series[mode]) || []);
      const W = 760;
      const H = 238;
      const pad = { l: 46, r: 14, t: 16, b: 30 };
      const plotW = W - pad.l - pad.r;
      const plotH = H - pad.t - pad.b;
      const xs = days.map((_, index) => (days.length === 1
        ? pad.l + plotW / 2
        : pad.l + (index / (days.length - 1)) * plotW));
      const yMax = Math.max(1, ...groups.flatMap((group) => group.points), ...days.map((day) => day.credits));
      const y = (value) => pad.t + (1 - Math.min(1, Math.max(0, (Number(value) || 0) / yMax))) * plotH;
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => yMax * ratio);
      const labelIndices = days.length <= 7
        ? days.map((_, index) => index)
        : [...new Set([0, Math.round((days.length - 1) * 0.25), Math.round((days.length - 1) * 0.5), Math.round((days.length - 1) * 0.75), days.length - 1])];
      const labelOf = (group) => (mode === 'model'
        ? modelLabel(group.key)
        : mode === 'client' ? clientLabel(group.key) : group.label);
      const hoverX = hover !== null && xs[hover] !== undefined ? xs[hover] : null;
      const move = (event) => {
        if (!days.length) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        setHover(Math.round(ratio * (days.length - 1)));
      };
      return h('div', { className: 'qdr-card qdr-credits-card' },
        h('div', { className: 'qdr-credits-toolbar' },
          h('div', { className: 'qdr-range-display' },
            h(Icon, { name: 'calendar', size: 14 }),
            h('span', null, rangeLabel(data.range))),
          h('div', { className: 'qdr-chips' },
          CREDIT_RANGES.map(([key, label]) => h('button', {
            key, type: 'button', className: `qdr-chip${range === key ? ' qdr-chip-on' : ''}`,
            'aria-pressed': range === key,
            onClick: () => onRange(key),
          }, label))),
          h(Button, { size: 'sm', variant: 'ghost', icon: 'refresh', disabled: Boolean(busy), onClick: onRefresh }, busy ? '更新中…' : '刷新')),
        h('div', { className: 'qdr-credits-head' },
          h('div', null,
            h('div', { className: 'qdr-credits-label' }, 'Credits 消耗'),
            h('div', { className: 'qdr-credits-total' },
              creditsText(data.totals.credits),
              h('button', {
                type: 'button', className: 'qdr-credits-info',
                title: '只统计本机请求元数据，不包含 prompt / 回复内容',
                'aria-label': '关于 Credits 统计口径', 'aria-expanded': showInfo,
                onClick: () => setShowInfo((value) => !value),
              }, '?'))),
          h(Select, {
            value: mode, ariaLabel: 'Credits 维度', className: 'qdr-credits-mode',
            onChange: onMode,
            options: [
              { value: 'all', label: '全部' },
              { value: 'model', label: '按模型' },
              { value: 'client', label: '按客户端' },
            ],
          })),
        showInfo ? h('div', { className: 'qdr-hint qdr-credits-note' },
          '只统计上游实际扣费的 Credits：免费模型即使返回原价估算也不计入，折扣请求只记实扣；已省金额单独汇总。数据只来自本机请求元数据，不包含 prompt / 回复内容。') : null,
        h('div', { className: 'qdr-chart-wrap' },
          h('svg', {
            className: 'qdr-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', tabIndex: 0,
            'aria-label': `Credits 消耗趋势，${rangeLabel(data.range)}；用左右方向键逐日查看`,
            onFocus: () => setHover((value) => (value === null ? Math.max(0, days.length - 1) : value)),
            onBlur: () => setHover(null),
            onKeyDown: (event) => {
              if (!days.length) return;
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                setHover((value) => {
                  const index = value === null ? days.length - 1 : value;
                  const step = event.key === 'ArrowRight' ? 1 : -1;
                  return Math.min(days.length - 1, Math.max(0, index + step));
                });
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                setHover(event.key === 'Home' ? 0 : days.length - 1);
              }
            },
          },
          ticks.map((tick, index) => h('g', { key: index },
            h('line', { x1: pad.l, x2: W - pad.r, y1: y(tick), y2: y(tick), className: 'qdr-chart-grid' }),
            h('text', { x: pad.l - 8, y: y(tick) + 3, textAnchor: 'end', className: 'qdr-chart-axis-label' }, creditsText(tick)))),
          labelIndices.map((index) => h('text', {
            key: index, x: xs[index], y: H - 8, textAnchor: 'middle', className: 'qdr-chart-axis-label',
          }, shortDate(days[index] && days[index].date))),
          groups.map((group, index) => h('path', {
            key: group.key,
            d: chartPath(group.points.map((value, pointIndex) => ({ x: xs[pointIndex], y: y(value) }))),
            className: 'qdr-chart-line',
            style: { stroke: seriesColor(index) },
          })),
          days.length === 1 ? groups.map((group, index) => h('circle', {
            key: `single-${group.key}`, cx: xs[0], cy: y(group.points[0] || 0), r: 3.6,
            className: 'qdr-chart-dot', style: { fill: seriesColor(index) },
          })) : null,
          hoverX !== null ? h('line', {
            x1: hoverX, x2: hoverX, y1: pad.t, y2: H - pad.b, className: 'qdr-chart-guide',
          }) : null,
          hoverX !== null ? groups.map((group, index) => h('circle', {
            key: group.key, cx: hoverX, cy: y(group.points[hover] || 0), r: 3.6,
            className: 'qdr-chart-dot', style: { fill: seriesColor(index) },
          })) : null,
          h('rect', {
            x: pad.l, y: pad.t, width: plotW, height: plotH,
            fill: 'transparent', pointerEvents: 'all',
            onPointerMove: move, onPointerLeave: () => setHover(null),
          })),
          hover !== null && days[hover] ? h('div', {
            className: 'qdr-chart-tooltip',
            style: { left: `${Math.min(82, Math.max(18, ((hoverX || 0) / W) * 100))}%` },
          },
          h('div', { className: 'qdr-chart-tooltip-date' }, rangeDateLabel(days[hover].date)),
          groups.map((group, index) => h('div', { className: 'qdr-chart-tooltip-row', key: group.key },
            h('span', null,
              h('i', { className: 'qdr-chart-tooltip-dot', style: { background: seriesColor(index) } }),
              labelOf(group)),
            h('strong', null, creditsText(group.points[hover] || 0))))) : null,
          data.totals.credits === 0 ? h('div', { className: 'qdr-chart-empty' }, '这个区间没有实际计费 Credits') : null),
        h('div', { className: 'qdr-chart-legend' },
          groups.length ? groups.map((group, index) => h('span', { key: group.key },
            h('i', { className: 'qdr-chart-legend-dot', style: { background: seriesColor(index) } }),
            labelOf(group),
            h('em', null, creditsText(group.credits)))) : h('span', { className: 'qdr-hint' }, '这个区间没有实际计费 Credits（免费模型不计入）')),
        h('div', { className: 'qdr-credits-foot' },
          `按天统计 · ${data.totals.requests} 次请求 · ${compact(data.totals.tokens)} tokens`,
          data.totals.failures ? ` · ${data.totals.failures} 次失败` : '',
          data.totals.savedCredits ? ` · 免费/折扣已省 ${creditsText(data.totals.savedCredits)} Credits` : '',
          ' · 只计上游实际扣费',
          data.updatedAt ? ` · 更新于 ${stamp(data.updatedAt)}` : '',
          partialDataNote(data) ? ` · ${partialDataNote(data)}` : ''));
    }

    function CheckinSummaryCard({ data, busy, onOpen, onRun }) {
      const summary = data && data.summary;
      const current = data && data.accounts ? data.accounts.find((account) => account.current) : null;
      const meta = current ? checkinMeta(current.status) : null;
      const pending = summary ? summary.pending || 0 : 0;
      const notOpen = summary ? summary.notOpen || 0 : 0;
      const waiting = summary ? summary.waiting || 0 : 0;
      const unavailable = summary ? summary.unavailable || 0 : 0;
      const accounts = (data && data.accounts) || [];
      const doneStatuses = new Set(['claimed', 'already']);
      const openAccounts = accounts.filter((account) => !doneStatuses.has(account.status));
      const retryable = openAccounts.some((account) => account.canClaim);
      const canRun = !busy && retryable;
      const actionLabel = busy ? '签到中…'
        : !accounts.length ? '无账号'
          : retryable ? (notOpen && !pending ? '重试活动' : pending ? '立即领取' : '重试签到')
            : waiting ? '10:00 后开放'
              : openAccounts.length && openAccounts.every((account) => account.status === 'unavailable') ? '本期无活动'
                : openAccounts.length ? '需处理' : '今日已领';
      const actionIcon = canRun ? 'gift'
        : openAccounts.length > 0 && !waiting && !openAccounts.every((account) => account.status === 'unavailable') ? 'alert' : 'check';
      return h('div', { className: 'qdr-card qdr-checkin-mini' },
        h('div', { className: 'qdr-card-head' },
          h('div', null,
            h('div', { className: 'qdr-checkin-mini-title' },
              h('div', { className: 'qdr-card-title' }, '每日签到'),
              meta ? h(Badge, { tone: meta.tone }, checkinAccountStatus(current)) : null,
              data ? h(Badge, { tone: data.auto ? 'green' : 'neutral' }, data.auto ? '自动开启' : '自动关闭') : null),
            h('div', { className: 'qdr-card-sub' }, data ? data.window : '正在读取签到状态…')),
          h('div', { className: 'qdr-card-actions' },
            data ? h(Button, {
              size: 'sm', variant: canRun ? 'secondary' : 'ghost',
              icon: actionIcon,
              disabled: !canRun,
              onClick: onRun,
            }, actionLabel) : null,
            h(Button, { size: 'sm', onClick: onOpen }, '去签到'))),
        !data ? h('div', { className: 'qdr-skeleton', style: { marginTop: '10px' } },
          h('div', { className: 'qdr-skel-line qdr-skel-lg' }),
          h('div', { className: 'qdr-skel-line', style: { width: '55%' } }))
          : h(React.Fragment, null,
            h('div', { className: 'qdr-checkin-mini-big' },
              h('strong', null, `${summary.done}/${summary.total}`),
              h('span', null, '个账号今日已处理'),
              summary.credits ? h('em', null, `+${money(summary.credits)} Credits`) : null),
            h(Meter, {
              value: summary.total ? summary.done / summary.total : 0,
              tone: summary.errors ? 'warn' : 'ok',
              label: '今日签到完成度',
            }),
            h('div', { className: 'qdr-checkin-mini-meta' },
              h('span', null, `待领取 ${pending}`),
              notOpen ? h('span', null, `待下发 ${notOpen}`) : null,
              waiting ? h('span', null, `未开放 ${waiting}`) : null,
              unavailable ? h('span', null, `无活动 ${unavailable}`) : null,
              h('span', null, `异常 ${summary.errors}`),
              data.auto
                ? (data.lastAutoAt ? h('span', null, `上次自动 ${stamp(data.lastAutoAt)} · 下次约 ${stamp(data.lastAutoAt + 20 * 60_000)}`) : h('span', null, '尚未自动运行'))
                : h('span', null, '自动签到已关闭'))));
    }

    function CheckinPanel({ data, busy, error, onRun, onToggleAuto, onRefresh, onAccount }) {
      if (!data) {
        return h('div', { className: 'qdr-panel', role: 'tabpanel' },
          error
            ? h(Empty, {
              icon: 'alert', title: '签到状态读取失败', detail: error,
              action: h(Button, { size: 'sm', icon: 'refresh', onClick: onRefresh }, '重试'),
            })
            : h('div', { className: 'qdr-card qdr-skeleton' },
              h('div', { className: 'qdr-skel-line qdr-skel-lg' }),
              h('div', { className: 'qdr-skel-line' }),
              h('div', { className: 'qdr-skel-grid' },
                h('div', { className: 'qdr-skel-box' }), h('div', { className: 'qdr-skel-box' }),
                h('div', { className: 'qdr-skel-box' }), h('div', { className: 'qdr-skel-box' }))));
      }
      const summary = data.summary;
      const accounts = data.accounts || [];
      const pending = summary.pending || 0;
      const notOpen = summary.notOpen || 0;
      const waiting = summary.waiting || 0;
      const unavailable = summary.unavailable || 0;
      const errors = summary.errors || 0;
      const actionable = accounts.some((account) => account.canClaim
        && account.status !== 'claimed' && account.status !== 'already');
      const allDone = accounts.length > 0 && accounts.every((account) => account.status === 'claimed' || account.status === 'already');
      const allSettled = accounts.length > 0 && accounts.every((account) => ['claimed', 'already', 'unavailable'].includes(account.status));
      const actionLabel = busy ? '领取中…'
        : allDone ? '今日已领'
          : actionable ? (notOpen && !pending ? '重试活动' : '立即领取全部')
            : waiting ? '10:00 后开放'
              : errors ? '需处理'
                : allSettled ? '本期无活动' : '暂无可领';
      return h('div', { className: 'qdr-panel', role: 'tabpanel' },
        h('div', { className: 'qdr-card qdr-checkin-hero' },
          h('div', { className: 'qdr-checkin-hero-top' },
            h('div', { className: 'qdr-checkin-icon' }, h(Icon, { name: 'gift', size: 22 })),
            h('div', { className: 'qdr-checkin-copy' },
              h('div', { className: 'qdr-checkin-title' }, '每日签到',
                h(Badge, { tone: data.auto ? 'green' : 'neutral' }, data.auto ? '自动签到已开启' : '自动签到已关闭')),
              h('div', { className: 'qdr-checkin-sub' }, data.window)),
            h('div', { className: 'qdr-checkin-actions' },
              h('button', {
                type: 'button', role: 'switch', 'aria-checked': Boolean(data.auto),
                className: `qdr-switch${data.auto ? ' qdr-switch-on' : ''}`,
                disabled: Boolean(busy) || !data.enabled,
                title: data.enabled ? '每天 10:00 后自动领取本机所有账号' : '自动签到已被 QODER_CHECKIN=0 禁用',
                onClick: onToggleAuto,
              },
              h('span', { className: 'qdr-switch-track' }, h('span', { className: 'qdr-switch-knob' })),
              h('span', { className: 'qdr-switch-label' }, '自动签到')),
              h(Button, { size: 'sm', icon: 'refresh', disabled: Boolean(busy), onClick: onRefresh }, '刷新'),
              h(Button, {
                size: 'sm', variant: actionable ? 'primary' : 'secondary', icon: actionable ? 'gift' : 'check',
                disabled: Boolean(busy) || !accounts.length || !actionable,
                onClick: () => onRun(''),
              }, actionLabel))),
          error ? h('div', { className: 'qdr-banner qdr-banner-error', role: 'alert' },
            h(Icon, { name: 'alert', size: 15 }), h('span', null, error)) : null,
          h('div', { className: 'qdr-checkin-summary' },
            h('div', null, h('span', null, '今日已处理'), h('strong', null, `${summary.done}/${summary.total}`)),
            h('div', null, h('span', null, '今日已领'), h('strong', null, summary.credits ? `+${money(summary.credits)}` : '—'), h('em', null, 'Credits')),
            h('div', null, h('span', null, '待领取'), h('strong', null, pending)),
            h('div', null, h('span', null, '异常'), h('strong', { className: summary.errors ? 'qdr-checkin-bad' : '' }, summary.errors))),
          (notOpen || waiting || unavailable) ? h('div', { className: 'qdr-checkin-lastrun' },
            [notOpen ? `${notOpen} 个账号活动待下发` : '', waiting ? `${waiting} 个账号未到开放时间` : '', unavailable ? `${unavailable} 个账号暂无活动` : '']
              .filter(Boolean).join(' · ')) : null,
          h('div', { className: 'qdr-checkin-devices' },
            h('span', { className: 'qdr-checkin-devices-label' }, '设备身份'),
            ...Object.entries(data.devices || {}).map(([region, device]) => h('span', {
              className: `qdr-checkin-device${device.available ? ' qdr-checkin-device-ok' : ' qdr-checkin-device-bad'}`,
              title: device.reason || '',
            }, h(StatusDot, { tone: device.available ? 'ok' : 'warn' }), `${regionShort(region)} ${device.available ? '就绪' : '不可用'}`))),
          data.lastRunAt ? h('div', { className: 'qdr-checkin-lastrun' }, `最近一次运行：${stamp(data.lastRunAt)}`) : null),
        h('div', { className: 'qdr-card' },
          h('div', { className: 'qdr-card-head' },
            h('div', null,
              h('div', { className: 'qdr-card-title' }, '账号签到状态'),
              h('div', { className: 'qdr-card-sub' }, '每个本机已登录账号都会单独领取；切换账号不会修改官方客户端登录态。')),
            h(Button, { size: 'sm', variant: 'ghost', onClick: onAccount }, '账号管理')),
          accounts.length ? h('div', { className: 'qdr-checkin-list' }, accounts.map((account) => {
            const meta = checkinMeta(account.status);
            const done = account.status === 'claimed' || account.status === 'already';
            const canRun = account.canClaim && !busy && !done;
            return h('div', { className: `qdr-checkin-account${account.current ? ' qdr-checkin-current' : ''}`, key: account.key },
              h('div', { className: 'qdr-checkin-mark' }, (account.label || '?').slice(0, 1).toUpperCase()),
              h('div', { className: 'qdr-checkin-main' },
                h('div', { className: 'qdr-checkin-title' },
                  h('strong', null, account.label),
                  account.current ? h(Badge, { tone: 'green' }, '当前') : null,
                  h(Badge, { tone: account.region === 'cn' ? 'accent' : 'neutral' }, account.regionLabel),
                  h(Badge, { tone: 'neutral' }, account.sourceLabel)),
                h('div', { className: 'qdr-checkin-meta' },
                  account.uidTail ? `uid …${account.uidTail}` : '本机账号',
                  account.expiresAt ? ` · ${dateLabel(account.expiresAt)} 过期` : '',
                  !account.deviceAvailable ? ` · ${account.deviceReason || '设备身份不可用'}` : ''),
                h('div', { className: 'qdr-checkin-status-line' },
                  h(Badge, { tone: meta.tone }, checkinAccountStatus(account)),
                  account.message ? h('span', { className: 'qdr-checkin-message' }, account.message) : null,
                  account.checkedAt ? h('span', { className: 'qdr-checkin-time' }, stamp(account.checkedAt)) : null)),
              !account.tokenReady ? h(Button, {
                size: 'sm', variant: 'secondary', icon: 'key',
                onClick: onAccount, title: account.message || '打开 Qoder 客户端登录后重新扫描',
              }, '去登录')
                : !account.deviceAvailable ? h(Button, {
                  size: 'sm', variant: 'ghost', icon: 'server', disabled: true,
                  title: account.deviceReason || '需要本机 Qoder 客户端的 runtime-info 设备身份',
                }, '需设备')
                  : h(Button, {
                    size: 'sm', variant: canRun ? 'secondary' : 'ghost', icon: 'gift',
                    disabled: !canRun,
                    title: account.message || (done ? '今日已领取' : ''),
                    onClick: () => onRun(account.key),
                  }, done ? '已领'
                    : account.status === 'unavailable' ? '无活动'
                      : account.status === 'waiting' ? '未开放'
                        : ['error', 'device', 'login', 'pending'].includes(account.status) ? '重试' : '领取'));
          })) : h(Empty, {
            icon: 'key', title: '没有检测到本机 Qoder 账号',
            detail: '先在 Qoder 客户端登录；插件会只读扫描本机登录态，多个账号可以分别领取。',
            action: h(Button, { size: 'sm', variant: 'secondary', icon: 'key', onClick: onAccount }, '去账号页'),
          }),
          h('div', { className: 'qdr-foot-note qdr-checkin-note' },
            h(Icon, { name: 'shield', size: 14 }),
            h('span', null, '签到使用本机 Qoder 客户端设备身份（runtime-info），令牌只在本机内存使用；每天 10:00（UTC+8）后开放，DSH 运行期间自动领取。非官方接口，活动变更时会在账号行显示原因。'))) );
    }

    function Panel() {
      const [status, setStatus] = useState(null);
      const [models, setModels] = useState(null);
      const [usage, setUsage] = useState(null);
      const [diagnostics, setDiagnostics] = useState(null);
      const [accountData, setAccountData] = useState(null);
      const [tab, setTab] = useTabs('overview');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [statusError, setStatusError] = useState('');
      const [modelsError, setModelsError] = useState('');
      const [usageError, setUsageError] = useState('');
      const [creditsError, setCreditsError] = useState('');
      const [diagnosticsError, setDiagnosticsError] = useState('');
      const [notice, setNotice] = useState(null);
      const [versionBannerClosed, setVersionBannerClosed] = useState(false);
      const [search, setSearch] = useState('');
      const [filter, setFilter] = useState('all');
      const [draftVisible, setDraftVisible] = useState(null);
      const [draftPinned, setDraftPinned] = useState('');
      const [dirty, setDirty] = useState(false);
      const [region, setRegion] = useState('global');
      const [device, setDevice] = useState(null);
      const [pat, setPat] = useState('');
      const [patError, setPatError] = useState('');
      const [showPat, setShowPat] = useState(false);
      const [dark, setDark] = useState(false);
      const [savedContext, setSavedContext] = useState({});
      const [savedParams, setSavedParams] = useState({});
      const [expanded, setExpanded] = useState('');
      const [editorDirty, setEditorDirty] = useState(false);
      const [modelBusy, setModelBusy] = useState('');
      const [modelError, setModelError] = useState(null);
      const [usageDays, setUsageDays] = useState(14);
      const [usageFilter, setUsageFilter] = useState('all');
      const [usageBusy, setUsageBusy] = useState(false);
      const [trialModel, setTrialModel] = useState('');
      const [trialSeq, setTrialSeq] = useState(0);
      const [accountBusy, setAccountBusy] = useState(true);
      const [checkin, setCheckin] = useState(null);
      const [checkinBusy, setCheckinBusy] = useState(false);
      const [checkinError, setCheckinError] = useState('');
      const [switcherOpen, setSwitcherOpen] = useState(false);
      const [tabPill, setTabPill] = useState({ left: 0, width: 0, ready: false });
      const tabsRef = useRef(null);
      const tabRefs = useRef({});
      const stageRef = useRef(null);
      const [credits, setCredits] = useState(null);
      const [creditsRange, setCreditsRange] = useState('7d');
      const [creditsMode, setCreditsMode] = useState('all');
      const [creditsBusy, setCreditsBusy] = useState(false);
      const authKey = useRef('');
      const dirtyRef = useRef(false);
      const noticeTimer = useRef(null);
      const creditsSeq = useRef(0);
      const usageSeq = useRef(0);
      const accountSeq = useRef(0);
      const modelsSeq = useRef(0);
      const statusSeq = useRef(0);
      const checkinSeq = useRef(0);
      const diagnosticsSeq = useRef(0);
      const mounted = useRef(true);

      useLayoutEffect(() => {
        const measure = () => {
          const box = tabsRef.current;
          const node = tabRefs.current[tab];
          if (!box || !node) return;
          const boxRect = box.getBoundingClientRect();
          const nodeRect = node.getBoundingClientRect();
          const left = Math.max(0, nodeRect.left - boxRect.left - box.clientLeft);
          setTabPill((previous) => (
            Math.abs(previous.left - left) < 0.5
            && Math.abs(previous.width - nodeRect.width) < 0.5
            && previous.ready
              ? previous
              : { left, width: nodeRect.width, ready: true }
          ));
        };
        let cancelled = false;
        measure();
        const raf = requestAnimationFrame(measure);
        const timer = setTimeout(measure, 90);
        let observer = null;
        if (typeof ResizeObserver === 'function' && tabsRef.current) {
          observer = new ResizeObserver(() => { if (!cancelled) measure(); });
          observer.observe(tabsRef.current);
          for (const node of Object.values(tabRefs.current)) {
            if (node) observer.observe(node);
          }
        }
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => { if (!cancelled) measure(); }).catch(() => {});
        }
        window.addEventListener('resize', measure);
        return () => {
          cancelled = true;
          cancelAnimationFrame(raf);
          clearTimeout(timer);
          if (observer) observer.disconnect();
          window.removeEventListener('resize', measure);
        };
      }, [tab]);

      useLayoutEffect(() => {
        const node = stageRef.current;
        if (!node) return;
        // 不卸载面板（试跑输入/结果需要保留），只用一次短动画做切页过渡。
        node.classList.remove('qdr-stage-anim');
        void node.offsetWidth;
        node.classList.add('qdr-stage-anim');
      }, [tab]);

      useEffect(() => {
        const read = () => {
          try {
            const html = getComputedStyle(document.documentElement).colorScheme || '';
            const body = getComputedStyle(document.body).colorScheme || '';
            const system = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            setDark(html.includes('dark') || body.includes('dark') || (!html && !body && system));
          } catch { /* keep current */ }
        };
        read();
        let observer = null;
        if (typeof MutationObserver === 'function') {
          observer = new MutationObserver(read);
          for (const node of [document.documentElement, document.body]) {
            if (node) observer.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
          }
        }
        const query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        if (query && typeof query.addEventListener === 'function') query.addEventListener('change', read);
        return () => {
          if (observer) observer.disconnect();
          if (query && typeof query.removeEventListener === 'function') query.removeEventListener('change', read);
        };
      }, []);
      useEffect(() => () => {
        mounted.current = false;
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
      }, []);
      dirtyRef.current = dirty;

      const showNotice = useCallback((tone, text) => {
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        setNotice({ tone, text });
        noticeTimer.current = setTimeout(() => { if (mounted.current) setNotice(null); }, 6000);
      }, []);

      const notifyAuth = useCallback(() => {
        try { window.dispatchEvent(new CustomEvent('qoder:auth-changed')); } catch { /* older webview */ }
      }, []);

      const syncDrafts = useCallback((data) => {
        if (!data) return;
        const prefs = data.prefs || {};
        setSavedContext(prefs.contextWindowByModel || {});
        setSavedParams(prefs.paramsByModel || {});
        if (dirtyRef.current) return;
        setDraftVisible(Array.isArray(prefs.visible) ? prefs.visible.slice() : null);
        setDraftPinned(prefs.pinned || '');
        setDirty(false);
      }, []);

      const loadModels = useCallback(async (refresh) => {
        const seq = ++modelsSeq.current;
        try {
          const data = await getJson('/qoder/models' + (refresh ? '?refresh=1' : ''), refresh ? { panel: true } : undefined);
          if (!mounted.current || seq !== modelsSeq.current) return;
          setModels(data.models || []);
          setModelsError('');
          if (data.error && !/尚未登录|未登录/.test(String(data.error))) setError(data.error);
        } catch (err) {
          if (!mounted.current || seq !== modelsSeq.current) return;
          const message = String(err.message || err);
          setModels((previous) => previous || []);
          setModelsError(message);
          if (!/尚未登录|未登录/.test(message)) setError(message);
        }
      }, []);

      const loadStatus = useCallback(async (deep, rescan = false) => {
        const seq = ++statusSeq.current;
        try {
          const params = [];
          if (deep) params.push('deep=1');
          if (rescan) params.push('rescan=1');
          const data = await getJson(
            '/qoder/status' + (params.length ? `?${params.join('&')}` : ''),
            { ...(deep ? { timeoutMs: DEEP_TIMEOUT_MS } : {}), ...(deep || rescan ? { panel: true } : {}) },
          );
          if (!mounted.current || seq !== statusSeq.current) return;
          setStatus(data);
          setStatusError('');
          setError('');
          syncDrafts(data);
          const key = `${data.signedIn}:${data.region}:${data.account && data.account.uid}`;
          if (key !== authKey.current) {
            authKey.current = key;
            setRegion(data.region || 'global');
            if (data.signedIn) loadModels(false);
          }
        } catch (err) {
          if (!mounted.current || seq !== statusSeq.current) return;
          const message = String(err.message || err);
          setStatusError(message);
          setError(message);
        }
      }, [loadModels, syncDrafts]);

      useEffect(() => {
        // /models 有进程内缓存与单飞；与 status 并行，别让桌面端账号扫描挡住模型首屏。
        loadStatus(false);
        loadModels(false);
      }, [loadStatus, loadModels]);
      // 深度刷新期间暂停浅轮询：后者会递增 statusSeq，把更完整的深刷新结果直接作废。
      useVisibilityPoll(() => { if (busy !== 'status') loadStatus(false); }, 25_000);

      const loadUsage = useCallback(async (days, silent = false) => {
        const seq = ++usageSeq.current;
        if (!silent) setUsageBusy(true);
        if (!silent) setUsageError('');
        try {
          const data = await getJson(`/qoder/usage?days=${days}`);
          if (!mounted.current || seq !== usageSeq.current) return;
          setUsage(data);
          setUsageError('');
        } catch (err) {
          if (!mounted.current || seq !== usageSeq.current) return;
          const message = String(err.message || err);
          if (!silent) {
            setUsageError(message);
            setError(message);
          }
        } finally {
          if (mounted.current && seq === usageSeq.current) setUsageBusy(false);
        }
      }, []);

      const loadAccount = useCallback(async () => {
        const seq = ++accountSeq.current;
        setAccountBusy(true);
        try {
          const data = await getJson('/qoder/account');
          if (!mounted.current || seq !== accountSeq.current) return;
          setAccountData(data);
          try { window.dispatchEvent(new CustomEvent('qoder:quota-changed', { detail: { extras: data.extras } })); } catch { /* older webview */ }
        } catch (err) {
          if (mounted.current && seq === accountSeq.current) setError(String(err.message || err));
        } finally {
          if (mounted.current && seq === accountSeq.current) setAccountBusy(false);
        }
      }, []);

      const loadCredits = useCallback(async (range) => {
        const seq = ++creditsSeq.current;
        setCreditsBusy(true);
        setCreditsError('');
        try {
          const data = await getJson(`/qoder/credits?range=${encodeURIComponent(range)}`);
          if (!mounted.current || seq !== creditsSeq.current) return;
          setCredits(data);
        } catch (err) {
          if (!mounted.current || seq !== creditsSeq.current) return;
          const message = String(err.message || err);
          setCreditsError(message);
          setError(message);
        } finally {
          if (mounted.current && seq === creditsSeq.current) setCreditsBusy(false);
        }
      }, []);

      const loadCheckin = useCallback(async (silent = false) => {
        const seq = ++checkinSeq.current;
        if (!silent) setCheckinBusy(true);
        if (!silent) setCheckinError('');
        try {
          const data = await getJson('/qoder/checkin');
          if (mounted.current && seq === checkinSeq.current) setCheckin(data);
        } catch (err) {
          if (!silent && mounted.current && seq === checkinSeq.current) setCheckinError(String(err.message || err));
        } finally {
          if (!silent && mounted.current && seq === checkinSeq.current) setCheckinBusy(false);
        }
      }, []);

      const runCheckin = async (key = '') => {
        if (checkinBusy) return;
        setCheckinBusy(true);
        setCheckinError('');
        try {
          const data = await postJson('/qoder/checkin/run', { key: String(key || '') }, { timeoutMs: DEEP_TIMEOUT_MS });
          if (!mounted.current) return;
          setCheckin(data);
          if (data.ok === false) {
            const text = data.error || '签到失败，请刷新后重试';
            if (tab === 'checkin') setCheckinError(text);
            else showNotice('error', text);
            await loadCheckin(true);
            return;
          }
          const notice = checkinNotice(data, String(key || ''));
          if (notice) {
            if (notice.tone === 'error') {
              if (tab === 'checkin') setCheckinError(notice.text);
              else showNotice('error', notice.text);
            } else {
              showNotice('ok', notice.text);
            }
          }
          await loadAccount();
          await loadStatus(false);
        } catch (err) {
          if (mounted.current) {
            const text = String(err.message || err);
            if (tab === 'checkin') setCheckinError(text);
            else showNotice('error', `签到失败：${text}`);
          }
        } finally {
          if (mounted.current) setCheckinBusy(false);
        }
      };

      const toggleCheckinAuto = async () => {
        if (checkinBusy || !checkin) return;
        setCheckinBusy(true);
        try {
          const data = await postJson('/qoder/checkin/config', { auto: !checkin.auto });
          if (!mounted.current) return;
          setCheckin(data);
          showNotice('ok', data.autoConfigured ? '自动签到已开启。' : '自动签到已关闭。');
        } catch (err) {
          if (mounted.current) setCheckinError(String(err.message || err));
        } finally {
          if (mounted.current) setCheckinBusy(false);
        }
      };

      // 天窗口和 Credits 区间互不影响：切 7/14/30 天不该顺带重读整年热力图，
      // 切换 Credits 区间也不该刷掉下方的逐条请求列表。
      useEffect(() => {
        if (tab === 'usage') loadUsage(usageDays);
      }, [tab, usageDays, loadUsage]);

      useEffect(() => {
        if (tab === 'usage') loadCredits(creditsRange);
      }, [tab, creditsRange, loadCredits]);

      useVisibilityPoll(() => loadUsage(usageDays, true), 30_000, tab === 'usage');

      const loadDiagnostics = useCallback(async () => {
        const seq = ++diagnosticsSeq.current;
        setDiagnosticsError('');
        try {
          const data = await getJson('/qoder/diagnostics', { timeoutMs: DEEP_TIMEOUT_MS, panel: true });
          if (!mounted.current || seq !== diagnosticsSeq.current) return;
          setDiagnostics(data);
        } catch (err) {
          if (!mounted.current || seq !== diagnosticsSeq.current) return;
          setDiagnosticsError(String(err.message || err));
        }
      }, []);

      useEffect(() => {
        if (tab === 'diagnose' && !diagnostics && !diagnosticsError) loadDiagnostics();
      }, [tab, diagnostics, diagnosticsError, loadDiagnostics]);

      useEffect(() => {
        if (!status || !status.signedIn) return;
        if (tab !== 'account' && tab !== 'overview') return;
        if (!accountData) loadAccount();
      }, [tab, status && status.signedIn, accountData, loadAccount]);
      useVisibilityPoll(loadAccount, 120_000, Boolean(status && status.signedIn) && (tab === 'account' || tab === 'overview'));

      useEffect(() => {
        const onAuth = () => {
          authKey.current = '';
          statusSeq.current += 1;
          modelsSeq.current += 1;
          checkinSeq.current += 1;
          diagnosticsSeq.current += 1;
          usageSeq.current += 1;
          creditsSeq.current += 1;
          accountSeq.current += 1;
          setDevice(null);
          setStatus(null);
          setModels([]);
          setTrialModel('');
          setUsage(null);
          setCredits(null);
          setAccountData(null);
          setCheckin(null);
          setDiagnostics(null);
          setDiagnosticsError('');
          setCheckinError('');
          setUsageError('');
          setCreditsError('');
          setModelsError('');
          // 序号递增会让旧账号的在途请求在 finally 里直接返回；不清 busy 的话
          // 账号/用量页会一直停在“读取中”，按钮也一直禁用。
          setAccountBusy(false);
          setUsageBusy(false);
          setCreditsBusy(false);
          setModelBusy('');
          setSwitcherOpen(false);
          setExpanded('');
          setEditorDirty(false);
          setPatError('');
          setModelError(null);
          setSearch('');
          setFilter('all');
          setUsageFilter('all');
          setUsageDays(14);
          setTrialSeq((seq) => seq + 1);
          dirtyRef.current = false;
          setDirty(false);
          setDraftVisible(null);
          setDraftPinned('');
          loadStatus(false);
          loadModels(false);
          loadCheckin(true);
          if (tab === 'usage') {
            loadUsage(14);
            loadCredits(creditsRange);
          }
        };
        window.addEventListener('qoder:auth-changed', onAuth);
        return () => window.removeEventListener('qoder:auth-changed', onAuth);
      }, [loadStatus, loadModels, loadCheckin, loadUsage, loadCredits, tab, creditsRange]);

      useEffect(() => {
        if (tab !== 'checkin' && tab !== 'account' && !(tab === 'overview' && status && status.signedIn)) return;
        loadCheckin(Boolean(checkin));
        // checkin 只决定首次是否静默，进入页签时仍会主动刷新。
      }, [tab, status && status.signedIn, loadCheckin]); // eslint-disable-line react-hooks/exhaustive-deps
      useVisibilityPoll(() => loadCheckin(true), 30_000, tab === 'checkin' || tab === 'account' || (tab === 'overview' && Boolean(status && status.signedIn)));

      useEffect(() => {
        if (!switcherOpen) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') setSwitcherOpen(false); };
        const onPointer = (event) => {
          const target = event.target;
          if (target && typeof target.closest === 'function'
            && !target.closest('.qdr-account-strip') && !target.closest('.qdr-account-menu')) {
            setSwitcherOpen(false);
          }
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onPointer);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onPointer);
        };
      }, [switcherOpen]);

      useEffect(() => {
        if (!device || !device.id) return undefined;
        let settled = false;
        let polling = false;
        const timer = setInterval(async () => {
          if (polling || settled) return;
          polling = true;
          try {
            const result = await postJson('/qoder/auth/poll', { id: device.id });
            if (!mounted.current || settled) return;
            if (result.status === 'ready') {
              settled = true;
              setDevice(null);
              showNotice('ok', '登录成功，模型目录已刷新。');
              notifyAuth();
            } else if (result.status === 'expired' || result.status === 'error' || result.ok === false) {
              settled = true;
              setDevice(null);
              setError(result.error || result.message || '授权失败，请重试');
            } else {
              setDevice((prev) => (prev ? { ...prev, message: result.message || '等待浏览器完成授权' } : prev));
            }
          } catch (err) {
            if (!mounted.current || settled) return;
            // 网络抖动或网关 5xx 不代表授权失效，保留会话继续轮询。
            if (!err.status || err.status >= 500) {
              setDevice((prev) => (prev ? { ...prev, message: '网络波动，正在重试授权状态…' } : prev));
              return;
            }
            settled = true;
            setDevice(null);
            setError(String(err.message || err));
          } finally {
            polling = false;
          }
        }, 2200);
        return () => { settled = true; clearInterval(timer); };
      }, [device && device.id, notifyAuth, showNotice]);

      const run = async (label, action) => {
        setBusy(label);
        setError('');
        try { await action(); } catch (err) { setError(String(err.message || err)); } finally { if (mounted.current) setBusy(''); }
      };

      const startDevice = (targetRegion) => run('device', async () => {
        const result = await postJson('/qoder/auth/device', { region: targetRegion });
        if (!result.ok) throw new Error(result.error || '发起授权失败');
        const started = { id: result.id, verificationUri: result.verificationUri, expiresAt: Date.now() + num(result.expiresIn || 600) * 1000, message: '等待浏览器完成授权' };
        let opened = null;
        try { opened = window.open(result.verificationUri, '_blank', 'noopener,noreferrer'); } catch { /* link is still shown */ }
        if (!opened) started.message = '浏览器拦截了新窗口，请点上方链接继续授权。';
        setDevice(started);
      });

      const importDesktop = (candidate) => {
        run('desktop', async () => {
          const result = await postJson('/qoder/auth/import-desktop', {
            region: candidate.region || '',
            uid: candidate.uid || '',
            kind: candidate.kind || '',
            file: candidate.file || '',
          });
          if (!result.ok) throw new Error(result.error || '导入失败');
          setSwitcherOpen(false);
          showNotice('ok', `已切换到 ${result.account && (result.account.name || result.account.uid) || '本机账号'}`);
          notifyAuth();
        });
      };

      const submitPat = async () => {
        if (busy === 'pat') return;
        setBusy('pat');
        setError('');
        setPatError('');
        try {
          if (!pat.trim()) throw new Error('请先粘贴 PAT 或访问令牌');
          const result = await postJson('/qoder/auth/pat', { token: pat.trim(), region });
          if (!result.ok) throw new Error(result.error || 'PAT 登录失败');
          setPat('');
          setShowPat(false);
          showNotice('ok', '登录成功，模型目录已刷新。');
          notifyAuth();
        } catch (err) {
          if (mounted.current) setPatError(String(err.message || err));
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const logout = () => {
        if (!window.confirm('退出 Qoder？\n这会删除本机保存的加密凭据，但不会影响 Qoder 官方客户端的登录。')) return;
        run('logout', async () => {
          await postJson('/qoder/auth/logout');
          setDevice(null);
          setModels([]);
          setUsage(null);
          setAccountData(null);
          setDiagnostics(null);
          showNotice('ok', '已退出 Qoder。');
          notifyAuth();
        });
      };

      const savePrefs = () => run('prefs', async () => {
        const result = await postJson('/qoder/prefs', {
          visible: draftVisible,
          pinned: draftPinned,
          includeAll: true,
        });
        setDirty(false);
        const prefs = result.prefs || {};
        setDraftVisible(Array.isArray(prefs.visible) ? prefs.visible.slice() : null);
        setDraftPinned(prefs.pinned || '');
        setSavedContext(prefs.contextWindowByModel || savedContext);
        setSavedParams(prefs.paramsByModel || savedParams);
        showNotice('ok', settingsNotice(result.notified, 'display'));
        // 选择器里的“默认/可见”来自 /qoder/models，只刷新 status 会让旧标记留到下次打开页面。
        await loadModels(false);
        await loadStatus(false);
      });

      const saveModelParams = async (model, next) => {
        if (modelBusy) return;
        setModelBusy(model.id);
        setModelError(null);
        try {
          const contextWindowByModel = { ...savedContext };
          if (Number(next.contextWindow) > 0) contextWindowByModel[model.id] = Number(next.contextWindow);
          else delete contextWindowByModel[model.id];
          const paramsByModel = { ...savedParams };
          if (next.params && Object.keys(next.params).length) paramsByModel[model.id] = next.params;
          else delete paramsByModel[model.id];
          const result = await postJson('/qoder/prefs', { contextWindowByModel, paramsByModel });
          const prefs = result.prefs || {};
          setSavedContext(prefs.contextWindowByModel || {});
          setSavedParams(prefs.paramsByModel || {});
          await loadModels(false);
          await loadStatus(false);
          showNotice('ok', settingsNotice(result.notified, 'params'));
        } catch (err) {
          if (mounted.current) setModelError({ id: model.id, message: String(err.message || err) });
        } finally {
          if (mounted.current) setModelBusy('');
        }
      };

      const resetModelParams = async (model) => {
        if (modelBusy) return;
        if (!window.confirm(`把 ${model.name} 的上下文、温度和最大输出恢复为官方默认？`)) return;
        setModelBusy(model.id);
        setModelError(null);
        try {
          const contextWindowByModel = { ...savedContext };
          delete contextWindowByModel[model.id];
          const paramsByModel = { ...savedParams };
          delete paramsByModel[model.id];
          const result = await postJson('/qoder/prefs', { contextWindowByModel, paramsByModel });
          const prefs = result.prefs || {};
          setSavedContext(prefs.contextWindowByModel || {});
          setSavedParams(prefs.paramsByModel || {});
          await loadModels(false);
          await loadStatus(false);
          showNotice('ok', `${model.name} 已恢复官方默认参数。`);
        } catch (err) {
          if (mounted.current) setModelError({ id: model.id, message: String(err.message || err) });
        } finally {
          if (mounted.current) setModelBusy('');
        }
      };

      const refreshModels = () => run('catalog', async () => {
        const result = await postJson('/qoder/catalog/refresh');
        await loadModels(true);
        await loadStatus(false);
        if (result.error) showNotice('error', `目录刷新失败，继续使用缓存：${result.error}`);
        else showNotice('ok', '模型目录已刷新。');
      });

      const handleEditorDirty = useCallback((dirty) => setEditorDirty(Boolean(dirty)), []);

      const changeTab = (id) => {
        if (id === tab) return;
        if (tab === 'models' && (editorDirty || dirty)) {
          const message = editorDirty && dirty
            ? '模型参数和显示设置都还没有保存，切换页签会丢失这些修改。继续？'
            : editorDirty
              ? '模型参数还没有保存，切换页签会丢失这些修改。继续？'
              : '显示设置还没有保存，切换页签会丢失这些修改。继续？';
          if (!window.confirm(message)) return;
          setEditorDirty(false);
          if (dirty) {
            dirtyRef.current = false;
            syncDrafts(status);
            setDirty(false);
          }
        }
        setTab(id);
      };

      const goTrial = (model) => {
        if (editorDirty && !window.confirm('模型参数还没有保存，去试跑会丢失这些修改。继续？')) return;
        setEditorDirty(false);
        const available = (models || []).filter((item) => effectivelyVisible(item));
        const target = model && model.id ? model.id
          : (draftPinned || (available[0] && available[0].id) || (models && models[0] && models[0].id) || '');
        setTrialModel(target);
        setTrialSeq((seq) => seq + 1);
        setTab('trial');
      };

      const clearUsage = () => {
        if (!window.confirm('清空本地用量记录？\n只删除 token/延迟统计，不影响 Qoder 账号和模型。')) return;
        run('clear', async () => {
          await postJson('/qoder/usage/clear');
          setUsage(null);
          setCredits(null);
          await loadStatus(false);
          await loadCredits(creditsRange);
          showNotice('ok', '本地用量记录已清空。');
        });
      };

      const copy = async (text, label) => {
        try { await navigator.clipboard.writeText(text); showNotice('ok', `${label || '内容'}已复制`); }
        catch { showNotice('error', '复制失败，请手动选择文本'); }
      };

      const visibleSet = draftVisible === null ? null : new Set(draftVisible);
      const isVisible = useCallback((model) => (visibleSet === null ? true : visibleSet.has(model.id)), [draftVisible]);

      const toggleModel = (model) => {
        const all = (models || []).map((item) => item.id);
        let next;
        if (visibleSet === null) next = all.filter((id) => id !== model.id);
        else if (visibleSet.has(model.id)) next = [...visibleSet].filter((id) => id !== model.id);
        else next = [...visibleSet, model.id];
        setDraftVisible(next);
        setDirty(true);
      };

      const selectAll = () => { setDraftVisible(null); setDirty(true); };
      const selectNone = () => { setDraftVisible([]); setDirty(true); };

      const customizedIds = useMemo(() => new Set([
        ...Object.keys(savedContext || {}),
        ...Object.keys(savedParams || {}),
      ]), [savedContext, savedParams]);

      const effectivelyVisible = useCallback(
        (model) => isVisible(model) || draftPinned === model.id,
        [isVisible, draftPinned],
      );

      const filtered = useMemo(() => {
        const query = search.trim().toLowerCase();
        const list = (models || []).filter((model) => {
          if (query && !`${model.id} ${model.name} ${model.vendor || ''}`.toLowerCase().includes(query)) return false;
          if (filter === 'visible') return effectivelyVisible(model);
          if (filter === 'reasoning') return model.supportsReasoning;
          if (filter === 'free') return model.free;
          if (filter === 'custom') return customizedIds.has(model.id);
          if (filter === 'context') return (model.contextWindowOptions || []).length > 1;
          return true;
        });
        const matched = list.length;
        // 正在编辑的行不能因为搜索/筛选消失：那会把未保存的草稿一起卸载。
        const open = (models || []).find((model) => model.id === expanded);
        if (open && !list.some((model) => model.id === open.id)) list.unshift(open);
        return { items: list, matched };
      }, [models, search, filter, effectivelyVisible, customizedIds, expanded]);

      const signedIn = Boolean(status && status.signedIn);
      const versionText = status ? versionNotice(status.version, status.installedVersion) : '';
      const credentialProtection = (status && status.config && status.config.credentialProtection) || '本机密钥';
      const today = (status && status.usage && status.usage.today) || {};
      const usageSummary = usage && usage.summary;
      const usageTotals = (usageSummary && usageSummary.totals) || null;
      const usageByModel = (usageSummary && usageSummary.byModel) || [];
      const usageDayBuckets = (usageSummary && usageSummary.days) || [];
      const recentAll = (usage && usage.recent) || [];
      const recent = usageFilter === 'all' ? recentAll
        : usageFilter === 'failed' ? recentAll.filter((item) => !item.ok)
          : recentAll.filter((item) => item.ok);
      const recentShown = recent.slice(0, 40);
      const modelLabel = useCallback((id) => {
        const hit = (models || []).find((model) => model.id === id);
        return hit ? hit.name : (id || '未知模型');
      }, [models]);
      const checkinForAccount = useCallback((region, uid) => {
        if (!checkin) return null;
        const tail = uid ? String(uid).slice(-6) : '';
        return checkin.accounts.find((account) => account.region === region
          && (!tail || account.uidTail === tail)) || null;
      }, [checkin]);
      const checkinForCandidate = useCallback(
        (candidate) => (candidate ? checkinForAccount(candidate.region, candidate.uid) : null),
        [checkinForAccount],
      );
      const desktopCandidates = (status && status.desktop && status.desktop.candidates) || [];
      const localAccounts = useMemo(() => {
        const map = new Map();
        for (const candidate of desktopCandidates.filter((item) => item.valid)) {
          const key = `${candidate.region}:${candidate.uid || candidate.file}`;
          const previous = map.get(key);
          const prefer = !previous
            || (candidate.kind === 'app' && previous.kind !== 'app')
            || (candidate.kind === previous.kind && (candidate.expiresAt || 0) > (previous.expiresAt || 0));
          if (prefer) map.set(key, candidate);
        }
        return [...map.values()];
      }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
      const extras = (accountData && accountData.extras) || (status && status.extras) || null;
      const planLabel = (() => {
        const plan = extras && extras.plan;
        if (!plan) return '';
        return String(plan.plan_tier_name || plan.planName || plan.name || plan.user_type || '') || '';
      })();
      const quotaInfo = quotaSummary(extras);
      const quotaText = quotaInfo && quotaInfo.total
        ? `${money(quotaInfo.remaining)} / ${money(quotaInfo.total)}`
        : '';
      const identity = accountIdentityNote(status && status.account, localAccounts);

      const accountRows = useMemo(() => {
        const rows = [];
        const seen = new Set();
        if (status && status.signedIn && status.account) {
          const uid = String(status.account.uid || '');
          const key = `${status.region}:${uid || 'current'}`;
          seen.add(key);
          rows.push({
            key,
            region: status.region,
            regionLabel: status.regionLabel,
            uid,
            name: status.account.name || status.account.email || 'Qoder 账号',
            email: status.account.email || '',
            sourceLabel: status.account.sourceLabel || '本机登录',
            expiresAt: status.token && status.token.expiresAt || 0,
            expiresLabel: status.token && status.token.expiresLabel || '',
            tokenNeedsRefresh: Boolean(status.token && status.token.needsRefresh),
            planLabel,
            current: true,
            candidate: null,
          });
        }
        for (const candidate of localAccounts) {
          const uid = String(candidate.uid || '');
          const key = `${candidate.region}:${uid || candidate.file || candidate.kind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({
            key,
            region: candidate.region,
            regionLabel: candidate.regionLabel || regionShort(candidate.region),
            uid,
            name: candidate.nickname || candidate.email || uid || '未命名账号',
            email: candidate.email || '',
            sourceLabel: candidate.kind === 'app' ? '桌面端' : 'CLI',
            expiresAt: candidate.expiresAt || 0,
            expiresLabel: '',
            planLabel: '',
            current: false,
            candidate,
          });
        }
        return rows;
      }, [status, localAccounts, planLabel]);

      const tabs = [
        ['overview', '概览'],
        ['checkin', '签到'],
        ['models', '模型'],
        ['trial', '试跑'],
        ['usage', '用量'],
        ['account', '账号'],
        ['diagnose', '诊断'],
      ];

      const onTabKeyDown = (event) => {
        const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const index = tabs.findIndex(([id]) => id === tab);
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        const id = tabs[next][0];
        changeTab(id);
        requestAnimationFrame(() => {
          const node = tabRefs.current[id];
          if (node) node.focus();
        });
      };

      const pageError = error ? h('div', { className: 'qdr-banner qdr-banner-error', role: 'alert' },
        h(Icon, { name: 'alert', size: 15 }),
        h('span', null, error),
        h('button', { type: 'button', className: 'qdr-banner-x', onClick: () => setError(''), 'aria-label': '关闭错误' }, h(Icon, { name: 'close', size: 13 }))) : null;
      const pageNotice = notice ? h('div', { className: `qdr-banner qdr-banner-${notice.tone === 'error' ? 'error' : 'ok'}`, role: notice.tone === 'error' ? 'alert' : 'status' },
        h(Icon, { name: notice.tone === 'error' ? 'alert' : 'check', size: 15 }),
        h('span', null, notice.text),
        h('button', { type: 'button', className: 'qdr-banner-x', onClick: () => setNotice(null), 'aria-label': '关闭提示' }, h(Icon, { name: 'close', size: 13 }))) : null;

      return h('div', { className: `qdr-root ${dark ? 'qdr-dark' : 'qdr-light'}` },
        h('div', { className: 'qdr-head' },
          h('div', { className: 'qdr-logo' }, 'Q'),
          h('div', { className: 'qdr-head-main' },
            h('div', { className: 'qdr-title-row' },
              h('h2', { className: 'qdr-title' }, 'Qoder'),
              h('span', { className: `qdr-pill ${signedIn ? 'qdr-pill-ok' : ''}` },
                h(StatusDot, { tone: !status ? 'neutral' : signedIn ? 'ok' : 'neutral' }),
                !status ? '连接中…' : signedIn ? '已连接' : '未登录')),
            h('div', { className: 'qdr-subtitle' }, 'DeepSeek Harness 原生接入 · 单进程 · 无额外端口')),
          h('div', { className: 'qdr-head-actions' },
            h('button', { type: 'button', className: 'qdr-icon-btn', title: '刷新状态', onClick: () => run('status', () => loadStatus(true)), disabled: busy === 'status' }, h(Icon, { name: 'refresh', size: 15 })))),
        pageError,
        pageNotice,
        versionText && !versionBannerClosed ? h('div', { className: 'qdr-banner qdr-banner-warn', role: 'status' },
          h(Icon, { name: 'alert', size: 15 }),
          h('span', null, versionText),
          h('button', { type: 'button', className: 'qdr-banner-x', onClick: () => setVersionBannerClosed(true), 'aria-label': '关闭版本提示' }, h(Icon, { name: 'close', size: 13 }))) : null,

        !status ? (statusError
          ? h(Empty, {
            icon: 'alert', title: '无法读取 Qoder 状态', detail: statusError,
            action: h(Button, { variant: 'primary', icon: 'refresh', disabled: busy === 'status-retry', onClick: () => run('status-retry', () => loadStatus(false)) }, '重试'),
          })
          : h('div', { className: 'qdr-card qdr-skeleton' },
            h('div', { className: 'qdr-skel-line qdr-skel-lg' }),
            h('div', { className: 'qdr-skel-line' }),
            h('div', { className: 'qdr-skel-grid' },
              h('div', { className: 'qdr-skel-box' }), h('div', { className: 'qdr-skel-box' }), h('div', { className: 'qdr-skel-box' }), h('div', { className: 'qdr-skel-box' })))) : null,

        status && !signedIn ? h('div', { className: 'qdr-signin' },
          h('div', { className: 'qdr-signin-mark' }, h(Icon, { name: 'bolt', size: 20 })),
          h('div', { className: 'qdr-signin-main' },
            h('div', { className: 'qdr-signin-title' }, '把 Qoder 的模型接进 dsh'),
            h('div', { className: 'qdr-signin-sub' }, `优先导入本机 Qoder 已登录账号；也可以使用浏览器授权或 PAT。凭据只保存在本机（${credentialProtection} 加密）。`),
            h('div', { className: 'qdr-signin-actions' },
              localAccounts.length ? h(Button, {
                variant: 'primary', icon: 'key', disabled: Boolean(busy),
                onClick: () => importDesktop(localAccounts[0]),
              }, '使用本机 Qoder 登录') : null,
              h(Button, { variant: localAccounts.length ? 'secondary' : 'primary', icon: 'external', disabled: Boolean(busy), onClick: () => startDevice(region) }, '浏览器授权'),
              h(Button, { variant: 'ghost', icon: 'key', onClick: () => { setShowPat(true); setTab('account'); } }, '使用 PAT'))),
          h('div', { className: 'qdr-signin-aside' },
            h('div', { className: 'qdr-mini' }, h(Icon, { name: 'lock', size: 14 }), '令牌不会离开本机'),
            h('div', { className: 'qdr-mini' }, h(Icon, { name: 'server', size: 14 }), '不需要启动第二个服务'),
            h('div', { className: 'qdr-mini' }, h(Icon, { name: 'chip', size: 14 }), '原生 provider=qoder'))) : null,

        h('div', { className: 'qdr-tabs', role: 'tablist', 'aria-label': 'Qoder 面板', ref: tabsRef, onKeyDown: onTabKeyDown },
          h('span', {
            className: `qdr-tab-pill${tabPill.ready ? ' qdr-tab-pill-ready' : ''}`,
            'aria-hidden': 'true',
            style: { width: `${tabPill.width}px`, transform: `translateX(${tabPill.left}px)` },
          }),
          tabs.map(([id, label]) => h('button', {
            key: id, type: 'button', role: 'tab', 'aria-selected': tab === id,
            tabIndex: tab === id ? 0 : -1,
            ref: (node) => { tabRefs.current[id] = node; },
            className: `qdr-tab${tab === id ? ' qdr-tab-on' : ''}`,
            onClick: () => changeTab(id),
          }, label))),

        h('div', { className: 'qdr-stage', ref: stageRef },
        tab === 'overview' ? h('div', { className: 'qdr-panel', role: 'tabpanel' },
          signedIn ? h(React.Fragment, null,
            h('div', { className: 'qdr-account-strip' },
              h('div', { className: 'qdr-avatar' }, (status.account && status.account.name || 'Q').slice(0, 1).toUpperCase()),
              h('div', { className: 'qdr-account-main' },
                h('div', { className: 'qdr-account-name' }, status.account && (status.account.name || status.account.email) || 'Qoder 账号'),
                h('div', { className: 'qdr-account-meta' },
                  status.regionLabel || status.region,
                  ' · ', status.account && status.account.sourceLabel || '本机登录',
                  planLabel ? ' · ' + planLabel : '',
                  quotaText ? ' · 额度 ' + quotaText : '')),
              h('div', { className: 'qdr-account-actions' },
                h(Button, {
                  size: 'sm', variant: localAccounts.length > 1 ? 'secondary' : 'ghost', icon: 'swap',
                  onClick: () => setSwitcherOpen((open) => !open),
                }, localAccounts.length > 1 ? '切换账号' : '账号'),
                h(Button, { size: 'sm', variant: 'ghost', onClick: () => setTab('account') }, '管理'))),
            switcherOpen ? h('div', { className: 'qdr-account-menu' },
              h('div', { className: 'qdr-account-menu-head' },
                h('div', null,
                  h('div', { className: 'qdr-card-title' }, '本机已登录账号'),
                  h('div', { className: 'qdr-card-sub' }, '切换只影响插件当前使用的账号，不会修改 Qoder 官方客户端的登录态。')),
                h(Button, { size: 'sm', icon: 'refresh', disabled: busy === 'desktop-scan', onClick: () => run('desktop-scan', async () => { await loadStatus(true, true); await loadCheckin(false); }) }, '重新扫描')),
              localAccounts.length
                ? h('div', { className: 'qdr-account-menu-list' }, localAccounts.map((candidate) => {
                  const current = Boolean(status.account && status.account.uid === candidate.uid && status.region === candidate.region);
                  const checkinAccount = checkinForCandidate(candidate);
                  return h('div', { className: `qdr-account-menu-row${current ? ' qdr-account-menu-current' : ''}`, key: `${candidate.region}-${candidate.kind}-${candidate.uid || candidate.file}` },
                    h('div', { className: 'qdr-candidate-mark' }, candidate.kind === 'app' ? 'D' : 'C'),
                    h('div', { className: 'qdr-account-menu-main' },
                      h('div', { className: 'qdr-account-menu-title' },
                        h('strong', null, candidate.nickname || candidate.email || candidate.uid || '未命名账号'),
                        current ? h(Badge, { tone: 'green' }, '当前') : null,
                        checkinAccount ? h(Badge, { tone: checkinMeta(checkinAccount.status).tone }, checkinAccountStatus(checkinAccount)) : null),
                      h('div', { className: 'qdr-account-menu-meta' },
                        candidate.regionLabel || regionShort(candidate.region),
                        ' · ', candidate.kind === 'app' ? '桌面端' : 'CLI',
                        candidate.expiresAt ? ` · ${dateLabel(candidate.expiresAt)} 过期` : '')),
                    h(Button, {
                      size: 'sm', variant: current ? 'ghost' : 'secondary',
                      disabled: current || busy === 'desktop',
                      onClick: () => importDesktop(candidate),
                    }, current ? '当前' : '切换'));
                }))
                : h('div', { className: 'qdr-quiet' }, '没有检测到其他本机登录；在 Qoder 客户端登录后会自动出现在这里。'),
              h('div', { className: 'qdr-account-menu-foot' },
                h(Icon, { name: 'lock', size: 13 }),
                h('span', null, '账号来自本机桌面端/CLI 的只读扫描，切换后模型目录会自动重载。'))) : null,
            h(QuotaCard, {
              extras, signedIn, wide: true, busy: accountBusy,
              checkin, checkinBusy,
              onRefresh: loadAccount,
              onAccount: () => setTab('account'),
              onCheckin: () => setTab('checkin'),
              onRunCheckin: () => runCheckin(''),
            }),
            h('div', { className: 'qdr-stats' },
              h(Stat, { label: '今日请求', value: String(today.requests || 0), hint: today.failures ? `${today.failures} 次失败` : '全部成功' }),
              h(Stat, { label: 'Tokens', value: compact(today.tokens || 0), hint: today.savedCredits ? `${money(today.credits)} Credits · 已省 ${money(today.savedCredits)}` : (today.credits ? `${money(today.credits)} Credits` : '本地统计') }),
              h(Stat, { label: '平均首字', value: today.avgFirstByteMs ? duration(today.avgFirstByteMs) : '—', hint: '上游首包' }),
              h(Stat, { label: '成功率', value: pct(today.successRate), hint: '今日', tone: today.successRate !== null && today.successRate < 0.9 ? 'warn' : undefined })),
            h('div', { className: 'qdr-grid-2' },
              h(CheckinSummaryCard, {
                data: checkin, busy: checkinBusy,
                onOpen: () => setTab('checkin'),
                onRun: () => runCheckin(''),
              }),
              h('div', { className: 'qdr-card' },
                h('div', { className: 'qdr-card-head' },
                  h('div', null,
                    h('div', { className: 'qdr-card-title' }, '路由与目录'),
                    h('div', { className: 'qdr-card-sub' }, '原生 adapter，无需 settings.yaml')),
                  h('span', { className: `qdr-pill ${status.route && status.route.registered ? 'qdr-pill-ok' : 'qdr-pill-bad'}` },
                    h(StatusDot, { tone: status.route && status.route.registered ? 'ok' : 'bad' }),
                    status.route && status.route.registered ? 'provider=qoder' : '未注册')),
                h('div', { className: 'qdr-kv' },
                  h('span', null, '可用模型'), h('strong', null, String((status.catalog && status.catalog.count) || 0)),
                  h('span', null, '选择器可见'), h('strong', null, String((status.catalog && status.catalog.visibleCount) || 0)),
                  h('span', null, '自定义参数'), h('strong', null, String(status.customized || 0) + ' 个模型'),
                  h('span', null, '目录刷新'), h('strong', null, status.catalog && status.catalog.at ? `${stamp(status.catalog.at)}${status.catalog.staleMs ? ' · 缓存' : ''}` : '—')),
                status.catalog && status.catalog.error ? h('div', { className: 'qdr-inline-warn' }, status.catalog.error) : null,
                h('div', { className: 'qdr-card-foot' },
                  h(Button, { size: 'sm', icon: 'refresh', disabled: Boolean(busy), onClick: refreshModels }, '刷新目录'),
                  h(Button, { size: 'sm', icon: 'bolt', disabled: Boolean(busy) || !(status.catalog && status.catalog.count), title: status.catalog && status.catalog.count ? '用当前模型发一次真实请求' : '目录为空，先刷新目录或登录', onClick: () => goTrial() }, '去试跑'),
                  h(Button, { size: 'sm', variant: 'ghost', onClick: () => setTab('models') }, '模型设置')))),
            h('div', { className: 'qdr-card' },
              h('div', { className: 'qdr-card-head' },
                h('div', null,
                  h('div', { className: 'qdr-card-title' }, '最近失败'),
                  h('div', { className: 'qdr-card-sub' }, '只展示失败请求，不记录对话内容')),
                h(Button, { size: 'sm', variant: 'ghost', onClick: () => { setUsageFilter('failed'); setTab('usage'); } }, '查看全部')),
              (status.recentFailures || []).length
                ? h('div', { className: 'qdr-recent' }, status.recentFailures.slice(0, 3).map((item, index) => h('div', { className: 'qdr-recent-row', key: index },
                  h(StatusDot, { tone: 'bad' }),
                  h('span', { className: 'qdr-recent-model' }, modelLabel(item.model) || '—'),
                  h('span', { className: 'qdr-recent-meta' }, statusLabel(item.status)),
                  h('span', { className: 'qdr-recent-time' }, stamp(item.at)))))
                : h('div', { className: 'qdr-quiet' }, '没有失败请求。'),
              h('div', { className: 'qdr-card-foot' },
                h(Button, { size: 'sm', variant: 'ghost', onClick: () => setTab('diagnose') }, '打开诊断'))),
            h('div', { className: 'qdr-foot-note' },
              h(Icon, { name: 'shield', size: 14 }),
              h('span', null, `凭据已加密保存在本机（${credentialProtection}）；面板只显示账号、计数和延迟，不返回令牌。`)))
          : h('div', { className: 'qdr-card' },
            h('div', { className: 'qdr-card-head' },
              h('div', null,
                h('div', { className: 'qdr-card-title' }, '登录后会发生什么'),
                h('div', { className: 'qdr-card-sub' }, '整个流程只在 dsh 插件进程内完成，不启动第二个服务。'))),
            h('div', { className: 'qdr-steps' },
              [
                ['1', '登录', '优先只读导入本机 Qoder 登录态；也可以用浏览器授权或 PAT。'],
                ['2', '加载目录', '自动注册 provider=qoder，并把当前账号可用的模型写进 dsh 选择器。'],
                ['3', '开始使用', '模型可直接对话；面板同时显示额度、用量、试跑和诊断。'],
              ].map(([num, title, detail]) => h('div', { className: 'qdr-step', key: num },
                h('span', { className: 'qdr-step-num' }, num),
                h('div', { className: 'qdr-step-body' },
                  h('div', { className: 'qdr-step-title' }, title),
                  h('div', { className: 'qdr-step-text' }, detail))))))) : null,

        tab === 'checkin' ? h(CheckinPanel, {
          data: checkin,
          busy: checkinBusy,
          error: checkinError,
          onRun: runCheckin,
          onToggleAuto: toggleCheckinAuto,
          onRefresh: () => loadCheckin(false),
          onAccount: () => setTab('account'),
        }) : null,

        tab === 'models' ? h('div', { className: 'qdr-panel', role: 'tabpanel' },
          h('div', { className: 'qdr-toolbar' },
            h('div', { className: 'qdr-search' },
              h(Icon, { name: 'search', size: 15 }),
              h('input', { type: 'search', placeholder: '搜索模型 id、名称或厂商', value: search, onChange: (event) => setSearch(event.target.value), 'aria-label': '搜索模型' })),
            h('div', { className: 'qdr-chips' },
              [['all', '全部'], ['visible', '已显示'], ['reasoning', '可思考'], ['free', '免费'], ['custom', '已自定义'], ['context', '可调上下文']].map(([id, label]) => h('button', {
                key: id, type: 'button', className: `qdr-chip${filter === id ? ' qdr-chip-on' : ''}`, 'aria-pressed': filter === id, onClick: () => setFilter(id),
              }, label)))),
          h('div', { className: 'qdr-list-head' },
            h('span', null, `${filtered.matched} / ${(models || []).length} 个模型匹配 · 已显示 ${(models || []).filter(effectivelyVisible).length} 个`),
            h('div', { className: 'qdr-list-actions' },
              h('button', { type: 'button', className: 'qdr-text-btn', onClick: selectAll }, '全选'),
              h('button', { type: 'button', className: 'qdr-text-btn', onClick: selectNone }, '全不选'),
              h(Button, { size: 'sm', icon: 'refresh', disabled: Boolean(busy), onClick: refreshModels }, '刷新'))),
          h('div', { className: 'qdr-list-note' }, '点模型行展开详情：可改上下文窗口、思考档位、温度和最大输出；默认模型即使未勾选也会保留在选择器中。'),
          modelsError ? h('div', { className: 'qdr-inline-warn' },
            `${modelsError} `,
            h('button', { type: 'button', className: 'qdr-text-btn', onClick: () => loadModels(false) }, '重试')) : null,
          !signedIn ? h(Empty, {
            icon: 'key', title: '登录后加载模型目录', detail: 'Qoder 的模型清单与账号绑定，登录后自动出现。',
            action: h(Button, { size: 'sm', variant: 'primary', icon: 'key', onClick: () => setTab('account') }, '去登录'),
          })
            : models === null ? h('div', { className: 'qdr-card qdr-skeleton' }, h('div', { className: 'qdr-skel-line' }), h('div', { className: 'qdr-skel-line' }), h('div', { className: 'qdr-skel-line' }))
              : filtered.items.length ? h('div', { className: 'qdr-model-list' }, filtered.items.map((model) => {
                const open = expanded === model.id;
                return h('div', { className: 'qdr-model-wrap', key: model.id },
                  h(ModelRow, {
                    model, checked: isVisible(model), pinned: draftPinned === model.id,
                    expanded: open, customized: customizedIds.has(model.id),
                    onToggle: () => toggleModel(model),
                    onPin: () => { setDraftPinned(draftPinned === model.id ? '' : model.id); setDirty(true); },
                    onOpen: () => {
                      if (open) {
                        if (editorDirty && !window.confirm('放弃未保存的模型参数？')) return;
                        setEditorDirty(false);
                        setExpanded('');
                      } else {
                        if (editorDirty && !window.confirm('当前模型有未保存的参数，切换会丢失。继续？')) return;
                        setEditorDirty(false);
                        setModelError(null);
                        setExpanded(model.id);
                      }
                    },
                  }),
                  open ? h(ModelEditor, {
                    model,
                    overrideContext: savedContext[model.id] || 0,
                    overrideParams: savedParams[model.id] || null,
                    pluginDefaults: {
                      temperature: status.config ? status.config.defaultTemperature : null,
                      maxTokens: status.config ? status.config.defaultMaxTokens : 0,
                      providerMaxTokens: status.config ? status.config.providerDefaultMaxTokens : 32000,
                      reasoningEffort: status.config ? status.config.defaultReasoningEffort : '',
                    },
                    busy: modelBusy === model.id,
                    error: modelError && modelError.id === model.id ? modelError.message : '',
                    onSave: (next) => saveModelParams(model, next),
                    onReset: () => resetModelParams(model),
                    onTrial: goTrial,
                    onCopy: copy,
                    onDirtyChange: handleEditorDirty,
                  }) : null);
              })) : h(Empty, {
                icon: 'search', title: modelsError ? '模型目录读取失败' : '没有匹配的模型',
                detail: modelsError ? '可以重试，或检查网络与登录状态。' : (search ? '换个关键词，或切回「全部」。' : '目录为空，试试刷新。'),
                action: h(Button, { size: 'sm', icon: 'refresh', onClick: () => (modelsError ? loadModels(true) : refreshModels()) }, '刷新目录'),
              }),
          dirty ? h('div', { className: 'qdr-savebar' },
            h('span', null, '显示设置尚未保存'),
            h('div', { className: 'qdr-savebar-actions' },
              h(Button, { size: 'sm', onClick: () => { dirtyRef.current = false; syncDrafts(status); setDirty(false); } }, '撤销'),
              h(Button, { size: 'sm', variant: 'primary', disabled: busy === 'prefs', onClick: savePrefs }, busy === 'prefs' ? '保存中…' : '保存设置'))) : null) : null,

        // 试跑面板常驻，只按页签隐藏：切去用量页再回来时，prompt 和结果还在。
        h('div', {
          className: 'qdr-panel', role: 'tabpanel', 'aria-hidden': tab !== 'trial',
          style: tab === 'trial' ? undefined : { display: 'none' },
        }, h(TrialPanel, {
          key: 'trial-' + trialSeq + '-' + ((status && status.account && status.account.uid) || 'anon'),
          models, signedIn, pinned: draftPinned, presetModel: trialModel,
          onUsage: () => { setUsage(null); setCredits(null); loadStatus(false); loadAccount(); },
          onLogin: () => setTab('account'),
          onCopy: copy,
        })),

        tab === 'usage' ? h('div', { className: 'qdr-panel', role: 'tabpanel' },
          h(CreditsHeatmap, {
            data: credits && credits.heatmap,
            busy: creditsBusy,
            error: credits ? '' : creditsError,
            onRefresh: () => loadCredits(creditsRange),
          }),
          h(CreditsChart, {
            data: credits,
            mode: creditsMode,
            range: creditsRange,
            busy: creditsBusy,
            error: credits ? '' : creditsError,
            onMode: setCreditsMode,
            onRange: setCreditsRange,
            onRefresh: () => loadCredits(creditsRange),
            modelLabel,
          }),
          h('div', { className: 'qdr-usage-head' },
            h('div', { className: 'qdr-chips' },
              [7, 14, 30].map((value) => h('button', {
                key: value, type: 'button', className: `qdr-chip${usageDays === value ? ' qdr-chip-on' : ''}`,
                'aria-pressed': usageDays === value,
                onClick: () => setUsageDays(value),
              }, `最近 ${value} 天`))),
            h('div', { className: 'qdr-usage-tools' },
              usageBusy ? h('span', { className: 'qdr-hint' }, '更新中…') : null,
              h(Button, { size: 'sm', icon: 'refresh', disabled: usageBusy, onClick: () => loadUsage(usageDays) }, '刷新'))),
          usageError ? h('div', { className: 'qdr-inline-warn' },
            `${usageError} `,
            h('button', { type: 'button', className: 'qdr-text-btn', onClick: () => loadUsage(usageDays) }, '重试')) : null,
          partialDataNote(usageSummary) ? h('div', { className: 'qdr-inline-warn' }, partialDataNote(usageSummary)) : null,
          usageError && !usage ? h(Empty, {
            icon: 'chart', title: '用量记录读取失败', detail: '统计接口暂时不可用；可重试或稍后再看。',
            action: h(Button, { size: 'sm', icon: 'refresh', onClick: () => loadUsage(usageDays) }, '重试'),
          })
            : usageBusy && !usage ? h('div', { className: 'qdr-card qdr-skeleton' },
            h('div', { className: 'qdr-skel-line qdr-skel-lg' }),
            h('div', { className: 'qdr-skel-line' }),
            h('div', { className: 'qdr-skel-grid' },
              h('div', { className: 'qdr-skel-box' }), h('div', { className: 'qdr-skel-box' }),
              h('div', { className: 'qdr-skel-box' }), h('div', { className: 'qdr-skel-box' })))
            : h(React.Fragment, null,
              h('div', { className: 'qdr-stats qdr-stats-6' },
                h(Stat, { label: '请求', value: String(usageTotals ? usageTotals.requests : 0), hint: usageTotals && usageTotals.failures ? `${usageTotals.failures} 次失败` : '窗口内' }),
                h(Stat, { label: 'Tokens', value: compact(usageTotals ? usageTotals.tokens : 0), hint: usageTotals ? `${compact(usageTotals.promptTokens)} 入 / ${compact(usageTotals.completionTokens)} 出` : '' }),
                h(Stat, { label: 'Credits', value: usageTotals ? money(usageTotals.credits) : '—', hint: usageTotals && usageTotals.savedCredits ? `实扣 · 已省 ${money(usageTotals.savedCredits)}` : '上游实扣' }),
                h(Stat, { label: '成功率', value: pct(usageTotals && usageTotals.successRate), tone: usageTotals && usageTotals.successRate !== null && usageTotals.successRate < 0.9 ? 'warn' : undefined }),
                h(Stat, { label: '平均首字', value: usageTotals && usageTotals.avgFirstByteMs ? duration(usageTotals.avgFirstByteMs) : '—', hint: '上游首包' }),
                h(Stat, { label: '平均耗时', value: usageTotals && usageTotals.avgLatencyMs ? duration(usageTotals.avgLatencyMs) : '—', hint: '完整响应' })),
              h('div', { className: 'qdr-card' },
                h('div', { className: 'qdr-card-head' },
                  h('div', null,
                    h('div', { className: 'qdr-card-title' }, '用量趋势'),
                    h('div', { className: 'qdr-card-sub' }, `按天统计 tokens · 今日 ${today.requests || 0} 次 / ${compact(today.tokens || 0)} tokens`)),
                  h('div', { className: 'qdr-chart-peak' }, rangeLabel(usageSummary && usageSummary.range))),
                h(Sparkline, { days: usageDayBuckets, label: 'Token 趋势' })),
              h('div', { className: 'qdr-card' },
                h('div', { className: 'qdr-card-head' },
                  h('div', null,
                    h('div', { className: 'qdr-card-title' }, '按模型'),
                    h('div', { className: 'qdr-card-sub' }, '窗口内 tokens 占比；用于判断额度花在哪里。')),
                  h('span', { className: 'qdr-chart-peak' }, `${usageByModel.length} 个模型${usageByModel.length > 8 ? ' · 显示前 8' : ''}`)),
                usageByModel.length ? h('div', { className: 'qdr-model-stats' },
                  usageByModel.slice(0, 8).map((item) => h('div', { className: 'qdr-model-stat', key: item.model },
                    h('div', { className: 'qdr-model-stat-head' },
                      h('div', { className: 'qdr-model-stat-name' },
                        h('strong', null, modelLabel(item.model)),
                        h('span', { className: 'qdr-model-stat-id' }, item.model)),
                      h('div', { className: 'qdr-model-stat-nums' },
                        h('strong', null, pct(item.share)),
                        h('span', null, `${item.requests} 次`))),
                    h(Meter, { value: item.share, label: `${item.model} tokens 占比` }),
                    h('div', { className: 'qdr-model-stat-meta' },
                      h('span', null, `${compact(item.tokens)} tokens`),
                      item.credits ? h('span', null, `${money(item.credits)} Credits`) : h('span', null, item.savedCredits ? '免费调用' : '0 Credits'),
                      item.savedCredits ? h('span', null, `已省 ${money(item.savedCredits)}`) : null,
                      h('span', null, `首字 ${item.avgFirstByteMs ? duration(item.avgFirstByteMs) : '—'}`),
                      h('span', null, `成功率 ${pct(item.successRate)}`),
                      item.cachedTokens ? h('span', null, `缓存 ${compact(item.cachedTokens)}`) : null,
                      item.reasoningTokens ? h('span', null, `思考 ${compact(item.reasoningTokens)}`) : null))))
                  : h('div', { className: 'qdr-quiet' }, '窗口内还没有请求。')),
              h('div', { className: 'qdr-card' },
                h('div', { className: 'qdr-card-head' },
                  h('div', null,
                    h('div', { className: 'qdr-card-title' }, '请求明细'),
                    h('div', { className: 'qdr-card-sub' },
                      `显示最近 ${recentShown.length} 条${recent.length > recentShown.length ? `（匹配 ${recent.length} 条）` : ''} · 只记录元数据，不含对话内容`)),
                  h('div', { className: 'qdr-card-actions' },
                    h('div', { className: 'qdr-chips' },
                      [['all', '全部'], ['ok', '成功'], ['failed', '失败']].map(([id, label]) => h('button', {
                        key: id, type: 'button', className: `qdr-chip${usageFilter === id ? ' qdr-chip-on' : ''}`,
                        'aria-pressed': usageFilter === id,
                        onClick: () => setUsageFilter(id),
                      }, label))),
                    h(Button, { size: 'sm', variant: 'ghost', icon: 'trash', disabled: Boolean(busy), onClick: clearUsage }, '清空'))),
                recent.length ? h('div', { className: 'qdr-usage-list' },
                  recentShown.map((item, index) => h('div', { className: 'qdr-usage-row', key: index },
                    h('div', { className: 'qdr-usage-top' },
                      h(StatusDot, { tone: item.ok ? 'ok' : 'bad' }),
                      h('span', { className: 'qdr-usage-model' }, modelLabel(item.model)),
                      h('span', { className: 'qdr-usage-id' }, item.model || '—'),
                      h('span', { className: `qdr-usage-status qdr-usage-status-${item.ok ? 'ok' : 'bad'}` },
                        item.ok ? (item.status === 'test' ? '试跑' : '成功') : statusLabel(item.status)),
                      usageBadges(item).map((label, badgeIndex) => h('span', { className: 'qdr-usage-badge', key: badgeIndex }, label)),
                      h('span', { className: 'qdr-usage-time' }, stamp(item.at))),
                    h('div', { className: 'qdr-usage-meta' },
                      h('span', null, `${compact(item.promptTokens)} 入 / ${compact(item.completionTokens)} 出`),
                      h('span', null, `${compact(item.totalTokens)} tokens`),
                      item.cachedTokens ? h('span', null, `缓存 ${compact(item.cachedTokens)}`) : null,
                      item.reasoningTokens ? h('span', null, `思考 ${compact(item.reasoningTokens)}`) : null,
                      h('span', null, `首字 ${item.firstByteMs ? duration(item.firstByteMs) : '—'}`),
                      h('span', null, `耗时 ${item.latencyMs ? duration(item.latencyMs) : '—'}`),
                      item.billable === false ? h('span', null, '免费') : (item.credits ? h('span', null, `${money(item.credits)} Credits`) : null),
                      item.savedCredits ? h('span', null, `已省 ${money(item.savedCredits)}`) : null),
                    !item.ok && item.error ? h('div', { className: 'qdr-usage-error' },
                      h('span', null, item.error),
                      h('button', {
                        type: 'button', className: 'qdr-text-btn',
                        onClick: () => copy(`${item.model} · ${stamp(item.at)}\n${item.error}`, '错误信息'),
                      }, '复制')) : null)))
                  : h('div', { className: 'qdr-quiet' }, usageFilter === 'failed' ? '没有失败请求。' : '还没有请求记录。完成一次对话或试跑后出现。')))) : null,

        tab === 'account' ? h('div', { className: 'qdr-panel', role: 'tabpanel' },
          h('div', { className: 'qdr-card qdr-account-list-card' },
            h('div', { className: 'qdr-card-head' },
              h('div', null,
                h('div', { className: 'qdr-card-title' }, '账号',
                  accountRows.length ? h(Badge, { tone: 'neutral' }, `${accountRows.length} 个`) : null),
                h('div', { className: 'qdr-card-sub' },
                  signedIn
                    ? `${identity.text} 点「切换」立即更换插件当前使用的账号。`
                    : '本机检测到的 Qoder 账号；切换会完成插件登录。')),
              h(Button, {
                size: 'sm', icon: 'refresh', disabled: busy === 'desktop-scan',
                onClick: () => run('desktop-scan', async () => { await loadStatus(true, true); await loadCheckin(false); }),
              }, '重新扫描')),
            signedIn && identity.note ? h('div', { className: 'qdr-inline-warn' }, identity.note) : null,
            accountRows.length ? h('div', { className: 'qdr-account-list' }, accountRows.map((row) => {
              const checkinInfo = checkinForAccount(row.region, row.uid);
              const checkinInfoMeta = checkinInfo ? checkinMeta(checkinInfo.status) : null;
              const meta = [
                row.regionLabel,
                row.sourceLabel,
                row.email || (row.uid ? `uid …${row.uid.slice(-6)}` : '本机账号'),
                row.expiresAt ? `${dateLabel(row.expiresAt)} 过期` : '',
              ].filter(Boolean).join(' · ');
              return h('div', { className: `qdr-account-row${row.current ? ' qdr-account-row-current' : ''}`, key: row.key },
                h('div', { className: 'qdr-account-mark' }, (row.name || '?').slice(0, 1).toUpperCase()),
                h('div', { className: 'qdr-account-main' },
                  h('div', { className: 'qdr-account-title' },
                    h('strong', null, row.name),
                    row.current ? h(Badge, { tone: 'green' }, '当前') : null,
                    row.planLabel ? h(Badge, { tone: 'accent' }, row.planLabel) : null,
                    checkinInfoMeta ? h(Badge, { tone: checkinInfoMeta.tone }, checkinAccountStatus(checkinInfo)) : null),
                  h('div', { className: 'qdr-account-meta' }, meta),
                  row.current ? h('div', { className: 'qdr-account-current-line' },
                    `${row.tokenNeedsRefresh ? '访问令牌待换取' : `令牌到期 ${row.expiresLabel || '—'}`} · 账号 id ${row.uid || '—'}`) : null),
                row.current
                  ? h(Badge, { tone: 'green' }, '当前账号')
                  : h(Button, {
                    size: 'sm', variant: 'secondary', icon: 'swap',
                    disabled: busy === 'desktop',
                    onClick: () => row.candidate && importDesktop(row.candidate),
                  }, '切换'));
            })) : h(Empty, {
              icon: 'key', title: '没有检测到本机 Qoder 登录',
              detail: '先在 Qoder 客户端登录，或使用下面的浏览器授权 / PAT。',
            }),
            h('div', { className: 'qdr-account-list-foot' },
              h('div', { className: 'qdr-account-foot-note' },
                h(Icon, { name: 'lock', size: 13 }),
                h('span', null, '切换只影响插件当前使用的账号，不会修改或退出 Qoder 官方客户端。')),
              signedIn ? h('div', { className: 'qdr-account-foot-actions' },
                h(Button, { size: 'sm', icon: 'refresh', disabled: accountBusy, onClick: loadAccount }, accountBusy ? '刷新中…' : '刷新账号'),
                h(Button, { size: 'sm', icon: 'bolt', disabled: Boolean(busy) || !(status.catalog && status.catalog.count), title: status.catalog && status.catalog.count ? '用当前模型发一次真实请求' : '目录为空，先刷新目录或登录', onClick: () => goTrial() }, '去试跑'),
                h(Button, { size: 'sm', variant: 'ghost', icon: 'logout', disabled: busy === 'logout', onClick: logout }, '退出登录')) : null)),

          signedIn ? h(QuotaCard, { extras, signedIn, busy: accountBusy, onRefresh: loadAccount }) : null,

          h(DeviceCard, {
            state: device, busy: busy === 'device', region, setRegion,
            onStart: startDevice,
            onCancel: () => setDevice(null),
          }),

          h('div', { className: 'qdr-card' },
            h('button', { type: 'button', className: 'qdr-disclosure', onClick: () => setShowPat((value) => !value), 'aria-expanded': showPat },
              h(Icon, { name: 'key', size: 15 }),
              h('span', null, '使用 PAT 或访问令牌'),
              h(Icon, { name: 'chevron', size: 14 })),
            showPat ? h('div', { className: 'qdr-pat' },
              h(Segmented, {
                value: region, onChange: setRegion, ariaLabel: 'PAT 登录区域', disabled: Boolean(busy),
                options: [['global', '国际版'], ['cn', '国内版']],
              }),
              h('input', { type: 'password', className: 'qdr-input', placeholder: 'pt-… / dt-… / jt-…', value: pat, onChange: (event) => { setPat(event.target.value); if (patError) setPatError(''); }, 'aria-label': 'PAT 或访问令牌', 'aria-invalid': Boolean(patError) }),
              patError ? h('div', { className: 'qdr-inline-warn', role: 'alert' }, patError) : null,
              h('div', { className: 'qdr-pat-foot' },
                h('span', { className: 'qdr-hint' }, 'PAT 会先换取短期令牌；令牌加密保存在本机。'),
                h(Button, { size: 'sm', variant: 'primary', disabled: busy === 'pat', onClick: submitPat }, '登录'))) : null),

          h('div', { className: 'qdr-foot-note' },
            h(Icon, { name: 'lock', size: 14 }),
            h('span', null, '凭据文件：' + ((status && status.config && status.config.authPath) || '本机 dsh 数据目录') + ` · ${credentialProtection} 加密`))) : null,

        tab === 'diagnose' && status ? h('div', { className: 'qdr-panel', role: 'tabpanel' },
          h('div', { className: 'qdr-card' },
            h('div', { className: 'qdr-card-head' },
              h('div', null,
                h('div', { className: 'qdr-card-title' }, '链路检查'),
                h('div', { className: 'qdr-card-sub' }, '凭据 / 令牌 / 目录 / 路由 / 存储 / 偏好 / 额度')),
              h('div', { className: 'qdr-card-actions' },
                h(Button, { size: 'sm', icon: 'refresh', disabled: busy === 'diag', onClick: () => run('diag', loadDiagnostics) }, busy === 'diag' ? '检查中…' : '重新检查'),
                h(Button, { size: 'sm', variant: 'ghost', icon: 'copy', disabled: !diagnostics, onClick: () => {
                  const lines = [
                    `qoder-to-dsh ${status.version || ''} · provider=${status.provider || 'qoder'}`,
                    `账号：${status.signedIn ? (status.account && (status.account.name || status.account.email) || '已登录') : '未登录'} · ${status.regionLabel || ''}`,
                    `运行时：Node ${status.runtime && status.runtime.node || '—'} · PID ${status.runtime && status.runtime.pid || '—'}`,
                    `模型：${status.catalog && status.catalog.count || 0} 个 / 可见 ${status.catalog && status.catalog.visibleCount || 0} 个 · 自定义 ${status.customized || 0}`,
                    '',
                    ...(diagnostics.checks || []).map((check) => `${check.status === 'pass' ? '[OK]' : check.status === 'warn' ? '[WARN]' : '[FAIL]'} ${check.label}: ${check.detail}`),
                  ];
                  copy(lines.join('\n'), '诊断报告');
                } }, '复制'))),
            diagnostics ? h('div', { className: 'qdr-checks' }, (diagnostics.checks || []).map((check) => h(CheckRow, { key: check.id, check })))
              : diagnosticsError ? h(Empty, {
                icon: 'alert', title: '诊断暂时失败', detail: diagnosticsError,
                action: h(Button, { size: 'sm', icon: 'refresh', onClick: () => run('diag', loadDiagnostics) }, '重试'),
              })
                : h('div', { className: 'qdr-quiet' }, '正在检查…')),
          h('div', { className: 'qdr-card' },
            h('div', { className: 'qdr-card-head' },
              h('div', null,
                h('div', { className: 'qdr-card-title' }, '运行环境'),
                h('div', { className: 'qdr-card-sub' }, '面板、模型选择器和请求共用这一份进程状态。'))),
            h('div', { className: 'qdr-kv qdr-kv-wide' },
              h('span', null, '版本'), h('strong', null, status.version || '—'),
              h('span', null, 'provider'), h('strong', { className: 'qdr-mono' }, status.provider || 'qoder'),
              h('span', null, 'Node'), h('strong', { className: 'qdr-mono' }, status.runtime && status.runtime.node || '—'),
              h('span', null, '进程'), h('strong', { className: 'qdr-mono' }, String(status.runtime && status.runtime.pid || '—')),
              h('span', null, '数据目录'), h('strong', { className: 'qdr-mono' }, status.config && status.config.dataDir || '—'),
              h('span', null, '凭据文件'), h('strong', { className: 'qdr-mono' }, status.config && status.config.authPath || '—'),
              h('span', null, '目录缓存'), h('strong', null, status.config && status.config.catalogTtlMs > 0 ? `${Math.round(status.config.catalogTtlMs / 60000)} 分钟` : '每次请求'),
              h('span', null, '首包上限'), h('strong', null, status.config && status.config.firstByteTimeoutMs > 0 ? `${Math.round(status.config.firstByteTimeoutMs / 1000)} 秒` : '不限'),
              h('span', null, '流空闲上限'), h('strong', null, status.config && status.config.streamIdleTimeoutMs > 0 ? `${Math.round(status.config.streamIdleTimeoutMs / 1000)} 秒` : '不限'))),
          h('div', { className: 'qdr-card' },
            h('div', { className: 'qdr-card-head' },
              h('div', null, h('div', { className: 'qdr-card-title' }, '运行日志'), h('div', { className: 'qdr-card-sub' }, '已脱敏，不包含令牌或对话内容')),
              h(Button, { size: 'sm', variant: 'ghost', icon: 'copy', disabled: !(diagnostics && diagnostics.logs), onClick: () => copy((diagnostics.logs || []).join('\n'), '日志') }, '复制')),
            h('pre', { className: 'qdr-logs' }, ((diagnostics && diagnostics.logs) || ['暂无日志']).slice(-24).join('\n')))) : null),

        h('div', { className: 'qdr-footer' },
          h('span', null, 'qoder-to-dsh · 非官方接入，仅使用本机自有账号'),
          h('span', null, 'provider=qoder')));
    }

    function insertStyles() {
      const id = 'qoder-to-dsh-panel-styles';
      if (document.getElementById(id)) return () => {};
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `
:root{--qdr-accent:#3c6b51;--qdr-accent-solid:#3c6b51;--qdr-accent-hover:#315a43;--qdr-accent-weak:#eaf1ec;--qdr-accent-border:#cadbcf;--qdr-on-accent:#ffffff;--qdr-ok:#3d7a5b;--qdr-ok-weak:#eaf4ee;--qdr-warn:#9a6a12;--qdr-warn-weak:#fbf4e3;--qdr-bad:#b94a48;--qdr-bad-weak:#fbeceb;--qdr-violet:#4c7b82;--qdr-violet-weak:#eaf2f2;--qdr-amber:#9a6a12;--qdr-amber-weak:#fbf4e3;--qdr-hero-bg:#f6f8f6;--qdr-hero-border:#d8e2db;--qdr-tab-bg:#f1f3f1;--qdr-tab-active:#ffffff;--qdr-tab-active-text:#1b2a22;--qdr-segmented-active:#ffffff;--qdr-series-0:#3f7d5d;--qdr-series-1:#4c7b82;--qdr-series-2:#9a7a35;--qdr-series-3:#647895;--qdr-series-4:#7f6753;--qdr-series-5:#6f8146;--qdr-heat-0:#eef1ee;--qdr-heat-1:#dbe9df;--qdr-heat-2:#b7d4c3;--qdr-heat-3:#7fae93;--qdr-heat-4:#3f7d5d}
.qdr-root{container-type:inline-size;container-name:qdr;color-scheme:inherit;--qdr-fg:#1a1d1b;--qdr-muted:#68716b;--qdr-faint:#969f99;--qdr-line:#e6e9e6;--qdr-line-strong:#d8ded9;--qdr-card:#fcfdfc;--qdr-soft:#f5f7f5;--qdr-soft-2:#eef1ee;--qdr-shadow:0 1px 2px rgba(24,40,32,.035),0 2px 8px rgba(24,40,32,.03);--qdr-radius:16px;display:flex;flex-direction:column;gap:14px;min-width:0;font-family:"Segoe UI Variable","Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5;color:var(--qdr-fg);-webkit-font-smoothing:antialiased}
.qdr-root *{box-sizing:border-box;min-width:0}
@media (prefers-color-scheme:dark){.qdr-root:not(.qdr-light):not(.qdr-dark){--qdr-fg:#e7eae7;--qdr-muted:#98a29b;--qdr-faint:#6e7771;--qdr-line:#2d302e;--qdr-line-strong:#3a3e3b;--qdr-card:#1f211f;--qdr-soft:#252826;--qdr-soft-2:#2b2e2c;--qdr-shadow:0 1px 2px rgba(0,0,0,.3);--qdr-accent:#7db398;--qdr-accent-solid:#3f6b52;--qdr-accent-hover:#4a7b60;--qdr-accent-weak:#1e2b24;--qdr-accent-border:#32483b;--qdr-on-accent:#eef6f1;--qdr-ok:#6fa98a;--qdr-ok-weak:#17261f;--qdr-warn:#c19a4a;--qdr-warn-weak:#2f2818;--qdr-bad:#c77a78;--qdr-bad-weak:#2f1d1d;--qdr-violet:#6da9b0;--qdr-violet-weak:#1a2a2b;--qdr-amber:#c19a4a;--qdr-amber-weak:#2f2818;--qdr-hero-bg:#1d201e;--qdr-hero-border:#2f3b34;--qdr-tab-bg:#191b1a;--qdr-tab-active:#2f4a3a;--qdr-tab-active-text:#e5f0e9;--qdr-series-0:#78b595;--qdr-series-1:#6fa8b0;--qdr-series-2:#c0a05a;--qdr-series-3:#8299bd;--qdr-series-4:#b19078;--qdr-series-5:#98ad6c;--qdr-heat-0:#242725;--qdr-heat-1:#1e3227;--qdr-heat-2:#2a4a39;--qdr-heat-3:#386b50;--qdr-heat-4:#4f8f69;--qdr-segmented-active:#343a35}}
.qdr-root.qdr-dark,[data-theme="dark"] .qdr-root,.dsh-dark .qdr-root{--qdr-fg:#e7eae7;--qdr-muted:#98a29b;--qdr-faint:#6e7771;--qdr-line:#2d302e;--qdr-line-strong:#3a3e3b;--qdr-card:#1f211f;--qdr-soft:#252826;--qdr-soft-2:#2b2e2c;--qdr-shadow:0 1px 2px rgba(0,0,0,.3);--qdr-accent:#7db398;--qdr-accent-solid:#3f6b52;--qdr-accent-hover:#4a7b60;--qdr-accent-weak:#1e2b24;--qdr-accent-border:#32483b;--qdr-on-accent:#eef6f1;--qdr-ok:#6fa98a;--qdr-ok-weak:#17261f;--qdr-warn:#c19a4a;--qdr-warn-weak:#2f2818;--qdr-bad:#c77a78;--qdr-bad-weak:#2f1d1d;--qdr-violet:#6da9b0;--qdr-violet-weak:#1a2a2b;--qdr-amber:#c19a4a;--qdr-amber-weak:#2f2818;--qdr-hero-bg:#1d201e;--qdr-hero-border:#2f3b34;--qdr-tab-bg:#191b1a;--qdr-tab-active:#2f4a3a;--qdr-tab-active-text:#e5f0e9;--qdr-series-0:#78b595;--qdr-series-1:#6fa8b0;--qdr-series-2:#c0a05a;--qdr-series-3:#8299bd;--qdr-series-4:#b19078;--qdr-series-5:#98ad6c;--qdr-heat-0:#242725;--qdr-heat-1:#1e3227;--qdr-heat-2:#2a4a39;--qdr-heat-3:#386b50;--qdr-heat-4:#4f8f69;--qdr-segmented-active:#343a35}
.qdr-head{display:flex;align-items:center;gap:12px;min-width:0}
.qdr-logo{width:38px;height:38px;border-radius:13px;background:var(--qdr-accent-solid);color:var(--qdr-on-accent);display:flex;align-items:center;justify-content:center;font-weight:750;font-size:20px;letter-spacing:-.04em;flex:none;box-shadow:0 3px 8px rgba(0,0,0,.18)}
.qdr-head-main{min-width:0;flex:1}
.qdr-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qdr-title{font-size:17px;font-weight:680;letter-spacing:-.02em;margin:0;line-height:1.2}
.qdr-subtitle{font-size:11.5px;color:var(--qdr-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qdr-head-actions{display:flex;gap:4px;flex:none}
.qdr-icon-btn{width:30px;height:30px;border:1px solid transparent;background:transparent;border-radius:10px;color:var(--qdr-muted);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .18s,border-color .18s,color .18s,transform .18s}
.qdr-icon-btn:hover{background:var(--qdr-soft);border-color:var(--qdr-line)}
.qdr-icon-btn:disabled{opacity:.5;cursor:default}
.qdr-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;background:rgba(127,127,127,.09);color:inherit;font-size:11px;font-weight:600;border:1px solid rgba(127,127,127,.16);white-space:nowrap}
.qdr-pill-ok{background:var(--qdr-ok-weak);color:var(--qdr-ok);border-color:transparent}
.qdr-pill-bad{background:var(--qdr-bad-weak);color:var(--qdr-bad);border-color:transparent}
.qdr-dot{width:6px;height:6px;border-radius:50%;background:var(--qdr-faint);display:inline-block;flex:none}
.qdr-dot-ok{background:var(--qdr-ok)}.qdr-dot-warn{background:var(--qdr-warn)}.qdr-dot-bad{background:var(--qdr-bad)}.qdr-dot-neutral{background:var(--qdr-faint)}
.qdr-card{background:var(--qdr-card);border:1px solid var(--qdr-line);border-radius:var(--qdr-radius);padding:15px;box-shadow:var(--qdr-shadow);min-width:0;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease,background .18s ease}
.qdr-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0;flex-wrap:wrap}
.qdr-card-head>div:first-child{flex:1 1 auto;min-width:0}
.qdr-card-head .qdr-card-sub{overflow-wrap:anywhere}
.qdr-card-actions{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.qdr-card-title{font-size:13px;font-weight:650;letter-spacing:-.01em}
.qdr-card-sub{font-size:11.5px;color:var(--qdr-muted);margin-top:3px;line-height:1.45}
.qdr-card-foot{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px;padding-top:11px;border-top:1px solid var(--qdr-line)}
.qdr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:31px;padding:0 11px;border-radius:10px;border:1px solid transparent;background:transparent;color:var(--qdr-fg);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s cubic-bezier(.2,.7,.2,1),box-shadow .18s ease}
.qdr-btn:active{transform:scale(.97)}
.qdr-btn:focus-visible,.qdr-icon-btn:focus-visible,.qdr-tab:focus-visible,.qdr-chip:focus-visible,.qdr-text-btn:focus-visible,.qdr-pin:focus-visible,.qdr-disclosure:focus-visible{outline:2px solid var(--qdr-accent);outline-offset:2px}
.qdr-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.qdr-btn-primary{background:var(--qdr-accent-solid);color:var(--qdr-on-accent);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.qdr-btn-primary:hover:not(:disabled){background:var(--qdr-accent-hover);box-shadow:0 2px 6px rgba(0,0,0,.16)}
.qdr-btn-secondary{background:var(--qdr-soft);border-color:var(--qdr-line);color:var(--qdr-fg)}
.qdr-btn-secondary:hover:not(:disabled){background:var(--qdr-soft-2);border-color:var(--qdr-accent-border)}
.qdr-btn-ghost{color:var(--qdr-muted)}
.qdr-btn-ghost:hover:not(:disabled){background:var(--qdr-soft);color:var(--qdr-fg)}
.qdr-btn-sm{height:27px;padding:0 9px;font-size:11.5px;border-radius:8px}
.qdr-banner{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:12px;font-size:12px;line-height:1.45;border:1px solid transparent;min-width:0;animation:qdr-drop .22s cubic-bezier(.2,.7,.2,1) both}
.qdr-banner span{flex:1;min-width:0;overflow-wrap:anywhere}
.qdr-banner-ok{background:var(--qdr-ok-weak);color:var(--qdr-ok)}
.qdr-banner-warn{background:var(--qdr-warn-weak);color:var(--qdr-warn)}
.qdr-banner-error{background:var(--qdr-bad-weak);color:var(--qdr-bad)}
.qdr-banner-x{border:none;background:transparent;color:inherit;cursor:pointer;padding:0;display:flex;flex:none}
.qdr-signin{display:flex;gap:14px;padding:17px;border:1px solid var(--qdr-accent-border);border-radius:18px;background:var(--qdr-hero-bg);box-shadow:var(--qdr-shadow);align-items:flex-start}
.qdr-signin-mark{width:38px;height:38px;border-radius:12px;background:var(--qdr-card);border:1px solid var(--qdr-accent-border);color:var(--qdr-accent);display:flex;align-items:center;justify-content:center;flex:none;box-shadow:0 2px 5px rgba(47,107,79,.1)}
.qdr-signin-main{flex:1;min-width:0}
.qdr-signin-title{font-size:14px;font-weight:670;letter-spacing:-.01em}
.qdr-signin-sub{font-size:12px;color:var(--qdr-muted);margin-top:4px;line-height:1.55;max-width:620px}
.qdr-signin-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
.qdr-signin-aside{display:flex;flex-direction:column;gap:8px;min-width:180px;padding-left:14px;border-left:1px solid var(--qdr-line)}
.qdr-mini{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--qdr-muted)}
.qdr-steps{display:flex;flex-direction:column;gap:1px;margin-top:8px}
.qdr-step{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--qdr-line)}
.qdr-step:last-child{border-bottom:none}
.qdr-step-num{width:21px;height:21px;border-radius:6px;background:var(--qdr-accent-weak);color:var(--qdr-accent);display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;flex:none;margin-top:1px}
.qdr-step-body{flex:1;min-width:0}
.qdr-step-title{font-size:11.5px;font-weight:600}
.qdr-step-text{font-size:10.5px;color:var(--qdr-muted);margin-top:2px;line-height:1.5}
.qdr-tabs{position:relative;display:flex;gap:3px;padding:4px;background:var(--qdr-tab-bg);border:1px solid var(--qdr-line);border-radius:999px;overflow-x:auto;scrollbar-width:none;min-width:0}
.qdr-tabs::-webkit-scrollbar{display:none}
.qdr-tab-pill{position:absolute;top:4px;bottom:4px;left:0;border-radius:999px;background:var(--qdr-tab-active);box-shadow:0 1px 3px rgba(0,0,0,.14),0 0 0 1px var(--qdr-line);opacity:0;pointer-events:none;z-index:0;transition:transform .28s cubic-bezier(.2,.8,.2,1),width .28s cubic-bezier(.2,.8,.2,1),opacity .18s ease;will-change:transform,width}
.qdr-tab-pill-ready{opacity:1}
.qdr-tab{position:relative;z-index:1;appearance:none;border:none;background:transparent;color:var(--qdr-muted);font-family:inherit;font-size:11.5px;font-weight:600;padding:7px 10px;cursor:pointer;white-space:nowrap;border-radius:999px;flex:1;min-width:54px;transition:background .2s ease,color .2s ease,transform .2s ease}
.qdr-tab:hover{color:var(--qdr-fg);background:rgba(127,127,127,.08)}
.qdr-tab-on{background:transparent;color:var(--qdr-tab-active-text);font-weight:650}
.qdr-tab-on:hover{background:transparent;color:var(--qdr-tab-active-text)}
.qdr-tab:active{transform:scale(.97)}
.qdr-panel{display:flex;flex-direction:column;gap:12px;min-width:0}
.qdr-stage{display:flex;flex-direction:column;gap:12px;min-width:0}
.qdr-stage-anim{animation:qdr-in .3s cubic-bezier(.2,.72,.25,1) both;will-change:opacity,transform}
@keyframes qdr-in{from{opacity:0;transform:translateY(7px) scale(.997)}to{opacity:1;transform:none}}
@keyframes qdr-pop{from{opacity:0;transform:translateY(-5px) scale(.992)}to{opacity:1;transform:none}}
@keyframes qdr-grow{from{transform:scaleY(.06);opacity:.35}to{transform:scaleY(1);opacity:.88}}
@keyframes qdr-drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes qdr-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes qdr-pulse{0%,100%{opacity:.55}50%{opacity:.9}}
@media (prefers-reduced-motion:reduce){.qdr-root *,.qdr-chat-login-wrap *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
.qdr-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
.qdr-stat{background:var(--qdr-card);border:1px solid var(--qdr-line);border-radius:14px;padding:12px 13px;box-shadow:var(--qdr-shadow);min-width:0;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}
.qdr-stat:hover{transform:translateY(-1px);border-color:var(--qdr-accent-border)}
.qdr-stat-label{font-size:10.5px;color:var(--qdr-muted);font-weight:560;letter-spacing:.01em}
.qdr-stat-value{font-size:18px;font-weight:680;letter-spacing:-.03em;margin-top:4px;font-variant-numeric:tabular-nums;line-height:1.15}
.qdr-stat-hint{font-size:10.5px;color:var(--qdr-faint);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qdr-stat-warn .qdr-stat-value{color:var(--qdr-warn)}
.qdr-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-width:0}
.qdr-account-strip{display:flex;align-items:center;gap:11px;min-width:0;padding:12px 14px;background:var(--qdr-card);border:1px solid var(--qdr-line);border-radius:16px;box-shadow:var(--qdr-shadow)}
.qdr-avatar{width:34px;height:34px;border-radius:10px;background:var(--qdr-soft-2);color:var(--qdr-fg);display:flex;align-items:center;justify-content:center;font-weight:680;font-size:14px;flex:none;border:1px solid var(--qdr-line)}
.qdr-account-main{flex:1;min-width:0}
.qdr-account-name{font-size:13px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qdr-account-meta{font-size:11.5px;color:var(--qdr-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qdr-kv{display:grid;grid-template-columns:auto 1fr;gap:7px 14px;margin-top:11px;font-size:11.5px}
.qdr-kv>span{color:var(--qdr-muted)}
.qdr-kv>strong{font-weight:600;text-align:right;overflow-wrap:anywhere}
.qdr-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;font-weight:500}
.qdr-inline-warn{margin-top:9px;font-size:11px;color:var(--qdr-warn);background:var(--qdr-warn-weak);padding:7px 9px;border-radius:7px;overflow-wrap:anywhere}
.qdr-quiet{font-size:11.5px;color:var(--qdr-muted);padding:10px 0}
.qdr-recent{display:flex;flex-direction:column;gap:1px;margin-top:6px}
.qdr-recent-row{display:flex;align-items:center;gap:7px;padding:7px 0;border-bottom:1px solid var(--qdr-line);font-size:11.5px;min-width:0}
.qdr-recent-row:last-child{border-bottom:none}
.qdr-recent-model{font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.qdr-recent-meta{color:var(--qdr-bad);font-size:10.5px;white-space:nowrap}
.qdr-recent-time{color:var(--qdr-faint);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:auto;padding-left:8px}
.qdr-inline-warn+.qdr-card-foot{margin-top:9px}
.qdr-toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0}
.qdr-search{flex:1;min-width:170px;display:flex;align-items:center;gap:7px;height:34px;padding:0 11px;background:var(--qdr-card);border:1px solid var(--qdr-line);border-radius:11px;color:var(--qdr-faint);transition:border-color .18s,box-shadow .18s}
.qdr-search:focus-within{border-color:var(--qdr-accent);box-shadow:0 0 0 3px var(--qdr-accent-weak)}
.qdr-search input{flex:1;border:none;background:transparent;outline:none;color:var(--qdr-fg);font-family:inherit;font-size:12px;min-width:0}
.qdr-search input::placeholder{color:var(--qdr-faint)}
.qdr-chips{display:flex;gap:4px;flex-wrap:wrap}
.qdr-chip{appearance:none;border:1px solid transparent;background:var(--qdr-soft);color:var(--qdr-muted);font-family:inherit;font-size:11px;font-weight:600;height:28px;padding:0 10px;border-radius:999px;cursor:pointer;transition:background .18s,color .18s,border-color .18s,transform .18s}
.qdr-chip:hover{color:var(--qdr-fg);background:var(--qdr-soft-2)}
.qdr-chip:active{transform:scale(.97)}
.qdr-chip-on{background:var(--qdr-accent-weak);color:var(--qdr-accent);border-color:var(--qdr-accent-border)}
.qdr-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--qdr-muted);font-size:11px;flex-wrap:wrap}
.qdr-list-actions{display:flex;align-items:center;gap:8px}
.qdr-text-btn{appearance:none;border:none;background:transparent;color:var(--qdr-muted);font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;padding:2px 0}
.qdr-text-btn:hover{color:var(--qdr-accent)}
.qdr-model-list{display:flex;flex-direction:column;gap:6px;min-width:0}
.qdr-model{display:flex;align-items:flex-start;gap:10px;padding:12px 13px;background:var(--qdr-card);border:1px solid var(--qdr-line);border-radius:14px;box-shadow:var(--qdr-shadow);min-width:0;transition:border-color .18s,box-shadow .18s,transform .18s,background .18s}
.qdr-model:hover{border-color:var(--qdr-accent-border);transform:translateY(-1px)}
.qdr-model-off{opacity:.62}
.qdr-checkbox{display:flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none;margin-top:1px;cursor:pointer}
.qdr-checkbox input{width:15px;height:15px;accent-color:var(--qdr-accent-solid);cursor:pointer;margin:0}
.qdr-model-main{flex:1;min-width:0}
.qdr-model-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.qdr-model-name{font-size:12.5px;font-weight:650;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdr-model-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;color:var(--qdr-faint);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdr-model-badges{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}
.qdr-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:6px;font-size:9.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap;background:var(--qdr-soft);color:var(--qdr-muted)}
.qdr-badge-accent{background:var(--qdr-accent-weak);color:var(--qdr-accent)}
.qdr-badge-green{background:var(--qdr-ok-weak);color:var(--qdr-ok)}
.qdr-badge-amber{background:var(--qdr-amber-weak);color:var(--qdr-amber)}
.qdr-badge-violet{background:var(--qdr-violet-weak);color:var(--qdr-violet)}
.qdr-pin{width:27px;height:27px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--qdr-faint);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;transition:background .18s,color .18s,transform .18s}
.qdr-pin:hover{background:var(--qdr-soft);color:var(--qdr-fg)}
.qdr-pin-on{color:var(--qdr-accent);background:var(--qdr-accent-weak)}
.qdr-savebar{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 13px;background:var(--qdr-card);border:1px solid var(--qdr-accent-border);border-radius:14px;box-shadow:0 -6px 18px rgba(24,40,32,.09);font-size:11.5px;color:var(--qdr-muted);flex-wrap:wrap;z-index:2;animation:qdr-rise .22s cubic-bezier(.2,.7,.2,1) both}
.qdr-savebar-actions{display:flex;gap:6px}
.qdr-chart{display:flex;flex-direction:column;gap:10px}
.qdr-chart-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.qdr-chart-title{font-size:12.5px;font-weight:650}
.qdr-chart-sub{font-size:11px;color:var(--qdr-muted);margin-top:2px;font-variant-numeric:tabular-nums}
.qdr-chart-peak{font-size:10.5px;color:var(--qdr-faint);font-variant-numeric:tabular-nums}
.qdr-bars{display:flex;align-items:flex-end;gap:4px;height:96px;padding:4px 0 0;border-bottom:1px solid var(--qdr-line)}
.qdr-bar-col{flex:1;height:100%;display:flex;align-items:flex-end;min-width:0}
.qdr-bar-track{width:100%;height:100%;display:flex;align-items:flex-end;border-radius:3px 3px 0 0;background:transparent}
.qdr-bar{width:100%;background:var(--qdr-accent-solid);border-radius:4px 4px 0 0;min-height:3px;opacity:.85;transform-origin:bottom;animation:qdr-grow .5s cubic-bezier(.2,.7,.2,1) both;transition:opacity .16s ease}
.qdr-bar-col:hover .qdr-bar{opacity:1}
.qdr-bar-warn{background:var(--qdr-warn)}
.qdr-chart-axis{display:flex;align-items:center;justify-content:space-between;color:var(--qdr-faint);font-size:10px}
.qdr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px;padding:32px 14px;background:var(--qdr-card);border:1px dashed var(--qdr-line-strong);border-radius:16px}
.qdr-empty-icon{width:38px;height:38px;border-radius:10px;background:var(--qdr-soft);color:var(--qdr-muted);display:flex;align-items:center;justify-content:center;margin-bottom:2px}
.qdr-empty-title{font-size:12.5px;font-weight:650}
.qdr-empty-detail{font-size:11.5px;color:var(--qdr-muted);max-width:340px;line-height:1.5}
.qdr-candidate-mark{width:27px;height:27px;border-radius:7px;background:var(--qdr-card);border:1px solid var(--qdr-line);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--qdr-muted);flex:none}
.qdr-device{border-color:var(--qdr-accent);box-shadow:0 0 0 3px var(--qdr-accent-weak),var(--qdr-shadow)}
.qdr-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--qdr-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.qdr-link{display:block;margin-top:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;color:var(--qdr-accent);text-decoration:none;background:var(--qdr-soft);border:1px solid var(--qdr-line);border-radius:10px;padding:9px;overflow-wrap:anywhere;line-height:1.4}
.qdr-link:hover{text-decoration:underline}
.qdr-device-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;flex-wrap:wrap}
.qdr-hint{font-size:10.5px;color:var(--qdr-muted);line-height:1.45}
.qdr-segmented{position:relative;display:inline-flex;background:var(--qdr-soft);border:1px solid var(--qdr-line);border-radius:999px;padding:3px;gap:2px;flex:none;min-width:0}
.qdr-segmented-pill{position:absolute;top:3px;bottom:3px;left:0;border-radius:999px;background:var(--qdr-segmented-active);box-shadow:0 1px 3px rgba(0,0,0,.14);opacity:0;pointer-events:none;z-index:0;transition:transform .24s cubic-bezier(.2,.8,.2,1),width .24s cubic-bezier(.2,.8,.2,1),opacity .16s ease}
.qdr-segmented-pill-ready{opacity:1}
.qdr-segmented-item{position:relative;z-index:1;appearance:none;border:none;background:transparent;color:var(--qdr-muted);font-family:inherit;font-size:10.5px;font-weight:600;padding:5px 10px;min-width:54px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:color .18s,transform .18s}
.qdr-segmented-item:hover{color:var(--qdr-fg)}
.qdr-segmented-item.on{color:var(--qdr-fg);font-weight:650}
.qdr-segmented-item:active{transform:scale(.97)}
.qdr-segmented-item:disabled{opacity:.55;cursor:not-allowed}
.qdr-disclosure{appearance:none;border:none;background:transparent;color:var(--qdr-fg);font-family:inherit;font-size:12px;font-weight:600;display:flex;align-items:center;gap:7px;width:100%;padding:0;cursor:pointer;text-align:left}
.qdr-disclosure svg:last-child{margin-left:auto;color:var(--qdr-faint);transition:transform .15s ease}
.qdr-disclosure[aria-expanded="true"] svg:last-child{transform:rotate(90deg)}
.qdr-pat{display:flex;flex-direction:column;gap:8px;margin-top:11px}
.qdr-input{width:100%;height:32px;padding:0 10px;border:1px solid var(--qdr-line);border-radius:10px;background:var(--qdr-soft);color:var(--qdr-fg);font-family:inherit;font-size:12px;outline:none;transition:border-color .18s,box-shadow .18s}
.qdr-input:focus{border-color:var(--qdr-accent);box-shadow:0 0 0 3px var(--qdr-accent-weak)}
.qdr-pat-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.qdr-checks{display:flex;flex-direction:column;gap:1px;margin-top:6px}
.qdr-check{display:flex;gap:9px;padding:8px 0;border-bottom:1px solid var(--qdr-line);align-items:flex-start}
.qdr-check:last-child{border-bottom:none}
.qdr-check-icon{width:21px;height:21px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none;margin-top:1px}
.qdr-check-ok{background:var(--qdr-ok-weak);color:var(--qdr-ok)}
.qdr-check-warn{background:var(--qdr-warn-weak);color:var(--qdr-warn)}
.qdr-check-bad{background:var(--qdr-bad-weak);color:var(--qdr-bad)}
.qdr-check-body{flex:1;min-width:0}
.qdr-check-label{font-size:12px;font-weight:600}
.qdr-check-detail{font-size:11px;color:var(--qdr-muted);margin-top:2px;line-height:1.45;overflow-wrap:anywhere}
.qdr-logs{margin:8px 0 0;padding:10px;background:var(--qdr-soft);border:1px solid var(--qdr-line);border-radius:8px;max-height:190px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.55;color:var(--qdr-muted);white-space:pre-wrap;overflow-wrap:anywhere}
.qdr-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--qdr-faint);font-size:10px;padding:1px 1px 2px;flex-wrap:wrap}
.qdr-foot-note{display:flex;align-items:flex-start;gap:6px;color:var(--qdr-muted);font-size:10.5px;line-height:1.45;padding:1px 2px;overflow-wrap:anywhere}
.qdr-foot-note svg{flex:none;margin-top:1px;color:var(--qdr-faint)}
.qdr-skeleton{display:flex;flex-direction:column;gap:9px}
.qdr-skel-line{height:12px;border-radius:5px;background:var(--qdr-soft-2);width:70%}
.qdr-skel-lg{height:18px;width:42%}
.qdr-skel-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:4px}
.qdr-skel-box{height:52px;border-radius:9px;background:var(--qdr-soft)}
/* ── 模型详情与参数 ─────────────────────────────────────────────── */
.qdr-model-wrap{display:flex;flex-direction:column;min-width:0}
.qdr-model-wrap .qdr-model{border-radius:10px}
.qdr-model-expanded{border-radius:14px 14px 0 0!important;border-color:var(--qdr-accent-border);box-shadow:var(--qdr-shadow),0 0 0 3px var(--qdr-accent-weak)}
.qdr-model-open{appearance:none;border:none;background:transparent;padding:0;margin:0;font:inherit;color:inherit;text-align:left;flex:1;min-width:0;display:flex;align-items:flex-start;gap:8px;cursor:pointer}
.qdr-model-open .qdr-model-main{flex:1;min-width:0}
.qdr-chevron{color:var(--qdr-faint);display:flex;flex:none;margin-top:2px;transition:transform .15s ease}
.qdr-chevron-on{transform:rotate(90deg)}
.qdr-editor{display:flex;flex-direction:column;gap:10px;padding:14px;background:var(--qdr-soft);border:1px solid var(--qdr-accent-border);border-top:1px solid var(--qdr-line);border-radius:0 0 14px 14px;box-shadow:var(--qdr-shadow);animation:qdr-pop .2s cubic-bezier(.2,.7,.2,1) both}
.qdr-editor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.qdr-editor-title{font-size:12.5px;font-weight:650}
.qdr-editor-sub{font-size:10.5px;color:var(--qdr-muted);margin-top:2px;line-height:1.45}
.qdr-editor-head-actions{display:flex;gap:5px;flex-wrap:wrap}
.qdr-editor-facts{display:flex;gap:4px;flex-wrap:wrap}
.qdr-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.qdr-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.qdr-field-wide{grid-column:1/-1}
.qdr-field-label{font-size:10.5px;font-weight:600;color:var(--qdr-muted)}
.qdr-field-note{font-size:9.5px;color:var(--qdr-faint);line-height:1.4;min-height:13px}
.qdr-presets{display:flex;gap:4px;flex-wrap:wrap;margin-top:1px}
.qdr-preset{appearance:none;border:1px solid var(--qdr-line);background:var(--qdr-soft);color:var(--qdr-muted);font-family:inherit;font-size:10px;font-weight:600;height:22px;padding:0 7px;border-radius:6px;cursor:pointer;transition:background .16s,color .16s,border-color .16s,transform .16s}
.qdr-preset:hover:not(:disabled){background:var(--qdr-soft-2);color:var(--qdr-fg)}
.qdr-preset:active:not(:disabled){transform:scale(.97)}
.qdr-preset-on{background:var(--qdr-accent-weak);color:var(--qdr-accent);border-color:var(--qdr-accent-border)}
.qdr-preset:disabled{opacity:.5;cursor:not-allowed}
.qdr-preset:focus-visible{outline:2px solid var(--qdr-accent);outline-offset:1px}
.qdr-field-bad{color:var(--qdr-bad)}
.qdr-select{position:relative;width:100%;min-width:0}
.qdr-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:32px;padding:0 10px;border:1px solid var(--qdr-line);border-radius:10px;background:var(--qdr-card);color:var(--qdr-fg);font-family:inherit;font-size:11.5px;cursor:pointer;outline:none;text-align:left;transition:border-color .18s,background .18s,box-shadow .18s}
.qdr-select-trigger:hover:not(:disabled){border-color:var(--qdr-accent-border);background:var(--qdr-soft)}
.qdr-select-trigger:focus-visible{outline:2px solid var(--qdr-accent);outline-offset:2px}
.qdr-select-trigger:disabled{opacity:.55;cursor:not-allowed}
.qdr-select-trigger svg{color:var(--qdr-muted);flex:none;transition:transform .22s cubic-bezier(.2,.7,.2,1)}
.qdr-select-open .qdr-select-trigger{border-color:var(--qdr-accent);background:var(--qdr-card);box-shadow:0 0 0 3px var(--qdr-accent-weak)}
.qdr-select-open .qdr-select-trigger svg{transform:rotate(180deg);color:var(--qdr-accent)}
.qdr-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdr-select-menu{position:absolute;z-index:50;left:0;right:0;top:calc(100% + 5px);padding:4px;background:var(--qdr-card);border:1px solid var(--qdr-line-strong);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);max-height:248px;overflow:auto;animation:qdr-pop .16s cubic-bezier(.2,.7,.2,1) both}
.qdr-select-option{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:7px 9px;border:none;border-radius:8px;background:transparent;color:var(--qdr-fg);font-family:inherit;font-size:11.5px;text-align:left;cursor:pointer;transition:background .15s,color .15s}
.qdr-select-option:hover{background:var(--qdr-soft)}
.qdr-select-option-on{background:var(--qdr-accent-weak);color:var(--qdr-accent);font-weight:600}
.qdr-select-option-label{min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdr-select-hint{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:9px;color:var(--qdr-faint);font-weight:400}
.qdr-select-option svg{flex:none;color:var(--qdr-accent)}
.qdr-field .qdr-input{height:32px;background:var(--qdr-card)}
.qdr-input-bad{border-color:var(--qdr-bad)!important;box-shadow:0 0 0 3px var(--qdr-bad-weak)}
.qdr-editor-effective{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:10px;color:var(--qdr-faint);padding-top:2px}
.qdr-editor-effective-value{font-size:10.5px;color:var(--qdr-fg);font-variant-numeric:tabular-nums;font-weight:550}
.qdr-editor-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:9px;border-top:1px solid var(--qdr-line)}
.qdr-editor-hint{margin-left:auto;font-size:10px;color:var(--qdr-faint)}
.qdr-list-note{font-size:10.5px;color:var(--qdr-faint);margin-top:-3px}
/* ── 进度条与额度 ───────────────────────────────────────────────── */
.qdr-meter{height:6px;border-radius:999px;background:rgba(127,127,127,.16);overflow:hidden;margin:10px 0 8px}
.qdr-meter-fill{display:block;height:100%;min-width:0;border-radius:inherit;background:var(--qdr-accent-solid);transition:width .55s cubic-bezier(.2,.7,.2,1)}
.qdr-meter-ok .qdr-meter-fill{background:var(--qdr-accent-solid)}
.qdr-meter-warn .qdr-meter-fill{background:var(--qdr-warn)}
.qdr-meter-bad .qdr-meter-fill{background:var(--qdr-bad)}
.qdr-quota{display:flex;flex-direction:column;min-width:0}
.qdr-quota-title-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.qdr-quota-big{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin-top:10px;font-variant-numeric:tabular-nums}
.qdr-quota-big strong{font-size:24px;font-weight:700;letter-spacing:-.035em;line-height:1.1}
.qdr-quota-total{font-size:11.5px;color:var(--qdr-muted)}
.qdr-quota-pct{margin-left:auto;font-size:10.5px;font-weight:650;white-space:nowrap}
.qdr-quota-pct-ok{color:var(--qdr-ok)}
.qdr-quota-pct-warn{color:var(--qdr-warn)}
.qdr-quota-pct-bad{color:var(--qdr-bad)}
.qdr-quota-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:9px;padding-top:9px;border-top:1px solid var(--qdr-line)}
.qdr-quota-grid>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.qdr-quota-grid span{font-size:9.5px;color:var(--qdr-faint);white-space:nowrap}
.qdr-quota-grid strong{font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qdr-quota-links{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:9px;padding-top:9px;border-top:1px solid var(--qdr-line)}
.qdr-quota-link{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--qdr-accent);text-decoration:none}
.qdr-quota-link:hover{text-decoration:underline}
.qdr-quota-empty{font-size:11.5px;color:var(--qdr-muted);padding:16px 0 4px}
.qdr-kv-wide>strong{font-size:10.5px;line-height:1.5}
/* ── 用量 ──────────────────────────────────────────────────────── */
.qdr-stats-6{grid-template-columns:repeat(3,minmax(0,1fr))}
.qdr-usage-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.qdr-usage-tools{display:flex;align-items:center;gap:8px;flex:none}
.qdr-model-stats{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.qdr-model-stat{padding:9px 10px;border:1px solid var(--qdr-line);border-radius:9px;background:var(--qdr-soft)}
.qdr-model-stat-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.qdr-model-stat-name{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;min-width:0}
.qdr-model-stat-name strong{font-size:12px;font-weight:650;letter-spacing:-.01em}
.qdr-model-stat-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:9px;color:var(--qdr-faint);overflow-wrap:anywhere}
.qdr-model-stat-nums{display:flex;align-items:baseline;gap:8px;flex:none;font-size:10px;color:var(--qdr-muted);font-variant-numeric:tabular-nums}
.qdr-model-stat-nums strong{font-size:12.5px;color:var(--qdr-fg);font-weight:650}
.qdr-model-stat .qdr-meter{height:4px;margin:7px 0 6px}
.qdr-model-stat-meta{display:flex;flex-wrap:wrap;gap:3px 10px;font-size:10px;color:var(--qdr-muted);font-variant-numeric:tabular-nums}
.qdr-usage-list{display:flex;flex-direction:column;margin-top:7px}
.qdr-usage-row{padding:9px 0;border-bottom:1px solid var(--qdr-line)}
.qdr-usage-row:last-child{border-bottom:none}
.qdr-usage-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;min-width:0}
.qdr-usage-model{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%}
.qdr-usage-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:9px;color:var(--qdr-faint);max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdr-usage-status{font-size:9.5px;font-weight:650;padding:1px 6px;border-radius:4px;white-space:nowrap}
.qdr-usage-status-ok{background:var(--qdr-ok-weak);color:var(--qdr-ok)}
.qdr-usage-status-bad{background:var(--qdr-bad-weak);color:var(--qdr-bad)}
.qdr-usage-badge{font-size:9.5px;font-weight:600;padding:1px 6px;border-radius:999px;background:var(--qdr-soft-2);color:var(--qdr-muted);white-space:nowrap}
.qdr-usage-time{margin-left:auto;font-size:10px;color:var(--qdr-faint);font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:6px}
.qdr-usage-meta{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:4px;font-size:10px;color:var(--qdr-muted);font-variant-numeric:tabular-nums}
.qdr-usage-error{display:flex;align-items:flex-start;gap:8px;margin-top:5px;padding:6px 8px;border-radius:6px;background:var(--qdr-bad-weak);color:var(--qdr-bad);font-size:10px;line-height:1.45;overflow-wrap:anywhere}
.qdr-usage-error>span{flex:1;min-width:0}
.qdr-usage-error .qdr-text-btn{color:inherit;flex:none}
/* ── 试跑 ──────────────────────────────────────────────────────── */
.qdr-trial-price{display:flex;gap:4px;flex-wrap:wrap;flex:none}
.qdr-trial-form{display:flex;flex-direction:column;gap:10px;margin-top:11px}
.qdr-trial-form .qdr-select{max-width:480px}
.qdr-textarea{width:100%;min-height:78px;padding:9px 10px;border:1px solid var(--qdr-line);border-radius:8px;background:var(--qdr-soft);color:var(--qdr-fg);font-family:inherit;font-size:12px;line-height:1.55;outline:none;resize:vertical}
.qdr-textarea:focus{border-color:var(--qdr-accent);box-shadow:0 0 0 3px var(--qdr-accent-weak)}
.qdr-trial-quick{display:flex;gap:5px;flex-wrap:wrap}
.qdr-trial-quick .qdr-chip{height:auto;padding:5px 8px;font-weight:500;text-align:left;line-height:1.35}
.qdr-trial-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:11px}
.qdr-trial-empty{padding:0;border-style:dashed;background:transparent;box-shadow:none}
.qdr-trial-result{margin-top:0}
.qdr-thinking{margin-top:10px;padding:8px 10px;border:1px solid var(--qdr-line);border-radius:8px;background:var(--qdr-soft)}
.qdr-thinking summary{cursor:pointer;font-size:10.5px;font-weight:600;color:var(--qdr-muted)}
.qdr-thinking pre{margin:7px 0 0;max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:1.55;color:var(--qdr-muted)}
.qdr-answer{margin-top:10px;padding:10px 12px;border:1px solid var(--qdr-line);border-radius:9px;background:var(--qdr-soft);font-size:12px;line-height:1.62;white-space:pre-wrap;overflow-wrap:anywhere;min-height:40px}
.qdr-trial-usage{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;padding-top:9px;border-top:1px solid var(--qdr-line);font-size:10.5px;color:var(--qdr-muted);font-variant-numeric:tabular-nums}
.qdr-trial-usage>span{display:inline-flex;align-items:baseline;gap:4px}
.qdr-trial-usage-label{color:var(--qdr-faint)}
.qdr-trial-usage strong{color:var(--qdr-fg);font-weight:600}
.qdr-trial-speed-note{display:flex;align-items:flex-start;gap:5px;margin-top:8px;font-size:10px;color:var(--qdr-faint);line-height:1.5}
/* ── 对话页顶部快捷登录/用量 ──────────────────────────────────── */
.qdr-chat-login-wrap{display:inline-flex;align-items:center;gap:8px;min-width:0}
.qdr-chat-login{appearance:none;font-family:inherit;cursor:pointer}
.qdr-chat-login:hover{background:rgba(127,127,127,.16)}
.qdr-chat-login-bad{background:var(--qdr-bad-weak);color:var(--qdr-bad);border-color:transparent}
.qdr-chat-login-link{font-size:10px;color:inherit;text-decoration:underline;white-space:nowrap}
.qdr-chat-login-error{font-size:10px;color:var(--qdr-bad);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdr-chat-usage-num{color:rgba(127,127,127,.95);font-variant-numeric:tabular-nums}
.qdr-chat-usage-label{color:rgba(127,127,127,.9);font-size:10px}
.qdr-chat-usage-quota{font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.qdr-chat-usage-low{color:var(--qdr-bad);background:var(--qdr-bad-weak);border-color:transparent}
.qdr-chat-usage-low .qdr-logo{background:var(--qdr-bad)!important}
/* ── 绿色主题补充：额度首屏、账号切换、签到 ─────────────────────── */
.qdr-avatar{border-radius:12px}
.qdr-empty-icon{border-radius:12px}
.qdr-step-num{border-radius:8px}
.qdr-usage-status{border-radius:999px;padding:2px 7px}
.qdr-logs{border-radius:10px}
.qdr-skel-line,.qdr-skel-box{animation:qdr-pulse 1.5s ease-in-out infinite}
.qdr-quota-wide{background:var(--qdr-hero-bg);border-color:var(--qdr-hero-border);padding:16px 18px;box-shadow:0 1px 2px rgba(24,40,32,.04),0 10px 28px rgba(47,107,79,.06)}
.qdr-quota-wide .qdr-quota-big{margin-top:12px}
.qdr-quota-wide .qdr-quota-big strong{font-size:32px}
.qdr-quota-wide .qdr-quota-grid{margin-top:11px;padding-top:11px;border-top-color:var(--qdr-hero-border)}
.qdr-quota-wide .qdr-meter{margin-top:12px}
.qdr-account-actions{display:flex;align-items:center;gap:5px;flex:none;flex-wrap:wrap}
.qdr-account-menu{display:flex;flex-direction:column;gap:10px;padding:14px;background:var(--qdr-card);border:1px solid var(--qdr-accent-border);border-radius:16px;box-shadow:0 8px 24px rgba(24,40,32,.08);animation:qdr-pop .2s cubic-bezier(.2,.7,.2,1) both}
.qdr-account-menu-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.qdr-account-menu-list{display:flex;flex-direction:column;gap:7px}
.qdr-account-menu-row{display:flex;align-items:center;gap:9px;padding:10px;border:1px solid var(--qdr-line);border-radius:12px;background:var(--qdr-soft);min-width:0;transition:border-color .18s,box-shadow .18s,transform .18s,background .18s}
.qdr-account-menu-row:hover{transform:translateY(-1px);border-color:var(--qdr-accent-border);box-shadow:var(--qdr-shadow)}
.qdr-account-menu-current{border-color:var(--qdr-accent-border);background:var(--qdr-accent-weak)}
.qdr-account-menu-main{flex:1;min-width:0}
.qdr-account-menu-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;min-width:0}
.qdr-account-menu-title strong{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.qdr-account-menu-meta{font-size:10px;color:var(--qdr-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qdr-account-menu-foot{display:flex;align-items:flex-start;gap:6px;padding-top:9px;border-top:1px solid var(--qdr-line);font-size:10px;color:var(--qdr-faint);line-height:1.45}
.qdr-account-menu-foot svg{flex:none;margin-top:1px}
.qdr-account-list-card .qdr-card-title{display:flex;align-items:center;gap:6px}
.qdr-account-list{display:flex;flex-direction:column;gap:7px;margin-top:10px}
.qdr-account-row{display:flex;align-items:flex-start;gap:10px;padding:12px;background:var(--qdr-soft);border:1px solid var(--qdr-line);border-radius:14px;min-width:0;transition:border-color .18s,box-shadow .18s,transform .18s,background .18s}
.qdr-account-row:hover{transform:translateY(-1px);border-color:var(--qdr-accent-border);box-shadow:var(--qdr-shadow)}
.qdr-account-row-current{border-color:var(--qdr-accent-border);background:var(--qdr-accent-weak)}
.qdr-account-mark{width:34px;height:34px;border-radius:10px;background:var(--qdr-card);border:1px solid var(--qdr-line);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--qdr-accent);flex:none}
.qdr-account-main{flex:1;min-width:0}
.qdr-account-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px;min-width:0}
.qdr-account-title strong{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.qdr-account-row .qdr-account-meta{font-size:10.5px;color:var(--qdr-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qdr-account-current-line{margin-top:6px;padding-top:6px;border-top:1px solid var(--qdr-line);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:9.5px;color:var(--qdr-faint);overflow-wrap:anywhere}
.qdr-account-row>button{flex:none;margin-top:1px}
.qdr-account-list-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px;padding-top:11px;border-top:1px solid var(--qdr-line)}
.qdr-account-foot-note{display:flex;align-items:flex-start;gap:6px;font-size:10px;color:var(--qdr-faint);line-height:1.45;min-width:0}
.qdr-account-foot-note svg{flex:none;margin-top:1px}
.qdr-account-foot-actions{display:flex;gap:6px;flex-wrap:wrap}
.qdr-checkin-hero{background:var(--qdr-hero-bg);border-color:var(--qdr-hero-border);box-shadow:0 1px 2px rgba(24,40,32,.04),0 10px 28px rgba(47,107,79,.06)}
.qdr-checkin-hero-top{display:flex;align-items:flex-start;gap:11px;flex-wrap:wrap}
.qdr-checkin-icon{width:44px;height:44px;border-radius:14px;background:var(--qdr-card);border:1px solid var(--qdr-accent-border);color:var(--qdr-accent);display:flex;align-items:center;justify-content:center;flex:none;box-shadow:0 2px 6px rgba(47,107,79,.12)}
.qdr-checkin-copy{flex:1;min-width:180px}
.qdr-checkin-copy .qdr-checkin-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:15px;font-weight:680;letter-spacing:-.02em}
.qdr-checkin-sub{font-size:11px;color:var(--qdr-muted);margin-top:3px}
.qdr-checkin-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.qdr-switch{appearance:none;display:inline-flex;align-items:center;gap:7px;border:1px solid var(--qdr-line);background:var(--qdr-card);border-radius:999px;padding:4px 9px 4px 4px;font-family:inherit;font-size:10.5px;font-weight:600;color:var(--qdr-muted);cursor:pointer;transition:background .18s,border-color .18s,color .18s,opacity .18s}
.qdr-switch-track{width:30px;height:18px;border-radius:999px;background:var(--qdr-soft-2);position:relative;display:block;transition:background .2s ease}
.qdr-switch-knob{position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:var(--qdr-card);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .22s cubic-bezier(.2,.7,.2,1),background .2s}
.qdr-switch-on{border-color:var(--qdr-accent-border);color:var(--qdr-accent);background:var(--qdr-accent-weak)}
.qdr-switch-on .qdr-switch-track{background:var(--qdr-accent-solid)}
.qdr-switch-on .qdr-switch-knob{transform:translateX(12px);background:#ffffff}
.qdr-switch:disabled{opacity:.5;cursor:not-allowed}
.qdr-checkin-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:13px;padding-top:12px;border-top:1px solid var(--qdr-hero-border)}
.qdr-checkin-summary>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.qdr-checkin-summary span{font-size:9.5px;color:var(--qdr-muted)}
.qdr-checkin-summary strong{font-size:19px;font-weight:680;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.qdr-checkin-summary em{font-style:normal;font-size:9.5px;color:var(--qdr-faint);margin-left:3px}
.qdr-checkin-bad{color:var(--qdr-bad)!important}
.qdr-checkin-devices{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:11px;font-size:10px;color:var(--qdr-muted)}
.qdr-checkin-devices-label{color:var(--qdr-faint)}
.qdr-checkin-device{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:var(--qdr-card);border:1px solid var(--qdr-line)}
.qdr-checkin-device-ok{color:var(--qdr-ok)}
.qdr-checkin-device-bad{color:var(--qdr-warn)}
.qdr-checkin-lastrun{font-size:10px;color:var(--qdr-faint);margin-top:9px}
.qdr-checkin-list{display:flex;flex-direction:column;gap:7px;margin-top:10px}
.qdr-checkin-account{display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid var(--qdr-line);border-radius:14px;background:var(--qdr-soft);min-width:0;transition:border-color .18s,box-shadow .18s,transform .18s,background .18s}
.qdr-checkin-account:hover{transform:translateY(-1px);border-color:var(--qdr-accent-border);box-shadow:var(--qdr-shadow)}
.qdr-checkin-current{border-color:var(--qdr-accent-border);background:var(--qdr-accent-weak)}
.qdr-checkin-mark{width:33px;height:33px;border-radius:10px;background:var(--qdr-card);border:1px solid var(--qdr-line);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:var(--qdr-accent);flex:none}
.qdr-checkin-main{flex:1;min-width:0}
.qdr-checkin-main .qdr-checkin-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;min-width:0}
.qdr-checkin-main .qdr-checkin-title strong{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.qdr-checkin-meta{font-size:10px;color:var(--qdr-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qdr-checkin-status-line{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:5px;font-size:10px;color:var(--qdr-muted)}
.qdr-checkin-message{color:var(--qdr-muted)}
.qdr-checkin-time{margin-left:auto;color:var(--qdr-faint);font-variant-numeric:tabular-nums}
.qdr-checkin-note{margin-top:2px}
.qdr-checkin-mini .qdr-meter{margin-top:9px}
.qdr-checkin-mini-title{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.qdr-checkin-mini-big{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin-top:11px}
.qdr-checkin-mini-big strong{font-size:24px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.qdr-checkin-mini-big span{font-size:11px;color:var(--qdr-muted)}
.qdr-checkin-mini-big em{font-style:normal;margin-left:auto;font-size:12px;font-weight:650;color:var(--qdr-ok)}
.qdr-checkin-mini-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--qdr-faint)}
/* ── Credits 热力图 / 趋势图 ─────────────────────────────────── */
.qdr-credits-heat-card{padding:15px 16px}
.qdr-heat{display:flex;flex-direction:column;gap:6px;margin-top:12px;--qdr-heat-cell:10px}
.qdr-heat-months{display:grid;gap:3px;height:13px;font-size:9px;color:var(--qdr-faint);overflow:hidden}
.qdr-heat-months span{white-space:nowrap;overflow:visible;line-height:13px}
.qdr-heat-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,var(--qdr-heat-cell));grid-auto-columns:var(--qdr-heat-cell);gap:3px;overflow-x:auto;padding-bottom:2px;align-content:flex-start;scrollbar-width:thin}
.qdr-heat-cell{width:var(--qdr-heat-cell);height:var(--qdr-heat-cell);border-radius:3px;display:block;background:var(--qdr-heat-0);transition:transform .15s ease,background .2s ease,outline-color .15s}
.qdr-heat-cell:hover{transform:scale(1.22);outline:1px solid var(--qdr-accent-border);position:relative;z-index:1}
.qdr-heat-0{background:var(--qdr-heat-0)}
.qdr-heat-1{background:var(--qdr-heat-1)}
.qdr-heat-2{background:var(--qdr-heat-2)}
.qdr-heat-3{background:var(--qdr-heat-3)}
.qdr-heat-4{background:var(--qdr-heat-4)}
.qdr-heat-empty{background:transparent}
.qdr-heat-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:9.5px;color:var(--qdr-faint);margin-top:3px}
.qdr-heat-legend{display:inline-flex;align-items:center;gap:4px}
.qdr-heat-legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.qdr-credits-card{padding:16px}
.qdr-credits-toolbar{display:flex;align-items:center;justify-content:space-between;gap:9px;flex-wrap:wrap;margin-bottom:12px}
.qdr-range-display{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px;border:1px solid var(--qdr-line);border-radius:10px;background:var(--qdr-card);font-size:11px;color:var(--qdr-fg);font-variant-numeric:tabular-nums}
.qdr-range-display svg{color:var(--qdr-muted);flex:none}
.qdr-credits-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.qdr-credits-label{font-size:12.5px;font-weight:650;letter-spacing:-.01em}
.qdr-credits-total{display:flex;align-items:center;font-size:27px;font-weight:690;letter-spacing:-.035em;margin-top:4px;font-variant-numeric:tabular-nums;line-height:1.15}
.qdr-credits-info{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:1px solid var(--qdr-line-strong);border-radius:50%;background:transparent;color:var(--qdr-faint);font-size:9px;font-family:inherit;font-weight:600;margin-left:7px;cursor:help;flex:none}
.qdr-credits-info:focus-visible{outline:2px solid var(--qdr-accent);outline-offset:2px}
.qdr-credits-note{margin-top:7px;padding:8px 10px;background:var(--qdr-soft);border-radius:8px}
.qdr-credits-mode{width:118px;flex:none}
.qdr-chart-wrap{position:relative;margin-top:10px}
.qdr-chart-svg{display:block;width:100%;height:auto;overflow:visible;touch-action:none;cursor:crosshair}
.qdr-chart-svg:focus-visible{outline:2px solid var(--qdr-accent);outline-offset:2px;border-radius:6px}
.qdr-chart-grid{stroke:var(--qdr-line);stroke-width:1}
.qdr-chart-axis-label{fill:var(--qdr-faint);font-size:9.5px;font-family:inherit}
.qdr-chart-line{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.qdr-chart-dot{stroke:var(--qdr-card);stroke-width:2;vector-effect:non-scaling-stroke}
.qdr-chart-guide{stroke:var(--qdr-line-strong);stroke-width:1;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
.qdr-chart-tooltip{position:absolute;top:2px;transform:translateX(-50%);pointer-events:none;background:var(--qdr-card);border:1px solid var(--qdr-line);border-radius:10px;box-shadow:0 8px 24px rgba(16,24,40,.14);padding:8px 10px;font-size:10px;min-width:150px;max-width:240px;z-index:3;animation:qdr-pop .14s ease both}
.qdr-chart-tooltip-date{font-weight:650;margin-bottom:4px;color:var(--qdr-fg)}
.qdr-chart-tooltip-row{display:flex;align-items:center;justify-content:space-between;gap:14px;color:var(--qdr-muted);padding:1px 0}
.qdr-chart-tooltip-row strong{color:var(--qdr-fg);font-variant-numeric:tabular-nums;font-weight:650}
.qdr-chart-tooltip-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:middle}
.qdr-chart-legend{display:flex;gap:6px 14px;flex-wrap:wrap;margin-top:10px}
.qdr-chart-legend span{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--qdr-muted)}
.qdr-chart-legend-dot{width:7px;height:7px;border-radius:2px;display:inline-block}
.qdr-chart-legend em{font-style:normal;color:var(--qdr-faint);font-variant-numeric:tabular-nums;margin-left:2px}
.qdr-chart-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--qdr-faint);font-size:11px;pointer-events:none}
.qdr-credits-foot{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;padding-top:9px;border-top:1px solid var(--qdr-line);font-size:9.5px;color:var(--qdr-faint)}
@container qdr (max-width:720px){.qdr-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.qdr-stats-6{grid-template-columns:repeat(2,minmax(0,1fr))}.qdr-grid-2{grid-template-columns:1fr}.qdr-signin-aside{display:none}.qdr-skel-grid{grid-template-columns:repeat(2,1fr)}.qdr-fields{grid-template-columns:1fr}.qdr-quota-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.qdr-usage-id{max-width:100%}.qdr-usage-time{margin-left:0}.qdr-usage-model{max-width:100%}.qdr-editor-hint{margin-left:0;width:100%}.qdr-checkin-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.qdr-account-menu-head{flex-direction:column}.qdr-checkin-actions{width:100%;justify-content:flex-end}}
@container qdr (max-width:520px){.qdr-root{font-size:12.5px}.qdr-subtitle{white-space:normal}.qdr-head{align-items:flex-start}.qdr-title{font-size:16px}.qdr-stat-value{font-size:16px}.qdr-model{padding:10px}.qdr-model-name{white-space:normal}.qdr-toolbar{align-items:stretch}.qdr-search{min-width:100%}.qdr-chips{overflow-x:auto;flex-wrap:nowrap;padding-bottom:1px}.qdr-chip{flex:none}.qdr-savebar{align-items:flex-start}.qdr-savebar-actions{width:100%;justify-content:flex-end}.qdr-signin{padding:13px}.qdr-signin-mark{width:30px;height:30px}.qdr-card{padding:12px}.qdr-card-actions{width:100%;justify-content:flex-end}.qdr-quota-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.qdr-quota-big strong{font-size:21px}.qdr-quota-pct{margin-left:0;width:100%}.qdr-editor{padding:11px}.qdr-model-stat-head{flex-direction:column;gap:3px}.qdr-model-stat-nums{width:100%;justify-content:space-between}.qdr-usage-head{align-items:flex-start}.qdr-usage-tools{width:100%;justify-content:space-between}.qdr-trial-form .qdr-select{max-width:none}.qdr-trial-actions{align-items:flex-start}.qdr-usage-top{row-gap:3px}.qdr-quota-wide{padding:12px}.qdr-quota-wide .qdr-quota-big strong{font-size:26px}.qdr-checkin-actions{width:100%;justify-content:space-between}.qdr-checkin-actions .qdr-switch{grid-column:1/-1;justify-self:start;width:auto}.qdr-credits-toolbar{align-items:flex-start}.qdr-credits-mode{width:110px}.qdr-checkin-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.qdr-checkin-account{align-items:flex-start;flex-wrap:wrap}.qdr-checkin-account>button{width:100%;justify-content:center}.qdr-checkin-time{margin-left:0}.qdr-checkin-mini-big em{margin-left:0;width:100%}.qdr-account-actions{width:100%;justify-content:flex-end}.qdr-account-strip{flex-wrap:wrap}.qdr-account-main{flex:1 1 190px}.qdr-account-menu-title strong{white-space:normal}.qdr-account-row{flex-wrap:wrap}.qdr-account-row>button{width:100%;justify-content:center;margin-top:2px}.qdr-account-row>button:disabled{width:auto;align-self:flex-end;justify-content:flex-end}.qdr-account-title strong{white-space:normal}.qdr-account-row .qdr-account-meta{white-space:normal;overflow-wrap:anywhere}.qdr-account-list-foot{align-items:flex-start}.qdr-account-foot-actions{width:100%;justify-content:flex-end}.qdr-heat{--qdr-heat-cell:5px}.qdr-credits-toolbar{flex-direction:column;align-items:stretch}.qdr-credits-toolbar>button{align-self:flex-end}.qdr-chart-axis-label{font-size:16px}.qdr-checkin-account>button:disabled{width:auto;justify-content:flex-end;align-self:flex-end}.qdr-checkin-actions{display:grid;grid-template-columns:auto 1fr;gap:6px}.qdr-checkin-actions .qdr-switch{grid-column:1/-1;justify-self:start;width:auto}.qdr-checkin-actions>button:last-child{justify-self:end}.qdr-range-display{width:100%;justify-content:flex-start}.qdr-credits-toolbar .qdr-chips{width:100%;overflow-x:auto;flex-wrap:nowrap}.qdr-credits-mode{width:100%}.qdr-credits-total{font-size:24px}.qdr-credits-heat-card,.qdr-credits-card{padding:12px}}
`;
      document.head.appendChild(style);
      return () => { try { style.remove(); } catch { /* ignore */ } };
    }

    function ChatQuotaPill() {
      const [data, setData] = useState(null);
      const [pending, setPending] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [accountExtras, setAccountExtras] = useState(null);
      const [quotaTried, setQuotaTried] = useState(false);
      const [authEpoch, setAuthEpoch] = useState(0);
      const alive = useRef(true);
      const statusSeq = useRef(0);
      const quotaSeq = useRef(0);
      const loadStatus = useCallback(() => {
        const seq = ++statusSeq.current;
        getJson('/qoder/status').then((next) => {
          if (alive.current && seq === statusSeq.current) setData(next);
        }).catch(() => {});
      }, []);
      useEffect(() => {
        alive.current = true;
        loadStatus();
        const onAuth = () => {
          if (!alive.current) return;
          statusSeq.current += 1;
          quotaSeq.current += 1;
          setAccountExtras(null);
          setQuotaTried(false);
          setData(null);
          // 登录状态已经变了：旧的设备授权会话不再有意义，继续轮询只会拿到“已过期”。
          setPending(null);
          setBusy(false);
          setError('');
          setAuthEpoch((value) => value + 1);
          loadStatus();
        };
        const onQuota = (event) => {
          if (!alive.current) return;
          if (event && event.detail && event.detail.extras) setAccountExtras(event.detail.extras);
        };
        window.addEventListener('qoder:auth-changed', onAuth);
        window.addEventListener('qoder:quota-changed', onQuota);
        return () => {
          alive.current = false;
          window.removeEventListener('qoder:auth-changed', onAuth);
          window.removeEventListener('qoder:quota-changed', onQuota);
        };
      }, [loadStatus]);
      useVisibilityPoll(loadStatus, 45_000);
      const signedIn = Boolean(data && data.signedIn);
      const loadQuota = useCallback(async () => {
        const seq = ++quotaSeq.current;
        try {
          const account = await getJson('/qoder/account');
          if (alive.current && seq === quotaSeq.current) setAccountExtras(account.extras || null);
        } catch { /* 额度读取失败不挡住对话页 */ } finally {
          if (alive.current && seq === quotaSeq.current) setQuotaTried(true);
        }
      }, []);
      useEffect(() => {
        if (!signedIn) return;
        loadQuota();
      }, [signedIn, authEpoch, loadQuota]);
      useVisibilityPoll(loadQuota, 3 * 60_000, signedIn);
      useEffect(() => {
        if (!pending) return undefined;
        let stopped = false;
        let settled = false;
        let polling = false;
        const timer = setInterval(async () => {
          if (polling || settled) return;
          polling = true;
          try {
            const result = await postJson('/qoder/auth/poll', { id: pending.id });
            if (stopped || settled || !alive.current) return;
            if (result.status === 'ready') {
              settled = true;
              setPending(null);
              setBusy(false);
              setError('');
              try { window.dispatchEvent(new CustomEvent('qoder:auth-changed')); } catch { /* ignore */ }
            } else if (result.status === 'expired' || result.status === 'error' || result.ok === false) {
              settled = true;
              setPending(null);
              setBusy(false);
              setError(result.error || '授权超时，请重试');
            }
          } catch (err) {
            if (!stopped && !settled && alive.current) {
              // 5xx / 断网只提示，不丢弃授权会话；明确的 4xx 才结束。
              if (!err.status || err.status >= 500) setError('网络波动，正在重试授权状态…');
              else {
                settled = true;
                setPending(null);
                setBusy(false);
                setError(String(err.message || err));
              }
            }
          } finally {
            polling = false;
          }
        }, 2400);
        const expire = setTimeout(() => {
          if (stopped || settled || !alive.current) return;
          settled = true;
          setPending(null);
          setBusy(false);
          setError('授权超时，请重试');
        }, Math.max(30_000, (pending.expiresAt || (Date.now() + 600_000)) - Date.now()));
        return () => { stopped = true; clearInterval(timer); clearTimeout(expire); };
      }, [pending]);
      if (!data) return null;
      const today = (data.usage && data.usage.today) || {};
      if (!data.signedIn) {
        const start = async () => {
          if (pending) {
            try { window.open(pending.uri, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
            return;
          }
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const result = await postJson('/qoder/auth/device', { region: data.region || 'global' });
            if (!alive.current) return;
            if (!result.ok) throw new Error(result.error || '发起授权失败');
            setPending({
              id: result.id,
              uri: result.verificationUri,
              expiresAt: Date.now() + num(result.expiresIn || 600) * 1000,
            });
            try { window.open(result.verificationUri, '_blank', 'noopener,noreferrer'); } catch { /* link opened by user */ }
          } catch (err) {
            if (alive.current) setError(String(err.message || err));
          } finally {
            if (alive.current) setBusy(false);
          }
        };
        return h('span', { className: 'qdr-chat-login-wrap' },
          h('button', {
            type: 'button',
            className: `qdr-pill qdr-chat-login${error ? ' qdr-chat-login-bad' : ''}`,
            onClick: start,
            title: pending ? '等待浏览器授权，点击重新打开授权页' : (error || '在浏览器里登录 Qoder，完成后模型会自动出现在选择器里'),
            'aria-live': 'polite',
          },
          h(StatusDot, { tone: error ? 'bad' : pending ? 'warn' : 'neutral' }),
          h('span', null, pending ? '等待授权…' : busy ? '打开授权页…' : error ? '重新连接 Qoder' : '连接 Qoder')),
          pending ? h('a', {
            className: 'qdr-chat-login-link', href: safeHref(pending.uri), target: '_blank', rel: 'noreferrer noopener',
            title: '重新打开授权页',
          }, '打开授权页') : null,
          error ? h('span', { className: 'qdr-chat-login-error', title: error }, error) : null);
      }
      // status 里的 extras 与 /qoder/account 拉到的 extras 都是同一份缓存的快照；
      // 之前固定优先 status，导致 qoder:quota-changed 刚推来的新额度被旧值盖住，
      // 胶囊要等下一次 45 秒轮询才更新。按 at 取更新的那份。
      const statusExtras = data && data.extras;
      const extras = statusExtras && accountExtras
        ? ((Number(accountExtras.at) || 0) >= (Number(statusExtras.at) || 0) ? accountExtras : statusExtras)
        : (accountExtras || statusExtras);
      const quota = quotaSummary(extras);
      const low = quota && (quota.exceeded || quota.ratio >= 0.9);
      const title = quota
        ? `Qoder 额度：${money(quota.remaining)} / ${money(quota.total)} ${quota.unit} · 已用 ${Math.round(quota.ratio * 100)}%${quota.at ? ` · 更新于 ${stamp(quota.at)}` : ''}${quota.expiresAt ? ` · ${dateLabel(quota.expiresAt)} 到期` : ''} · 今日 ${today.requests || 0} 次（设置 → Qoder）`
        : quotaTried
          ? 'Qoder 已连接 · 额度暂时读取失败（设置 → Qoder 可刷新）'
          : `Qoder 已连接 · 正在读取额度（今日 ${today.requests || 0} 次）`;
      return h('div', { className: `qdr-pill qdr-chat-usage${low ? ' qdr-chat-usage-low' : ''}`, title },
        h('span', { className: 'qdr-logo', style: { width: 16, height: 16, borderRadius: 4, fontSize: 10, boxShadow: 'none' } }, 'Q'),
        h('span', null, 'Qoder'),
        quota
          ? h(React.Fragment, null,
            h('span', { className: 'qdr-chat-usage-label' }, '额度'),
            h('span', { className: 'qdr-chat-usage-quota' }, `${money(quota.remaining)} / ${money(quota.total)}`))
          : h('span', { className: 'qdr-chat-usage-num' }, quotaTried ? '额度 —' : '额度读取中…'));
    }

    function apply(ctx) {
      const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined);
      if (!slots || typeof slots.register !== 'function') {
        try { console.error('qoder-to-dsh: slots service unavailable'); } catch { /* ignore */ }
        return;
      }
      ctx.effect(() => {
        const disposeStyles = insertStyles();
        const disposeSlot = slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'qoder',
          order: 60,
          label: 'Qoder',
        }, Panel));
        let disposePill = null;
        try {
          disposePill = slots.inject('conversation.session.header.utilities', () => slots.register({
            name: 'conversation.session.header.utilities',
            id: 'qoder-quota',
            order: 20,
          }, ChatQuotaPill));
        } catch { /* older dsh: slot may not exist */ }
        return () => {
          try { disposePill && disposePill(); } catch { /* ignore */ }
          try { disposeSlot && disposeSlot(); } catch { /* ignore */ }
          disposeStyles();
        };
      }, 'qoder.panel');
    }

    exports.name = 'qoder-client';
    exports.apply = apply;
    exports.inject = ['slots'];
    exports.QoderPanel = Panel;
    exports.getJson = getJson;
    exports.postJson = postJson;
    exports.safeHref = safeHref;
    exports.versionNotice = versionNotice;
    exports.settingsNotice = settingsNotice;
    exports.usageBadges = usageBadges;
    exports.partialDataNote = partialDataNote;
    exports.accountIdentityNote = accountIdentityNote;
    exports.checkinNotice = checkinNotice;
    exports.startVisibilityPoll = startVisibilityPoll;
    exports.toEpochMs = toEpochMs;
    exports.autoOutputTokens = autoOutputTokens;
    return module.exports;
  }

  const ids = new Set(['qoder-to-dsh', 'dsh-plugin-qoder']);
  try {
    const src = document.currentScript && document.currentScript.src;
    if (src) {
      const match = /\/plugins\/(?:\?\?)?([^/]+)\/client\.js(?:[?&#]|$)/.exec(String(src));
      if (match) ids.add(decodeURIComponent(match[1]));
    }
  } catch { /* fall back to known ids */ }
  for (const id of ids) {
    try { window.__ModuleLoader__.load({ id, factory }); } catch (error) {
      if (!/duplicate factory registration/.test(String((error && error.message) || error))) throw error;
    }
  }
})();
