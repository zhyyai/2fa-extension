/**
 * 端到端集成验证（零依赖）
 *
 * 用途：起一个忠实复刻上游 v1.9.0 契约的本地 HTTP 服务，用真实的 ApiClient 跑一遍
 *      「登录 → 拉列表 → 推进 HOTP 计数器 → 刷新令牌 → 登出」。
 *      验证的是扩展客户端与服务端契约的咬合，不是上游实现本身（上游有 vitest）。
 *
 * 运行：node scripts/verify-integration.mjs
 *
 * mock 的每一处行为都对应一份上游源码：
 *   登录字段 credential           src/utils/auth.js:703
 *   响应体 token                  src/utils/auth.js:749-756
 *   verifyAuth 读 Bearer          src/utils/auth.js:427-434
 *   /api/secrets 返回裸数组       src/api/secrets/crud.js:47
 *   计数器快照校验                src/api/secrets/counter.js:82-102
 *   错误响应 {error,message,...}  src/utils/response.js:86-94
 */

import { ApiClient, normalizeSecrets, isHotp, entryLabel } from '../src/lib/api.js';
import { generateForEntry } from '../src/lib/otp.js';
import { matchEntriesForHost } from '../src/lib/match.js';
import { createMockWorker, DEFAULT_PASSWORD, TOKEN_1, TOKEN_2 } from './mock-worker.mjs';

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
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

const worker = await createMockWorker();
const observed = worker.observed;
const serverUrl = worker.url;
const PASSWORD = DEFAULT_PASSWORD;

console.log(`mock Worker 已启动：${serverUrl}\n`);

/* ------------------------------------------------------------------ */
console.log('① 登录字段名必须是 credential');
/* ------------------------------------------------------------------ */
{
  const client = new ApiClient({ serverUrl });
  let error = null;
  // 模拟旧实现的错误写法：直接调端点传 password
  try {
    await client._request('/api/login', { method: 'POST', body: { password: PASSWORD } });
  } catch (err) {
    error = err;
  }
  check('传 password 被服务端拒绝（400）', error?.status, 400);

  const result = await client.login(PASSWORD);
  check('login() 返回 token', result.token, TOKEN_1);
  check('token 已写入客户端', client.token, TOKEN_1);
  check('返回 expiresIn', result.expiresIn, '30天');
  checkTrue('返回 expiresAt 是 ISO 时间', !Number.isNaN(Date.parse(result.expiresAt)));
}

/* ------------------------------------------------------------------ */
console.log('\n② 认证走 Bearer，且从不依赖 Cookie');
/* ------------------------------------------------------------------ */
{
  const client = new ApiClient({ serverUrl, token: TOKEN_1 });
  const list = await client.listSecrets();
  check('listSecrets() 拿到裸数组', Array.isArray(list), true);
  check('条目数', list.length, 2);
  check('条目用 name 而非 issuer', list[0].name, 'GitHub');
  check('不存在 issuer 字段', 'issuer' in list[0], false);
  check('entryLabel() 回落到 name', entryLabel(list[0]), 'GitHub');
  check('未发送任何 Cookie', observed.cookieHeaders, 0);
  checkTrue('已发送 Bearer', observed.bearerHeaders > 0, `${observed.bearerHeaders} 次`);

  const noAuth = new ApiClient({ serverUrl });
  let error = null;
  try {
    await noAuth.listSecrets();
  } catch (err) {
    error = err;
  }
  check('无 token 时 401', error?.status, 401);
  check('错误信息取自上游的 message 字段', error?.message, '认证失败');
}

/* ------------------------------------------------------------------ */
console.log('\n③ HOTP 计数器：快照语义');
/* ------------------------------------------------------------------ */
{
  const client = new ApiClient({ serverUrl, token: TOKEN_1 });
  const list = await client.listSecrets();
  const hotp = list.find(isHotp);
  check('识别出 HOTP 条目', hotp.id, 'sec-hotp-1');
  check('TOTP 条目不是 HOTP', isHotp(list[0]), false);

  const result = await client.advanceHotp(hotp);
  check('服务端确认 counter 推进到 8', result.counter, 8);
  check('idempotent 为 false', result.idempotent, false);

  const payload = observed.counterPayloads.at(-1);
  check('请求路径是 :id/counter', payload.id, 'sec-hotp-1');
  check('expectedCounter 取本地当前值', payload.expectedCounter, 7);
  check('expectedSecret 大写对齐', payload.expectedSecret, 'JBSWY3DPEHPK3PXP');
  check('expectedDigits', payload.expectedDigits, 6);
  check('expectedAlgorithm 大写', payload.expectedAlgorithm, 'SHA1');
  check('expectedNamespace 透传', payload.expectedNamespace, 'ns-abc');

  // 用过期快照再推一次 —— 必须 409，不能静默成功
  let error = null;
  try {
    await client.advanceHotp({ ...hotp, counter: 7 });
  } catch (err) {
    error = err;
  }
  check('过期快照被拒（409）', error?.status, 409);
  check('错误信息提示刷新', error?.message, 'HOTP计数器已变更，请刷新后重试');

  // 篡改 secret 的快照 —— 同样必须 409
  let mismatch = null;
  try {
    await client.advanceHotp({ ...hotp, counter: 8, secret: 'MZXW6YTBOI======' });
  } catch (err) {
    mismatch = err;
  }
  check('参数不符被拒（409）', mismatch?.status, 409);

  // 对 TOTP 条目上推 —— 上游明确拒绝
  let totpError = null;
  try {
    await client.advanceHotp(list[0]);
  } catch (err) {
    totpError = err;
  }
  check('对 TOTP 上推被拒（409）', totpError?.status, 409);
}

/* ------------------------------------------------------------------ */
console.log('\n④ 令牌刷新与登出');
/* ------------------------------------------------------------------ */
{
  const client = new ApiClient({ serverUrl, token: TOKEN_1 });
  const refreshed = await client.refreshToken();
  check('refreshToken() 换新 token', refreshed.token, TOKEN_2);
  check('客户端已更新', client.token, TOKEN_2);

  // 旧 token 现已失效
  const stale = new ApiClient({ serverUrl, token: TOKEN_1 });
  let error = null;
  try {
    await stale.listSecrets();
  } catch (err) {
    error = err;
  }
  check('旧 token 失效（401）', error?.status, 401);

  await client.logout();
  check('logout() 清空本地 token', client.token, null);
}

/* ------------------------------------------------------------------ */
console.log('\n⑤ 响应形状兼容');
/* ------------------------------------------------------------------ */
{
  check('裸数组', normalizeSecrets([{ id: 1 }]).length, 1);
  check('{secrets:[...]}', normalizeSecrets({ secrets: [{ id: 1 }] }).length, 1);
  check('{data:[...]}', normalizeSecrets({ data: [{ id: 1 }] }).length, 1);
  check('{data:{secrets:[...]}}', normalizeSecrets({ data: { secrets: [{ id: 1 }] } }).length, 1);
  check('{items:[...]}', normalizeSecrets({ items: [{ id: 1 }] }).length, 1);
  check('无法识别时返回空数组', normalizeSecrets({ foo: 1 }).length, 0);
}

/* ------------------------------------------------------------------ */
console.log('\n⑥ 端到端：取码 + 站点匹配');
/* ------------------------------------------------------------------ */
{
  const client = new ApiClient({ serverUrl, token: TOKEN_2 });
  const list = await client.listSecrets();

  const totpEntry = list.find((item) => item.id === 'sec-totp-1');
  const result = await generateForEntry(totpEntry);
  check('TOTP 码为 6 位', result.code.length, 6);
  checkTrue('剩余秒数在 1..30 之间', result.remaining >= 1 && result.remaining <= 30, `${result.remaining}s`);

  const hotpEntry = list.find(isHotp);
  const hotpResult = await generateForEntry(hotpEntry);
  check('HOTP 码为 6 位', hotpResult.code.length, 6);
  check('HOTP 不随时间失效', hotpResult.remaining, Number.POSITIVE_INFINITY);

  // GitHub 条目应被 github.com 命中；Acme Bank 不应被命中
  const matched = matchEntriesForHost(list, 'github.com');
  check('github.com 命中 1 条', matched.length, 1);
  check('命中的是 GitHub 条目', matched[0].id, 'sec-totp-1');
  check('无匹配域名返回空', matchEntriesForHost(list, 'nonexistent-site.example').length, 0);
}

/* ------------------------------------------------------------------ */
console.log('\n⑦ 权限模式串');
/* ------------------------------------------------------------------ */
{
  check('originPermission 带通配路径', new ApiClient({ serverUrl: 'https://a.workers.dev' }).originPermission, 'https://a.workers.dev/*');
  check('去掉结尾斜杠', new ApiClient({ serverUrl: 'https://a.workers.dev/' }).originPermission, 'https://a.workers.dev/*');
  check('未配置时为 null', new ApiClient({}).originPermission, null);
}

await worker.close();
console.log(`\n${'='.repeat(52)}`);
console.log(`集成验证：通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(52));
// exitCode 替代 process.exit：避免 Windows 下强退触发 libuv 断言崩溃
process.exitCode = failed === 0 ? 0 : 1;
