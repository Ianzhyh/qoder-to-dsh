/**
 * 把父信号与一个内部 controller 合并成一条可主动取消的信号。
 * Node 18 没有 AbortSignal.any()，这里手动转发；dispose() 负责解除监听。
 */
export function createLinkedSignal(parent = null) {
  const controller = new AbortController();
  const relay = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) relay();
    else parent.addEventListener('abort', relay, { once: true });
  }
  let disposed = false;
  return {
    signal: controller.signal,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (parent) parent.removeEventListener('abort', relay);
    },
  };
}

/**
 * 请求级首包守卫：把调用方的 AbortSignal 与首包截止时间合并成一条
 * 传给 fetch 的信号。首块数据到达时调用 clear()，但监听器保留到
 * dispose()，这样后续仍能响应调用方取消。
 */
export function createFirstByteGuard({ signal = null, timeoutMs = 0, label = '首包' } = {}) {
  const linked = createLinkedSignal(signal);
  let timedOut = false;
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(`Qoder ${Math.max(1, Math.round(timeoutMs / 1000))} 秒内没有返回${label}`);
      error.code = 'FIRST_BYTE_TIMEOUT';
      linked.abort(error);
    }, timeoutMs);
  }
  return {
    signal: linked.signal,
    get timedOut() { return timedOut; },
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    dispose() {
      this.clear();
      linked.dispose();
    },
  };
}
