/**
 * 请求级首包守卫：把调用方的 AbortSignal 与首包截止时间合并成一条
 * 传给 fetch 的信号。首块数据到达时调用 clear()，但监听器保留到
 * dispose()，这样后续仍能响应调用方取消。
 */
export function createFirstByteGuard({ signal = null, timeoutMs = 0, label = '首包' } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) relayAbort();
    else signal.addEventListener('abort', relayAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(`Qoder ${Math.max(1, Math.round(timeoutMs / 1000))} 秒内没有返回${label}`);
      error.code = 'FIRST_BYTE_TIMEOUT';
      controller.abort(error);
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    dispose() {
      this.clear();
      if (signal) signal.removeEventListener('abort', relayAbort);
    },
  };
}
