/**
 * 新增条目的校验与规范化
 *
 * 这一模块是上游 src/utils/validation.js 的**客户端镜像**。之所以要在本地复制一遍规则，
 * 而不是直接把表单丢给服务端等 400：
 *   1. 服务端返回的是笼统的 ValidationError，字段级提示要本地给
 *   2. 密钥强度警告（validateBase32 的 warning）只在服务端响应里出现一次，
 *      本地先算出来能让用户在提交前就知道
 *
 * ⚠️ 与上游保持同步是硬要求。上游改了白名单而这里没改，用户会碰到"本地通过、服务端 400"。
 *    scripts/verify-contract.mjs 会断言上游的白名单，两边一起盯。
 *
 * 上游源码依据：
 *   addSecretSchema      src/utils/validation.js
 *   validateBase32       src/utils/validation.js
 *   checkDuplicateSecret src/utils/validation.js
 *   handleAddSecret      src/api/secrets/crud.js:78
 */

import { parseOtpauthUri } from './otp.js';

/** 上游 addSecretSchema 的枚举白名单 —— 改动必须同步上游 */
export const ALLOWED_TYPES = ['TOTP', 'HOTP'];
export const ALLOWED_DIGITS = [6, 8];
export const ALLOWED_PERIODS = [30, 60, 120];
export const ALLOWED_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];
export const MAX_NAME_LENGTH = 50;

/**
 * 上游**不支持** Steam Guard。
 *
 * 全项目 grep 只有 src/ui/config/serviceLogos.js 里一条域名映射，
 * addSecretSchema 的 type 白名单也只有 TOTP/HOTP。所以添加页不提供该选项 ——
 * 选了也会被服务端拒。otp.js 里的 generateSteam 仅在未来上游支持时才会被走到。
 */
export const UNSUPPORTED_TYPES = ['STEAM'];

/**
 * 规范化密钥字符串（去空格 / 连字符 / 加号并大写）。
 *
 * 这里和上游的**新增**路径有一处刻意的分歧，写清楚以便日后对齐：
 *   - 上游 addSecretSchema 的 transform 只有 toUpperCase().trim()，
 *     而校验用的 validateBase32 会先 replace(/\s/g,'') 再匹配。二者不一致，
 *     结果是 "JBSW Y3DP" 能通过校验，却带着空格原样落库（crud.js:104 存的是
 *     secretData.secret，即 transform 后的值）。
 *   - 上游**备份导入**路径用的是 sanitizeBackupSecretValue（backup-format.js:38），
 *     清洗规则是 [\s\-+]，落库的是干净值。
 *
 * 本扩展按导入侧的口径处理：发给服务端的永远是无空格连字符的大写形式。
 * 副作用是比上游新增页**更宽松**一点（连字符也能收），但落库结果更干净，
 * 不存在"存进去了却算不出正确验证码"的隐患。
 */
export function normalizeSecretValue(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[\s\-+]/g, '')
    .trim();
}

/**
 * 复刻上游 validateBase32：返回 { valid, error?, warning? }
 * 注意上游的判定顺序 —— 短密钥是 error，长但弱是 warning。
 */
export function analyzeSecretStrength(rawSecret) {
  const cleaned = String(rawSecret ?? '')
    .toUpperCase()
    .trim()
    .replace(/\s/g, '');

  if (!cleaned) return { valid: false, error: '密钥不能为空' };

  if (!/^[A-Z2-7]+=*$/.test(cleaned)) {
    return {
      valid: false,
      error: '密钥格式无效，只能包含字母 A-Z 和数字 2-7（例如：JBSWY3DPEHPK3PXP）',
    };
  }

  const paddingCount = (cleaned.match(/=/g) || []).length;
  const encodedLength = cleaned.length - paddingCount;
  const bitLength = Math.floor((encodedLength * 5) / 8) * 8;

  if (cleaned.length < 8) {
    return { valid: false, error: `密钥长度过短（${cleaned.length} 字符），至少需要 8 字符` };
  }
  if (bitLength < 80) {
    return {
      valid: true,
      warning: `密钥强度较弱（${bitLength} 位），建议使用至少 128 位（21 字符）的密钥`,
    };
  }
  if (bitLength >= 128) {
    return { valid: true };
  }
  return { valid: true, warning: `密钥强度一般（${bitLength} 位），推荐使用 128 位以上的密钥` };
}

/**
 * 校验并规范化一份待提交的条目。
 *
 * @param {Object} input 表单原始值
 * @returns {{ok: boolean, errors: Object<string,string>, warnings: string[], payload: Object|null}}
 */
export function validateNewSecret(input = {}) {
  const errors = {};
  const warnings = [];

  // name —— required, trim, ≤50
  const name = String(input.name ?? '').trim();
  if (!name) errors.name = '服务名称不能为空';
  else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `服务名称过长，最多支持 ${MAX_NAME_LENGTH} 个字符（当前：${name.length}）`;
  }

  // account —— optional, default ''
  const account = String(input.account ?? '').trim();

  // secret —— required, base32
  const secret = normalizeSecretValue(input.secret);
  if (!secret) {
    errors.secret = '密钥不能为空';
  } else {
    const strength = analyzeSecretStrength(secret);
    if (!strength.valid) errors.secret = strength.error;
    else if (strength.warning) warnings.push(strength.warning);
  }

  // type —— default TOTP，只允许 TOTP/HOTP
  const rawType = String(input.type ?? 'TOTP').toUpperCase();
  const type = ALLOWED_TYPES.includes(rawType) ? rawType : 'TOTP';
  if (!ALLOWED_TYPES.includes(rawType)) {
    errors.type = `不支持的 OTP 类型，仅支持 ${ALLOWED_TYPES.join(' 或 ')}`;
  }

  // digits —— default 6，只允许 6/8
  const digits = Number.parseInt(input.digits ?? 6, 10);
  if (!ALLOWED_DIGITS.includes(digits)) {
    errors.digits = `验证码位数仅支持 ${ALLOWED_DIGITS.join(' 或 ')} 位`;
  }

  // period —— default 30，只允许 30/60/120
  const period = Number.parseInt(input.period ?? 30, 10);
  if (!ALLOWED_PERIODS.includes(period)) {
    errors.period = `TOTP 周期仅支持 ${ALLOWED_PERIODS.join('、')} 秒`;
  }

  // algorithm —— default SHA1，只允许 SHA1/SHA256/SHA512
  const algorithm = String(input.algorithm ?? 'SHA1').toUpperCase();
  if (!ALLOWED_ALGORITHMS.includes(algorithm)) {
    errors.algorithm = `哈希算法仅支持 ${ALLOWED_ALGORITHMS.join('、')}`;
  }

  // counter —— 仅 HOTP 需要，非负安全整数
  let counter;
  if (type === 'HOTP') {
    counter = Number.parseInt(input.counter ?? 0, 10);
    if (!Number.isSafeInteger(counter) || counter < 0) {
      errors.counter = 'HOTP 计数器必须是非负整数';
    }
  }

  const ok = Object.keys(errors).length === 0;
  if (!ok) return { ok, errors, warnings, payload: null };

  // 不发送 id —— 服务端会用 crypto.randomUUID() 生成（crud.js:104）
  const payload = { name, account, secret, type, digits, period, algorithm };
  if (type === 'HOTP') payload.counter = counter;

  return { ok, errors, warnings, payload };
}

/**
 * 解析 otpauth:// URI 为上游条目形状。
 *
 * ⚠️ 关键映射：URI 里的 `issuer` 对应上游的 **`name`** 字段。
 *    上游没有 issuer 字段，直接透传会导致新条目显示为空名。
 *
 * 若 URI 携带上游不支持的参数值（如 digits=7），降级到允许值并给出警告，
 * 而不是让用户对着一个必然 400 的表单发呆。
 */
export function fromOtpauthUri(uri) {
  let parsed;
  try {
    parsed = parseOtpauthUri(uri);
  } catch (error) {
    return { ok: false, error: error.message, value: null, warnings: [] };
  }

  const warnings = [];
  const type = String(parsed.type ?? 'totp').toUpperCase() === 'HOTP' ? 'HOTP' : 'TOTP';

  let digits = Number.parseInt(parsed.digits ?? 6, 10);
  if (!ALLOWED_DIGITS.includes(digits)) {
    warnings.push(`URI 中的位数 ${digits} 不被上游支持，已改为 6`);
    digits = 6;
  }

  let period = Number.parseInt(parsed.period ?? 30, 10);
  if (!ALLOWED_PERIODS.includes(period)) {
    warnings.push(`URI 中的周期 ${period} 秒不被上游支持，已改为 30`);
    period = 30;
  }

  let algorithm = String(parsed.algorithm ?? 'SHA1').toUpperCase();
  if (!ALLOWED_ALGORITHMS.includes(algorithm)) {
    warnings.push(`URI 中的算法 ${algorithm} 不被上游支持，已改为 SHA1`);
    algorithm = 'SHA1';
  }

  // 上游 label 形如 "服务名:账户"，issuer 参数与 label 前缀都可能是服务名
  const name = String(parsed.issuer || parsed.account || '').trim();
  if (!name) warnings.push('URI 中未包含服务名，请手动填写');

  const value = {
    name,
    account: String(parsed.account ?? '').trim(),
    secret: normalizeSecretValue(parsed.secret),
    type,
    digits,
    period,
    algorithm,
    counter: type === 'HOTP' ? Number.parseInt(parsed.counter ?? 0, 10) : 0,
  };

  return { ok: true, error: null, value, warnings };
}

/**
 * 复刻上游 checkDuplicateSecret：name + account + secret 三者全同才算重复。
 * 只改其中任一项都允许再建一条（上游就是这么定的）。
 */
export function findDuplicate(entries, candidate) {
  const normalized = normalizeSecretValue(candidate?.secret);
  const name = String(candidate?.name ?? '').trim();
  const account = String(candidate?.account ?? '').trim();

  return (
    entries.find(
      (item) =>
        String(item.name ?? '').trim() === name &&
        String(item.account ?? '').trim() === account &&
        normalizeSecretValue(item.secret) === normalized,
    ) ?? null
  );
}

/** 生成一条可用于本地验证的样例密钥（仅测试用，随机 16 字节 base32） */
export function randomSecretBase32(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out;
}
