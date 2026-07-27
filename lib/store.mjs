import { promises as fs } from "node:fs";
import path from "node:path";
import { text as streamToText } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { BlobNotFoundError, get as getBlob, put as putBlob } from "@vercel/blob";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USE_BLOB_STORAGE = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.VERCEL
    ? "/tmp/dmca-data"
  : path.join(ROOT_DIR, "data");

const FILES = {
  config: path.join(DATA_DIR, "config.json"),
  portfolio: path.join(DATA_DIR, "portfolio.json"),
  history: path.join(DATA_DIR, "history.json"),
  urlAudits: path.join(DATA_DIR, "url-audits.json"),
  serpAudits: path.join(DATA_DIR, "serp-audits.json"),
  lumenClaims: path.join(DATA_DIR, "lumen-claims.json"),
  cases: path.join(DATA_DIR, "cases.json"),
  secrets: path.join(DATA_DIR, "secrets.json")
};

const DEFAULT_CONFIG = {
  mode: "google",
  scheduleEnabled: true,
  dailyAt: "09:00",
  perPage: 10,
  browserDelayMs: 3000,
  browserTimeoutMs: 20000,
  urlSearchDelayMs: 5000,
  urlSearchTimeoutMs: 300000,
  urlSearchMaxUrlsPerDomain: 0,
  apifyCountry: "us",
  apifyLanguage: "en",
  apifyBatchSize: 50,
  apifyProxyGroup: "RESIDENTIAL",
  emailAlertsEnabled: false,
  notificationEmail: "",
  lastRunAt: null,
  lastScheduledDate: null,
  updatedAt: null
};

const DEFAULT_PORTFOLIO = {
  domains: []
};

const DEFAULT_HISTORY = {
  runs: []
};

const DEFAULT_URL_AUDITS = {
  runs: []
};

const DEFAULT_SERP_AUDITS = {
  runs: []
};

const DEFAULT_LUMEN_CLAIMS = {
  notices: {},
  runs: []
};

const DEFAULT_CASES = {
  domains: {}
};

const DEFAULT_SECRETS = {};
const CASE_STATUSES = new Set([
  "unreviewed",
  "monitoring",
  "claim_filed",
  "in_progress",
  "resolved",
  "ignored"
]);
const LUMEN_CLAIM_REVIEW_STATUSES = new Set([
  "to_review",
  "claim_submitted",
  "resolved"
]);
const LEGACY_LUMEN_CLAIM_REVIEW_STATUS_MAP = {
  access_requested: "claim_submitted",
  full_link_received: "claim_submitted",
  urls_extracted: "claim_submitted",
  ignored: "to_review"
};
let dataFilesPromise = null;

function normalizeLumenClaimReviewStatus(value) {
  const status = String(value || "to_review").trim();
  const normalized = LEGACY_LUMEN_CLAIM_REVIEW_STATUS_MAP[status] || status;
  return LUMEN_CLAIM_REVIEW_STATUSES.has(normalized) ? normalized : "to_review";
}

export function normalizeDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";

  const withoutWildcard = raw.replace(/^\*\./, "");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutWildcard)
    ? withoutWildcard
    : `https://${withoutWildcard}`;

  try {
    const parsed = new URL(withScheme);
    return parsed.hostname.replace(/\.$/, "");
  } catch {
    return withoutWildcard
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/\.$/, "");
  }
}

export async function ensureDataFiles() {
  if (!dataFilesPromise) {
    dataFilesPromise = (async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await ensureFile(FILES.config, DEFAULT_CONFIG);
      await ensureFile(FILES.portfolio, DEFAULT_PORTFOLIO);
      await ensureFile(FILES.history, DEFAULT_HISTORY);
      await ensureFile(FILES.urlAudits, DEFAULT_URL_AUDITS);
      await ensureFile(FILES.serpAudits, DEFAULT_SERP_AUDITS);
      await ensureFile(FILES.lumenClaims, DEFAULT_LUMEN_CLAIMS);
      await ensureFile(FILES.cases, DEFAULT_CASES);
    })();
  }

  await dataFilesPromise;
}

export async function loadConfig() {
  await ensureDataFiles();
  const config = await readJson(FILES.config, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...config };
}

export async function saveConfigPatch(patch) {
  const current = await loadConfig();
  const next = { ...current };

  if (Object.hasOwn(patch, "mode")) {
    if (!["google", "browser", "demo", "live"].includes(patch.mode)) {
      throw new Error("Mode must be google, browser, demo, or live.");
    }
    next.mode = patch.mode;
  }

  if (Object.hasOwn(patch, "scheduleEnabled")) {
    next.scheduleEnabled = Boolean(patch.scheduleEnabled);
  }

  if (Object.hasOwn(patch, "dailyAt")) {
    if (!/^\d{2}:\d{2}$/.test(String(patch.dailyAt))) {
      throw new Error("Daily time must be HH:MM.");
    }
    const [hour, minute] = patch.dailyAt.split(":").map(Number);
    if (hour > 23 || minute > 59) {
      throw new Error("Daily time must be HH:MM.");
    }
    next.dailyAt = patch.dailyAt;
  }

  if (Object.hasOwn(patch, "perPage")) {
    const perPage = Number(patch.perPage);
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 50) {
      throw new Error("Results per domain must be between 1 and 50.");
    }
    next.perPage = perPage;
  }

  if (Object.hasOwn(patch, "browserDelayMs")) {
    const delay = Number(patch.browserDelayMs);
    if (!Number.isInteger(delay) || delay < 1000 || delay > 30000) {
      throw new Error("Browser delay must be between 1000 and 30000 ms.");
    }
    next.browserDelayMs = delay;
  }

  if (Object.hasOwn(patch, "browserTimeoutMs")) {
    const timeout = Number(patch.browserTimeoutMs);
    if (!Number.isInteger(timeout) || timeout < 10000 || timeout > 120000) {
      throw new Error("Browser timeout must be between 10000 and 120000 ms.");
    }
    next.browserTimeoutMs = timeout;
  }

  if (Object.hasOwn(patch, "urlSearchDelayMs")) {
    const delay = Number(patch.urlSearchDelayMs);
    if (!Number.isInteger(delay) || delay < 1000 || delay > 60000) {
      throw new Error("URL search delay must be between 1000 and 60000 ms.");
    }
    next.urlSearchDelayMs = delay;
  }

  if (Object.hasOwn(patch, "urlSearchTimeoutMs")) {
    const timeout = Number(patch.urlSearchTimeoutMs);
    if (!Number.isInteger(timeout) || timeout < 10000 || timeout > 600000) {
      throw new Error("URL search timeout must be between 10000 and 600000 ms.");
    }
    next.urlSearchTimeoutMs = timeout;
  }

  if (Object.hasOwn(patch, "urlSearchMaxUrlsPerDomain")) {
    const limit = Number(patch.urlSearchMaxUrlsPerDomain);
    if (!Number.isInteger(limit) || limit < 0 || limit > 100000) {
      throw new Error("URL search limit must be 0 or between 1 and 100000.");
    }
    next.urlSearchMaxUrlsPerDomain = limit;
  }

  if (Object.hasOwn(patch, "apifyCountry")) {
    const country = String(patch.apifyCountry || "").trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(country)) {
      throw new Error("Apify country must be a two-letter country code.");
    }
    next.apifyCountry = country;
  }

  if (Object.hasOwn(patch, "apifyLanguage")) {
    const language = String(patch.apifyLanguage || "").trim().toLowerCase();
    if (!/^[a-z]{2}(?:-[a-z]{2,})?$/.test(language)) {
      throw new Error("Apify language must be a language code like en or pt-br.");
    }
    next.apifyLanguage = language;
  }

  if (Object.hasOwn(patch, "apifyBatchSize")) {
    const batchSize = Number(patch.apifyBatchSize);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new Error("Apify batch size must be between 1 and 500.");
    }
    next.apifyBatchSize = batchSize;
  }

  if (Object.hasOwn(patch, "apifyProxyGroup")) {
    const proxyGroup = String(patch.apifyProxyGroup || "").trim().toUpperCase();
    if (!["RESIDENTIAL", "DATACENTER"].includes(proxyGroup)) {
      throw new Error("Apify proxy group must be RESIDENTIAL or DATACENTER.");
    }
    next.apifyProxyGroup = proxyGroup;
  }

  if (Object.hasOwn(patch, "emailAlertsEnabled")) {
    next.emailAlertsEnabled = Boolean(patch.emailAlertsEnabled);
  }

  if (Object.hasOwn(patch, "notificationEmail")) {
    const email = String(patch.notificationEmail || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Notification email must be a valid email address.");
    }
    next.notificationEmail = email;
  }

  if (Object.hasOwn(patch, "lastRunAt")) {
    next.lastRunAt = patch.lastRunAt;
  }

  if (Object.hasOwn(patch, "lastScheduledDate")) {
    next.lastScheduledDate = patch.lastScheduledDate;
  }

  next.updatedAt = new Date().toISOString();
  await writeJson(FILES.config, next);
  return next;
}

export async function loadPortfolio() {
  await ensureDataFiles();
  const portfolio = await readJson(FILES.portfolio, DEFAULT_PORTFOLIO);
  const domains = Array.from(
    new Set((portfolio.domains || []).map(normalizeDomain).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));
  return { domains };
}

export async function addDomain(value) {
  const next = await addDomains([value]);
  return next;
}

export async function addDomains(values) {
  const incoming = values.map(normalizeDomain).filter(Boolean);
  if (incoming.length === 0) {
    throw new Error("Domain is required.");
  }

  const portfolio = await loadPortfolio();
  const domains = Array.from(new Set([...portfolio.domains, ...incoming])).sort((a, b) =>
    a.localeCompare(b)
  );
  const next = { domains };
  await writeJson(FILES.portfolio, next);
  return next;
}

export async function replaceDomains(values) {
  const domains = Array.from(new Set(values.map(normalizeDomain).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  if (domains.length === 0) {
    throw new Error("At least one domain is required.");
  }

  const next = { domains };
  await writeJson(FILES.portfolio, next);
  return next;
}

export async function removeDomain(value) {
  const domain = normalizeDomain(value);
  const portfolio = await loadPortfolio();
  const next = {
    domains: portfolio.domains.filter((item) => item !== domain)
  };
  await writeJson(FILES.portfolio, next);
  return next;
}

export async function loadHistory() {
  await ensureDataFiles();
  const history = await readJson(FILES.history, DEFAULT_HISTORY);
  return {
    runs: Array.isArray(history.runs) ? history.runs : []
  };
}

export async function loadCases() {
  await ensureDataFiles();
  const cases = await readJson(FILES.cases, DEFAULT_CASES);
  const domains = {};

  for (const [domainValue, caseValue] of Object.entries(cases.domains || {})) {
    const domain = normalizeDomain(domainValue);
    if (!domain) continue;
    domains[domain] = normalizeCase(domain, caseValue);
  }

  return { domains };
}

export async function saveDomainCase(domainValue, patch = {}) {
  const domain = normalizeDomain(domainValue);
  if (!domain) throw new Error("Domain is required.");

  const cases = await loadCases();
  const existing = cases.domains[domain] || normalizeCase(domain);
  const nextStatus = Object.hasOwn(patch, "status") ? String(patch.status) : existing.status;

  if (!CASE_STATUSES.has(nextStatus)) {
    throw new Error("Case status is not valid.");
  }

  const now = new Date().toISOString();
  const next = {
    ...existing,
    domain,
    status: nextStatus,
    note: Object.hasOwn(patch, "note")
      ? String(patch.note || "").trim().slice(0, 2000)
      : existing.note,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };

  if (nextStatus === "claim_filed" && !next.filedAt) {
    next.filedAt = now;
  }

  if (nextStatus === "resolved" && !next.resolvedAt) {
    next.resolvedAt = now;
  }

  if (nextStatus !== "resolved") {
    delete next.resolvedAt;
  }

  if (next.status === "unreviewed" && !next.note) {
    delete cases.domains[domain];
  } else {
    cases.domains[domain] = next;
  }
  await writeJson(FILES.cases, cases);
  return next;
}

export async function appendRun(run) {
  const history = await loadHistory();
  const next = {
    runs: [run, ...history.runs].slice(0, 80)
  };
  await writeJson(FILES.history, next);

  const patch = { lastRunAt: run.startedAt };
  if (run.source === "scheduled") {
    patch.lastScheduledDate = localDateKey(new Date(run.startedAt));
  }
  await saveConfigPatch(patch);

  return run;
}

export async function loadUrlAudits() {
  await ensureDataFiles();
  const audits = await readJson(FILES.urlAudits, DEFAULT_URL_AUDITS);
  return {
    runs: Array.isArray(audits.runs) ? audits.runs : []
  };
}

export async function appendUrlAudit(run) {
  const audits = await loadUrlAudits();
  const next = {
    runs: [run, ...audits.runs].slice(0, 30)
  };
  await writeJson(FILES.urlAudits, next);
  return run;
}

export async function loadSerpAudits() {
  await ensureDataFiles();
  const audits = await readJson(FILES.serpAudits, DEFAULT_SERP_AUDITS);
  return {
    runs: Array.isArray(audits.runs) ? audits.runs : []
  };
}

export async function appendSerpAudit(run) {
  const audits = await loadSerpAudits();
  const next = {
    runs: [run, ...audits.runs].slice(0, 40)
  };
  await writeJson(FILES.serpAudits, next);
  return run;
}

export async function loadLumenClaims() {
  await ensureDataFiles();
  const claims = await readJson(FILES.lumenClaims, DEFAULT_LUMEN_CLAIMS);
  return {
    notices: claims.notices && typeof claims.notices === "object" ? claims.notices : {},
    runs: Array.isArray(claims.runs) ? claims.runs : []
  };
}

export async function appendLumenClaimRun(run, notices = []) {
  const claims = await loadLumenClaims();
  const now = new Date().toISOString();
  const nextNotices = { ...claims.notices };

  for (const notice of notices) {
    const key = getLumenClaimKey(notice);
    if (!key) continue;
    const { isNew, ...persistedNotice } = notice;
    const existing = nextNotices[key] || {};
    const existingUrls = Array.isArray(existing.exactUrls) ? existing.exactUrls : [];
    const incomingUrls = Array.isArray(persistedNotice.exactUrls) ? persistedNotice.exactUrls : [];
    const exactUrls = Array.from(new Set([...existingUrls, ...incomingUrls]));
    nextNotices[key] = {
      ...existing,
      ...persistedNotice,
      claimKey: key,
      noticeId: persistedNotice.noticeId || existing.noticeId || persistedNotice.requestId || key,
      status:
        existing.status === "urls_extracted" || exactUrls.length > 0
          ? "urls_extracted"
          : persistedNotice.status || existing.status || "access_needed",
      reviewStatus: normalizeLumenClaimReviewStatus(existing.reviewStatus || persistedNotice.reviewStatus),
      reviewNote: existing.reviewNote || persistedNotice.reviewNote || "",
      exactUrls,
      firstSeenAt: existing.firstSeenAt || now,
      lastSeenAt: now,
      updatedAt: now
    };
  }

  const next = {
    notices: nextNotices,
    runs: [run, ...claims.runs].slice(0, 40)
  };
  await writeJson(FILES.lumenClaims, next);
  return next;
}

export async function saveLumenClaimNotice(noticeIdValue, patch = {}) {
  const noticeId = String(noticeIdValue || "").trim();
  if (!noticeId) throw new Error("Notice ID is required.");

  const claims = await loadLumenClaims();
  const key = claims.notices[noticeId]
    ? noticeId
    : Object.keys(claims.notices).find((itemKey) => claims.notices[itemKey]?.noticeId === noticeId);
  const existing = key ? claims.notices[key] : null;
  if (!existing) throw new Error("Lumen claim notice was not found.");

  const nextReviewStatus = Object.hasOwn(patch, "reviewStatus")
    ? normalizeLumenClaimReviewStatus(patch.reviewStatus)
    : normalizeLumenClaimReviewStatus(existing.reviewStatus);

  if (!LUMEN_CLAIM_REVIEW_STATUSES.has(nextReviewStatus)) {
    throw new Error("Claim review status is not valid.");
  }

  const now = new Date().toISOString();
  const nextNotice = {
    ...existing,
    reviewStatus: nextReviewStatus,
    reviewNote: Object.hasOwn(patch, "reviewNote")
      ? String(patch.reviewNote || "").trim().slice(0, 2000)
      : existing.reviewNote || "",
    reviewedAt: nextReviewStatus === "to_review" ? existing.reviewedAt || null : now,
    updatedAt: now
  };

  const next = {
    ...claims,
    notices: {
      ...claims.notices,
      [key]: nextNotice
    }
  };

  await writeJson(FILES.lumenClaims, next);
  return nextNotice;
}

function getLumenClaimKey(notice) {
  const domain = normalizeDomain(notice.domain || "");
  const id = String(notice.noticeId || notice.requestId || notice.lumenUrl || "").trim();
  return domain && id ? `${domain}::${id}` : id;
}

export async function loadSecrets() {
  await ensureDataFiles();
  return readJson(FILES.secrets, DEFAULT_SECRETS);
}

export async function saveLumenToken(token) {
  await ensureDataFiles();
  const cleaned = String(token || "").trim();
  const current = await loadSecrets();
  const next = { ...current };

  if (cleaned) {
    next.lumenAuthToken = cleaned;
  } else {
    delete next.lumenAuthToken;
  }

  await writeJson(FILES.secrets, next);
  return {
    tokenConfigured: Boolean(next.lumenAuthToken || process.env.LUMEN_AUTH_TOKEN)
  };
}

export async function getLumenAuthToken() {
  const envToken = String(process.env.LUMEN_AUTH_TOKEN || "").trim();
  if (envToken) return envToken;
  const secrets = await loadSecrets();
  return String(secrets.lumenAuthToken || "").trim();
}

export async function saveApifyToken(token) {
  await ensureDataFiles();
  const cleaned = String(token || "").trim();
  const current = await loadSecrets();
  const next = { ...current };

  if (cleaned) {
    next.apifyToken = cleaned;
  } else {
    delete next.apifyToken;
  }

  await writeJson(FILES.secrets, next);
  return {
    apifyTokenConfigured: Boolean(next.apifyToken || process.env.APIFY_TOKEN)
  };
}

export async function getApifyToken() {
  const envToken = String(process.env.APIFY_TOKEN || "").trim();
  if (envToken) return envToken;
  const secrets = await loadSecrets();
  return String(secrets.apifyToken || "").trim();
}

export function getSmtpSettings(config) {
  const host = String(process.env.SMTP_HOST || "").trim();
  const to = String(config.notificationEmail || process.env.SMTP_TO || "").trim();
  const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();

  return {
    configured: Boolean(host && to && from),
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    user: String(process.env.SMTP_USER || "").trim(),
    pass: String(process.env.SMTP_PASS || "").trim(),
    from,
    to
  };
}

export async function getPublicState() {
  const [config, portfolio, history, urlAudits, serpAudits, lumenClaims, cases, token, apifyToken] = await Promise.all([
    loadConfig(),
    loadPortfolio(),
    loadHistory(),
    loadUrlAudits(),
    loadSerpAudits(),
    loadLumenClaims(),
    loadCases(),
    getLumenAuthToken(),
    getApifyToken()
  ]);

  return {
    config,
    portfolio,
    history,
    urlAudits,
    serpAudits,
    lumenClaims,
    cases,
    tokenConfigured: Boolean(token),
    apifyTokenConfigured: Boolean(apifyToken),
    emailConfigured: getSmtpSettings(config).configured,
    dataDir: DATA_DIR
  };
}

function normalizeCase(domain, input = {}) {
  const status = CASE_STATUSES.has(input.status) ? input.status : "unreviewed";
  return {
    domain,
    status,
    note: String(input.note || "").slice(0, 2000),
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
    filedAt: input.filedAt || null,
    resolvedAt: status === "resolved" ? input.resolvedAt || null : null
  };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function ensureFile(filePath, fallback) {
  if (USE_BLOB_STORAGE) {
    try {
      await readBlobJson(filePath);
    } catch (error) {
      if (!(error instanceof BlobNotFoundError)) throw error;
      await writeBlobJson(filePath, fallback);
    }
    return;
  }

  try {
    await fs.access(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeJson(filePath, fallback);
  }
}

async function readJson(filePath, fallback) {
  if (USE_BLOB_STORAGE) {
    try {
      return await readBlobJson(filePath);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return structuredClone(fallback);
      throw error;
    }
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJson(filePath, value) {
  if (USE_BLOB_STORAGE) {
    await writeBlobJson(filePath, value);
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function readBlobJson(filePath) {
  const blob = await getBlob(blobPathFor(filePath), {
    access: "private"
  });
  if (!blob?.stream) throw new BlobNotFoundError();
  const raw = await streamToText(blob.stream);
  return JSON.parse(raw);
}

async function writeBlobJson(filePath, value) {
  await putBlob(blobPathFor(filePath), `${JSON.stringify(value, null, 2)}\n`, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json"
  });
}

function blobPathFor(filePath) {
  return `data/${path.basename(filePath)}`;
}
