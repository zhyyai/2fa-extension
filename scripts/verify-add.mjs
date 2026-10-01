/**
 * 新增条目功能的验证（零依赖）
 *
 * 覆盖三层：
 *   ① secret-input.js 的校验是否与上游 addSecretSchema 一致
 *   ② otpauth:// URI 解析 → 上游条目形状（issuer → name 的映射是重点）
 *   ③ 经 background 真实写入 mock Worker，并确认缓存被刷新
 *
 * 运行：node scripts/verify-add.mjs
 */

import { createMockWorker, DEFAULT_PASSWORD } from './mock-worker.mjs';

const messageListeners = [];
const io = { sessionGets: 0 };

function makeStorageArea(kind) {
  const data = {};
  return {
    async get(keys) {
      if (kind === 'session') io.sessionGets += 1;
      const wanted = Array.isArray(keys) ? keys : keys == null ? Object.keys(data) : [keys];
      const out = {};
      for (const key of wanted) if (key in data) out[key] = data[key];
      return out;
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    _data: data,
  };
}

let permissionsGranted = true;
const log = { offscreenCreated: 0, alarms: [] };

globalThis.chrome = {
  storage: { sync: makeStorageArea('sync'), session: makeStorageArea('session'), local: makeStorageArea('local') },
  alarms: {
    async create(name, info) {
      log.alarms.push({ name, ...info });
    },
    async clear() {},
    onAlarm: { addListener: () => {} },
  },
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    async sendMessage(message) {
      if (message?.target === 'offscreen') return { ok: true };
      throw new Error(`未预期消息 ${JSON.stringify(message)}`);
    },
    getURL: (p) => `chrome-extension://test/${p}`,
    async getContexts() {
      return log.offscreenCreated > 0 ? [{}] : [];
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
      return permissionsGranted;
    },
  },
  commands: { onCommand: { addListener: () => {} } },
  tabs: {
    async query() {
      return [{ id: 1, url: 'https://example.com/', windowId: 1 }];
    },
    async sendMessage() {
      return { ok: true };
    },
    async captureVisibleTab() {
      return 'data:image/png;base64,';
    },
  },
};

const worker = await createMockWorker();
await import('../src/lib/secret-input.js');
const {
  validateNewSecret,
  fromOtpauthUri,
  findDuplicate,
  normalizeSecretValue,
  analyzeSecretStrength,
  randomSecretBase32,
  ALLOWED_TYPES,
  ALLOWED_DIGITS,
  ALLOWED_PERIODS,
  ALLOWED_ALGORITHMS,
} = await import('../src/lib/secret-input.js');
const { suggestNameFromHost } = await import('../src/lib/match.js');

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
      if (listener({ type, ...extra }, {}, resolve) === true) return;
    }
    resolve(undefined);
  });
}

/* ------------------------------------------------------------------ */
console.log('① 密钥规范化与强度判定（对齐上游 validateBase32）');
/* ------------------------------------------------------------------ */
{
  check('去空格并大写', normalizeSecretValue('jbsw y3dp ehpk 3pxp'), 'JBSWY3DPEHPK3PXP');
  check('去掉连字符', normalizeSecretValue('JBSW-Y3DP'), 'JBSWY3DP');

  check('空密钥无效', analyzeSecretStrength('').valid, false);
  check('非法字符无效（含 0/1/8/9）', analyzeSecretStrength('JBSWY3DP0').valid, false);
  check('过短无效（7 字符）', analyzeSecretStrength('JBSWY3D').valid, false);
  check('8 字符有效但告警', Boolean(analyzeSecretStrength('JBSWY3DP').warning), true);
  check('26 字符强密钥无告警', analyzeSecretStrength('JBSWY3DPEHPK3PXPJBSWY3DPEH').warning, undefined);
  check('16 字符一般强度有告警', Boolean(analyzeSecretStrength('JBSWY3DPEHPK3PXP').warning), true);
}

/* ------------------------------------------------------------------ */
console.log('\n② 校验规则与上游 addSecretSchema 一致');
/* ------------------------------------------------------------------ */
{
  const base = { name: 'GitHub', secret: 'JBSWY3DPEHPK3PXP' };

  const ok = validateNewSecret(base);
  check('最小必填项通过', ok.ok, true);
  check('默认 type=TOTP', ok.payload.type, 'TOTP');
  check('默认 digits=6', ok.payload.digits, 6);
  check('默认 period=30', ok.payload.period, 30);
  check('默认 algorithm=SHA1', ok.payload.algorithm, 'SHA1');
  check('默认 account 为空串', ok.payload.account, '');
  check('TOTP 不带 counter', 'counter' in ok.payload, false);

  check('缺少 name 报错', Boolean(validateNewSecret({ ...base, name: '' }).errors.name), true);
  check('name 超 50 字报错', Boolean(validateNewSecret({ ...base, name: 'x'.repeat(51) }).errors.name), true);
  check('name 恰好 50 字通过', validateNewSecret({ ...base, name: 'x'.repeat(50) }).ok, true);
  check('缺少 secret 报错', Boolean(validateNewSecret({ ...base, secret: '' }).errors.secret), true);
  check('非法 base32 报错', Boolean(validateNewSecret({ ...base, secret: '1111' }).errors.secret), true);

  check('digits=7 被拒', Boolean(validateNewSecret({ ...base, digits: 7 }).errors.digits), true);
  check('period=45 被拒', Boolean(validateNewSecret({ ...base, period: 45 }).errors.period), true);
  check('period=60 通过', validateNewSecret({ ...base, period: 60 }).ok, true);
  check('algorithm=MD5 被拒', Boolean(validateNewSecret({ ...base, algorithm: 'MD5' }).errors.algorithm), true);
  check('type=STEAM 被拒（上游不支持）', Boolean(validateNewSecret({ ...base, type: 'STEAM' }).errors.type), true);

  const hotp = validateNewSecret({ ...base, type: 'HOTP', counter: 3 });
  check('HOTP 通过', hotp.ok, true);
  check('HOTP 带 counter', hotp.payload.counter, 3);
  check('HOTP 负计数器被拒', Boolean(validateNewSecret({ ...base, type: 'HOTP', counter: -1 }).errors.counter), true);

  check('payload 不含 id（由服务端生成）', 'id' in ok.payload, false);
  check('白名单与上游一致', ALLOWED_TYPES.join(), 'TOTP,HOTP');
  check('digits 白名单', ALLOWED_DIGITS.join(), '6,8');
  check('period 白名单', ALLOWED_PERIODS.join(), '30,60,120');
  check('algorithm 白名单', ALLOWED_ALGORITHMS.join(), 'SHA1,SHA256,SHA512');
}

/* ------------------------------------------------------------------ */
console.log('\n③ otpauth:// 解析 → 上游条目形状');
/* ------------------------------------------------------------------ */
{
  const totp = fromOtpauthUri(
    'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30',
  );
  check('解析成功', totp.ok, true);
  check('issuer 映射到 name', totp.value.name, 'GitHub');
  check('account 保留', totp.value.account, 'alice');
  check('secret 大写', totp.value.secret, 'JBSWY3DPEHPK3PXP');
  check('type 大写 TOTP', totp.value.type, 'TOTP');
  check('解析结果可直接通过校验', validateNewSecret(totp.value).ok, true);

  const hotp = fromOtpauthUri('otpauth://hotp/Acme:bob?secret=JBSWY3DPEHPK3PXP&counter=7');
  check('HOTP URI 类型', hotp.value.type, 'HOTP');
  check('HOTP URI 计数器', hotp.value.counter, 7);

  const weird = fromOtpauthUri('otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&digits=7&period=45&algorithm=MD5');
  check('不支持的 digits 降级为 6', weird.value.digits, 6);
  check('不支持的 period 降级为 30', weird.value.period, 30);
  check('不支持的算法降级为 SHA1', weird.value.algorithm, 'SHA1');
  check('降级有告警', weird.warnings.length >= 3, true);
  check('降级后仍可通过校验', validateNewSecret(weird.value).ok, true);

  const broken = fromOtpauthUri('https://example.com');
  check('非 otpauth 协议解析失败', broken.ok, false);
}

/* ------------------------------------------------------------------ */
console.log('\n④ 重复检测（对齐 checkDuplicateSecret）');
/* ------------------------------------------------------------------ */
{
  const entries = [
    { id: 'a', name: 'GitHub', account: 'alice', secret: 'JBSWY3DPEHPK3PXP' },
  ];
  check(
    '三者全同 → 命中',
    findDuplicate(entries, { name: 'GitHub', account: 'alice', secret: 'JBSWY3DPEHPK3PXP' })?.id,
    'a',
  );
  check(
    'secret 大小写不同也算同一条',
    findDuplicate(entries, { name: 'GitHub', account: 'alice', secret: 'jbswy3dpehpk3pxp' })?.id,
    'a',
  );
  check('换账户 → 不重复', findDuplicate(entries, { name: 'GitHub', account: 'bob', secret: 'JBSWY3DPEHPK3PXP' }), null);
  check('换密钥 → 不重复', findDuplicate(entries, { name: 'GitHub', account: 'alice', secret: 'MZXW6YTBOI' }), null);
  check('换服务名 → 不重复', findDuplicate(entries, { name: 'GitLab', account: 'alice', secret: 'JBSWY3DPEHPK3PXP' }), null);
}

/* ------------------------------------------------------------------ */
console.log('\n⑤ 经 background 写入服务端');
/* ------------------------------------------------------------------ */

// ③④ 是纯函数，不需要 service worker；⑤ 之后要真的发消息，这里才加载
await import('../src/background.js');
check('service worker 已注册消息监听', messageListeners.length > 0, true);

{
  await dispatch('CONFIG_SET', { patch: { serverUrl: worker.url } });
  const login = await dispatch('LOGIN', { credential: DEFAULT_PASSWORD });
  check('登录成功', login.ok, true);
  check('初始 2 条', login.count, 2);

  const payload = validateNewSecret({
    name: 'Example',
    account: 'carol@example.com',
    secret: randomSecretBase32(20),
    type: 'TOTP',
    digits: 6,
    period: 30,
    algorithm: 'SHA256',
  }).payload;

  const created = await dispatch('ADD_SECRET', { payload });
  check('写入成功', created.ok, true);
  check('返回 201', created.status, 201);
  check('服务端生成了 id', Boolean(created.secret?.id), true);
  check('返回的 name 正确', created.secret.name, 'Example');
  check('计数增加到 3', created.count, 3);

  // 关键：缓存必须失效，否则新增的条目要等 30 秒才出现
  const state = await dispatch('STATE');
  check('缓存已刷新到 3 条', state.count, 3);

  const list = await dispatch('ENTRIES');
  check('列表里能查到新条目', list.entries.some((e) => e.id === created.secret.id), true);
}

/* ------------------------------------------------------------------ */
console.log('\n⑥ 重复与非法输入的服务端行为');
/* ------------------------------------------------------------------ */
{
  const payload = validateNewSecret({
    name: 'GitHub',
    account: 'alice@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
  }).payload;

  const dup = await dispatch('CHECK_DUPLICATE', { candidate: payload });
  check('预检查出重复', dup.duplicate?.id, 'sec-totp-1');

  const rejected = await dispatch('ADD_SECRET', { payload });
  check('重复写入返回 error', rejected.error, true);
  check('状态码 409', rejected.status, 409);
  checkTrue('提示已存在', rejected.message.includes('已存在'), rejected.message);

  // 本地放行的、服务端拒绝的枚举值 —— 证明白名单两边一致
  const bad = await dispatch('ADD_SECRET', {
    payload: { name: 'Bad', account: '', secret: 'JBSWY3DPEHPK3PXP', type: 'TOTP', digits: 7, period: 30, algorithm: 'SHA1' },
  });
  check('服务端拒绝 digits=7', bad.status, 400);

  const badPeriod = await dispatch('ADD_SECRET', {
    payload: { name: 'Bad', account: '', secret: 'JBSWY3DPEHPK3PXP', type: 'TOTP', digits: 6, period: 45, algorithm: 'SHA1' },
  });
  check('服务端拒绝 period=45', badPeriod.status, 400);
}

/* ------------------------------------------------------------------ */
console.log('\n⑦ 随机密钥生成器');
/* ------------------------------------------------------------------ */
{
  const a = randomSecretBase32(20);
  const b = randomSecretBase32(20);
  check('长度符合 base32 编码规律', a.length, Math.ceil((20 * 8) / 5));
  check('两次生成不同', a !== b, true);
  check('生成的密钥能通过校验', analyzeSecretStrength(a).valid, true);
  check('生成的密钥足够强（无告警）', analyzeSecretStrength(a).warning, undefined);
}

/* ------------------------------------------------------------------ */
console.log('\n⑧ 站点名预填建议（suggestNameFromHost）');
/* ------------------------------------------------------------------ */
{
  check('github.com → Github', suggestNameFromHost('github.com'), 'Github');
  check('mail.google.com → Google（取主标签）', suggestNameFromHost('mail.google.com'), 'Google');
  check('www.zhihu.com → Zhihu（去 www）', suggestNameFromHost('www.zhihu.com'), 'Zhihu');
  check('my-site.com → My Site（连字符分词）', suggestNameFromHost('my-site.com'), 'My Site');
  check('GITHUB.COM 大小写归一', suggestNameFromHost('GITHUB.COM'), 'Github');
  check('localhost → Localhost', suggestNameFromHost('localhost'), 'Localhost');
  check('空输入 → 空串', suggestNameFromHost(''), '');
  check('纯端口式输入不崩', typeof suggestNameFromHost('127.0.0.1:8765'), 'string');
}

await worker.close();

console.log(`\n${'='.repeat(52)}`);
console.log(`新增功能验证：通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(52));
// exitCode 替代 process.exit：避免 Windows 下强退触发 libuv 断言崩溃
process.exitCode = failed === 0 ? 0 : 1;
