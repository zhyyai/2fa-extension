/**
 * 【可选】CORS 扩展白名单补丁 —— 供 wuzf/2fa v1.9.0 接入
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ 默认不需要这个补丁。
 *
 *    上游已经原生支持 Bearer：verifyAuth() 在 Cookie 缺失时直接读
 *    Authorization 头（src/utils/auth.js:427-434），登录与刷新接口也已在
 *    响应体返回 token（auth.js:754 / 862）。
 *
 *    Chrome MV3 下，service worker 发出的、且已获得目标 origin 的 host 权限的
 *    请求**豁免 CORS**，因此同源限制（isOriginAllowed，src/utils/security.js:53）
 *    根本不会被触发。
 *
 *    只有下面两种情况才需要打这个补丁：
 *      1. Firefox —— 其扩展不享有与 Chrome 等价的 CORS 豁免
 *      2. 你希望 content script（页面上下文，受 CORS 约束）也能直连 API
 * ────────────────────────────────────────────────────────────────────
 *
 * 接入方式：把本文件的两个导出合并进 src/utils/security.js
 *   1. 用 allowExtensionOrigin() 替换 isOriginAllowed() 内部"检查白名单"那一段
 *   2. 在 wrangler 里配置 secret：
 *        wrangler secret put ALLOWED_EXTENSION_ORIGINS
 *        # 值示例：chrome-extension://abcdefghijklmnopabcdefghijklmnop
 *        # 多个用英文逗号分隔，可混用 moz-extension://
 *
 * 安全说明：
 *   - 白名单是**精确匹配**的扩展 ID，不是通配符 —— 别偷懒写 chrome-extension://*
 *   - 放行 CORS 不等于放行认证：请求仍须通过 verifyAuth() 的 Bearer 校验
 *   - 不要为了让扩展能连而放宽 SameSite —— 那是给 PWA 的 CSRF 防线开洞
 */

/**
 * 从环境变量解析扩展 origin 白名单
 *
 * @param {Object} env Cloudflare Worker env
 * @returns {string[]} 精确匹配的 origin 数组
 */
export function getAllowedExtensionOrigins(env) {
  const raw = env?.ALLOWED_EXTENSION_ORIGINS;
  if (!raw) return [];

  return String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^(chrome|moz)-extension:\/\/[a-z0-9]{32}$/i.test(value))
    .map((value) => value.toLowerCase());
}

/**
 * 判断 origin 是否放行。
 * 放在 src/utils/security.js 的 isOriginAllowed() 里，接在同源判断之后：
 *
 *   // 现有：同源判断
 *   if (allowedOrigins.includes(origin)) return true;
 *
 *   // 新增：扩展白名单
 *   if (isAllowedExtensionOrigin(origin)) return true;
 *
 * 注意 isOriginAllowed 目前是同步函数且拿不到 env；接入时需要把 env 透传进来
 * （getAllowedOrigin(request, env) → isOriginAllowed(origin, request, env)），
 * 或者退而求其次在 Worker 入口把白名单算好挂到 env 上：
 *   env.__extOrigins = getAllowedExtensionOrigins(env);
 *
 * @param {string} origin
 * @param {string[]} allowedList getAllowedExtensionOrigins() 的结果
 * @returns {boolean}
 */
export function isAllowedExtensionOrigin(origin, allowedList) {
  if (!origin || !Array.isArray(allowedList) || allowedList.length === 0) return false;
  return allowedList.includes(String(origin).trim().toLowerCase());
}

/**
 * 参考实现：改造后的 getAllowedOrigin（可直接替换 security.js 里同名函数）
 *
 * 需要同步改动调用链：
 *   getSecurityHeaders(request, options, env)
 *   getCorsPreflightHeaders(request, env)
 *
 * 上游现有的 CORS 头已经包含 Authorization：
 *   'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
 * （security.js:192）—— 所以带 Bearer 的预检不会再因为请求头被拒。
 */
export function getAllowedOriginWithExtensions(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  const host = request.headers.get('Host');
  if (host && (origin === `https://${host}` || origin === `http://${host}`)) {
    return origin;
  }

  if (host?.startsWith('localhost') || host?.startsWith('127.0.0.1')) {
    try {
      const originUrl = new URL(origin);
      const hostWithoutPort = host.split(':')[0];
      if (
        originUrl.hostname === hostWithoutPort ||
        originUrl.hostname === 'localhost' ||
        originUrl.hostname === '127.0.0.1'
      ) {
        return origin;
      }
    } catch {
      /* 非法 origin，继续往下走 */
    }
  }

  if (isAllowedExtensionOrigin(origin, getAllowedExtensionOrigins(env))) {
    return origin;
  }

  return null;
}
