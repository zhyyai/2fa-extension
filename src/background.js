/**
 * MV3 Service Worker —— 扩展的中枢
 *
 * 职责：
 *   1. 持有会话凭据（chrome.storage.session，不落盘；浏览器关闭即失效）
 *   2. 拉取并缓存密钥条目，按请求实时生成 OTP（secret 只在内存/会话内存活）
 *   3. 处理 popup 与 content script 的消息
 *   4. 自动锁定（默认 5 分钟无操作）+ 剪贴板 30 秒清除
 *
 * ── 与上游 wuzf/2fa v1.9.0 对齐的三个关键点 ──────────────────────────
 *
 * A) 认证：上游 verifyAuth() 在 Cookie 缺失时直接读 Authorization: Bearer
 *    （src/utils/auth.js:427），且登录响应体已带 token（auth.js:754）。
 *    → **服务端零改动**。SameSite=Strict 的 Cookie 跨站带不上，用 Bearer 绕开。
 *
 * B) 跨域：上游 isOriginAllowed() 只允许同源（src/utils/security.js:53），
 *    chrome-extension:// origin 拿不到 CORS 头。解决办法是让所有请求从 SW 发出
 *    并持有目标 origin 的 host 权限（MV3 下带 host 权限的请求豁免 CORS）。
 *    → 只申请用户服务器那一个 origin，不申请 <all_urls>。见 ensureHostPermission()。
 *
 * C) HOTP：上游不接受"我用到 N 了"，而要求提交快照做乐观并发校验
 *    （src/api/secrets/counter.js:82-102），任一项不符即 409。
 *    → advanceHotp(entry) 会带上 expected* 四件套；成功后本地 counter 才 +1。
 *
 * 安全定位：chrome.storage.session 是内存级存储，强度 ≈ 设备锁。
 *   窃取它 = 窃取该设备上的令牌，但不泄露主密码。
 */

import { ApiClient, ApiError, isHotp, entryLabel, normalizeSecrets } from './lib/api.js';
import { generateForEntry } from './lib/otp.js';
import { matchEntriesForHost } from './lib/match.js';
import { writeClipboard, clearClipboard } from './lib/clipboard.js';
import { findDuplicate } from './lib/secret-input.js';

const LOCK_ALARM = 'authforge-lock';
const CLIPBOARD_ALARM = 'authforge-clear-clipboard';
const DEFAULT_LOCK_MINUTES = 5;
const CLIPBOARD_CLEAR_SECONDS = 31;
const ENTRIES_TTL_MS = 30 * 1000;

/** 内存态：SW 存活期间有效，回收即清空（天然安全） */
const memory = {
  client: null,
  entries: [],
  entriesAt: 0,
  lastActivityAt: 0,
  currentHost: null,
};

/* ------------------------------------------------------------------ */
/* 配置读写                                                             */
/* ------------------------------------------------------------------ */

async function getConfig() {
  const { config } = await chrome.storage.sync.get('config');
  return {
    serverUrl: config?.serverUrl ?? '',
    endpoints: config?.endpoints ?? {},
    lockMinutes: config?.lockMinutes ?? DEFAULT_LOCK_MINUTES,
    cacheToSession: config?.cacheToSession ?? true,
    autoFillEnabled: config?.autoFillEnabled ?? true,
    clipboardClear: config?.clipboardClear ?? true,
    // 记住登录：token 额外写入 storage.local（磁盘），重启浏览器免登录。
    // 关闭时退回"仅会话"语义（storage.session，浏览器关闭即失效）。
    keepLoggedIn: config?.keepLoggedIn ?? true,
  };
}

async function saveConfig(patch) {
  const current = await getConfig();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ config: next });
  return next;
}

async function loadToken() {
  if (memory.client?.token) return memory.client.token;
  const { token } = await chrome.storage.session.get('token');
  if (token) return token;
  // 记住登录：会话已失效（浏览器重启等）时回落到本机持久化 token
  const config = await getConfig();
  if (config.keepLoggedIn) {
    const local = await chrome.storage.local.get('token');
    if (local.token) {
      // 回填会话存储，后续读取不再走磁盘
      await chrome.storage.session.set({ token: local.token });
      return local.token;
    }
  }
  return null;
}

async function persistToken(token) {
  await chrome.storage.session.set({ token });
  const config = await getConfig();
  if (config.keepLoggedIn && token) {
    await chrome.storage.local.set({ token, tokenSavedAt: Date.now() });
  }
}

/**
 * 清理会话。
 * @param {object} [opts]
 * @param {boolean} [opts.includeLocal] 同时删除本机持久化 token。显式登出时必须传；
 *   自动锁定时不传 —— keepLoggedIn 下"锁定"的语义是清缓存，不打断登录态。
 */
async function clearSession({ includeLocal = false } = {}) {
  memory.client = null;
  memory.entries = [];
  memory.entriesAt = 0;
  await chrome.storage.session.remove('token');
  await chrome.storage.session.remove('entries');
  if (includeLocal) {
    await chrome.storage.local.remove('token');
    await chrome.storage.local.remove('tokenSavedAt');
  } else {
    const config = await getConfig();
    if (!config.keepLoggedIn) {
      await chrome.storage.local.remove('token');
      await chrome.storage.local.remove('tokenSavedAt');
    }
  }
  await chrome.alarms.clear(LOCK_ALARM);
}

/* ------------------------------------------------------------------ */
/* Host 权限（跨域豁免的前提）                                          */
/* ------------------------------------------------------------------ */

/**
 * 检查是否已获得目标 origin 的 host 权限。
 * 未获得时抛 HOST_PERMISSION_REQUIRED，UI 据此引导用户点一次授权按钮。
 */
async function ensureHostPermission(client, { request = false } = {}) {
  const origin = client.originPermission;
  if (!origin) return false;

  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  if (request) {
    return chrome.permissions.request({ origins: [origin] });
  }

  const error = new ApiError(
    `尚未授权访问 ${origin}。跨域调用需要该站点的主机权限（MV3 用它豁免 CORS）。`,
    { status: 0, code: 'HOST_PERMISSION_REQUIRED' },
  );
  error.origin = origin;
  throw error;
}

/* ------------------------------------------------------------------ */
/* 客户端与数据                                                         */
/* ------------------------------------------------------------------ */

async function ensureClient({ requirePermission = true } = {}) {
  const config = await getConfig();
  if (!config.serverUrl) throw new ApiError('尚未配置服务器地址', { code: 'NOT_CONFIGURED' });

  if (!memory.client) {
    memory.client = new ApiClient({
      serverUrl: config.serverUrl,
      endpoints: config.endpoints,
    });
  }
  memory.client.serverUrl = config.serverUrl;
  memory.client.endpoints = { ...memory.client.endpoints, ...config.endpoints };
  if (!memory.client.token) memory.client.token = await loadToken();

  if (requirePermission) await ensureHostPermission(memory.client);
  return memory.client;
}

/**
 * 统一的网络调用入口：401 时用 refreshToken 续一次再重试。
 * 上游 JWT 默认 30 天有效，改主密码会让所有 token 立即失效（JWT 密钥就是密码哈希）。
 */
async function callApi(fn) {
  const client = await ensureClient();
  try {
    return await fn(client);
  } catch (error) {
    if (error?.status !== 401 || !client.token) throw error;
    try {
      const refreshed = await client.refreshToken();
      await persistToken(refreshed.token);
      return await fn(client);
    } catch {
      // 续期失败说明凭据已作废（多半是改过主密码），清空会话让用户重新登录
      await clearSession();
      throw new ApiError('登录已失效，请重新登录', { status: 401, code: 'SESSION_EXPIRED' });
    }
  }
}

async function refreshEntries({ force = false } = {}) {
  const now = Date.now();
  if (!force && memory.entries.length && now - memory.entriesAt < ENTRIES_TTL_MS) {
    return memory.entries;
  }

  const entries = await callApi((client) => client.listSecrets());
  memory.entries = normalizeSecrets(entries);
  memory.entriesAt = now;

  const config = await getConfig();
  if (config.cacheToSession) {
    await chrome.storage.session.set({ entries: memory.entries, entriesAt: now });
  }
  return memory.entries;
}

async function restoreFromSession() {
  if (memory.entries.length) return;
  const cached = await chrome.storage.session.get(['entries', 'entriesAt']);
  if (Array.isArray(cached.entries)) {
    memory.entries = cached.entries;
    memory.entriesAt = cached.entriesAt ?? 0;
  }
}

function findEntry(id) {
  return memory.entries.find((item) => String(item.id) === String(id)) ?? null;
}

/** 把服务端返回的新 counter 回写到内存与会话缓存 */
async function commitCounter(id, counter) {
  const index = memory.entries.findIndex((item) => String(item.id) === String(id));
  if (index === -1) return;
  memory.entries[index] = { ...memory.entries[index], counter };
  const config = await getConfig();
  if (config.cacheToSession) {
    await chrome.storage.session.set({ entries: memory.entries, entriesAt: memory.entriesAt });
  }
}

/* ------------------------------------------------------------------ */
/* 锁定与剪贴板                                                         */
/* ------------------------------------------------------------------ */

async function scheduleLock() {
  const config = await getConfig();
  const minutes = Math.max(1, Number(config.lockMinutes) || DEFAULT_LOCK_MINUTES);
  await chrome.alarms.clear(LOCK_ALARM);
  await chrome.alarms.create(LOCK_ALARM, { delayInMinutes: minutes });
}

function touch() {
  memory.lastActivityAt = Date.now();
  // 刻意不 await：touch() 在消息热路径上，不该阻塞。
  // 但必须挂 catch，否则闹钟创建失败会变成 unhandled rejection。
  scheduleLock().catch((error) => {
    console.warn('[2fa-ext] 设置自动锁定闹钟失败', error);
  });
}

/**
 * Chrome 的 alarm 最小间隔是 30 秒，且低于该值会被静默上调 —
 * 这里用 31 秒明确避开边界，避免"30 秒清除"实际变成不确定的更久。
 */
async function scheduleClipboardClear() {
  await chrome.alarms.clear(CLIPBOARD_ALARM);
  await chrome.alarms.create(CLIPBOARD_ALARM, {
    delayInMinutes: CLIPBOARD_CLEAR_SECONDS / 60,
  });
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                             */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // offscreen document 的专用消息不在这里处理
  if (message?.target === 'offscreen') return;

  const type = message?.type;

  // HOST_REPORT 由每个页面的 content script 在加载时发出。
  // 它绝不能触发 storage IO —— 否则每次开网页都会唤醒 service worker，
  // 这是 MV3 明确的性能反模式（白白烧 CPU，并加速 SW 回收）。
  if (type === 'HOST_REPORT') {
    const newHost = message.hostname ?? null;
    if (memory.currentHost !== newHost) {
      memory.currentHost = newHost;
      // 仅在站点变化时写一次 session —— 同站导航零写入（仍避免每页导航的 storage IO 反模式）。
      // 持久到会话存储是为了添加页的站点预填在 SW 被回收重启后依然可用。
      chrome.storage.session.set({ lastHost: newHost }).catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }

  // 添加页的站点预填（GET_SITE_HINT）：内存优先，SW 重启后回落会话存储。
  // 无 host 不算错误 —— 没有可识别站点时添加页就保持空白让用户手填。
  if (type === 'GET_SITE_HINT') {
    (async () => {
      if (memory.currentHost) return sendResponse({ host: memory.currentHost });
      const { lastHost } = await chrome.storage.session.get('lastHost');
      sendResponse({ host: lastHost ?? null });
    })().catch(() => sendResponse({ host: null }));
    return true; // 异步应答
  }

  const handled = (async () => {
    if (type !== 'CONFIG_GET') await restoreFromSession();
    touch();

    switch (type) {
      case 'CONFIG_GET':
        return { config: await getConfig() };

      case 'CONFIG_SET':
        return { config: await saveConfig(message.patch ?? {}) };

      // 注意：授予权限必须由**页面在用户手势中**调用 chrome.permissions.request()
      //      （见 options.js）。service worker 不在手势上下文里，调用必然被 Chrome 拒绝，
      //      所以这里刻意不提供 PERMISSION_REQUEST 消息，避免给出一个永远失败的入口。
      case 'PERMISSION_CHECK': {
        const client = await ensureClient({ requirePermission: false });
        const granted = await ensureHostPermission(client).then(
          () => true,
          () => false,
        );
        return { granted, origin: client.originPermission };
      }

      case 'LOGIN': {
        const credential = message.credential ?? message.password;
        if (!credential) throw new ApiError('请输入主密码');
        const client = await ensureClient();
        // 上游字段名为 credential；登录成功会立刻拉一次列表，顺带验证 Bearer 可用
        const result = await client.login(credential);
        await persistToken(result.token);
        await scheduleLock();
        const entries = await refreshEntries({ force: true });
        return { ok: true, count: entries.length, expiresAt: result.expiresAt };
      }

      case 'REFRESH_TOKEN': {
        const client = await ensureClient();
        const result = await client.refreshToken();
        await persistToken(result.token);
        return { ok: true, expiresAt: result.expiresAt };
      }

      case 'LOGOUT':
        // 显式登出：连本机持久化 token 一起清除
        await clearSession({ includeLocal: true });
        return { ok: true };

      case 'REFRESH': {
        const entries = await refreshEntries({ force: true });
        return { ok: true, count: entries.length };
      }

      /**
       * 新增条目并写入服务端。
       *
       * 提交成功后必须让本地缓存失效 —— 否则新条目要等 30 秒 TTL 才显示，
       * 用户会以为添加失败了而去重试，结果撞上 409 重复。
       */
      case 'ADD_SECRET': {
        const result = await callApi((client) => client.createSecret(message.payload));
        memory.entries = [];
        memory.entriesAt = 0;
        const entries = await refreshEntries({ force: true });
        return {
          ok: true,
          secret: result.secret,
          warning: result.warning,
          status: result.status,
          count: entries.length,
        };
      }

      /** 提交前的重复预检：让 UI 能在发请求之前就提示 */
      case 'CHECK_DUPLICATE': {
        const entries = await refreshEntries();
        const hit = findDuplicate(entries, message.candidate);
        return { duplicate: hit ? { id: hit.id, name: hit.name } : null };
      }

      /**
       * 从当前标签页截图识别二维码。
       *
       * 用浏览器内置的 BarcodeDetector 而不是打包 jsQR —— MV3 的 CSP 是
       * script-src 'self'，拉不了 CDN 脚本，而引入一个 40KB 的第三方库
       * 只为这个可选功能不值得。
       *
       * BarcodeDetector 的平台覆盖不全（Windows/Linux 上常不可用），
       * 所以调用方必须先探测；这里只负责"能识别时返回 URI"。
       */
      case 'SCAN_QR': {
        const uri = await scanQrFromActiveTab();
        return { uri };
      }

      case 'STATE': {
        const config = await getConfig();
        let permissionGranted = false;
        let origin = null;
        try {
          const client = await ensureClient({ requirePermission: false });
          origin = client.originPermission;
          permissionGranted = await ensureHostPermission(client).then(
            () => true,
            () => false,
          );
        } catch {
          /* 未配置服务器时无权限概念 */
        }
        return {
          configured: Boolean(config.serverUrl),
          authenticated: Boolean(await loadToken()),
          permissionGranted,
          origin,
          // 没有 tabs 权限时 chrome.tabs.query 拿不到 URL，popup 用它做 hostname 兜底
          host: memory.currentHost,
          count: memory.entries.length,
          lockedIn: memory.lastActivityAt ? Date.now() - memory.lastActivityAt : null,
        };
      }

      case 'ENTRIES': {
        const entries = await refreshEntries({ force: message.force === true });
        return { entries: entries.map(toSummary) };
      }

      case 'GENERATE': {
        const entries = await refreshEntries();
        const entry = findEntry(message.id);
        if (!entry) throw new ApiError(`未找到条目 ${message.id}`);
        const result = await generateForEntry(entry);
        return {
          id: entry.id,
          code: result.code,
          remaining: Number.isFinite(result.remaining) ? result.remaining : null,
          type: entry.type ?? 'TOTP',
        };
      }

      case 'COPY':
        return handleCopy(message.id);

      case 'MATCH': {
        const entries = await refreshEntries();
        const matched = matchEntriesForHost(entries, message.hostname ?? '');
        const codes = [];
        for (const entry of matched) {
          try {
            const result = await generateForEntry(entry);
            codes.push({
              id: entry.id,
              issuer: entryLabel(entry),
              account: entry.account || '',
              code: result.code,
              remaining: Number.isFinite(result.remaining) ? result.remaining : null,
              type: entry.type ?? 'TOTP',
            });
          } catch (error) {
            codes.push({
              id: entry.id,
              issuer: entryLabel(entry),
              account: entry.account || '',
              error: error.message,
            });
          }
        }
        return { codes, hostname: message.hostname };
      }

      case 'FILL': {
        // 填充也算"用了这个码"，HOTP 需与复制同等对待（推进计数器）
        const { code } = await handleFill(message.id);
        return { code };
      }

      case 'PROBE': {
        const client = await ensureClient();
        return client.probeSecretsEndpoint(message.candidates);
      }

      default:
        throw new ApiError(`未知消息类型: ${type}`);
    }
  })();

  handled.then(sendResponse).catch((error) => {
    sendResponse({
      error: true,
      message: error?.message ?? String(error),
      code: error?.code ?? null,
      status: error?.status ?? null,
      origin: error?.origin ?? null,
    });
  });

  return true;
});

/* ------------------------------------------------------------------ */
/* 复制 / HOTP 推进                                                     */
/* ------------------------------------------------------------------ */

/**
 * 推进服务端 HOTP 计数器，失败时带上"是否已复制"的上下文交给上层。
 * 对齐上游：本地 counter 只有在服务端确认后才 +1（core.js:665-682）。
 */
async function advanceHotpSafely(entry) {
  const client = await ensureClient();
  const expectedNext = Number(entry.counter ?? 0) + 1;
  const result = await client.advanceHotp(entry);
  const confirmed = Number.isFinite(result.counter) ? result.counter : expectedNext;
  await commitCounter(entry.id, confirmed);
  return confirmed;
}

/**
 * 截取当前标签页可见区域，用 BarcodeDetector 找二维码。
 *
 * @returns {Promise<string|null>} 命中的 otpauth:// URI，或 null（无码 / 不支持 / 无权限）
 */
async function scanQrFromActiveTab() {
  if (typeof BarcodeDetector === 'undefined') return null;

  let detector;
  try {
    // 构造失败通常意味着该平台没有可用后端
    detector = new BarcodeDetector();
    const supported = await BarcodeDetector.getSupportedFormats();
    if (!supported.includes('qr_code')) return null;
  } catch {
    return null;
  }

  let dataUrl;
  try {
    // 截图目标 = 最近聚焦的**常规**浏览器窗口的活动标签。
    // 添加页本身以独立小窗（popup 型窗口）打开 —— 若按"当前窗口"截，会截到添加页自己。
    let windowId = null;
    try {
      const normal = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      windowId = normal?.id ?? null;
    } catch { /* API 不可用时回落 tabs.query */ }
    if (windowId == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      windowId = tab?.windowId ?? null;
    }
    if (windowId == null) return null;
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch {
    // 多半是缺 activeTab 权限或页面不可截（如 chrome:// 内部页）
    return null;
  }

  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const codes = await detector.detect(bitmap);
    bitmap.close?.();
    for (const code of codes) {
      const value = String(code.rawValue ?? '').trim();
      if (value.toLowerCase().startsWith('otpauth://')) return value;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 取一条用于**消费**的码（区别于 GENERATE 那种只看不算用的场景）。
 * HOTP 必须先拿到服务端权威 counter，否则填进去的就是废码。
 */
async function resolveForConsumption(id) {
  await refreshEntries();
  if (isHotp(findEntry(id))) await refreshEntries({ force: true });
  const entry = findEntry(id);
  if (!entry) throw new ApiError(`未找到条目 ${id}`);
  return entry;
}

async function handleFill(id) {
  const entry = await resolveForConsumption(id);
  const result = await generateForEntry(entry);
  if (isHotp(entry)) await advanceHotpSafely(entry);
  return { code: result.code };
}

async function handleCopy(id) {
  const entry = await resolveForConsumption(id);
  const result = await generateForEntry(entry);

  if (!isHotp(entry)) {
    await writeClipboard(result.code);
    await maybeScheduleClipboardClear();
    return { ok: true, type: 'TOTP' };
  }

  // HOTP：剪贴板写入与服务端预留**并发**发起。
  // 浏览器要求剪贴板写入在用户激活有效期内完成，这里不能再串行一次网络请求。
  const [clipboardResult, reservationResult] = await Promise.allSettled([
    writeClipboard(result.code),
    advanceHotpSafely(entry),
  ]);

  const copied = clipboardResult.status === 'fulfilled';

  if (reservationResult.status === 'rejected') {
    // 码可能已经复制出去了，但计数器没推进 —— 必须告诉用户，否则两端会漂移
    const error = new ApiError(
      `HOTP 计数器同步失败：${reservationResult.reason?.message ?? '未知错误'}` +
        (copied ? '（验证码已复制，但可能无效，请刷新后重试）' : ''),
      {
        status: reservationResult.reason?.status ?? null,
        code: 'HOTP_ADVANCE_FAILED',
      },
    );
    error.copied = copied;
    // 强制下次拉取服务端权威状态
    memory.entriesAt = 0;
    throw error;
  }

  if (!copied) {
    throw new ApiError(
      `复制失败：${clipboardResult.reason?.message ?? '未知错误'}（HOTP 计数器已推进，请使用新验证码重试）`,
      { code: 'CLIPBOARD_FAILED' },
    );
  }

  await maybeScheduleClipboardClear();
  return { ok: true, type: 'HOTP', counter: reservationResult.value };
}

async function maybeScheduleClipboardClear() {
  const config = await getConfig();
  if (config.clipboardClear) await scheduleClipboardClear();
}

/** 只回传列表展示所需字段，不把 secret 送到 popup */
function toSummary(entry) {
  return {
    id: entry.id,
    issuer: entryLabel(entry),
    account: entry.account || '',
    type: entry.type ?? 'TOTP',
    digits: entry.digits ?? 6,
    period: entry.period ?? 30,
    counter: entry.counter ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                             */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  await saveConfig({});
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreFromSession();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === LOCK_ALARM) {
    await clearSession();
    return;
  }
  if (alarm.name === CLIPBOARD_ALARM) {
    await clearClipboard();
    await chrome.alarms.clear(CLIPBOARD_ALARM);
  }
});

/** 快捷键：复制当前站点匹配的第一个码 */
chrome.commands.onCommand.addListener(async (command) => {
  try {
    await restoreFromSession();
    if (command !== 'copy-code') return;
    const entries = await refreshEntries();
    const matched = matchEntriesForHost(entries, memory.currentHost ?? '');
    const entry = matched[0];
    if (!entry) return;
    await handleCopy(entry.id);
  } catch (error) {
    console.warn('[2fa-ext] command failed', command, error);
  }
});
