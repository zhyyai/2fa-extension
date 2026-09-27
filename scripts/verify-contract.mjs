/**
 * 上游契约漂移检测（零依赖）
 *
 * 用途：扩展的 src/lib/api.js 是按上游源码逐行核实出来的。上游一旦改契约
 *      （改字段名、换端点、去掉 Bearer 支持），这个脚本会立刻失败 ——
 *      比"扩展在用户浏览器里静默失灵"要好得多。
 *
 * 运行：node scripts/verify-contract.mjs
 *       UPSTREAM_DIR=/path/to/2fa-main node scripts/verify-contract.mjs
 *
 * 它不是"测试上游"，而是把"扩展对上游的假设"固化成可执行断言。
 * 上游升级后：先跑这个脚本，红了就去改 src/lib/api.js，再跑。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.UPSTREAM_DIR,
  '/workspace/.upstream/2fa-main',
  '/workspace/2fa-main',
].filter(Boolean);

const upstreamDir = CANDIDATES.find((dir) => existsSync(join(dir, 'src/utils/auth.js')));

if (!upstreamDir) {
  console.error('找不到上游源码目录。设置 UPSTREAM_DIR 环境变量，或把 2fa-main 解压到 /workspace/.upstream/');
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const cache = new Map();
function read(relPath) {
  if (!cache.has(relPath)) {
    cache.set(relPath, readFileSync(join(upstreamDir, relPath), 'utf8'));
  }
  return cache.get(relPath);
}

console.log(`上游源码目录：${upstreamDir}\n`);

/* ------------------------------------------------------------------ */
console.log('① 版本');
/* ------------------------------------------------------------------ */
const pkg = JSON.parse(read('package.json'));
check('上游版本为 1.9.0（契约据此核实）', pkg.version === '1.9.0', `实际 ${pkg.version}`);
const versionJs = read('src/utils/version.js');
check('APP_VERSION 与 package.json 一致', versionJs.includes(`'${pkg.version}'`));

/* ------------------------------------------------------------------ */
console.log('\n② 认证：Bearer 必须仍然被支持');
/* ------------------------------------------------------------------ */
const auth = read('src/utils/auth.js');

check(
  'verifyAuth() 在 Cookie 缺失时读 Authorization 头',
  /getTokenFromCookie\(request\)[\s\S]{0,300}?request\.headers\.get\('Authorization'\)/.test(auth),
);
check(
  'Bearer 前缀被正确剥离（substring(7)）',
  auth.includes(`authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader`),
);
check(
  'handleRefreshToken 同样接受 Bearer',
  /handleRefreshToken[\s\S]{0,1200}?authHeader\.startsWith\('Bearer '\)/.test(auth),
);
check(
  'Cookie 名为 auth_token',
  /const COOKIE_NAME = 'auth_token';/.test(auth),
);
check(
  'Cookie 仍为 SameSite=Strict（PWA 的 CSRF 防线不该被动过）',
  /SameSite=Strict/.test(auth),
);

/* ------------------------------------------------------------------ */
console.log('\n③ 登录：字段名与响应体');
/* ------------------------------------------------------------------ */
check(
  '登录请求体字段是 credential（不是 password）',
  auth.includes('const { credential } = await request.json();'),
);
check(
  '登录响应体返回 token',
  /token: jwtToken/.test(auth),
);
check(
  '登录响应体含 expiresAt / expiresIn',
  auth.includes('expiresAt:') && auth.includes('expiresIn:'),
);

/* ------------------------------------------------------------------ */
console.log('\n④ 密钥列表：端点与响应形状');
/* ------------------------------------------------------------------ */
const crud = read('src/api/secrets/crud.js');
check(
  'GET /api/secrets 返回裸数组（无 {success,data} 信封）',
  /return createJsonResponse\(secrets\);/.test(crud),
);
check(
  '条目含 name 字段（上游没有 issuer 字段）',
  /name: secretData\.name/.test(crud),
);
check(
  '条目含 account / secret / type / digits / period / algorithm',
  ['account:', 'secret:', 'type:', 'digits:', 'period:', 'algorithm:'].every((f) =>
    crud.includes(`${f} secretData.${f.replace(':', '')}`),
  ),
);
check(
  'HOTP 条目带 counter，非 HOTP 为 undefined',
  /counter: secretData\.type === 'HOTP' \? secretData\.counter : undefined/.test(crud),
);
check(
  '更新时会生成 hotpCounterNamespace（用于并发快照校验）',
  crud.includes('hotpCounterNamespace'),
);

/* ------------------------------------------------------------------ */
console.log('\n⑤ HOTP 计数器：端点与乐观并发快照');
/* ------------------------------------------------------------------ */
const router = read('src/router/handler.js');
check(
  '路由存在 /api/secrets/:id/counter',
  router.includes('/^\\/api\\/secrets\\/[^/]+\\/counter$/'),
);
check(
  '该路由在 /api/secrets/{id} 通配之前匹配',
  router.indexOf('/counter$') < router.indexOf("pathname.startsWith('/api/secrets/')"),
);

const response = read('src/utils/response.js');

const counter = read('src/api/secrets/counter.js');
check(
  '上推端点从路径倒数第二段取 id（即 :id/counter）',
  counter.includes('pathSegments.at(-2)'),
);
check(
  '上推只接受 HOTP 类型',
  /!== 'HOTP'/.test(counter),
);
check(
  '上推成功后 counter +1',
  /const nextCounter = currentCounter \+ 1;/.test(counter),
);

// 扩展没有 GET 单条的通道，要拿服务端权威 counter 只能重拉整个列表。
// 断言这一点固化下来，避免以后有人"优化"成 GET /api/secrets/:id 然后吃到 405。
const singleRoute = router.slice(router.indexOf("if (pathname.startsWith('/api/secrets/'))"));
check(
  'GET /api/secrets/:id 不被支持（仅 PUT/DELETE）',
  singleRoute.includes("case 'PUT':") &&
    singleRoute.includes("case 'DELETE':") &&
    singleRoute.includes('不支持的HTTP方法'),
);

const validation = read('src/utils/validation.js');
const schemaBlock = validation.slice(
  validation.indexOf('export const advanceHOTPCounterSchema'),
  validation.indexOf('export const updateSecretSchema'),
);
for (const field of [
  'expectedNamespace',
  'expectedCounter',
  'expectedSecret',
  'expectedDigits',
  'expectedAlgorithm',
]) {
  check(`上推快照字段 ${field} 存在`, schemaBlock.includes(`${field}:`));
}
check(
  'expectedSecret 会被 toUpperCase（比较前必须对齐）',
  schemaBlock.includes("transform: (v) => v.toUpperCase().trim()"),
);
check(
  'expectedAlgorithm 仅接受 SHA1/SHA256/SHA512',
  schemaBlock.includes("['SHA1', 'SHA256', 'SHA512']"),
);
check(
  'expectedDigits 仅接受 6 或 8',
  schemaBlock.includes('[6, 8]'),
);

/* ------------------------------------------------------------------ */
console.log('\n⑥ 成功响应信封（{success, message, data}）');
/* ------------------------------------------------------------------ */
check(
  'createSuccessResponse 产出 { success, message, data }',
  response.includes('success: true,') && response.includes('message,') && response.includes('data,'),
);
check(
  '错误响应产出 { error, message, timestamp }',
  response.includes('error: title,') && response.includes('timestamp:'),
);

/* ------------------------------------------------------------------ */
console.log('\n⑦ CORS：确认扩展仍需靠 host 权限豁免');
/* ------------------------------------------------------------------ */
const security = read('src/utils/security.js');
check(
  'isOriginAllowed 只放行同源（未内置扩展白名单）',
  security.includes('const allowedOrigins = [') &&
    security.includes('`https://${host}`') &&
    security.includes('`http://${host}`'),
);
check(
  '未放行 chrome-extension 通配（安全默认值）',
  !/chrome-extension:\/\/\*/.test(security),
);
check(
  'CORS 已允许 Authorization 请求头',
  security.includes("'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'"),
);

/* ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(52)}`);
console.log(`契约检测：通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
