/**
 * Mock Worker —— 忠实复刻上游 v1.9.0 的可观测 HTTP 服务
 *
 * 供 verify-integration.mjs 与 verify-background.mjs 共用。
 * 每一处行为都对应一份上游源码，改动前先看 server-patch/README.md 的契约表。
 */

import { createServer } from 'node:http';

export const DEFAULT_PASSWORD = 'hunter2';
export const TOKEN_1 = 'eyJhbGciOiJIUzI1NiJ9.eyJhdXRoIjp0cnVlfQ.sig-aaa';
export const TOKEN_2 = 'eyJhbGciOiJIUzI1NiJ9.eyJhdXRoIjp0cnVlfQ.sig-bbb';

export const DEFAULT_SECRETS = [
  {
    id: 'sec-totp-1',
    name: 'GitHub',
    account: 'alice@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    type: 'TOTP',
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  },
  {
    id: 'sec-hotp-1',
    name: 'Acme Bank',
    account: 'bob@acme.com',
    secret: 'JBSWY3DPEHPK3PXP',
    type: 'HOTP',
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
    counter: 7,
    hotpCounterNamespace: 'ns-abc',
  },
];

/**
 * @param {Object} options
 * @param {string} options.password
 * @param {Array} options.secrets
 * @returns {Promise<{url: string, close: () => Promise<void>, observed: object, state: object}>}
 */
export async function createMockWorker({
  password = DEFAULT_PASSWORD,
  secrets = DEFAULT_SECRETS,
} = {}) {
  const observed = {
    cookieHeaders: 0,
    bearerHeaders: 0,
    counterPayloads: [],
    createPayloads: [],
    secretsRequests: 0,
    forcedCounterConflict: false, // 置 true 时让上推必定 409，用于测异常分支
  };

  const state = { secrets: structuredClone(secrets), token: TOKEN_1 };

  function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  /** 复刻 src/utils/auth.js 的认证：Cookie 优先，其次 Bearer */
  function authenticate(req) {
    const cookie = req.headers.cookie ?? '';
    const cookieMatch = /auth_token=([^;]+)/.exec(cookie);
    if (cookieMatch) {
      observed.cookieHeaders += 1;
      return cookieMatch[1];
    }
    const authHeader = req.headers.authorization;
    if (authHeader) {
      observed.bearerHeaders += 1;
      return authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    }
    return null;
  }

  const notFound = (res, pathname) =>
    send(res, 404, { error: 'Not Found', message: pathname, timestamp: new Date().toISOString() });

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;

    const pathname = new URL(req.url, 'http://localhost').pathname;
    const unauthorized = () =>
      send(res, 401, {
        error: '未认证',
        message: '认证失败',
        timestamp: new Date().toISOString(),
      });

    // POST /api/login —— 公开，字段名必须是 credential（auth.js:703）
    if (pathname === '/api/login' && req.method === 'POST') {
      if (!body?.credential) {
        return send(res, 400, {
          error: '请提供密码',
          message: '请提供密码',
          timestamp: new Date().toISOString(),
        });
      }
      if (body.credential !== password) {
        return send(res, 401, {
          error: '密码错误',
          message: '密码错误',
          timestamp: new Date().toISOString(),
        });
      }
      state.token = TOKEN_1;
      return send(res, 200, {
        success: true,
        message: '登录成功',
        token: state.token,
        expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        expiresIn: '30天',
      });
    }

    // POST /api/refresh-token（auth.js:800）
    if (pathname === '/api/refresh-token' && req.method === 'POST') {
      if (authenticate(req) !== state.token) return unauthorized();
      state.token = TOKEN_2;
      return send(res, 200, {
        success: true,
        message: '令牌刷新成功',
        token: state.token,
        expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        expiresIn: '30天',
      });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { success: true, message: '已登出', data: null });
    }

    // GET /api/secrets —— 裸数组（crud.js:47）
    if (pathname === '/api/secrets' && req.method === 'GET') {
      if (authenticate(req) !== state.token) return unauthorized();
      observed.secretsRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state.secrets));
    }

    // POST /api/secrets —— 新增（crud.js:78）
    if (pathname === '/api/secrets' && req.method === 'POST') {
      if (authenticate(req) !== state.token) return unauthorized();
      observed.createPayloads.push(body);

      const invalid = (message) =>
        send(res, 400, { error: message, message, timestamp: new Date().toISOString() });

      // addSecretSchema 的枚举白名单
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) return invalid('服务名称不能为空');
      if (name.length > 50) return invalid(`服务名称过长，最多支持50个字符（当前：${name.length}）`);

      const cleanSecret = String(body?.secret ?? '')
        .toUpperCase()
        .trim()
        .replace(/\s/g, '');
      if (!cleanSecret) return invalid('密钥不能为空');
      if (!/^[A-Z2-7]+=*$/.test(cleanSecret)) return invalid('密钥格式无效，只能包含字母A-Z和数字2-7');
      if (cleanSecret.length < 8) return invalid(`密钥长度过短（${cleanSecret.length}字符），至少需要8字符`);

      const type = String(body?.type ?? 'TOTP').toUpperCase();
      if (!['TOTP', 'HOTP'].includes(type)) return invalid('不支持的OTP类型，仅支持TOTP或HOTP');
      if (![6, 8].includes(Number.parseInt(body?.digits ?? 6, 10))) return invalid('验证码位数仅支持6位或8位');
      if (![30, 60, 120].includes(Number.parseInt(body?.period ?? 30, 10))) {
        return invalid('TOTP周期仅支持30、60或120秒');
      }
      if (!['SHA1', 'SHA256', 'SHA512'].includes(String(body?.algorithm ?? 'SHA1').toUpperCase())) {
        return invalid('哈希算法仅支持SHA1、SHA256或SHA512');
      }
      if (type === 'HOTP') {
        const counter = Number.parseInt(body?.counter ?? 0, 10);
        if (!Number.isSafeInteger(counter) || counter < 0) return invalid('HOTP计数器必须是非负安全整数');
      }

      // 重复：name + account + secret 三者全同（validation.js checkDuplicateSecret）
      const account = typeof body?.account === 'string' ? body.account.trim() : '';
      const isDuplicate = state.secrets.some(
        (item) =>
          item.name === name &&
          String(item.account ?? '') === account &&
          String(item.secret ?? '').replace(/\s/g, '').toUpperCase() === cleanSecret,
      );
      if (isDuplicate) {
        const message = `服务"${name}"${account ? ` (账户: ${account})` : ''} 已存在`;
        return send(res, 409, { error: message, message, timestamp: new Date().toISOString() });
      }

      // 服务端生成 id（crud.js:104）
      const created = {
        id: `sec-new-${state.secrets.length + 1}`,
        name,
        account,
        secret: cleanSecret,
        type,
        digits: Number.parseInt(body?.digits ?? 6, 10),
        period: Number.parseInt(body?.period ?? 30, 10),
        algorithm: String(body?.algorithm ?? 'SHA1').toUpperCase(),
        counter: type === 'HOTP' ? Number.parseInt(body?.counter ?? 0, 10) : undefined,
      };

      // 弱密钥警告（crud.js:127-136）
      const bitLength = Math.floor((cleanSecret.length * 5) / 8) * 8;
      const warning =
        bitLength < 128 ? `密钥强度一般（${bitLength}位），推荐使用128位以上的密钥` : undefined;

      state.secrets.push(created);
      return send(res, 201, {
        success: true,
        message: warning ? `⚠️ 密钥添加成功，但${warning}` : '密钥添加成功',
        data: { secret: created, ...(warning ? { warning } : {}) },
      });
    }

    // POST /api/secrets/:id/counter —— 乐观并发快照（counter.js:82-102）
    const counterMatch = /^\/api\/secrets\/([^/]+)\/counter$/.exec(pathname);
    if (counterMatch && req.method === 'POST') {
      if (authenticate(req) !== state.token) return unauthorized();

      const id = counterMatch[1];
      const index = state.secrets.findIndex((item) => String(item.id) === String(id));
      if (index === -1) {
        return send(res, 404, {
          error: '密钥不存在',
          message: '密钥不存在',
          timestamp: new Date().toISOString(),
        });
      }
      const current = state.secrets[index];
      if (String(current.type).toUpperCase() !== 'HOTP') {
        return send(res, 409, {
          error: '只有HOTP密钥可以递增计数器',
          message: '只有HOTP密钥可以递增计数器',
          timestamp: new Date().toISOString(),
        });
      }

      observed.counterPayloads.push({ id, ...body });

      if (observed.forcedCounterConflict) {
        return send(res, 409, {
          error: 'HOTP计数器已变更，请刷新后重试',
          message: 'HOTP计数器已变更，请刷新后重试',
          timestamp: new Date().toISOString(),
        });
      }

      const matches =
        (current.hotpCounterNamespace || null) === (body?.expectedNamespace ?? null) &&
        current.secret === String(body?.expectedSecret ?? '').toUpperCase().trim() &&
        current.digits === body?.expectedDigits &&
        String(current.algorithm).toUpperCase() === String(body?.expectedAlgorithm ?? '').toUpperCase();
      if (!matches) {
        return send(res, 409, {
          error: 'HOTP生成参数已变更，请刷新后重试',
          message: 'HOTP生成参数已变更，请刷新后重试',
          timestamp: new Date().toISOString(),
        });
      }
      if (current.counter !== body?.expectedCounter) {
        return send(res, 409, {
          error: 'HOTP计数器已变更，请刷新后重试',
          message: 'HOTP计数器已变更，请刷新后重试',
          timestamp: new Date().toISOString(),
        });
      }

      const next = current.counter + 1;
      state.secrets[index] = { ...current, counter: next };
      return send(res, 200, {
        success: true,
        message: 'HOTP计数器递增成功',
        data: { secret: state.secrets[index], id, counter: next, idempotent: false },
      });
    }

    // 上游对 /api/secrets/:id 只实现 PUT/DELETE，其余 405（router/handler.js:321-334）
    if (pathname.startsWith('/api/secrets/')) {
      return send(res, 405, {
        error: '方法不允许',
        message: `不支持的HTTP方法: ${req.method}`,
        timestamp: new Date().toISOString(),
      });
    }

    return notFound(res, pathname);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    state,
    observed,
    close: () =>
      new Promise((resolve) => {
        // keep-alive 空闲连接不主动断开会让 close() 悬挂；Node 18.2+ 提供该方法
        server.closeIdleConnections?.();
        server.close(resolve);
        // 兜底：即使 close 因未知句柄未完成，也不阻止进程自然退出
        //（Windows + Node 24 下 process.exit 强退会触发 libuv 断言崩溃）
        server.unref();
      }),
  };
}
