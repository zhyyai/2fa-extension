# 服务端改造（可选）

## 结论先说：**默认一行服务端代码都不用改**

拿到上游源码（wuzf/2fa **v1.9.0**）逐行核对后，原计划里"必须给服务端打 Bearer 补丁"这个前提**不成立**。两处源码直接推翻了它：

```js
// src/utils/auth.js:427-434  —— verifyAuth() 已经支持 Bearer
let token = getTokenFromCookie(request);
if (!token) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
        token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    }
}
```

```js
// src/utils/auth.js:749-756  —— 登录响应体已经带 token
return new Response(JSON.stringify({
    success: true,
    message: '登录成功',
    token: jwtToken,   // 同时在响应 body 中返回 token（供测试和客户端使用）
    expiresAt: expiryDate.toISOString(),
    expiresIn: `${jwtExpiryDays}天`,
}), { status: 200, headers: { ..., 'Set-Cookie': createSetCookieHeader(...) } });
```

也就是说：扩展只要拿主密码换一次 token，之后全程用 `Authorization: Bearer` 即可，**不需要动服务端任何一个文件**。

## 那 SameSite=Strict 的 Cookie 问题怎么解决的？

它确实存在 —— 扩展 origin 是 `chrome-extension://<id>`，向 `*.workers.dev` 发请求属跨站，`SameSite=Strict` 的 Cookie 不会带上；而 `Cookie` 又是 forbidden header name，塞不进去。

解决办法是**绕开 Cookie 而不是修 Cookie**：上游的 Bearer 分支本来就在，直接用它。PWA 继续走 Cookie，扩展走 Bearer，两条路互不影响。

## 跨域（CORS）怎么办？也是绕开

上游 `isOriginAllowed()`（src/utils/security.js:53）只放行与 `Host` 同源的 origin，`chrome-extension://` 拿不到 `Access-Control-Allow-Origin`。

但 Chrome MV3 下，**service worker 发出的、且已取得目标 origin 的 host 权限的请求豁免 CORS**。所以：

- 所有 API 调用都从 background service worker 发出（popup / content script 只发消息，不直接 fetch）
- 运行时只申请用户服务器那**一个** origin 的权限，不申请 `<all_urls>`

manifest 里保留 `optional_host_permissions: ["https://*/*", "http://*/*"]` 是必要的 —— Chrome 要求可申请的具体 origin 必须被这里声明的 pattern 覆盖。用户实际看到的授权提示只会是那一个具体域名。

## 什么时候才需要打补丁

只有两种情况，见 [`cors-allow-extension.js`](./cors-allow-extension.js)：

| 场景 | 是否需要 |
|---|:--:|
| Chrome + 授予了目标 origin 的 host 权限 | ❌ 不需要 |
| Firefox（扩展无等价的 CORS 豁免） | ✅ 需要 |
| 想让 content script 在页面上下文直连 API | ✅ 需要 |

补丁做的事很有限：在 `isOriginAllowed()` 之后追加一段**精确匹配**的扩展 ID 白名单（读 `ALLOWED_EXTENSION_ORIGINS` secret），不放宽同源策略、不动 `SameSite`、不动认证逻辑。

## 别做的事

- ❌ 不要放宽 `SameSite=Strict`。上游 PWA 靠它防 CSRF，这是正确的默认值。
- ❌ 不要在响应体里额外返回 `secret` 明文。`token` 返回无妨（客户端本来就要拿到它），但密钥条目本身必须是最小字段集。
- ❌ 不要为了让扩展连得上而在 CSP 里加 `'unsafe-eval'`。上游 CSP 用的是 `'unsafe-inline'`（自己的页面自己的策略），与扩展无关；扩展侧如果将来要用 WASM，加的是 `'wasm-unsafe-eval'`，两者不是一回事。
- ❌ 不要用 `chrome.cookies` 去偷 PWA 的 Cookie。读得出 HttpOnly，但没有任何地方能塞进跨站请求。
