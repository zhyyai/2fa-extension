/**
 * 剪贴板写入
 *
 * ⚠️ 这是 MV3 的一个真实陷阱：extension service worker 里 **没有** navigator.clipboard
 *    （ServiceWorkerGlobalScope 不实现 Clipboard API）。原实现直接 `navigator.clipboard
 *    .writeText()` 在 SW 中会抛 TypeError，导致"复制验证码"这个主功能完全不可用。
 *
 * 三级降级链：
 *   1. 当前上下文有 Clipboard API（popup / options / offscreen 页面）→ 直接用
 *   2. 否则创建 offscreen document（Chrome 109+，reason: CLIPBOARD）→ 转发写入
 *   3. 再不行 → 发给当前活动标签页的 content script 用 execCommand('copy') 兜底
 *
 * 之所以必须"并发"而不是"先复制再上推 HOTP"：浏览器要求剪贴板写入发生在用户激活
 * 有效期内，一旦先 await 网络请求，激活就失效了。上游 core.js 也用 Promise.allSettled
 * 同时发起复制与计数器预留（src/ui/scripts/core.js:557）。
 */

/**
 * 扩展内的路径一律**相对于扩展根目录**（也就是 src/，加载时选的就是它）。
 * 曾经这里写成 'src/offscreen.html'，会在 src/src/offscreen.html 找 —— 必挂。
 */
const OFFSCREEN_URL = 'offscreen.html';

let offscreenCreating = null;

export function hasClipboardApi() {
  return typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.writeText);
}

/** 创建（或复用）offscreen document。并发调用共享同一个 Promise，避免重复创建。 */
async function ensureOffscreen() {
  if (typeof chrome.offscreen === 'undefined') {
    throw new Error('当前浏览器不支持 offscreen document');
  }

  const existing = await chrome.runtime.getContexts?.({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing?.length) return;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: '在 service worker 中复制 2FA 验证码到剪贴板',
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

/**
 * 向 offscreen document 转发写入。
 *
 * ⚠️ createDocument() resolve 只保证文档**开始加载**，不保证它的 onMessage 监听器
 *    已经挂上。此时 sendMessage 会因为没有接收者而抛
 *    "Could not establish connection. Receiving end does not exist."。
 *    所以这里做短间隔重试，而不是乐观地发一次了事。
 */
async function writeViaOffscreen(text, { attempts = 3, delayMs = 60 } = {}) {
  await ensureOffscreen();

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_WRITE',
        target: 'offscreen',
        text,
      });
      if (response?.ok) return;
      throw new Error(response?.reason || 'offscreen 写入剪贴板失败');
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeViaActiveTab(text) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('没有活动的标签页可用于复制');
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'CLIPBOARD_WRITE', text });
  if (!response?.ok) throw new Error(response?.reason || '页面内复制失败');
}

/**
 * 写入剪贴板。
 * @param {string} text
 * @returns {Promise<{ok: true, via: string}>}
 */
export async function writeClipboard(text) {
  if (hasClipboardApi()) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, via: 'clipboard-api' };
    } catch {
      /* 落到下一级 */
    }
  }
  try {
    await writeViaOffscreen(text);
    return { ok: true, via: 'offscreen' };
  } catch {
    /* 落到下一级 */
  }
  await writeViaActiveTab(text);
  return { ok: true, via: 'content-script' };
}

/** 清空剪贴板（best-effort，失败静默） */
export async function clearClipboard() {
  try {
    await writeClipboard('');
  } catch {
    /* 清除失败不打断流程 */
  }
}
