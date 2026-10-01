/**
 * 扩展资源路径完整性检查（零依赖）
 *
 * 用途：这个问题曾经真实发生过 —— manifest.json 里所有路径都写成了 "src/xxx"，
 *      而扩展加载的根目录就是 src/，于是 Chromium 去 src/src/xxx 找，直接加载失败。
 *      页面打不开、background 起不来、图标全是裂图，而任何单元测试都发现不了。
 *
 *      本脚本模拟浏览器的解析规则：以 manifest.json 所在目录为根，逐个校验声明的
 *      资源是否真实存在，并检查没人再偷偷加回 "src/" 前缀。
 *
 * 运行：node scripts/verify-manifest.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_ROOT = join(PROJECT_ROOT, 'src'); // 扩展根目录：加载时选的就是它
const MANIFEST_PATH = join(EXT_ROOT, 'manifest.json');

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

function exists(relPath) {
  return existsSync(join(EXT_ROOT, relPath)) && statSync(join(EXT_ROOT, relPath)).isFile();
}

console.log(`扩展根目录：${EXT_ROOT}\n`);

/* ------------------------------------------------------------------ */
console.log('① manifest.json');
/* ------------------------------------------------------------------ */
check('位于扩展根目录', existsSync(MANIFEST_PATH));

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  check('是合法 JSON', true);
} catch (error) {
  check('是合法 JSON', false, error.message);
  process.exit(1);
}

check('manifest_version 为 3', manifest.manifest_version === 3, String(manifest.manifest_version));
check(
  'minimum_chrome_version 与 offscreen API 兼容（≥109）',
  Number(manifest.minimum_chrome_version) >= 109,
  String(manifest.minimum_chrome_version),
);

/* ------------------------------------------------------------------ */
console.log('\n② 声明的资源必须存在（以扩展根为基准解析）');
/* ------------------------------------------------------------------ */

/** 收集 manifest 中所有"相对资源路径"声明 */
const declarations = [];

if (manifest.action?.default_popup) {
  declarations.push(['action.default_popup', manifest.action.default_popup]);
}
for (const [size, path] of Object.entries(manifest.action?.default_icon ?? {})) {
  declarations.push([`action.default_icon[${size}]`, path]);
}
if (manifest.background?.service_worker) {
  declarations.push(['background.service_worker', manifest.background.service_worker]);
}
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  declarations.push([`icons[${size}]`, path]);
}
if (manifest.options_ui?.page) {
  declarations.push(['options_ui.page', manifest.options_ui.page]);
}
for (const script of manifest.content_scripts ?? []) {
  for (const path of script.js ?? []) declarations.push(['content_scripts[].js', path]);
  for (const path of script.css ?? []) declarations.push(['content_scripts[].css', path]);
}
for (const resource of manifest.web_accessible_resources ?? []) {
  for (const path of resource.resources ?? []) {
    declarations.push(['web_accessible_resources[].resources', path]);
  }
}

check('至少收集到若干路径声明', declarations.length >= 10, `${declarations.length} 条`);

for (const [field, path] of declarations) {
  check(`${field} → ${path}`, exists(path), `解析为 ${join(EXT_ROOT, path)}`);
}

/* ------------------------------------------------------------------ */
console.log('\n③ 不得出现重复的 src/ 前缀（本次踩的坑）');
/* ------------------------------------------------------------------ */
{
  // 扩展根目录本身叫 src/，所以任何以 "src/" 开头的声明都是错的
  const offenders = declarations.filter(([, path]) => path.startsWith('src/'));
  check(
    'manifest 中没有一行以 src/ 开头',
    offenders.length === 0,
    offenders.map(([f, p]) => `${f}=${p}`).join(', '),
  );

  // 同样的错误也可能出现在运行期拼路径的地方
  const clipboard = readFileSync(join(EXT_ROOT, 'lib/clipboard.js'), 'utf8');
  const offscreenConst = /const OFFSCREEN_URL\s*=\s*'([^']+)'/.exec(clipboard);
  check('clipboard.js 里能取到 OFFSCREEN_URL', Boolean(offscreenConst));
  if (offscreenConst) {
    const value = offscreenConst[1];
    check(`OFFSCREEN_URL 不以 src/ 开头（当前 "${value}"）`, !value.startsWith('src/'));
    check(`OFFSCREEN_URL 指向真实文件`, exists(value), `解析为 ${join(EXT_ROOT, value)}`);
  }
}

/* ------------------------------------------------------------------ */
console.log('\n④ HTML 引用的资源必须存在（相对 HTML 自身解析）');
/* ------------------------------------------------------------------ */
{
  const htmlFiles = ['popup/popup.html', 'options/options.html', 'offscreen.html', 'add.html'];
  for (const rel of htmlFiles) {
    if (!exists(rel)) {
      check(`${rel} 存在`, false);
      continue;
    }
    const html = readFileSync(join(EXT_ROOT, rel), 'utf8');
    const dir = dirname(join(EXT_ROOT, rel));
    const refs = [
      ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ].filter((href) => !/^(https?:)?\/\//.test(href) && !href.startsWith('data:'));

    check(`${rel} 引用了本地资源`, refs.length > 0, `${refs.length} 条`);
    for (const ref of refs) {
      const target = normalize(join(dir, ref));
      const insideRoot = target.startsWith(normalize(EXT_ROOT));
      check(`  ${rel} → ${ref}`, existsSync(target) && insideRoot, target);
    }
    // MV3 禁止内联脚本
    check(`${rel} 无内联 <script> 代码块`, !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html));
  }
}

/* ------------------------------------------------------------------ */
console.log('\n⑤ JS 的静态 import 必须可解析');
/* ------------------------------------------------------------------ */
{
  const jsFiles = [
    'background.js',
    'content.js',
    'offscreen.js',
    'lib/api.js',
    'lib/otp.js',
    'lib/match.js',
    'lib/clipboard.js',
    'popup/popup.js',
    'options/options.js',
    'add.js',
  ];

  for (const rel of jsFiles) {
    if (!exists(rel)) {
      check(`${rel} 存在`, false);
      continue;
    }
    const code = readFileSync(join(EXT_ROOT, rel), 'utf8');
    const specs = [
      ...[...code.matchAll(/import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...code.matchAll(/import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ];

    if (specs.length === 0) {
      check(`${rel}（无静态 import）`, true);
      continue;
    }
    for (const spec of specs) {
      if (!spec.startsWith('.')) {
        check(`  ${rel} → ${spec}（裸模块名，扩展内不受支持）`, false, spec);
        continue;
      }
      const target = normalize(join(dirname(join(EXT_ROOT, rel)), spec));
      check(`  ${rel} → ${spec}`, existsSync(target), target);
    }
  }
}

/* ------------------------------------------------------------------ */
console.log('\n⑥ JS 引用的 DOM id 必须在对应 HTML 中存在');
/* ------------------------------------------------------------------ */
{
  // 这条检查针对一类很隐蔽的崩溃：JS 里 getElementById 拼错一个字母，
  // 得到 null，然后 null.textContent = ... 直接炸在页面初始化阶段。
  // 没有单元测试会覆盖到，只能在加载真实页面时才发现。
  const pairs = [
    ['popup/popup.js', 'popup/popup.html'],
    ['options/options.js', 'options/options.html'],
    ['add.js', 'add.html'],
  ];

  for (const [jsRel, htmlRel] of pairs) {
    if (!exists(jsRel) || !exists(htmlRel)) {
      check(`${jsRel} / ${htmlRel} 存在`, false);
      continue;
    }
    const js = readFileSync(join(EXT_ROOT, jsRel), 'utf8');
    const html = readFileSync(join(EXT_ROOT, htmlRel), 'utf8');

    const wanted = new Set(
      [...js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    );
    const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

    const missing = [...wanted].filter((id) => !declared.has(id));
    check(
      `${jsRel} 引用的 ${wanted.size} 个 id 都在 ${htmlRel} 中`,
      missing.length === 0,
      missing.length ? `缺失：${missing.join(', ')}` : '',
    );
  }
}

/* ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(52)}`);
console.log(`资源路径检查：通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(52));
process.exitCode = failed === 0 ? 0 : 1;
