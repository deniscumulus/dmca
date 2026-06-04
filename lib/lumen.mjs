import crypto from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendRun,
  getLumenAuthToken,
  loadConfig,
  loadHistory,
  loadPortfolio,
  normalizeDomain
} from "./store.mjs";
import { maybeSendRunNotification } from "./notify.mjs";

const LUMEN_BASE_URL = process.env.LUMEN_BASE_URL || "https://lumendatabase.org";
const GOOGLE_BASE_URL = "https://transparencyreport.google.com";
const DEFAULT_USER_AGENT =
  process.env.LUMEN_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PortfolioCopyrightMonitor/0.1";

export async function runPortfolioCheck(options = {}) {
  const startedAt = new Date().toISOString();
  const source = options.source || "manual";
  const [config, portfolio, history] = await Promise.all([
    loadConfig(),
    loadPortfolio(),
    loadHistory()
  ]);
  const domains = (options.domains || portfolio.domains).map(normalizeDomain).filter(Boolean);
  const previousNoticeIds = collectPreviousNoticeIds(history);
  const token = await getLumenAuthToken();
  const mode = options.mode || config.mode;
  const results = [];
  let browserSearcher = null;
  let consecutiveBrowserErrors = 0;
  let browserInitError = null;

  options.onProgress?.({
    phase: "started",
    mode,
    totalDomains: domains.length,
    checked: 0
  });

  try {
    if (mode === "google" || mode === "browser") {
      try {
        browserSearcher = await createBrowserSearcher(config);
      } catch (error) {
        browserInitError = cleanBrowserError(error);
        for (const domain of domains) {
          results.push({
            domain,
            status: "error",
            total: 0,
            notices: [],
            queryUrl: buildHumanSearchUrl(domain),
            error: browserInitError
          });
        }
        options.onProgress?.({
          phase: "stopped",
          mode,
          totalDomains: domains.length,
          checked: domains.length,
          currentDomain: null,
          lastStatus: "stopped"
        });
      }
    }

    if (!browserInitError) {
      for (const [index, domain] of domains.entries()) {
      options.onProgress?.({
        phase: "checking",
        mode,
        totalDomains: domains.length,
        checked: index,
        currentDomain: domain
      });

      try {
        const result =
          mode === "google" || mode === "browser"
            ? await browserSearcher.search(domain)
            : mode === "live"
              ? await searchDomainLive(domain, {
                  token,
                  perPage: config.perPage
                })
              : await searchDomainDemo(domain, index);

        result.notices = result.notices.map((notice) => ({
          ...notice,
          isNew: notice.id ? !previousNoticeIds.has(String(notice.id)) : false
        }));
        results.push(result);
      } catch (error) {
        results.push({
          domain,
          status: "error",
          total: 0,
          notices: [],
          queryUrl: buildHumanSearchUrl(domain),
          error: cleanBrowserError(error)
        });
      }

      if ((mode === "google" || mode === "browser") && results.at(-1)?.status === "error") {
        consecutiveBrowserErrors += 1;
      } else {
        consecutiveBrowserErrors = 0;
      }

      options.onProgress?.({
        phase: "checked",
        mode,
        totalDomains: domains.length,
        checked: index + 1,
        currentDomain: domain,
        lastStatus: results.at(-1)?.status || "unknown"
      });

      if ((mode === "google" || mode === "browser") && consecutiveBrowserErrors >= 3 && index < domains.length - 1) {
        for (const skippedDomain of domains.slice(index + 1)) {
          results.push({
            domain: skippedDomain,
            status: "skipped",
            total: 0,
            notices: [],
            queryUrl: buildHumanSearchUrl(skippedDomain),
            error: "Skipped after repeated browser timeouts while reaching Google Transparency Report."
          });
        }
        options.onProgress?.({
          phase: "stopped",
          mode,
          totalDomains: domains.length,
          checked: domains.length,
          currentDomain: null,
          lastStatus: "stopped"
        });
        break;
      }

      if (index < domains.length - 1) {
        if (mode === "google" || mode === "browser") await sleep(Number(config.browserDelayMs || 3000));
        if (mode === "live") await sleep(1100);
      }
    }
    }
  } finally {
    await browserSearcher?.close();
  }

  const errorCount = results.filter((item) => item.status === "error" || item.status === "skipped").length;
  const noticeCount = results.reduce((sum, item) => sum + item.total, 0);
  const changeCount = results.reduce(
    (sum, item) => sum + item.notices.filter((notice) => notice.isNew).length,
    0
  );
  const run = {
    id: crypto.randomUUID(),
    source,
    mode,
    status:
      domains.length === 0
        ? "empty"
        : errorCount > 0
          ? "error"
          : changeCount > 0
            ? "changes"
            : noticeCount > 0
              ? "issues"
              : "clean",
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDomains: domains.length,
    noticeCount,
    changeCount,
    errorCount,
    results
  };

  run.notification = await maybeSendRunNotification(run);
  await appendRun(run);
  options.onProgress?.({
    phase: "finished",
    mode,
    totalDomains: domains.length,
    checked: domains.length,
    runId: run.id,
    status: run.status
  });
  return run;
}

export function buildHumanSearchUrl(domain) {
  const url = new URL("/copyright/explore", GOOGLE_BASE_URL);
  url.searchParams.set("hl", "en");
  url.searchParams.set("copyright_data_exploration", `q:${domain};ce:domain;size:10`);
  url.searchParams.set("lu", "copyright_data_exploration");
  return url.toString();
}

async function searchDomainLive(domain, options) {
  if (!options.token) {
    throw new Error("Live mode needs a Lumen API token.");
  }

  const url = new URL("/notices/search.json", LUMEN_BASE_URL);
  url.searchParams.set("term", `"${domain}"`);
  url.searchParams.set("term-require-all", "yes");
  url.searchParams.set("page", "1");
  url.searchParams.set("per_page", String(options.perPage || 10));
  url.searchParams.set("sort_by", "date_received desc");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Authentication-Token": options.token,
        "User-Agent": DEFAULT_USER_AGENT
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Lumen API returned ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 160)}` : ""}`
      );
    }

    const json = await response.json();
    return normalizeSearchResponse(domain, json, url.toString());
  } finally {
    clearTimeout(timeout);
  }
}

async function searchDomainDemo(domain, index) {
  const hasDemoNotice = index === 0;
  const notices = hasDemoNotice
    ? [
        {
          id: `demo-${shortHash(domain)}`,
          type: "DMCA",
          title: `Demo notice mentioning ${domain}`,
          dateReceived: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
          senderName: "Demo sender",
          recipientName: "Demo recipient",
          topics: ["DMCA Notices"],
          noticeUrl: buildHumanSearchUrl(domain),
          matchedFields: ["term"]
        }
      ]
    : [];

  return {
    domain,
    status: "ok",
    total: notices.length,
    notices,
    queryUrl: buildHumanSearchUrl(domain)
  };
}

async function createBrowserSearcher(config) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    throw new Error(`Browser mode needs Playwright available locally: ${error.message}`);
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath: findLocalBrowserExecutable()
  });
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(Number(config.browserTimeoutMs || 45000));

  return {
    async search(domain) {
      return searchDomainBrowser(page, domain, {
        timeoutMs: Number(config.browserTimeoutMs || 45000)
      });
    },
    async close() {
      await browser.close().catch(() => {});
    }
  };
}

function findLocalBrowserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

async function searchDomainBrowser(page, domain, options) {
  const queryUrl = buildHumanSearchUrl(domain);
  await page.goto(queryUrl, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs
  });

  await page
    .waitForFunction(
      () => document.body?.innerText?.includes("Specified domain") || document.body?.innerText?.includes("Copyright owner"),
      { timeout: Math.min(options.timeoutMs, 15000) }
    )
    .catch(() => {});
  await page.waitForTimeout(1200);

  const rows = await page
    .locator("table tr")
    .evaluateAll((trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("th,td")).map((cell) => cell.textContent.trim()))
    )
    .catch(() => []);
  return normalizeGoogleDomainRows(domain, rows, queryUrl);
}

function normalizeGoogleDomainRows(domain, rows, queryUrl) {
  const normalizedDomain = normalizeDomain(domain);
  const dataRows = rows.filter((row) => row.length >= 4 && row[0] !== "Specified domain");
  const exactRow = dataRows.find((row) => normalizeDomain(row[0]) === normalizedDomain);

  if (!exactRow) {
    return {
      domain,
      status: "ok",
      total: 0,
      notices: [],
      queryUrl
    };
  }

  const copyrightOwners = parseNumber(exactRow[1]);
  const reportingOrganizations = parseNumber(exactRow[2]);
  const requestedUrls = parseNumber(exactRow[3]);
  const noticeId = `google-${shortHash(`${normalizedDomain}:${copyrightOwners}:${reportingOrganizations}:${requestedUrls}`)}`;
  const notices =
    requestedUrls > 0
      ? [
          {
            id: noticeId,
            type: "Google copyright delisting data",
            title: `${normalizedDomain}: ${formatNumber(requestedUrls)} requested URL${requestedUrls === 1 ? "" : "s"}`,
            dateReceived: null,
            senderName: `${formatNumber(copyrightOwners)} copyright owner${copyrightOwners === 1 ? "" : "s"}`,
            recipientName: `${formatNumber(reportingOrganizations)} reporting organization${reportingOrganizations === 1 ? "" : "s"}`,
            topics: ["Google Transparency Report", "Copyright"],
            noticeUrl: new URL(`/copyright/domains/${encodeURIComponent(exactRow[0])}`, GOOGLE_BASE_URL).toString(),
            matchedFields: ["google-domain-search", normalizedDomain],
            requestedUrls,
            copyrightOwners,
            reportingOrganizations
          }
        ]
      : [];

  return {
    domain,
    status: "ok",
    total: requestedUrls,
    notices,
    queryUrl
  };
}

function parseNumber(value) {
  return Number(String(value || "0").replace(/,/g, "")) || 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function extractNoticeLinks(html, domain) {
  const notices = [];
  const seen = new Set();
  const linkPattern = /<a\b[^>]*href=["']([^"']*(?:\/notices\/|\/N\/)(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(linkPattern)) {
    const id = match[2];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title = cleanHtml(match[3]) || `Lumen notice ${id}`;
    const after = html.slice(match.index || 0, (match.index || 0) + 1600);
    const dateReceived = extractDate(after);
    const type = /dmca/i.test(title) ? "DMCA" : "Lumen notice";

    notices.push({
      id,
      type,
      title,
      dateReceived,
      senderName: extractField(after, "Sender"),
      recipientName: extractField(after, "Recipient"),
      topics: [],
      noticeUrl: new URL(`/notices/${id}`, LUMEN_BASE_URL).toString(),
      matchedFields: ["browser-search", domain]
    });
  }

  return notices;
}

function extractResultTotal(text, fallback) {
  const cleaned = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /of\s+([\d,]+)\s+(?:results|notices)/i,
    /([\d,]+)\s+(?:results|notices)\s+found/i,
    /showing\s+[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+)/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) return Number(match[1].replaceAll(",", ""));
  }

  if (/no\s+(?:results|notices)\s+(?:found|matched)/i.test(cleaned)) return 0;
  return fallback;
}

function extractDate(html) {
  const text = cleanHtml(html);
  const match =
    text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i) ||
    text.match(/\b\d{4}-\d{2}-\d{2}\b/) ||
    text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);

  if (!match) return null;
  const parsed = new Date(match[0]);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function extractField(html, label) {
  const text = cleanHtml(html);
  const pattern = new RegExp(`${label}\\s*:?\\s*([^\\n|]+)`, "i");
  const match = text.match(pattern);
  return match ? match[1].trim().slice(0, 120) : "";
}

function cleanHtml(value) {
  return decodeEntities(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function cleanBrowserError(error) {
  const message = String(error?.message || error || "Unknown browser error")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/Timeout \d+ms exceeded/i.test(message) && /transparencyreport\.google\.com/i.test(message)) {
    return "Google Transparency Report page timed out in browser mode.";
  }

  if (/Timeout \d+ms exceeded/i.test(message) && /lumendatabase\.org/i.test(message)) {
    return "Lumen page timed out in browser mode.";
  }

  return message.slice(0, 260);
}

function normalizeSearchResponse(domain, payload, queryUrl) {
  const notices = Array.isArray(payload.notices) ? payload.notices : [];
  const normalized = notices.map((notice) => normalizeNotice(notice, domain));
  const total = Number(payload.meta?.total_entries ?? normalized.length);

  return {
    domain,
    status: "ok",
    total,
    notices: normalized,
    queryUrl
  };
}

function normalizeNotice(input, domain) {
  const notice = unwrapNotice(input);
  const id = notice.id ? String(notice.id) : "";
  const rawText = JSON.stringify(notice).toLowerCase();
  const matchedFields = [];

  if (rawText.includes(domain.toLowerCase())) {
    matchedFields.push("notice");
  }

  return {
    id,
    type: notice.type || input.type || "Notice",
    title: notice.title || input.title || "Untitled notice",
    dateReceived: notice.date_received || notice.dateReceived || null,
    senderName: notice.sender_name || notice.senderName || "",
    recipientName: notice.recipient_name || notice.recipientName || "",
    topics: Array.isArray(notice.topics) ? notice.topics : [],
    noticeUrl: id ? `${LUMEN_BASE_URL}/notices/${id}` : buildHumanSearchUrl(domain),
    matchedFields
  };
}

function unwrapNotice(input) {
  if (!input || typeof input !== "object") return {};
  if (input.id || input.title || input.type) return input;
  const keys = Object.keys(input);
  if (keys.length === 1 && input[keys[0]] && typeof input[keys[0]] === "object") {
    return input[keys[0]];
  }
  return input;
}

function collectPreviousNoticeIds(history) {
  const ids = new Set();
  for (const run of history.runs || []) {
    for (const result of run.results || []) {
      for (const notice of result.notices || []) {
        if (notice.id) ids.add(String(notice.id));
      }
    }
  }
  return ids;
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
