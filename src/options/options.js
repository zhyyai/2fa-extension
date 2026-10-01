/**
 * 选项页逻辑
 *
 * 关键动作：host 权限申请。
 * MV3 下 service worker 要 fetch 用户自托管的 Worker，必须声明 host 权限。
 * 这里只申请用户实际输入的那个 origin —— 比在 host_permissions 里声明通配符友好得多。
 */

import { DEFAULT_ENDPOINTS } from '../lib/api.js';

const els = {
  serverUrl: document.getElementById('server-url'),
  password: document.getElementById('password'),
  token: document.getElementById('token'),
  autofill: document.getElementById('autofill'),
  clipboardClear: document.getElementById('clipboard-clear'),
  keepLoggedIn: document.getElementById('keep-logged-in'),
  lockMinutes: document.getElementById('lock-minutes'),
  epLogin: document.getElementById('ep-login'),
  epSecrets: document.getElementById('ep-secrets'),
  btnGrant: document.getElementById('btn-grant'),
  btnLogin: document.getElementById('btn-login'),
  btnSaveToken: document.getElementById('btn-save-token'),
  btnProbe: document.getElementById('btn-probe'),
  permNote: document.getElementById('perm-note'),
  probeResult: document.getElementById('probe-result'),
  msg: document.getElementById('msg'),
  loginResult: document.getElementById('login-result'),
};

/** 登录结果专用提示（常驻显示保存状态，不会像全局 msg 一样被下一次保存覆盖） */
function loginMessage(text, isError = false) {
  els.loginResult.textContent = text;
  els.loginResult.className = isError ? 'msg error' : 'msg';
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.error) return reject(new Error(response.message));
      resolve(response);
    });
  });
}

function message(text, isError = false) {
  els.msg.textContent = text;
  els.msg.className = isError ? 'msg error' : 'msg';
}

/** 由 URL 推导需要申请的 origin */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function refreshPermNote() {
  const origin = originOf(els.serverUrl.value);
  if (!origin) {
    els.permNote.textContent = '';
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  els.permNote.textContent = granted
    ? `✅ 已授权访问 ${origin}`
    : `⚠️ 尚未授权访问 ${origin}，后台请求会被拦截`;
  els.btnGrant.disabled = granted;
}

async function save() {
  await send({
    type: 'CONFIG_SET',
    patch: {
      serverUrl: els.serverUrl.value.trim(),
      endpoints: {
        ...DEFAULT_ENDPOINTS,
        login: els.epLogin.value.trim() || DEFAULT_ENDPOINTS.login,
        secrets: els.epSecrets.value.trim() || DEFAULT_ENDPOINTS.secrets,
      },
      autoFillEnabled: els.autofill.checked,
      clipboardClear: els.clipboardClear.checked,
      keepLoggedIn: els.keepLoggedIn.checked,
      lockMinutes: Number(els.lockMinutes.value) || 5,
    },
  });
  await refreshPermNote();
  message('已保存');
}

async function load() {
  const { config } = await send({ type: 'CONFIG_GET' });
  els.serverUrl.value = config.serverUrl ?? '';
  els.epLogin.value = config.endpoints?.login ?? DEFAULT_ENDPOINTS.login;
  els.epSecrets.value = config.endpoints?.secrets ?? DEFAULT_ENDPOINTS.secrets;
  els.autofill.checked = config.autoFillEnabled ?? true;
  els.clipboardClear.checked = config.clipboardClear ?? true;
  els.keepLoggedIn.checked = config.keepLoggedIn ?? true;
  els.lockMinutes.value = config.lockMinutes ?? 5;
  await refreshPermNote();
}

/* ------------------------------ 事件 ------------------------------ */

/**
 * 确保已拿到目标 origin 的主机权限。
 * 必须在**点击回调内**调用 —— chrome.permissions.request() 需要用户手势。
 */
async function ensurePermission(silent = false) {
  const origin = originOf(els.serverUrl.value);
  if (!origin) {
    if (!silent) message('请先填写合法的服务器地址', true);
    return false;
  }
  const mode = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [mode] })) return true;

  const granted = await chrome.permissions.request({ origins: [mode] });
  if (!granted && !silent) message('未授权，后台无法访问该地址', true);
  await refreshPermNote();
  return granted;
}

els.btnGrant.addEventListener('click', async () => {
  if (await ensurePermission()) message('已授权');
});

els.btnLogin.addEventListener('click', async () => {
  if (!els.password.value) return loginMessage('请输入管理密码', true);
  els.btnLogin.disabled = true;
  loginMessage('正在登录…');
  try {
    await save();
    // 登录按钮本身就是用户手势，顺手把权限一起办了，省得用户多点一次
    if (!(await ensurePermission())) return;
    // 上游登录字段名是 credential（不是 password），background 内部会转换
    const result = await send({ type: 'LOGIN', credential: els.password.value });
    const { config } = await send({ type: 'CONFIG_GET' });
    const where = config?.keepLoggedIn
      ? 'token 已保存到本机（重启浏览器免登录）'
      : 'token 已保存（仅本次浏览器会话有效）';
    loginMessage(`✅ 登录成功，已同步 ${result.count} 条条目；${where}`);
    els.password.value = '';
  } catch (error) {
    loginMessage(`登录失败：${error.message}`, true);
  } finally {
    els.btnLogin.disabled = false;
  }
});

els.btnSaveToken.addEventListener('click', async () => {
  const token = els.token.value.trim();
  if (!token) return message('token 为空', true);
  await chrome.storage.session.set({ token });
  message('token 已保存到会话存储');
});

els.btnProbe.addEventListener('click', async () => {
  els.probeResult.textContent = '探测中…';
  try {
    await save();
    if (!(await ensurePermission())) return;
    const found = await send({ type: 'PROBE' });
    if (found?.ok) {
      els.epSecrets.value = found.path;
      await save();
      els.probeResult.textContent = `✅ 命中 ${found.path}${found.needsAuth ? '（需认证）' : ''}`;
    } else {
      els.probeResult.textContent = '未命中任何候选端点，请从 PWA 的网络面板手动确认路径';
    }
  } catch (error) {
    els.probeResult.textContent = `探测失败：${error.message}`;
  }
});

for (const el of [
  els.serverUrl,
  els.autofill,
  els.clipboardClear,
  els.keepLoggedIn,
  els.lockMinutes,
  els.epLogin,
  els.epSecrets,
]) {
  el.addEventListener('change', save);
}

els.serverUrl.addEventListener('input', refreshPermNote);

load();
