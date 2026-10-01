/**
 * 站点 ↔ 密钥条目匹配
 *
 * 上游按"服务家族"聚合展示，没有 domain 字段；扩展需要按当前站点 hostname
 * 把最可能用到的条目置顶。这里的策略是从 issuer / account 反推域名线索。
 */

/** 从邮箱取出域名部分 */
function domainFromAccount(account) {
  const value = String(account || '').trim();
  const at = value.lastIndexOf('@');
  if (at === -1) return '';
  return value.slice(at + 1).toLowerCase();
}

/** 归一化服务名：去公司后缀、去非字母数字 */
function normalizeIssuer(issuer) {
  return String(issuer || '')
    .toLowerCase()
    .replace(/\((inc|llc|ltd|corp|gmbh|co)\)|\b(inc|llc|ltd|corp|gmbh)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** 取 hostname 的主域名部分（去掉 www 与子域前缀中的噪声） */
function normalizeHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9.]/g, '');
}

/** 主标签：github.com → github */
function mainLabel(host) {
  const parts = normalizeHost(host).split('.').filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] ?? '';
}

/**
 * 单条目打分。0 表示不匹配。
 * 分值越高越应置顶。
 */
export function scoreEntry(entry, hostname) {
  const host = normalizeHost(hostname);
  if (!host) return 0;

  const issuer = normalizeIssuer(entry.issuer || entry.name);
  const accountDomain = domainFromAccount(entry.account);
  const label = mainLabel(host);

  let score = 0;

  // 1) 邮箱域名完全等于当前站点 → 最强信号
  if (accountDomain && accountDomain === host) score = Math.max(score, 100);
  // 2) 邮箱域名与站点主域相同（如 account=x@gmail.com 在 mail.google.com）
  else if (accountDomain && mainLabel(accountDomain) === label && label) {
    score = Math.max(score, 70);
  }

  // 3) 条目自带 domains 字段（上游若后续支持，直接命中）
  if (Array.isArray(entry.domains) && entry.domains.length) {
    for (const domain of entry.domains) {
      const normalized = normalizeHost(domain);
      if (normalized === host) score = Math.max(score, 110);
      else if (host.endsWith(`.${normalized}`) || normalized.endsWith(`.${host}`)) {
        score = Math.max(score, 80);
      }
    }
  }

  // 4) 服务名与站点主标签一致
  if (issuer && label && issuer === label) score = Math.max(score, 90);
  // 5) 服务名是站点主标签的前缀/子串（如 "github" 匹配 "githubenterprise"）
  else if (issuer && label && (label.includes(issuer) || issuer.includes(label))) {
    score = Math.max(score, 55);
  }

  return score;
}

/**
 * 按 hostname 排序匹配条目
 * @returns 匹配到的条目数组（分值降序）；hostname 为空时返回全部条目
 */
export function matchEntriesForHost(entries, hostname) {
  if (!hostname) return [...entries];

  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, hostname) }))
    .filter((item) => item.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.entry);
}

/**
 * 由 hostname 推导条目名建议（Bitwarden 式预填）。
 * 取主标签（去掉 TLD 与 www），按 -/._ 分词并首字母大写：
 *   "github.com" → "Github"；"mail.google.com" → "Google"；"my-site.com" → "My Site"。
 * 纯启发式、无公共后缀库（co.uk 这类复合 TLD 会取到 "co"），调用方可让用户改。
 */
export function suggestNameFromHost(hostname) {
  const raw = String(hostname || '').trim().toLowerCase();
  if (!raw) return '';
  const parts = raw.split('.').filter(Boolean);
  const labels = parts.length >= 2 ? parts.slice(-2, -1) : parts;
  const label = labels[0] ?? '';
  if (!label) return '';
  return label
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
