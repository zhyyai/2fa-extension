/**
 * OTP 核心的 RFC 标准向量测试
 *
 * 运行：npm install && npm test
 *
 * 说明：HOTP/TOTP 的官方向量使用的密钥是 ASCII "12345678901234567890"，
 *       而本库的入参是 base32 字符串，因此先用 base32Encode 转换。
 *       base32 编解码自身的正确性由 RFC 4648 独立向量保证。
 */

import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateHOTP,
  generateTOTP,
  parseOtpauthUri,
} from '../src/lib/otp.js';

const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = base32Encode(new TextEncoder().encode(RFC_SECRET_ASCII));

describe('base32', () => {
  it('RFC 4648 向量：JBSWY3DPEHPK3PXP', () => {
    const decoded = base32Decode('JBSWY3DPEHPK3PXP');
    expect(Array.from(decoded)).toEqual([
      0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef,
    ]);
  });

  it('编解码往返一致', () => {
    const bytes = new TextEncoder().encode(RFC_SECRET_ASCII);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });

  it('忽略大小写、空格与 = 填充', () => {
    const upper = base32Decode('JBSWY3DPEHPK3PXP');
    const lower = base32Decode('jbswy3dpehpk3pxp');
    const padded = base32Decode('JBSWY3DPEHPK3PXP====');
    const spaced = base32Decode('JBSW Y3DP EHPK 3PXP');
    expect(Array.from(lower)).toEqual(Array.from(upper));
    expect(Array.from(padded)).toEqual(Array.from(upper));
    expect(Array.from(spaced)).toEqual(Array.from(upper));
  });

  it('拒绝非法字符', () => {
    expect(() => base32Decode('ABC1')).toThrow();
  });

  it('空 secret 抛错', () => {
    expect(() => base32Decode('')).toThrow();
  });
});

describe('HOTP (RFC 4226 附录 D)', () => {
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  it.each(expected.map((code, index) => [index, code]))(
    'counter=%i → %s',
    async (counter, code) => {
      const result = await generateHOTP({
        secret: RFC_SECRET_B32,
        counter,
        digits: 6,
        algorithm: 'SHA1',
      });
      expect(result).toBe(code);
    },
  );
});

describe('TOTP (RFC 6238 附录 B, SHA-1, 8 位)', () => {
  const cases = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(cases)('T=%i → %s', async (t, code) => {
    const result = await generateTOTP({
      secret: RFC_SECRET_B32,
      period: 30,
      digits: 8,
      algorithm: 'SHA1',
      timestamp: t * 1000,
    });
    expect(result.code).toBe(code);
  });

  it('返回剩余秒数与 counter', async () => {
    const result = await generateTOTP({
      secret: RFC_SECRET_B32,
      period: 30,
      digits: 6,
      timestamp: 59 * 1000,
    });
    expect(result.counter).toBe(1); // floor(59/30) = 1
    expect(result.remaining).toBe(1); // 30 - (59 % 30) = 1
  });
});

describe('otpauth URI 解析', () => {
  it('解析 totp URI', () => {
    const parsed = parseOtpauthUri(
      'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30',
    );
    expect(parsed.type).toBe('totp');
    expect(parsed.issuer).toBe('GitHub');
    expect(parsed.account).toBe('alice');
    expect(parsed.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
  });

  it('解析 hotp URI 的 counter', () => {
    const parsed = parseOtpauthUri('otpauth://hotp/Acme:bob?secret=JBSWY3DPEHPK3PXP&counter=7');
    expect(parsed.type).toBe('hotp');
    expect(parsed.counter).toBe(7);
  });

  it('非 otpauth 协议抛错', () => {
    expect(() => parseOtpauthUri('https://example.com')).toThrow();
  });
});
