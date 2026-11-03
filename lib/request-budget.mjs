/**
 * 请求体预算：Qoder 的上限按字节而不是 token 算。
 *
 * 官方 CLI 1.1.81 起单次请求最多保留最近 50 张图片；网关侧还有约 50 MiB
 * 的请求体上限。截图密集的会话经常在上下文只有几个百分点时就撞到 413/502，
 * 而 token 预算完全看不出来。这里在发请求前做一次确定性裁剪：
 *   1. 超过 maxImages 时从最旧的图片开始降级成文本占位；
 *   2. 仍超过 maxBytes 时继续从最旧的图片开始降级；
 *   3. 返回裁剪统计，调用方写日志/面板，不静默。
 */
const PLACEHOLDER = '[图片已省略：单次请求的图片数量或体积超过 Qoder 上限]';

function imageParts(messages) {
  const out = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const content = messages[messageIndex]?.content;
    if (!Array.isArray(content)) continue;
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      if (content[partIndex]?.type === 'image_url') out.push({ messageIndex, partIndex });
    }
  }
  return out;
}

function replaceWithText(messages, ref) {
  const content = messages[ref.messageIndex]?.content;
  if (!Array.isArray(content) || !content[ref.partIndex]) return false;
  content[ref.partIndex] = { type: 'text', text: PLACEHOLDER };
  return true;
}

function bodyBytes(messages) {
  try { return Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { return 0; }
}

/**
 * @param {Array} messages 已经过 sanitizeWire 的 OpenAI 消息
 * @param {{maxImages?: number, maxBytes?: number}} limits
 * @returns {{messages: Array, bytes: number, images: number, dropped: number, droppedByCount: number, droppedByBytes: number}}
 */
export function trimImages(messages, { maxImages = 50, maxBytes = 40 * 1024 * 1024 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const maxCount = Number.isFinite(Number(maxImages)) ? Math.max(0, Math.floor(Number(maxImages))) : 50;
  const maxSize = Number.isFinite(Number(maxBytes)) ? Math.max(0, Number(maxBytes)) : 40 * 1024 * 1024;
  const refs = imageParts(list);
  const total = refs.length;
  let droppedByCount = 0;
  let droppedByBytes = 0;

  // 保留最近的 maxCount 张：refs 按消息顺序，最旧的在前面。
  for (let index = 0; index < refs.length - maxCount; index += 1) {
    if (replaceWithText(list, refs[index])) droppedByCount += 1;
  }

  let bytes = bodyBytes(list);
  if (bytes > maxSize) {
    for (const ref of refs.slice(Math.max(0, refs.length - maxCount))) {
      if (bytes <= maxSize) break;
      if (!Array.isArray(list[ref.messageIndex]?.content)
        || list[ref.messageIndex].content[ref.partIndex]?.type !== 'image_url') continue;
      if (replaceWithText(list, ref)) {
        droppedByBytes += 1;
        bytes = bodyBytes(list);
      }
    }
  }

  return {
    messages: list,
    bytes,
    images: total - droppedByCount - droppedByBytes,
    dropped: droppedByCount + droppedByBytes,
    droppedByCount,
    droppedByBytes,
  };
}

export const __test = { PLACEHOLDER, bodyBytes, imageParts };
