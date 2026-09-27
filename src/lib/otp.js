/**
 * OTP 生成核心（TOTP / HOTP / Steam）
 *
 * 设计说明：
 * - 纯 WebCrypto 实现，无第三方依赖，可直接在 MV3 service worker 中运行。
 * - 与 wuzf/2fa 上游 src/otp/generator.js 行为对齐（RFC 4226 / RFC 6238 + Steam 变体）。
 * - HMAC 走 crypto.subtle.importKey：secret 进入 CryptoKey 后不可导出，
 *   优于"明文 secret 进入 JS 变量"的写法。
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';

/** WebCrypto 的 hash 名称映射 */
const HASH_MAP = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
};

/** 归一化用户/上游传入的算法名 */
function normalizeAlgorithm(algorithm) {
  if (!algorithm) return 'SHA-1';
  const upper = String(algorithm).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (upper === 'SHA1' || upper === 'SHA-1') return 'SHA-1';
  if (upper === 'SHA256' || upper === 'SHA-256') return 'SHA-256';
  if (upper === 'SHA512' || upper === 'SHA-512') return 'SHA-512';
  throw new Error(`不支持的算法: ${algorithm}`);
}

/** base32 解码（RFC 4648），忽略大小写、空格与 = 填充 */
export function base32Decode(input) {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/[\s=]/g, '');
  if (!cleaned) throw new Error('secret 为空');

  let bits = '';
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`非法 base32 字符: ${char}`);
    bits += index.toString(2).padStart(5, '0');
  }

  const byteCount = Math.floor(bits.length / 8);
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

/** base32 编码（不加 = 填充，与解码端忽略填充的行为一致） */
export function base32Encode(bytes) {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    output += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }
  return output;
}

/** 把 counter 写成 64-bit big-endian（JS 位运算是 32 位的，故拆成两段） */
function counterToBuffer(counter) {
  if (!Number.isFinite(counter) || counter < 0) {
    throw new Error(`counter 非法: ${counter}`);
  }
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter % 0x100000000);
  return buffer;
}

async function hmacDigest(algorithm, keyBytes, counter) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: normalizeAlgorithm(algorithm) },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, counterToBuffer(counter));
  return new Uint8Array(signature);
}

/** RFC 4226 动态截断 */
function dynamicTruncate(digest, digits) {
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Steam Guard 变体：5 位，使用专用字符集 */
function steamTruncate(digest) {
  const offset = digest[digest.length - 1] & 0x0f;
  let full =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += STEAM_ALPHABET[full % STEAM_ALPHABET.length];
    full = Math.floor(full / STEAM_ALPHABET.length);
  }
  return code;
}

/**
 * HOTP：按指定 counter 生成
 * @returns {Promise<string>}
 */
export async function generateHOTP({ secret, counter = 0, digits = 6, algorithm = 'SHA1' }) {
  const keyBytes = base32Decode(secret);
  const digest = await hmacDigest(algorithm, keyBytes, counter);
  return dynamicTruncate(digest, digits);
}

/**
 * TOTP：按时间窗生成
 * @returns {Promise<{code: string, counter: number, period: number, remaining: number}>}
 */
export async function generateTOTP({
  secret,
  period = 30,
  digits = 6,
  algorithm = 'SHA1',
  timestamp = Date.now(),
}) {
  const keyBytes = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / period);
  const digest = await hmacDigest(algorithm, keyBytes, counter);

  // 剩余秒数：用时间戳精确计算，避免 period 非 30 时算错
  const elapsed = Math.floor(timestamp / 1000) % period;
  return {
    code: dynamicTruncate(digest, digits),
    counter,
    period,
    remaining: period - elapsed,
  };
}

/** Steam Guard TOTP（固定 period=30、digits=5） */
export async function generateSteam({ secret, timestamp = Date.now() }) {
  const keyBytes = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / 30);
  const digest = await hmacDigest('SHA1', keyBytes, counter);
  const elapsed = Math.floor(timestamp / 1000) % 30;
  return {
    code: steamTruncate(digest),
    counter,
    period: 30,
    remaining: 30 - elapsed,
  };
}

/**
 * 统一入口：按条目类型分派
 * @param {Object} entry 上游密钥条目 { secret, type, digits, period, algorithm, counter }
 * @param {number} timestamp
 */
export async function generateForEntry(entry, timestamp = Date.now()) {
  const type = String(entry?.type || 'totp').toLowerCase();

  if (type === 'steam') {
    return generateSteam({ secret: entry.secret, timestamp });
  }
  if (type === 'hotp') {
    return {
      code: await generateHOTP({
        secret: entry.secret,
        counter: entry.counter ?? 0,
        digits: entry.digits ?? 6,
        algorithm: entry.algorithm ?? 'SHA1',
      }),
      counter: entry.counter ?? 0,
      period: 0,
      remaining: Number.POSITIVE_INFINITY, // HOTP 不随时间失效
    };
  }
  return generateTOTP({
    secret: entry.secret,
    period: entry.period ?? 30,
    digits: entry.digits ?? 6,
    algorithm: entry.algorithm ?? 'SHA1',
    timestamp,
  });
}

/**
 * 从 otpauth:// URI 解析条目
 * 支持 totp/hotp；steam 由上游以 type 字段标识，URI 中通常表现为 totp
 */
export function parseOtpauthUri(uri) {
  let url;
  try {
    url = new URL(String(uri).trim());
  } catch {
    throw new Error('不是合法的 otpauth:// URI');
  }
  if (url.protocol !== 'otpauth:') throw new Error('不是 otpauth:// URI');

  const type = url.hostname.toLowerCase(); // totp | hotp
  // label 形如 "Issuer:account"，需解码
  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const [issuerFromLabel, ...rest] = label.split(':');
  const account = rest.join(':') || '';

  const params = url.searchParams;
  const issuer = params.get('issuer') || issuerFromLabel || '';

  return {
    type,
    issuer,
    account,
    secret: params.get('secret') || '',
    digits: params.get('digits') ? Number(params.get('digits')) : 6,
    period: params.get('period') ? Number(params.get('period')) : 30,
    algorithm: (params.get('algorithm') || 'SHA1').toUpperCase(),
    counter: params.get('counter') ? Number(params.get('counter')) : 0,
  };
}
