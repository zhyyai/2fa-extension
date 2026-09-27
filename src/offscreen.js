/**
 * Offscreen document
 *
 * 唯一职责：为 service worker 提供 DOM/Clipboard 能力。
 * 它不持有任何密钥或 token —— 只接收已经算好的验证码字符串。
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;
  if (message?.type !== 'OFFSCREEN_WRITE') return;

  (async () => {
    const text = String(message.text ?? '');
    try {
      await navigator.clipboard.writeText(text);
      sendResponse({ ok: true });
    } catch (error) {
      // execCommand 兜底：某些环境下 Clipboard API 因权限策略被拒
      try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        const ok = document.execCommand('copy');
        textArea.remove();
        if (!ok) throw error;
        sendResponse({ ok: true });
      } catch (fallbackError) {
        sendResponse({ ok: false, reason: fallbackError?.message || String(fallbackError) });
      }
    }
  })();

  return true;
});
