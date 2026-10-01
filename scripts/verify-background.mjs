/**
 * background service worker 的行为验证（零依赖）
 *
 * 用途：用一个假的 chrome.* 表面把 src/background.js 跑起来，直接验证消息路由层的
 *      判断逻辑 —— 这一层以前没有任何覆盖，而 HOTP 新鲜度、权限、剪贴板降级这些
 *      最容易出错的东西全在这里。
 *
 * 运行：node scripts/verify-background.mjs
 *
 * 注意：mock 只实现被测逻辑实际用到的 API。如果哪天 background.js 用了新的 API
 *      而这里没补，会立刻抛 TypeError —— 这是特性不是缺陷。
 */

import { createMockWorker, DEFAULT_PASSWORD } from './mock-worker.mjs';

/* ------------------------------------------------------------------ */
/* chrome.* mock                                                       */
/* ------------------------------------------------------------------ */

const messageListeners = [];
const alarmListeners = [];
const commandListeners = [];

const io = { sessionGets: 0, sessionSets: 0, sessionRemoves: 0, syncGets: 0 };
const log = { offscreenCreated: 0, offscreenWrites: [], permissionRequests: 0, alarms: [] };

function makeStorageArea(counter) {
  const data = {};
  return {
    async get(keys) {
      if (counter === 'session') io.sessionGets += 1;
      else io.syncGets += 1;
      const wanted = Array.isArray(keys) ? keys : keys == null ? Object.keys(data) : [keys];
      const out = {};
      for (const key of wanted) if (key in data) out[key] = data[key];
      return out;
    },
    async set(obj) {
      if (counter === 'session') io.sessionSets += 1;
      Object.assign(data, obj);
    },
    async remove(keys) {
      if (counter === 'session') io.sessionRemoves += 1;
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    _data: data,
  };
}

let permissionsGranted = true;

globalThis.chrome = {
  storage: {
    sync: makeStorageArea('sync'),
    session: makeStorageArea('session'),
    local: makeStorageArea('local'),
  },
  alarms: {
    async create(name, info) {
      log.alarms.push({ name, ...info });
    },
    async clear() {},
    onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
  },
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    async sendMessage(message) {
      if (message?.target === 'offscreen') {
        log.offscreenWrites.push(message.text);
        return { ok: true };
      }
      throw new Error(`未预期的 runtime.sendMessage: ${JSON.stringify(message)}`);
    },
    getURL: (path) => `chrome-extension://0123456789abcdef/${path}`,
    async getContexts() {
      return log.offscreenCreated > 0 ? [{ url: 'chrome-extension://offscreen' }] : [];
    },
    lastError: null,
  },
  offscreen: {
    Reason: { CLIPBOARD: 'CLIPBOARD' },
    async createDocument() {
      log.offscreenCreated += 1;
    },
  },
  permissions: {
    async contains() {
      return permissionsGranted;
    },
    async request() {
      log.permissionRequests += 1;
      return permissionsGranted;
    },
  },
  commands: { onCommand: { addListener: (fn) => commandListeners.push(fn) } },
  tabs: {
    async query() {
      return [{ id: 1, url: 'https://example.com/' }];
    },
    async sendMessage() {
      return { ok: true };
    },
  },
};

const worker = await createMockWorker();

// 必须在 import 之前装好 globalThis.chrome
await import('../src/background.js');

/* ------------------------------------------------------------------ */
/* 断言工具                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function checkTrue(label, condition, detail = '') {
  check(`${label}${detail ? ` (${detail})` : ''}`, Boolean(condition), true);
}

function dispatch(type, extra = {}) {
  return new Promise((resolve) => {
    for (const listener of messageListeners) {
      const result = listener({ type, ...extra }, {}, resolve);
      if (result === true) return; // 该 listener 认领了这个消息
    }
    // 没有 listener 认领（同步路径），直接 resolve 空
    resolve(undefined);
  });
}

console.log('==> 已加载 background service worker\n');

/* ------------------------------------------------------------------ */
console.log('① HOST_REPORT：站点变化才写一次 session（同站导航零 IO）');
/* ------------------------------------------------------------------ */
{
  const before = io.sessionGets + io.sessionSets;
  await dispatch('HOST_REPORT', { hostname: 'example.com' });
  const after = io.sessionGets + io.sessionSets;
  check('站点变化：恰好一次写入（供添加页预填在 SW 重启后使用）', after - before, 1);

  // 同站重复上报：必须零 IO（每次开网页都会发 HOST_REPORT，不能每页都写）
  const repeatBefore = io.sessionGets + io.sessionSets;
  await dispatch('HOST_REPORT', { hostname: 'example.com' });
  await dispatch('HOST_REPORT', { hostname: 'example.com' });
  check('同站重复上报：零读写', io.sessionGets + io.sessionSets - repeatBefore, 0);

  const status = await dispatch('STATE');
  check('hostname 已记录', status.host, 'example.com');

  // GET_SITE_HINT：内存命中 + 显式不触发 touch/restore
  const hint = await dispatch('GET_SITE_HINT');
  check('GET_SITE_HINT 返回当前站点', hint.host, 'example.com');
}

/* ------------------------------------------------------------------ */
console.log('\n② 未授权 host 权限时，登录必须给出可机读错误');
/* ------------------------------------------------------------------ */
{
  await dispatch('CONFIG_SET', { patch: { serverUrl: worker.url } });

  // 未配置服务器时应当先报 NOT_CONFIGURED（两者必须可区分）
  await dispatch('CONFIG_SET', { patch: { serverUrl: '' } });
  const unconfigured = await dispatch('LOGIN', { credential: DEFAULT_PASSWORD });
  check('未配置服务器时错误码为 NOT_CONFIGURED', unconfigured.code, 'NOT_CONFIGURED');

  await dispatch('CONFIG_SET', { patch: { serverUrl: worker.url } });

  permissionsGranted = false;
  const result = await dispatch('LOGIN', { credential: DEFAULT_PASSWORD });
  check('返回 error', result.error, true);
  check('错误码 HOST_PERMISSION_REQUIRED', result.code, 'HOST_PERMISSION_REQUIRED');
  checkTrue('错误里带出具体 origin', typeof result.origin === 'string', result.origin);
  permissionsGranted = true;
}

/* ------------------------------------------------------------------ */
console.log('\n③ 登录 → 拉列表');
/* ------------------------------------------------------------------ */
{
  await dispatch('CONFIG_SET', { patch: { serverUrl: worker.url } });
  const result = await dispatch('LOGIN', { credential: DEFAULT_PASSWORD });
  check('登录成功', result.ok, true);
  check('拉到 2 条', result.count, 2);
  checkTrue('返回过期时间', typeof result.expiresAt === 'string');

  const state = await dispatch('STATE');
  check('configured', state.configured, true);
  check('authenticated', state.authenticated, true);
  check('permissionGranted', state.permissionGranted, true);
  check('count', state.count, 2);
  check('全程未使用 Cookie', worker.observed.cookieHeaders, 0);
}

/* ------------------------------------------------------------------ */
console.log('\n④ TOTP 复制：不应额外拉取');
/* ------------------------------------------------------------------ */
{
  const before = worker.observed.secretsRequests;
  const writesBefore = log.offscreenWrites.length;
  const result = await dispatch('COPY', { id: 'sec-totp-1' });
  check('复制成功', result.ok, true);
  check('类型 TOTP', result.type, 'TOTP');
  // 30 秒缓存内不应重复请求
  check('未额外请求列表', worker.observed.secretsRequests - before, 0);
  // SW 没有 Clipboard API，必须经由 offscreen 写入（见 §⑧）
  check('经 offscreen 写入一次', log.offscreenWrites.length - writesBefore, 1);
  check('TOTP 不上推计数器', worker.observed.counterPayloads.length, 0);
}

/* ------------------------------------------------------------------ */
console.log('\n⑤ HOTP 复制：必须先取服务端权威 counter');
/* ------------------------------------------------------------------ */
{
  const before = worker.observed.secretsRequests;
  const result = await dispatch('COPY', { id: 'sec-hotp-1' });
  check('复制成功', result.ok, true);
  check('类型 HOTP', result.type, 'HOTP');
  check('counter 推进到 8', result.counter, 8);
  // HOTP 必须绕过 30 秒缓存强制拉取一次，否则拿过期快照去上推必然 409
  check('强制刷新了一次列表', worker.observed.secretsRequests - before, 1);

  const payload = worker.observed.counterPayloads.at(-1);
  check('上推路径带 counter', payload.id, 'sec-hotp-1');
  check('expectedCounter 为拉取到的权威值', payload.expectedCounter, 7);
}

/* ------------------------------------------------------------------ */
console.log('\n⑥ HOTP 上推失败不能静默');
/* ------------------------------------------------------------------ */
{
  worker.observed.forcedCounterConflict = true;
  const bad = await dispatch('COPY', { id: 'sec-hotp-1' });
  check('返回 error', bad.error, true);
  check('错误码 HOTP_ADVANCE_FAILED', bad.code, 'HOTP_ADVANCE_FAILED');
  checkTrue('文案提示刷新重试', bad.message.includes('刷新'), bad.message.slice(0, 40));
  worker.observed.forcedCounterConflict = false;

  // 失败后必须重新拉服务端状态，不能继续用脏缓存
  const before = worker.observed.secretsRequests;
  await dispatch('ENTRIES', { force: true });
  check('失败后仍可正常拉取', worker.observed.secretsRequests - before, 1);
}

/* ------------------------------------------------------------------ */
console.log('\n⑦ 填充走同样的 HOTP 新鲜度保证');
/* ------------------------------------------------------------------ */
{
  const before = worker.observed.secretsRequests;
  const result = await dispatch('FILL', { id: 'sec-hotp-1' });
  check('拿到 6 位码', result.code?.length, 6);
  check('强制刷新了一次', worker.observed.secretsRequests - before, 1);
  check('counter 已推进到 9', worker.observed.counterPayloads.at(-1).expectedCounter, 8);
}

/* ------------------------------------------------------------------ */
console.log('\n⑧ 剪贴板：SW 无 Clipboard API，必须降级到 offscreen');
/* ------------------------------------------------------------------ */
{
  check('Node 环境确实没有 navigator.clipboard', typeof globalThis.navigator?.clipboard, 'undefined');
  checkTrue('已创建 offscreen document', log.offscreenCreated > 0, `${log.offscreenCreated} 次`);
  checkTrue(
    '验证码经 offscreen 写入',
    log.offscreenWrites.some((text) => /^\d{6}$/.test(String(text))),
    `${log.offscreenWrites.length} 次写入`,
  );
}

/* ------------------------------------------------------------------ */
console.log('\n⑨ 剪贴板清除闹钟需避开 Chrome 30 秒下限');
/* ------------------------------------------------------------------ */
{
  const clearAlarm = log.alarms.find((a) => a.name === 'authforge-clear-clipboard');
  checkTrue('已注册清除闹钟', Boolean(clearAlarm));
  const seconds = clearAlarm ? clearAlarm.delayInMinutes * 60 : 0;
  checkTrue('间隔 > 30 秒', seconds > 30, `${seconds}s`);
  checkTrue('间隔不至于太离谱', seconds <= 45, `${seconds}s`);

  const lockAlarm = log.alarms.find((a) => a.name === 'authforge-lock');
  checkTrue('已注册锁定闹钟', Boolean(lockAlarm), `${lockAlarm?.delayInMinutes} 分钟`);
}

/* ------------------------------------------------------------------ */
console.log('\n⑩ 登出与未知消息');
/* ------------------------------------------------------------------ */
{
  const out = await dispatch('LOGOUT');
  check('登出成功', out.ok, true);
  const state = await dispatch('STATE');
  check('已失去认证', state.authenticated, false);

  const unknown = await dispatch('NO_SUCH_MESSAGE');
  check('未知消息返回 error', unknown.error, true);
  checkTrue('错误信息含类型名', unknown.message.includes('NO_SUCH_MESSAGE'));
}

await worker.close();

console.log(`\n${'='.repeat(52)}`);
console.log(`background 验证：通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(52));
// exitCode 替代 process.exit：避免 Windows 下强退触发 libuv 断言崩溃
process.exitCode = failed === 0 ? 0 : 1;
