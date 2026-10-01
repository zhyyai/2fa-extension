/**
 * 构建 Firefox 变体
 *
 * 设计决定：
 *   - src/ 保持为 Chrome 版单一事实源，本脚本只做**产物变换**，不碰源码。
 *   - Firefox MV3 不支持 background.service_worker → 换成 background.page 事件页，
 *     由 background.html 以 <script type="module"> 加载 background.js，
 *     ES module 静态 import 链原样复用。
 *   - Firefox 无 offscreen API（剪贴板降级链在运行时自动跳过该级）→ 移除该权限，
 *     避免 AMO/安装时的未知权限告警。
 *   - 浏览器自行探测 BarcodeDetector，Firefox 下扫码按钮自动隐藏，无需产物差异。
 *
 * 产物：dist/firefox/（目录）与 dist/2fa-extension-firefox.xpi（可直接临时加载）。
 * 用法：node scripts/build-firefox.mjs
 *   GECKO_ID=xxx node scripts/build-firefox.mjs  可覆盖扩展 ID
 */

import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const out = join(root, 'dist', 'firefox');
const xpi = join(root, 'dist', '2fa-extension-firefox.xpi');

const GECKO_ID = process.env.GECKO_ID ?? '2fa-extension@koalas.kdns.fr';
const MIN_FIREFOX = '115.0'; // chrome.storage.session 的最低支持版本

if (!existsSync(join(src, 'manifest.json'))) {
  console.error('找不到 src/manifest.json —— 请在项目根目录运行');
  process.exitCode = 1;
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  cpSync(src, out, { recursive: true });

  const manifestPath = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // 1) 后台：service_worker → 事件页（background.html 以 module 方式加载）
  delete manifest.background;
  manifest.background = { page: 'background.html' };

  // 2) 权限：Firefox 无 offscreen API，移除；clipboardWrite 保留
  //    （Firefox 中该权限允许后台页免用户手势写剪贴板，正是第一级降级需要的）
  manifest.permissions = manifest.permissions.filter((p) => p !== 'offscreen');

  // 3) Firefox 扩展身份：稳定 ID（服务端 CORS 白名单按 origin 精确匹配的前提）
  manifest.browser_specific_settings = {
    gecko: { id: GECKO_ID, strict_min_version: MIN_FIREFOX },
  };

  // 4) Chrome 专属键：Firefox 会忽略，但清掉更干净
  delete manifest.minimum_chrome_version;

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // 5) 事件页：module script 复用整条 import 链
  writeFileSync(
    join(out, 'background.html'),
    `<!doctype html>
<!-- Firefox 事件页：background.js 及其 import 链（lib/*.js）在此以 ES module 加载。
     由 scripts/build-firefox.mjs 生成，勿直接修改。 -->
<html>
<head><meta charset="utf-8"></head>
<body>
<script type="module" src="background.js"></script>
</body>
</html>
`,
  );

  // 6) 打 XPI（zip 内容以 manifest.json 为根；.xpi = 改名的 zip）
  //    ⚠️ 打包器必须是正斜杠条目：PowerShell Compress-Archive 与 .NET Framework
  //    ZipFile 都用反斜杠（Firefox 会把 lib\api.js 当单文件名，子目录模块全 404）。
  //    Windows 自带 bsdtar（System32\tar.exe）按 zip 规范使用正斜杠。
  const TAR = process.env.TAR_EXE ?? 'C:\\Windows\\System32\\tar.exe';
  try {
    rmSync(xpi, { force: true });
    if (existsSync(TAR)) {
      execFileSync(TAR, ['--format=zip', '-cf', xpi, '-C', out, ...readdirSync(out)], { stdio: 'inherit' });
      console.log(`XPI 已生成：${xpi}`);
    } else {
      throw new Error('未找到 tar.exe');
    }
  } catch (error) {
    console.warn(`XPI 打包跳过（${error.message.split('\n')[0]}）；目录产物在 ${out}`);
  }

  console.log(`Firefox 构建完成：${out}`);
  console.log(`  gecko id: ${GECKO_ID}`);
  console.log(`  strict_min_version: ${MIN_FIREFOX}`);
  console.log('  变更：background.page 事件页 / 移除 offscreen 权限 / 新增 gecko 身份');
}
