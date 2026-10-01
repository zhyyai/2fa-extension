/**
 * 无依赖的 OTP 正确性验证脚本
 *
 * 用途：在没有 npm 网络的环境里，直接用 Node 内置 crypto.subtle 验证
 *       HOTP/TOTP 实现是否符合 RFC 标准向量。
 *
 * 运行：node scripts/verify-otp.mjs
 */

import {
  base32Decode,
  base32Encode,
  generateHOTP,
  generateTOTP,
  parseOtpauthUri,
} from '../src/lib/otp.js';

const SECRET_ASCII = '12345678901234567890'; // RFC 4226 / 6238 官方测试密钥
const SECRET_B32 = base32Encode(new TextEncoder().encode(SECRET_ASCII));

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}\n     期望: ${expected}\n     实际: ${actual}`);
  }
}

console.log(`\n测试密钥 base32 = ${SECRET_B32}\n`);

console.log('base32 解码（RFC 4648）：');
check(
  'JBSWY3DPEHPK3PXP',
  Array.from(base32Decode('JBSWY3DPEHPK3PXP'))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(''),
  '48656c6c6f21deadbeef',
);

console.log('\nHOTP（RFC 4226 附录 D）：');
const hotpExpected = [
  '755224', '287082', '359152', '969429', '338314',
  '254676', '287922', '162583', '399871', '520489',
];
for (let counter = 0; counter < hotpExpected.length; counter++) {
  const code = await generateHOTP({
    secret: SECRET_B32,
    counter,
    digits: 6,
    algorithm: 'SHA1',
  });
  check(`counter=${counter}`, code, hotpExpected[counter]);
}

console.log('\nTOTP（RFC 6238 附录 B, SHA-1, 8 位, period=30）：');
const totpCases = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
for (const [t, expected] of totpCases) {
  const result = await generateTOTP({
    secret: SECRET_B32,
    period: 30,
    digits: 8,
    algorithm: 'SHA1',
    timestamp: t * 1000,
  });
  check(`T=${t}`, result.code, expected);
}

console.log('\notpauth:// URI 解析：');
const parsed = parseOtpauthUri(
  'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30',
);
check('type', parsed.type, 'totp');
check('issuer', parsed.issuer, 'GitHub');
check('account', parsed.account, 'alice');

console.log(`\n${'='.repeat(48)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(48));

process.exitCode = failed === 0 ? 0 : 1;
