/**
 * 添加条目页
 *
 * 设计要点：
 *   1. 只做 UI 与本地校验，**提交一律走 background**。理由是保持既有架构承诺 ——
 *      token 与密钥不离开 service worker，401 续期与权限检查也都在那边复用。
 *   2. URI 解析不是独立的提交路径，而是"填表"。解析完把值写进表单让用户确认再提交，
 *      避免"粘了个 URI 就莫名其妙存了一条"。
 *   3. 所有枚举都从 secret-input.js 取，不在这里硬编码，防止与上游白名单漂移。
 */

import {
  validateNewSecret,
  fromOtpauthUri,
  randomSecretBase32,
  normalizeSecretValue,
  ALLOWED_DIGITS,
  ALLOWED_PERIODS,
  ALLOWED_ALGORITHMS,
} from './lib/secret-input.js';
import { suggestNameFromHost } from './lib/match.js';

const els = {
  uri: document.getElementById('uri-input'),
  parseNote: document.getElementById('parse-note'),
  scanNote: document.getElementById('scan-note'),
  btnParse: document.getElementById('btn-parse'),
  btnScan: document.getElementById('btn-scan'),
  btnSubmit: document.getElementById('btn-submit'),
  btnGenerate: document.getElementById('btn-generate'),
  name: document.getElementById('f-name'),
  account: document.getElementById('f-account'),
  secret: document.getElementById('f-secret'),
  type: document.getElementById('f-type'),
  digits: document.getElementById('f-digits'),
  period: document.getElementById('f-period'),
  algorithm: document.getElementById('f-algorithm'),
  counter: document.getElementById('f-counter'),
  wrapCounter: document.getElementById('wrap-counter'),
  msg: document.getElementById('msg'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
  bannerAction: document.getElementById('banner-action'),
  siteNote: document.getElementById('site-note'),
};

const errEls = {
  name: document.getElementById('e-name'),
  account: document.getElementById('e-account'),
  secret: document.getElementById('e-secret'),
  form: document.getElementById('e-form'),
};
const warnSecret = document.getElementById('w-secret');

/** 本次会话解析到的当前站点 host（用于添加成功后的自动绑定） */
let siteHost = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        const error = new Error(response.message || '请求失败');
        error.code = response.code ?? null;
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function message(text, isError = false) {
  els.msg.textContent = text;
  els.msg.className = isError ? 'msg error' : 'msg ok';
}

/**
 * 环境自检提示条。
 *
 * 这个页面是独立标签页，可能被长时间停留或刷新 —— 令牌过期、服务器未配置、
 * 权限没授，这三种情况提交必然失败。与其让用户填完表单才吃到一记 401，
 * 不如进页面就说明，并给一个能点的出口。
 */
function showBanner(text, actionLabel) {
  els.bannerText.textContent = text;
  if (actionLabel) {
    els.bannerAction.textContent = actionLabel;
    els.bannerAction.hidden = false;
  } else {
    els.bannerAction.hidden = true;
  }
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
}

/** 把 background 抛来的错误码翻译成人话 + 一个动作 */
const ERROR_HINTS = {
  NOT_CONFIGURED: '尚未配置服务器地址，无法写入。',
  HOST_PERMISSION_REQUIRED: '尚未授权访问该服务器地址，请求会被浏览器拦截。',
  SESSION_EXPIRED: '登录已失效，请重新登录。',
  NETWORK_ERROR: '无法连接到服务器，请检查地址与网络。',
  TIMEOUT: '请求超时，请检查服务器地址与网络。',
};

function hintFor(error) {
  return ERROR_HINTS[error?.code] ?? null;
}

function clearErrors() {
  for (const el of Object.values(errEls)) {
    el.hidden = true;
    el.textContent = '';
  }
  warnSecret.hidden = true;
}

function showErrors(errors) {
  clearErrors();
  for (const [field, text] of Object.entries(errors)) {
    const target = errEls[field];
    if (target) {
      target.textContent = text;
      target.hidden = false;
    } else {
      // 没有专属位置的字段错误统一显示
      errEls.form.textContent = text;
      errEls.form.hidden = false;
    }
  }
}

/* ------------------------------ 表单读写 ------------------------------ */

function readForm() {
  return {
    name: els.name.value,
    account: els.account.value,
    secret: els.secret.value,
    type: els.type.value,
    digits: els.digits.value,
    period: els.period.value,
    algorithm: els.algorithm.value,
    counter: els.counter.value,
  };
}

function writeForm(value) {
  if (value.name !== undefined) els.name.value = value.name;
  if (value.account !== undefined) els.account.value = value.account;
  if (value.secret !== undefined) els.secret.value = value.secret;
  if (value.type !== undefined) els.type.value = value.type;
  if (value.digits !== undefined) els.digits.value = String(value.digits);
  if (value.period !== undefined) els.period.value = String(value.period);
  if (value.algorithm !== undefined) els.algorithm.value = value.algorithm;
  if (value.counter !== undefined) els.counter.value = String(value.counter);
  syncTypeUi();
}

/** HOTP 才显示计数器；TOTP 的周期才生效 */
function syncTypeUi() {
  const isHotp = els.type.value === 'HOTP';
  els.wrapCounter.hidden = !isHotp;
  els.period.disabled = isHotp;
}

// 把白名单写死进 UI，避免 HTML 里的 option 与校验规则不一致
function hydrateSelects() {
  els.digits.innerHTML = ALLOWED_DIGITS.map((v) => `<option value="${v}">${v}</option>`).join('');
  els.period.innerHTML = ALLOWED_PERIODS.map((v) => `<option value="${v}">${v}</option>`).join('');
  els.algorithm.innerHTML = ALLOWED_ALGORITHMS.map((v) => `<option value="${v}">${v}</option>`).join('');
  els.digits.value = '6';
  els.period.value = '30';
  els.algorithm.value = 'SHA1';
}

/* ------------------------------ 操作 ------------------------------ */

async function applyUri(uri) {
  const result = fromOtpauthUri(uri);
  if (!result.ok) {
    els.parseNote.className = 'note error';
    els.parseNote.textContent = `解析失败：${result.error}`;
    return;
  }
  writeForm(result.value);
  const notes = ['已填入表单，确认后提交。'];
  if (!result.value.name) notes.push('URI 中未包含服务名，请手动填写。');
  notes.push(...result.warnings);
  els.parseNote.className = 'note ok';
  els.parseNote.textContent = notes.join(' ');
  validateLive();
}

async function scanFromPage() {
  els.scanNote.textContent = '正在识别…';
  try {
    const { uri } = await send({ type: 'SCAN_QR' });
    if (!uri) {
      els.scanNote.className = 'note muted';
      els.scanNote.textContent = '未在当前页面识别到 2FA 二维码。请确认二维码可见，或直接粘贴 URI。';
      return;
    }
    els.uri.value = uri;
    await applyUri(uri);
    els.scanNote.textContent = '';
  } catch (error) {
    els.scanNote.className = 'note error';
    els.scanNote.textContent = `识别失败：${error.message}`;
  }
}

/** 实时校验：只在有内容时提示，避免一进页面就红一片 */
function validateLive() {
  const result = validateNewSecret(readForm());
  // 只显示"用户已经填过的字段"的错误，未触碰的字段留到提交时再报
  const touched = {
    name: els.name.value.trim() !== '',
    secret: els.secret.value.trim() !== '',
  };
  const visible = {};
  for (const [field, text] of Object.entries(result.errors)) {
    if (field === 'name' || field === 'secret') {
      if (touched[field]) visible[field] = text;
    } else {
      visible[field] = text;
    }
  }
  showErrors(visible);

  if (result.warnings.length) {
    warnSecret.textContent = result.warnings.join('；');
    warnSecret.hidden = false;
  } else {
    warnSecret.hidden = true;
  }
  return result;
}

async function submit() {
  clearErrors();
  const result = validateNewSecret(readForm());
  if (!result.ok) {
    showErrors(result.errors);
    if (result.warnings.length) {
      warnSecret.textContent = result.warnings.join('；');
      warnSecret.hidden = false;
    }
    message('请修正表单中的问题', true);
    return;
  }

  if (result.warnings.length) {
    warnSecret.textContent = result.warnings.join('；');
    warnSecret.hidden = false;
  }

  els.btnSubmit.disabled = true;
  message('正在写入…');
  try {
    // 先做一次重复预检 —— 服务端会 409，但本地提示更友好
    const check = await send({ type: 'CHECK_DUPLICATE', candidate: result.payload });
    if (check?.duplicate) {
      message(`已存在完全相同的条目「${check.duplicate.name}」，未重复添加`, true);
      return;
    }

    const created = await send({ type: 'ADD_SECRET', payload: result.payload });
    const name = created?.secret?.name ?? result.payload.name;
    let text = `已添加「${name}」，当前共 ${created?.count ?? '?'} 条，可在扩展弹窗中查看。`;
    if (created?.warning) text += ` 服务端提醒：${created.warning}`;

    // 自动绑定条目↔当前站点：无论条目将来改成什么名字，站点匹配都以绑定为准
    if (siteHost && created?.secret?.id) {
      try {
        await send({ type: 'BIND_ENTRY_HOST', id: created.secret.id, host: siteHost });
        text += ' 已绑定到当前站点。';
      } catch {
        text += ' （站点绑定失败，可在弹窗中手动绑定）';
      }
    }
    message(text);

    // 清空表单，方便连续添加
    els.uri.value = '';
    els.parseNote.textContent = '';
    writeForm({ name: '', account: '', secret: '', counter: 0 });
    clearErrors();
  } catch (error) {
    message(error.message, true);
    const hint = hintFor(error);
    if (hint) showBanner(hint, '打开设置');
  } finally {
    els.btnSubmit.disabled = false;
  }
}

/* ------------------------------ 能力探测 ------------------------------ */

(async function detectScanSupport() {
  if (typeof BarcodeDetector === 'undefined') {
    els.scanNote.textContent = '当前平台不支持内置二维码识别，请使用「粘贴 URI」或手动输入。';
    return;
  }
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    if (formats.includes('qr_code')) {
      els.btnScan.hidden = false;
    } else {
      els.scanNote.textContent = '当前平台不支持内置二维码识别，请使用「粘贴 URI」或手动输入。';
    }
  } catch {
    els.scanNote.textContent = '当前平台不支持内置二维码识别，请使用「粘贴 URI」或手动输入。';
  }
})();

/* ------------------------------ 环境自检 ------------------------------ */

els.bannerAction.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

(async function boot() {
  try {
    const state = await send({ type: 'STATE' });
    if (!state?.configured) {
      showBanner('尚未配置服务器地址，请先配置再添加。', '打开设置');
    } else if (!state?.authenticated) {
      showBanner('尚未登录，写入会被服务端拒绝。', '打开设置');
    } else if (!state?.permissionGranted) {
      showBanner(`尚未授权访问 ${state.origin ?? '该服务器'}，请求会被浏览器拦截。`, '打开设置');
    }
  } catch {
    // 自检本身失败不阻塞填表 —— 提交时还会有明确报错
  }
})();

/* ------------------------------ 站点预填 ------------------------------ */

/**
 * 自动识别当前站点并预填服务名（Bitwarden 式）。
 * hostname 来源优先级：popup 打开本页时经 query 传入 > background 的 HOST_REPORT 记录。
 * 只在服务名为空时预填 —— 不覆盖 URI 解析结果或用户已输入的内容。
 */
(async function resolveSiteHint() {
  const params = new URLSearchParams(location.search);
  let host = params.get('host');
  if (!host) {
    try {
      host = (await send({ type: 'GET_SITE_HINT' }))?.host ?? null;
    } catch {
      /* 无提示也不阻塞填表 */
    }
  }
  if (!host) return;
  siteHost = String(host).toLowerCase();

  const suggestion = suggestNameFromHost(host);
  if (suggestion && !els.name.value.trim()) {
    els.name.value = suggestion;
    validateLive();
  }
  els.siteNote.textContent = `已识别当前站点：${host}` +
    (els.name.value.trim() ? '，服务名已预填（可修改）' : '');
  els.siteNote.hidden = false;
})();

/* ------------------------------ 事件 ------------------------------ */

hydrateSelects();
syncTypeUi();

els.type.addEventListener('change', syncTypeUi);
els.btnParse.addEventListener('click', () => applyUri(els.uri.value.trim()));
els.btnScan.addEventListener('click', scanFromPage);
els.btnSubmit.addEventListener('click', submit);
els.btnGenerate.addEventListener('click', () => {
  els.secret.value = randomSecretBase32(20);
  validateLive();
});

for (const el of [els.name, els.secret, els.account, els.counter]) {
  el.addEventListener('input', validateLive);
}
for (const el of [els.type, els.digits, els.period, els.algorithm]) {
  el.addEventListener('change', validateLive);
}

// 密钥框粘贴时顺手规范化（用户常从邮件/文档里复制带空格的密钥）
els.secret.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text') ?? '';
  if (!text) return;
  event.preventDefault();
  const normalized = normalizeSecretValue(text);
  const target = event.target;
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const next = target.value.slice(0, start) + normalized + target.value.slice(end);
  target.value = next;
  target.setSelectionRange(start + normalized.length, start + normalized.length);
  validateLive();
});

els.name.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submit();
});
els.secret.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submit();
});
