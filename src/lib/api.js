/**
 * wuzf/2fa Worker API 客户端
 *
 * ✅ 契约来源：本文件所有端点、字段名、响应形状均已从上游源码逐行核实
 *    （上游版本 v1.9.0，见 /workspace/.upstream/2fa-main）。核实结论：
 *
 *    | 契约项                | 真实值                                   | 源码位置                          |
 *    |-----------------------|------------------------------------------|-----------------------------------|
 *    | 登录                  | POST /api/login  body { credential }      | src/utils/auth.js:703             |
 *    | 登录响应              | { success, message, token, expiresAt, expiresIn } | src/utils/auth.js:749   |
 *    | 刷新令牌              | POST /api/refresh-token（支持 Bearer）     | src/utils/auth.js:800             |
 *    | 认证方式              | Cookie(auth_token) **或** Authorization: Bearer | src/utils/auth.js:427      |
 *    | 密钥列表              | GET /api/secrets → **裸数组**             | src/api/secrets/crud.js:47        |
 *    | 条目字段              | { id, name, account, secret, type, digits, period, algorithm, counter?, hotpCounterNamespace? } | crud.js:103 |
 *    | HOTP 上推             | POST /api/secrets/:id/counter             | src/api/secrets/counter.js:46     |
 *    | 上推请求体            | { expectedCounter, expectedSecret, expectedDigits, expectedAlgorithm, expectedNamespace? } | validation.js advanceHOTPCounterSchema |
 *    | 上推响应              | { success, message, data: { secret, id, counter, idempotent } } | counter.js:28 |
 *
 * 认证策略（本项目的核心结论）：
 *   上游 **已原生支持** `Authorization: Bearer`（verifyAuth 在 Cookie 缺失时直接读
 *   Authorization 头），且登录/刷新接口 **已在响应体返回 token**。因此扩展无需对
 *   服务端做任何改动 —— 之前假设的 "bearer 补丁" 已作废，见 server-patch/README.md。
 *
 *   唯一需要处理的跨域问题是 CORS：上游 isOriginAllowed() 只允许同源
 *   （src/utils/security.js:53），chrome-extension:// origin 拿不到
 *   Access-Control-Allow-Origin。解决办法不是改服务端，而是让请求都从
 *   **background service worker** 发出并持有目标 origin 的 host 权限 ——
 *   MV3 下带 host 权限的请求豁免 CORS。见 ensureHostPermission()。
 */

export const DEFAULT_ENDPOINTS = {
  login: '/api/login',
  refresh: '/api/refresh-token',
  logout: '/api/logout',
  secrets: '/api/secrets',
  /** 单条目：GET/PUT/DELETE /api/secrets/:id；HOTP 计数器：POST /api/secrets/:id/counter */
  secret: '/api/secrets',
};

/** 上游条目类型常量（crud.js / counter.js 中均以大写比较） */
export const SECRET_TYPE = {
  TOTP: 'TOTP',
  HOTP: 'HOTP',
  STEAM: 'STEAM',
};

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * 判断是否为 HOTP 条目。
 * 上游用 String(type).toUpperCase() === 'HOTP' 比较（counter.js:66），此处保持一致。
 */
export function isHotp(entry) {
  return String(entry?.type || '').toUpperCase() === 'HOTP';
}

export class ApiClient {
  constructor({ serverUrl, token = null, endpoints = {}, timeoutMs = 15000 } = {}) {
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this.timeoutMs = timeoutMs;
  }

  get isConfigured() {
    return Boolean(this.serverUrl);
  }

  get isAuthenticated() {
    return Boolean(this.token);
  }

  _url(path) {
    if (!this.serverUrl) throw new ApiError('未配置服务器地址');
    return new URL(path.replace(/^\/+/, '/'), `${this.serverUrl}/`).toString();
  }

  /**
   * 目标 origin 的 host 权限模式串，供 chrome.permissions.request() 使用。
   * 例如 https://2fa.example.workers.dev → https://2fa.example.workers.dev/*
   */
  get originPermission() {
    if (!this.serverUrl) return null;
    try {
      const url = new URL(this.serverUrl);
      return `${url.origin}/*`;
    } catch {
      return null;
    }
  }

  async _request(path, { method = 'GET', body, headers = {}, signal, allowStatus = [] } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const finalHeaders = {
        Accept: 'application/json',
        ...headers,
      };
      if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
      if (this.token) finalHeaders.Authorization = `Bearer ${this.token}`;

      const response = await fetch(this._url(path), {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        // 上游 Cookie 是 HttpOnly + SameSite=Strict，跨站本就不会带上；
        // 显式 omit 保证行为确定，也避免触发带凭据的 CORS 预检分支。
        credentials: 'omit',
        signal: controller.signal,
      });

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok && !allowStatus.includes(response.status)) {
        // 上游错误响应形如 { error, message, timestamp }（response.js:87）
        throw new ApiError(data?.message || data?.error || `请求失败 (${response.status})`, {
          status: response.status,
          code: data?.code ?? data?.error ?? null,
          body: data,
        });
      }
      return { status: response.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 登录并获取 Bearer token。
   *
   * @param {string} credential 主密码。注意上游字段名是 `credential` 不是 `password`
   *   （若传 password，服务端会抛 ValidationError「请提供密码」）。
   * @returns {Promise<{token: string, expiresAt: string|null, expiresIn: string|null, raw: object}>}
   */
  async login(credential) {
    const { data } = await this._request(this.endpoints.login, {
      method: 'POST',
      body: { credential },
    });

    // 上游返回 { success, message, token, expiresAt, expiresIn }
    const token = data?.token ?? data?.data?.token ?? null;

    if (!token) {
      throw new ApiError('服务端未在响应体中返回 token，请确认服务端版本 ≥ 1.9.0', {
        status: 200,
        code: 'NO_TOKEN_IN_RESPONSE',
        body: data,
      });
    }

    this.token = token;
    return {
      token,
      expiresAt: data?.expiresAt ?? null,
      expiresIn: data?.expiresIn ?? null,
      raw: data,
    };
  }

  /**
   * 用现有 token 换新 token。
   * 上游 JWT 默认 30 天有效（可用 JWT_EXPIRY_DAYS 配置），扩展在检测到临近过期时调用。
   */
  async refreshToken() {
    if (!this.token) throw new ApiError('未持有 token，无法刷新');
    const { data } = await this._request(this.endpoints.refresh, { method: 'POST' });
    const token = data?.token ?? null;
    if (!token) {
      throw new ApiError('刷新响应中未返回 token', { status: 200, code: 'NO_TOKEN_IN_RESPONSE', body: data });
    }
    this.token = token;
    return { token, expiresAt: data?.expiresAt ?? null, expiresIn: data?.expiresIn ?? null, raw: data };
  }

  async logout() {
    try {
      await this._request(this.endpoints.logout, { method: 'POST' });
    } finally {
      this.token = null;
    }
    return { ok: true };
  }

  /**
   * 拉取全部密钥条目。
   *
   * 上游 handleGetSecrets 直接返回 `createJsonResponse(secrets)` —— 是**裸数组**，
   * 没有 { success, data } 信封。这里仍保留信封兼容，防止用户自建/旧版服务端。
   */
  async listSecrets() {
    const { data } = await this._request(this.endpoints.secrets, { method: 'GET' });
    return normalizeSecrets(data);
  }

  /**
   * 推进 HOTP 计数器。
   *
   * ⚠️ 语义关键（counter.js:46-126）：上游不接受客户端"我用到 N 了"，而是要求客户端
   *    提交一份**快照**做乐观并发校验：
   *      expectedNamespace == 服务端 hotpCounterNamespace
   *      expectedSecret     == 服务端 secret（大写）
   *      expectedDigits     == 服务端 digits（6 或 8）
   *      expectedAlgorithm  == 服务端 algorithm（大写）
   *      expectedCounter    == 服务端当前 counter
   *    任一不符 → 409 Conflict「请刷新后重试」。这是为防止两端 counter 漂移。
   *
   * @param {Object} entry 本地条目（必须含 id/secret/digits/algorithm/counter，以及 hotpCounterNamespace）
   * @returns {Promise<{counter: number, secret: object|null, idempotent: boolean}>}
   */
  async advanceHotp(entry) {
    if (!entry?.id) throw new ApiError('条目缺少 id，无法推进 HOTP 计数器');

    const payload = {
      expectedCounter: Number(entry.counter ?? 0),
      // 服务端 transform 会 toUpperCase().trim()，这里预先对齐以便本地快照比较
      expectedSecret: String(entry.secret || '').toUpperCase().trim(),
      expectedDigits: Number(entry.digits ?? 6),
      expectedAlgorithm: String(entry.algorithm || 'SHA1').toUpperCase(),
    };
    // expectedNamespace 可选：上游默认 null。条目没有该字段时服务端也应为 null/undefined
    if (entry.hotpCounterNamespace) payload.expectedNamespace = entry.hotpCounterNamespace;

    const { data } = await this._request(
      `${this.endpoints.secret}/${encodeURIComponent(entry.id)}/counter`,
      { method: 'POST', body: payload },
    );

    // 响应：{ success, message, data: { secret, id, counter, idempotent } }
    const inner = data?.data ?? data ?? {};
    return {
      counter: inner.counter ?? null,
      secret: inner.secret ?? null,
      idempotent: inner.idempotent === true,
      raw: data,
    };
  }

  /**
   * 端点探测：依次尝试候选路径，返回第一个可用的。
   * 仅用于首次接入排障，不作运行时依赖。
   */
  async probeSecretsEndpoint(candidates = []) {
    const list = candidates.length ? candidates : ['/api/secrets', '/api/keys', '/api/list'];
    for (const path of list) {
      try {
        const { data } = await this._request(path, {
          method: 'GET',
          allowStatus: [401, 403],
        });
        if (data && (Array.isArray(data) || data.secrets || data.data)) {
          return { path, ok: true };
        }
        return { path, ok: true, needsAuth: true };
      } catch {
        /* 尝试下一个候选 */
      }
    }
    return { path: null, ok: false };
  }
}

/**
 * 把 /api/secrets 的响应统一成条目数组。
 * 上游是裸数组；兼容 { secrets } / { data } / { items } 形状。
 */
export function normalizeSecrets(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.secrets)) return payload.secrets;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.secrets)) return payload.data.secrets;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

/**
 * 条目的展示名。上游只有 `name` 字段（没有 issuer），
 * 这里保留 issuer 兜底是为了兼容未来上游改名或自建服务端。
 */
export function entryLabel(entry) {
  return entry?.name ?? entry?.issuer ?? '';
}
