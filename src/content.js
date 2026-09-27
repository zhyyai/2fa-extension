/**
 * Content Script
 *
 * 职责：
 *   1. 页面加载即向 background 上报 hostname（不申请 tabs 权限，避免权限提示过重）
 *   2. 检测页面上的 2FA 输入框
 *   3. 接收 popup 的填充指令，用 native setter 写入（React/Vue 受控组件必须走这条路）
 *
 * 安全边界：只读取输入框位置并写入值，**绝不自动提交表单** —— 提交必须由用户操作。
 */

(function () {
  'use strict';

  // 1) 站点识别上报
  try {
    chrome.runtime.sendMessage({
      type: 'HOST_REPORT',
      hostname: window.location.hostname,
    });
  } catch {
    /* 扩展被禁用或上下文失效时静默 */
  }

  const SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="2fa" i]',
    'input[name*="mfa" i]',
    'input[name*="verification_code" i]',
    'input[id*="otp" i]',
    'input[placeholder*="验证码"]',
    'input[placeholder*="verification" i]',
    'input[maxlength="6"][inputmode="numeric"]',
    'input[maxlength="6"][type="tel"]',
  ];

  function findOtpInputs() {
    const results = [];
    for (const selector of SELECTORS) {
      try {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
          if (node.type === 'hidden' || node.disabled) continue;
          if (results.includes(node)) continue;
          results.push(node);
        }
      } catch {
        /* 某些选择器在特定浏览器下不合法，跳过 */
      }
    }
    return results;
  }

  /** 受控组件必须走 native setter，直接赋 value 不会触发框架状态更新 */
  function fillInput(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.focus?.();
  }

  // 2) 响应 popup 的探测与填充
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PING_INPUTS') {
      sendResponse({ count: findOtpInputs().length });
      return;
    }

    // 剪贴板兜底：页面上下文有 Clipboard API，可替 service worker 完成复制
    if (message?.type === 'CLIPBOARD_WRITE') {
      const text = String(message.text ?? '');
      (async () => {
        try {
          await navigator.clipboard.writeText(text);
          sendResponse({ ok: true });
        } catch {
          try {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.select();
            const ok = document.execCommand('copy');
            textArea.remove();
            sendResponse(ok ? { ok: true } : { ok: false, reason: 'execCommand 复制失败' });
          } catch (error) {
            sendResponse({ ok: false, reason: error?.message || String(error) });
          }
        }
      })();
      return true;
    }

    if (message?.type === 'DO_FILL') {
      const inputs = findOtpInputs();
      if (inputs.length === 0) {
        sendResponse({ ok: false, reason: '未找到 2FA 输入框' });
        return;
      }
      // 只填第一个（多输入框场景极少，且误填风险高于收益）
      fillInput(inputs[0], message.code);
      sendResponse({ ok: true });
      return;
    }
  });

  // 3) 页面获得焦点时重新上报（用户切换标签页后 hostname 会变）
  window.addEventListener('focus', () => {
    try {
      chrome.runtime.sendMessage({
        type: 'HOST_REPORT',
        hostname: window.location.hostname,
      });
    } catch {
      /* 静默 */
    }
  });
})();
