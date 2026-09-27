# 2FA Extension

Chrome 浏览器扩展，为 [wuzf/2fa](https://github.com/wuzf/2fa)（基于 Cloudflare Workers 的两步验证管理器）提供快捷取码、一键复制与登录页自动填充。

上游提供了完整的 PWA 与服务端能力，但没有浏览器扩展。本项目补齐这一块，**且不修改上游任何一行代码**。

| 项目 | 说明 |
|---|---|
| 兼容上游版本 | wuzf/2fa **v1.9.0** |
| 浏览器要求 | Chrome 116+（Manifest V3） |
| 服务端改动 | **无** |
| 自动化验证 | 189 项，全部通过（零第三方依赖） |
| 当前状态 | 功能完整，待真机联调 |

---

## 目录

- [功能特性](#功能特性)
- [工作原理](#工作原理)
- [安装](#安装)
- [使用](#使用)
- [服务端契约](#服务端契约)
- [目录结构](#目录结构)
- [开发](#开发)
- [权限说明](#权限说明)
- [安全说明](#安全说明)
- [已知限制与路线图](#已知限制与路线图)
- [许可证](#许可证)

---

## 功能特性

- **按站点自动匹配**：打开弹窗即把当前网站最可能用到的条目置顶（服务名 / 邮箱域名 / 主域标签三级打分）
- **一键复制**：复制后 31 秒自动清空剪贴板
- **自动填充**：识别登录页的 2FA 输入框并写入，兼容 React/Vue 受控组件
- **全类型支持**：TOTP、HOTP、Steam Guard，纯 WebCrypto 实现，通过 RFC 4226 / RFC 6238 官方标准向量
- **HOTP 强一致**：计数器与服务端保持同步，不会给出已作废的码
- **会话隔离**：token 与条目缓存只存内存级 `chrome.storage.session`，浏览器关闭即失效，不落盘
- **自动锁定**：默认 5 分钟无操作清空会话
- 搜索过滤、实时倒计时、快捷键取码

---

## 工作原理

```
   popup / content script
            │  chrome.runtime.sendMessage
            ▼
   background service worker  ──── 本地生成 OTP（secret 不离开这里）
            │  Authorization: Bearer <token>
            ▼
   Cloudflare Worker (wuzf/2fa)
```

三个关键设计决定：

**1. 认证用 Bearer，不动 Cookie**

上游把 JWT 放在 `HttpOnly + Secure + SameSite=Strict` 的 Cookie 里。扩展的 origin 是 `chrome-extension://<id>`，跨站请求带不上这个 Cookie，而 `Cookie` 是 forbidden header name 也塞不进去。

解决办法不是放宽 `SameSite`（那会降级所有 PWA 用户的 CSRF 防护），而是走上游本来就支持的 Bearer 通道：

```js
// 上游 src/utils/auth.js:427-434 —— verifyAuth() 原生支持 Bearer
let token = getTokenFromCookie(request);
if (!token) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
        token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    }
}
```

登录接口也已在响应体返回 token（`auth.js:754`）。所以扩展只需拿主密码换一次 token，服务端零改动。

**2. 跨域靠 host 权限豁免，不改服务端 CORS**

上游 `isOriginAllowed()`（src/utils/security.js:53）只放行同源，扩展拿不到 CORS 头。但 Chrome MV3 下，**service worker 发出的、且已取得目标 origin 的 host 权限的请求豁免 CORS**。因此所有 API 调用都收拢到 service worker，运行时只申请用户服务器那一个 origin。

**3. 密钥不离开 service worker**

`secret` 只在 SW 内存与 `chrome.storage.session` 中存活；popup 收到的只是已经算好的验证码。HOTP 的计数器由服务端裁决，本地只在服务端确认后才推进。

---

## 安装

### 前置条件

1. 已部署 [wuzf/2fa](https://github.com/wuzf/2fa) v1.9.0 或更高版本
2. 知道 Worker 地址（如 `https://your-worker.workers.dev`）和主密码
3. Chrome 116 或更高版本

### 加载扩展

1. 打开 `chrome://extensions`，启用右上角「开发者模式」
2. 点击「加载已解压的扩展程序」，选择 **`src/`** 目录（它是扩展根目录，内含 `manifest.json`）
3. 点击扩展图标，进入设置页

> 注意加载的是 `src/` 而不是仓库根目录。所有内部路径都相对 `src/` 解析，
> 因此 manifest 里写的是 `popup/popup.html` 而非 `src/popup/popup.html`。

### 配置

| 步骤 | 操作 |
|---|---|
| 1 | 填写 Worker 地址，例如 `https://your-worker.workers.dev` |
| 2 | 点击「授权访问该地址」，在弹出的对话框中确认 |
| 3 | 输入主密码，点击「登录并保存 token」 |

登录成功后即可使用。出现问题时可点「探测列表端点」排查端点路径。

**为什么要单独授权**：Chrome 要求可申请的具体 origin 必须被 manifest 声明的 pattern 覆盖，因此 `optional_host_permissions` 写成通配符；但用户实际看到的授权提示只会是填写的那一个具体域名。

---

## 使用

### 弹窗

点击扩展图标打开弹窗，当前站点匹配的条目会置顶显示。

| 元素 | 说明 |
|---|---|
| 验证码 | 点击即复制，复制后 31 秒自动清空剪贴板 |
| 倒计时 | TOTP 剩余有效秒数，归零后自动刷新；HOTP 不显示 |
| `⤓` 按钮 | 填充到当前页面的 2FA 输入框 |
| 搜索框 | 按服务名或账户过滤 |
| 齿轮 | 打开设置页 |

### 自动填充

content script 会识别页面上的 2FA 输入框（`autocomplete="one-time-code"`、`name*="otp"`、`maxlength="6"` 等）。点击填充后使用 native setter 写入，以触发 React/Vue 的状态更新。

**扩展绝不自动提交表单** —— 提交必须由用户完成。

### 快捷键

`Ctrl+Shift+C`：复制当前站点匹配的第一个验证码。

---

## 服务端契约

以下契约已从上游源码逐行核实，并由 `scripts/verify-contract.mjs` 固化为 34 项断言。上游升级后应先运行该脚本。

| 契约项 | 真实值 | 源码位置 |
|---|---|---|
| 登录 | `POST /api/login`，body **`{credential}`** | auth.js:703 |
| 登录响应 | `{success, message, token, expiresAt, expiresIn}` | auth.js:749 |
| 刷新令牌 | `POST /api/refresh-token`（支持 Bearer） | auth.js:800 |
| 认证方式 | Cookie `auth_token` **或** `Authorization: Bearer` | auth.js:427 |
| JWT 有效期 | 默认 30 天（`JWT_EXPIRY_DAYS` 可配） | auth.js |
| 密钥列表 | `GET /api/secrets` → **裸数组**（无信封） | crud.js:47 |
| 条目字段 | `{id, name, account, secret, type, digits, period, algorithm, counter?, hotpCounterNamespace?}` | crud.js:103 |
| HOTP 上推 | `POST /api/secrets/:id/counter` | counter.js:46 |
| 上推请求体 | `{expectedCounter, expectedSecret, expectedDigits, expectedAlgorithm, expectedNamespace?}` | validation.js |
| 上推响应 | `{success, message, data:{secret, id, counter, idempotent}}` | counter.js:28 |
| 错误响应 | `{error, message, timestamp}` | response.js:86 |

### 两个容易踩的坑

**登录字段是 `credential`，不是 `password`**。传 `password` 会被 ValidationError 拦下，返回「请提供密码」。

**HOTP 上推是乐观并发，不是「我用到 N 了」**。服务端要求提交一份完整快照做校验（counter.js:82-102）：

```
expectedNamespace == 服务端 hotpCounterNamespace
expectedSecret     == 服务端 secret（大写）
expectedDigits     == 服务端 digits（6 或 8）
expectedAlgorithm  == 服务端 algorithm（大写）
expectedCounter    == 服务端当前 counter
```

任一项不符即返回 409「请刷新后重试」。这是防止两端计数器漂移的设计。另外上游**不支持** `GET /api/secrets/:id`（该路径只有 PUT/DELETE，其余返回 405），因此获取服务端权威状态只能重拉整个列表。

---

## 目录结构

```
2fa-extension/
├── src/                          # 扩展本体（加载此目录）
│   ├── manifest.json
│   ├── background.js             # MV3 service worker，中枢
│   ├── content.js                # hostname 上报 + 自动填充 + 剪贴板兜底
│   ├── offscreen.html / offscreen.js  # 为 SW 提供 DOM/Clipboard 能力
│   ├── lib/
│   │   ├── api.js                # Worker API 客户端（契约已核实）
│   │   ├── otp.js                # TOTP/HOTP/Steam（纯 WebCrypto）
│   │   ├── match.js              # 站点 hostname 与条目匹配
│   │   └── clipboard.js          # 剪贴板三级降级
│   ├── popup/                    # 弹窗 UI
│   ├── options/                  # 设置页
│   └── icons/
├── server-patch/                 # 可选的服务端补丁（仅 Firefox 需要）
├── scripts/
│   ├── bootstrap.sh              # 一键建仓并推送（需 GitHub 网络）
│   ├── mock-worker.mjs           # 复刻上游契约的可观测 HTTP 服务
│   ├── verify-manifest.mjs       # 扩展资源路径完整性（44 项）
│   ├── verify-otp.mjs            # OTP 正确性（20 项）
│   ├── verify-contract.mjs       # 上游契约漂移检测（34 项）
│   ├── verify-integration.mjs    # ApiClient 端到端（48 项）
│   └── verify-background.mjs     # service worker 消息路由（43 项）
├── tests/                        # vitest 用例（需 npm install）
└── package.json
```

---

## 开发

### 环境要求

- Node 20+（验证脚本使用内置 `crypto.subtle`，无需安装依赖）
- Chrome 116+（调试用）

### 运行验证

```bash
npm test                               # 全部 189 项

node scripts/verify-manifest.mjs       # 44 项  资源路径是否真的能被浏览器找到
node scripts/verify-otp.mjs            # 20 项  RFC 4226 / RFC 6238 标准向量
node scripts/verify-contract.mjs       # 34 项  直接读上游源码做断言
node scripts/verify-integration.mjs    # 48 项  ApiClient 对 mock Worker
node scripts/verify-background.mjs     # 43 项  mock chrome.* 跑真实 background.js
```

`verify-manifest.mjs` 模拟浏览器的解析规则：以 `manifest.json` 所在目录为根，逐个校验声明的资源是否存在，顺带检查 HTML 引用、JS 的静态 import，以及 MV3 禁止的内联 `<script>`。这类问题（例如路径多写一层 `src/`）会让扩展直接加载失败，而任何单元测试都发现不了 —— 所以它排在 `npm test` 的第一位。

四个脚本均为零依赖，**不需要 `npm install`**。

`verify-contract.mjs` 默认读取 `/workspace/.upstream/2fa-main`，可用环境变量覆盖：

```bash
UPSTREAM_DIR=/path/to/2fa-main node scripts/verify-contract.mjs
```

`verify-background.mjs` 用一套假的 `chrome.*` 表面加载真实的 `src/background.js`，覆盖 HOTP 新鲜度、权限缺失、剪贴板降级、闹钟间隔等不易察觉的逻辑。它刻意不 mock `navigator.clipboard`（Node 中本就不存在），以此证明降级链真的会被触发。

### 发布为独立仓库

上游无需改动，因此本项目是独立仓库，不 fork 上游，后续也不会产生合并冲突：

```bash
export GITHUB_TOKEN=<your token>     # 或先执行 gh auth login
./scripts/bootstrap.sh 2fa-extension private
```

脚本会在推送前先运行验证，失败则中止。

---

## 权限说明

| 权限 | 用途 | 授予时机 | 安装提示 |
|---|---|---|---|
| `storage` | 配置（sync）与会话凭据（session） | 安装时 | 无 |
| `offscreen` | 让 service worker 能写剪贴板 | 安装时 | 无 |
| `alarms` | 自动锁定、剪贴板定时清除 | 安装时 | 无 |
| `activeTab` | 填充当前页输入框 | 安装时 | 无 |
| `<服务器 origin>/*` | 跨域调用（MV3 用它豁免 CORS） | 点击「授权访问该地址」时 | 单个具体域名 |
| content script `<all_urls>` | 检测任意站点的 2FA 输入框 | 安装时 | 「读取和更改您在所有网站上的数据」 |

最后一条需要说清楚：**它并不「最小」**。只要想在任意登录页自动检测 2FA 输入框，就必须能注入任意页面，Bitwarden、1Password 等同类扩展都是同一条权限，没有例外。

本项目做到的是**网络侧最小**——只申请用户填写的那一个具体域名。DOM 侧没有回避余地。可选的折中方案是改为 `activeTab` + `chrome.scripting.executeScript` 按需注入：安装提示会友好得多，代价是必须先点击扩展图标才能填充，失去「页面加载后自动识别」。已列入路线图，属于产品取舍而非安全问题。

---

## 安全说明

**凭据存储**：token 与条目缓存存放于 `chrome.storage.session`，浏览器关闭即失效，不写入磁盘。强度约等于设备锁：窃取它等于窃取该设备上的令牌，但不泄露主密码。

**填充边界**：content script 只定位输入框并写入值，绝不自动提交表单。

**剪贴板**：复制后 31 秒写入空串清除。

**上游架构的既有风险**：上游的 `ENCRYPTION_KEY` 是 Worker 的环境变量，服务端持有主密钥、能解密全部数据——它做的是「服务端加密存储」，**不是端到端加密**。扩展从 API 拿到的 `secret` 是明文。本项目不改变这一点；若需要真正的零知识架构，必须重写数据层。

另外两点需要知晓：

- 上游的公开 OTP 端点 `/otp/<secret>` 无需登录，且 secret 出现在 URL 中（会落入日志与浏览器历史）。**本扩展不使用该端点。**
- JWT 的签名密钥就是用户密码哈希，因此**修改主密码会使所有已签发的 token 立即失效**。扩展据此把续期失败判定为「会话作废」，而非网络抖动。

---

## 已知限制与路线图

### 已知限制

以下两项依赖真实浏览器行为，当前的 mock 验证无法覆盖，**发布前必须人工确认**：

1. **CORS 豁免是否生效** —— mock 服务未做 Origin 校验，该项断言在 mock 面前是空转的
2. **offscreen document 的剪贴板写入是否成功** —— 只能证明降级链被触发，无法证明写入成功。若失败，退路是让 popup 自行调用 `navigator.clipboard`（popup 有完整的 Clipboard API，且用户手势天然在那里）

### 路线图

- 真机联调：在 Chrome 中加载并对真实 Worker 完成一次登录
- 将 `<all_urls>` content script 改为 `activeTab` + 按需注入
- 页面二维码识别（扫描页面上的 2FA 二维码直接添加条目）
- 恢复码查看（上游有此功能，扩展尚未接入）
- 快捷键冲突处理
- Firefox 适配（需要 `server-patch/cors-allow-extension.js`）
- 正式图标设计（当前为占位图）

### 关于服务端补丁

默认不需要。只有两种情况才需要 `server-patch/cors-allow-extension.js`：

- Firefox（其扩展不享有与 Chrome 等价的 CORS 豁免）
- 希望 content script 在页面上下文中直连 API

补丁只做一件事：在 `isOriginAllowed()` 之后追加一段**精确匹配**的扩展 ID 白名单（读取 `ALLOWED_EXTENSION_ORIGINS` secret）。不放宽同源策略，不动 `SameSite`，不动认证逻辑。详见 `server-patch/README.md`。

---

## 许可证

MIT，与上游 [wuzf/2fa](https://github.com/wuzf/2fa) 保持一致。衍生版本可闭源。
