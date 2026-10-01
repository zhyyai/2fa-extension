/**
 * Popup 逻辑
 *
 * 注意：popup 只显示"摘要 + 码"，不持有 secret。
 * 所有 OTP 计算都在 background service worker 中完成。
 */

const els = {
  host: document.getElementById('host'),
  status: document.getElementById('status'),
  list: document.getElementById('list'),
  search: document.getElementById('input-search'),
  viewSetup: document.getElementById('view-setup'),
  viewLogin: document.getElementById('view-login'),
  viewList: document.getElementById('view-list'),
  inputPassword: document.getElementById('input-password'),
  btnLogin: document.getElementById('btn-login'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnAdd: document.getElementById('btn-add'),
  btnSettings: document.getElementById('btn-settings'),
  btnOpenOptions: document.getElementById('btn-open-options'),
  loginError: document.getElementById('login-error'),
};

const state = {
  hostname: '',
  codes: [],
  filter: '',
  timer: null,
};

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        const error = new Error(response.message || '请求失败');
        // 保留机器可读的错误码，UI 才能针对特定失败给出针对性引导
        error.code = response.code ?? null;
        error.origin = response.origin ?? null;
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function show(view) {
  for (const key of ['viewSetup', 'viewLogin', 'viewList']) {
    els[key].hidden = els[key] !== view;
  }
}

function setStatus(text) {
  els.status.textContent = text || '';
}

/* ------------------------------ 初始化 ------------------------------ */

async function resolveHostname() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const url = new URL(tab.url);
      return url.hostname;
    }
  } catch {
    /* 无 activeTab 授权时忽略 */
  }
  return '';
}

async function bootstrap() {
  const config = await send({ type: 'CONFIG_GET' });
  if (!config?.config?.serverUrl) {
    show(els.viewSetup);
    return;
  }

  const status = await send({ type: 'STATE' });

  // chrome.tabs.query 在没有 tabs 权限时拿不到 URL；此时回落到 content script
  // 上报给 background 的 hostname。两条路都没有才降级为"全部条目"。
  state.hostname = (await resolveHostname()) || status?.host || '';
  els.host.textContent = state.hostname || '未识别站点';

  if (!status?.authenticated) {
    show(els.viewLogin);
    els.inputPassword.focus();
    return;
  }

  show(els.viewList);
  await loadCodes();
}

/* ------------------------------ 数据 ------------------------------ */

async function loadCodes() {
  try {
    const result = await send({ type: 'MATCH', hostname: state.hostname });
    state.codes = result?.codes ?? [];
    render();
    setStatus(state.codes.length ? '' : '当前站点无匹配条目');
  } catch (error) {
    setStatus(error.message);
    show(els.viewList);
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function render() {
  const filter = state.filter.trim().toLowerCase();
  const visible = state.codes.filter((item) => {
    if (!filter) return true;
    return (
      item.issuer.toLowerCase().includes(filter) ||
      item.account.toLowerCase().includes(filter)
    );
  });

  els.list.innerHTML = '';

  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = state.codes.length ? '无匹配结果' : '没有可用条目';
    els.list.appendChild(empty);
    return;
  }

  for (const item of visible) {
    els.list.appendChild(renderItem(item));
  }

  startCountdown();
}

function renderItem(item) {
  const card = document.createElement('div');
  card.className = 'card';

  const top = document.createElement('div');
  top.className = 'card-top';

  const issuer = document.createElement('span');
  issuer.className = 'issuer';
  issuer.textContent = item.issuer || '(未命名)';

  const account = document.createElement('span');
  account.className = 'account';
  account.textContent = item.account || '';

  top.append(issuer, account);

  const bottom = document.createElement('div');
  bottom.className = 'card-bottom';

  if (item.error) {
    const err = document.createElement('span');
    err.className = 'code error-text';
    err.textContent = '解析失败';
    err.title = item.error;
    bottom.appendChild(err);
  } else {
    const code = document.createElement('button');
    code.className = 'code';
    code.type = 'button';
    code.textContent = item.code;
    code.title = '点击复制';
    code.addEventListener('click', () => copy(item.id));
    bottom.appendChild(code);

    if (item.remaining !== null && item.remaining !== undefined) {
      const ring = document.createElement('span');
      ring.className = 'remaining';
      ring.dataset.remaining = String(item.remaining);
      ring.textContent = `${item.remaining}s`;
      bottom.appendChild(ring);
    }

    const fill = document.createElement('button');
    fill.className = 'icon-btn';
    fill.type = 'button';
    fill.title = '自动填充到当前页面';
    fill.textContent = '⤓';
    fill.addEventListener('click', () => fillToPage(item.id));
    bottom.appendChild(fill);

    // 条目↔当前站点 绑定切换：绑定后无论条目叫什么名字，站点匹配都以绑定为准
    if (state.hostname) {
      const bind = document.createElement('button');
      bind.className = 'icon-btn' + (item.bound ? ' on' : '');
      bind.type = 'button';
      bind.title = item.bound
        ? `已绑定 ${state.hostname}，点击解绑`
        : `绑定到 ${state.hostname}（改名不影响匹配）`;
      bind.textContent = '⛓';
      bind.addEventListener('click', () => toggleBind(item.id, item.bound));
      bottom.appendChild(bind);
    }
  }

  card.append(top, bottom);
  return card;
}

/** 本地倒计时：只更新显示，不重新生成码（码在后台按时间窗计算） */
function startCountdown() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    let needsRefresh = false;
    for (const ring of els.list.querySelectorAll('.remaining')) {
      const value = Number(ring.dataset.remaining) - 1;
      if (value <= 0) {
        needsRefresh = true;
        break;
      }
      ring.dataset.remaining = String(value);
      ring.textContent = `${value}s`;
    }
    if (needsRefresh) {
      clearInterval(state.timer);
      state.timer = null;
      loadCodes();
    }
  }, 1000);
}

/* ------------------------------ 操作 ------------------------------ */

async function copy(id) {
  try {
    await send({ type: 'COPY', id });
    setStatus('已复制，30 秒后自动清除');
  } catch (error) {
    setStatus(error.message);
  }
}

async function fillToPage(id) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('无法定位当前标签页');
      return;
    }
    const generated = await send({ type: 'FILL', id });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'DO_FILL',
      code: generated.code,
    });
    setStatus(response?.ok ? '已填充' : `填充失败：${response?.reason ?? '未知'}`);
  } catch (error) {
    setStatus(error.message || '填充失败');
  }
}

/** 绑定/解绑条目↔当前站点，然后刷新列表反映新匹配 */
async function toggleBind(id, currentlyBound) {
  try {
    await send({
      type: 'BIND_ENTRY_HOST',
      id,
      host: state.hostname,
      unbind: currentlyBound === true,
    });
    setStatus(currentlyBound ? '已解绑当前站点' : '已绑定当前站点，改名不影响匹配');
    await loadCodes();
  } catch (error) {
    setStatus(error.message || '绑定失败');
  }
}

async function login() {
  const password = els.inputPassword.value;
  if (!password) {
    els.loginError.textContent = '请输入密码';
    els.loginError.hidden = false;
    return;
  }
  els.btnLogin.disabled = true;
  els.btnLogin.textContent = '登录中…';
  try {
    await send({ type: 'LOGIN', credential: password });
    els.loginError.hidden = true;
    els.inputPassword.value = '';
    // 明确告知 token 保存结果（背景页写入 storage 后才算成功）
    setStatus('登录成功，token 已保存');
    show(els.viewList);
    await loadCodes();
  } catch (error) {
    const needsPermission = error.code === 'HOST_PERMISSION_REQUIRED';
    els.loginError.textContent = needsPermission
      ? `${error.message} 请到设置页点「授权访问该地址」。`
      : error.message;
    els.loginError.hidden = false;
    setStatus('');
  } finally {
    els.btnLogin.disabled = false;
    els.btnLogin.textContent = '登录';
  }
}

/* ------------------------------ 事件 ------------------------------ */

els.btnLogin.addEventListener('click', login);
els.inputPassword.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') login();
});

// 添加页按 Bitwarden 的方式以**独立小窗**弹出（430×680，popup 型窗口）：
// 不抢占浏览器标签页，随点随用随关；全屏表单塞在小窗里比塞在 340px 弹层里从容。
// 弹窗解析出的当前站点 hostname 一并带过去，添加页据此预填服务名
els.btnAdd.addEventListener('click', async () => {
  const { config } = await send({ type: 'CONFIG_GET' });
  if (!config?.serverUrl) {
    setStatus('请先配置服务器地址');
    chrome.runtime.openOptionsPage();
    return;
  }
  const q = state.hostname ? `?host=${encodeURIComponent(state.hostname)}` : '';
  await chrome.windows.create({
    url: chrome.runtime.getURL('add.html') + q,
    type: 'popup',
    width: 430,
    height: 680,
  });
  window.close();
});

els.btnRefresh.addEventListener('click', async () => {
  setStatus('刷新中…');
  try {
    await send({ type: 'REFRESH' });
    await loadCodes();
    setStatus('已刷新');
  } catch (error) {
    setStatus(error.message);
  }
});

els.btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.btnOpenOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

els.search.addEventListener('input', () => {
  state.filter = els.search.value;
  render();
});

bootstrap();
