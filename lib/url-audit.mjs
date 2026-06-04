import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import zlib from "node:zlib";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  appendUrlAudit,
  DATA_DIR,
  getApifyToken,
  loadConfig,
  loadHistory,
  normalizeDomain
} from "./store.mjs";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PortfolioCopyrightMonitor/0.1";
const APIFY_INDEX_CHECKER_URL =
  "https://api.apify.com/v2/acts/caprolok~google-bulk-index-checker/run-sync-get-dataset-items";

export async function runUrlDeepScan(options = {}) {
  const startedAt = new Date().toISOString();
  const source = options.source || "manual";
  const [config, history, apifyToken] = await Promise.all([
    loadConfig(),
    loadHistory(),
    getApifyToken()
  ]);
  const latestRun = history.runs[0] || null;
  const domains = resolveDomains(options.domains, latestRun);
  const maxUrlsPerDomain = Number(
    options.maxUrlsPerDomain ?? config.urlSearchMaxUrlsPerDomain ?? 0
  );
  const timeoutMs = Number(config.urlSearchTimeoutMs || 120000);
  const batchSize = Number(options.batchSize || config.apifyBatchSize || 50);
  const country = String(options.country || config.apifyCountry || "us").toLowerCase();
  const language = String(options.language || config.apifyLanguage || "en").toLowerCase();
  const proxyGroup = String(options.proxyGroup || config.apifyProxyGroup || "RESIDENTIAL").toUpperCase();

  if (!apifyToken) {
    throw new Error("Apify token is required for URL index checks.");
  }

  const domainResults = [];
  let checkedUrls = 0;

  options.onProgress?.({
    phase: "started",
    provider: "apify",
    totalDomains: domains.length,
    checkedDomains: 0,
    totalUrls: 0,
    checkedUrls: 0
  });

  for (const [domainIndex, domain] of domains.entries()) {
    options.onProgress?.({
      phase: "sitemap",
      provider: "apify",
      totalDomains: domains.length,
      checkedDomains: domainIndex,
      currentDomain: domain,
      checkedUrls
    });

    const sitemap = await discoverSitemapUrls(domain);
    const urls =
      maxUrlsPerDomain > 0 ? sitemap.urls.slice(0, maxUrlsPerDomain) : sitemap.urls;
    const urlResults = [];
    const progressTotalUrls = checkedUrls + urls.length;

    for (const [batchIndex, batch] of chunk(urls, batchSize).entries()) {
      options.onProgress?.({
        phase: "apify",
        provider: "apify",
        totalDomains: domains.length,
        checkedDomains: domainIndex,
        currentDomain: domain,
        totalUrls: progressTotalUrls,
        checkedUrls,
        currentUrl: batch[0] || null
      });

      try {
        const batchResults = await runApifyIndexBatch(batch, {
          token: apifyToken,
          country,
          language,
          proxyGroup,
          timeoutMs
        });
        urlResults.push(...batchResults);
      } catch (error) {
        urlResults.push(
          ...batch.map((pageUrl) => ({
            url: pageUrl,
            status: "error",
            searchUrl: buildGoogleSearchUrl(pageUrl),
            error: cleanSearchError(error),
            signal: "Apify index checker did not return a result for this URL."
          }))
        );
      }

      checkedUrls += batch.length;
    }

    domainResults.push({
      domain,
      provider: "apify",
      status: domainStatus(sitemap, urlResults),
      sitemapUrls: sitemap.sitemapUrls,
      sitemapErrors: sitemap.errors,
      discoveredUrls: sitemap.urls.length,
      scannedUrls: urls.length,
      skippedUrls: Math.max(0, sitemap.urls.length - urls.length),
      results: urlResults,
      summary: summarizeUrlResults(urlResults)
    });

    options.onProgress?.({
      phase: "domain_finished",
      provider: "apify",
      totalDomains: domains.length,
      checkedDomains: domainIndex + 1,
      currentDomain: domain,
      checkedUrls
    });
  }

  const totals = summarizeDomainResults(domainResults);
  const run = {
    id: crypto.randomUUID(),
    source,
    provider: "apify",
    country,
    language,
    batchSize,
    proxyGroup,
    status:
      domains.length === 0
        ? "empty"
        : totals.errorCount > 0
          ? "error"
          : totals.blockedCount > 0
            ? "blocked"
          : totals.possibleRemovalCount > 0
            ? "attention"
            : totals.notFoundCount > 0
              ? "review"
              : "clean",
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDomains: domains.length,
    checkedDomains: domainResults.length,
    totalUrls: totals.totalUrls,
    indexedCount: totals.indexedCount,
    possibleRemovalCount: totals.possibleRemovalCount,
    notFoundCount: totals.notFoundCount,
    blockedCount: totals.blockedCount,
    errorCount: totals.errorCount,
    domains: domainResults
  };

  await appendUrlAudit(run);
  options.onProgress?.({
    phase: "finished",
    provider: "apify",
    totalDomains: domains.length,
    checkedDomains: domains.length,
    checkedUrls: totals.totalUrls,
    runId: run.id,
    status: run.status
  });
  return run;
}

export async function exportReportedUrls(options = {}) {
  const [config, history] = await Promise.all([loadConfig(), loadHistory()]);
  const latestRun = history.runs[0] || null;
  const domains = resolveDomains(options.domains, latestRun);
  const maxUrlsPerDomain = Number(
    options.maxUrlsPerDomain ?? config.urlSearchMaxUrlsPerDomain ?? 0
  );
  const concurrency = Number(options.concurrency || 8);

  const exports = await mapWithConcurrency(domains, concurrency, async (domain) => {
    const sitemap = await discoverSitemapUrls(domain, {
      maxSitemaps: 40,
      robotsTimeoutMs: 5000,
      sitemapTimeoutMs: 8000
    });
    const urls =
      maxUrlsPerDomain > 0 ? sitemap.urls.slice(0, maxUrlsPerDomain) : sitemap.urls;
    return {
      rows: urls.map((pageUrl) => ({ domain, url: pageUrl })),
      summary: {
        domain,
        discoveredUrls: sitemap.urls.length,
        exportedUrls: urls.length,
        skippedUrls: Math.max(0, sitemap.urls.length - urls.length),
        sitemapUrls: sitemap.sitemapUrls,
        sitemapErrors: sitemap.errors
      }
    };
  });
  const rows = exports.flatMap((item) => item.rows);
  const domainSummaries = exports.map((item) => item.summary);

  const exportDir = path.join(DATA_DIR, "exports");
  await fs.mkdir(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(exportDir, `reported-urls-${timestamp}.csv`);
  const csv = [
    ["domain", "url"].map(csvCell).join(","),
    ...rows.map((row) => [row.domain, row.url].map(csvCell).join(","))
  ].join("\n");
  await fs.writeFile(filePath, `${csv}\n`, "utf8");

  return {
    createdAt: new Date().toISOString(),
    filePath,
    totalDomains: domains.length,
    totalUrls: rows.length,
    domains: domainSummaries
  };
}

export function buildGoogleSearchUrl(pageUrl) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("hl", "en");
  url.searchParams.set("num", "10");
  url.searchParams.set("q", `"${pageUrl}"`);
  return url.toString();
}

async function runApifyIndexBatch(urls, options) {
  if (urls.length === 0) return [];

  const endpoint = new URL(APIFY_INDEX_CHECKER_URL);
  endpoint.searchParams.set("token", options.token);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 120000));

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": DEFAULT_USER_AGENT
      },
      body: JSON.stringify({
        urls,
        country: options.country || "us",
        language: options.language || "en",
        proxyConfiguration: {
          useApifyProxy: true,
          apifyProxyGroups: [options.proxyGroup || "RESIDENTIAL"]
        }
      }),
      signal: controller.signal
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const apifyError = parseApifyError(bodyText);
      if (apifyError?.type === "actor-is-not-rented") {
        throw new Error(
          "Apify actor is not rented. Open caprolok/google-bulk-index-checker in Apify and rent/activate it before running index scans."
        );
      }
      if (/requires full access|approve its permissions/i.test(apifyError?.message || "")) {
        throw new Error(
          "Apify actor permissions are not approved. Open caprolok/google-bulk-index-checker in Apify and approve the requested full-access permissions before running index scans."
        );
      }
      throw new Error(
        `Apify returned HTTP ${response.status}${apifyError?.message ? `: ${apifyError.message}` : bodyText ? `: ${bodyText.slice(0, 220)}` : ""}`
      );
    }

    const payload = bodyText ? JSON.parse(bodyText) : [];
    const items = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
    return normalizeApifyItems(urls, items);
  } finally {
    clearTimeout(timeout);
  }
}

function parseApifyError(bodyText) {
  try {
    const payload = JSON.parse(bodyText);
    return payload?.error && typeof payload.error === "object" ? payload.error : null;
  } catch {
    return null;
  }
}

function normalizeApifyItems(inputUrls, items) {
  const itemsByUrl = new Map();
  for (const item of items) {
    const key = comparableUrl(extractItemUrl(item));
    if (key && !itemsByUrl.has(key)) itemsByUrl.set(key, item);
  }

  return inputUrls.map((inputUrl) => {
    const item = itemsByUrl.get(comparableUrl(inputUrl)) || null;

    if (!item) {
      return {
        url: inputUrl,
        status: "error",
        searchUrl: buildGoogleSearchUrl(inputUrl),
        signal: "Apify did not return a row for this URL."
      };
    }

    return normalizeApifyItem(inputUrl, item);
  });
}

function normalizeApifyItem(inputUrl, item) {
  const itemUrl = extractItemUrl(item) || inputUrl;
  const text = flattenItemText(item);
  const booleanIndexed = firstBoolean(item, [
    "indexed",
    "isIndexed",
    "is_indexed",
    "found",
    "isFound",
    "googleIndexed",
    "inIndex",
    "indexation"
  ]);

  let status = "not_found";
  if (/copyright|dmca|complaint|removed due to|legal removal|lumendatabase/i.test(text)) {
    status = "possible_removal";
  } else if (/blocked|captcha|unusual traffic|rate limit/i.test(text)) {
    status = "blocked";
  } else if (booleanIndexed === true) {
    status = "indexed";
  } else if (booleanIndexed === false) {
    status = "not_found";
  } else if (/\bnot\s+indexed\b|\bnot\s+found\b|no results?|not in index|deindexed|not indexed/i.test(text)) {
    status = "not_found";
  } else if (/\bindexed\b|\bfound\b|in index|is indexed|true/i.test(text)) {
    status = "indexed";
  }

  return {
    url: inputUrl,
    inputUrl,
    returnedUrl: comparableUrl(itemUrl) === comparableUrl(inputUrl) ? "" : itemUrl,
    status,
    searchUrl: buildGoogleSearchUrl(inputUrl),
    matchedUrl: status === "indexed" ? itemUrl : "",
    signal: apifySignal(status, item)
  };
}

function apifySignal(status, item) {
  const fields = ["status", "result", "message", "googleStatus", "indexed", "isIndexed", "found"];
  const detail = fields
    .map((field) => {
      const value = getObjectValue(item, field);
      return value === undefined ? "" : `${field}: ${String(value)}`;
    })
    .filter(Boolean)
    .join(" · ");

  if (detail) return detail.slice(0, 260);
  return (
    {
      indexed: "Apify index checker reported this URL as indexed.",
      possible_removal: "Apify result contains a copyright/removal signal.",
      not_found: "Apify index checker did not report this URL as indexed.",
      blocked: "Apify/Google reported a block while checking this URL.",
      error: "Apify result could not be interpreted."
    }[status] || "Apify result was parsed."
  );
}

function extractItemUrl(item) {
  if (!item || typeof item !== "object") return "";
  const candidates = [
    item.url,
    item.inputUrl,
    item.input_url,
    item.pageUrl,
    item.page_url,
    item.link,
    item.startUrl?.url,
    item.startUrl
  ];
  const direct = candidates.find((value) => typeof value === "string" && /^https?:\/\//i.test(value));
  if (direct) return direct;

  for (const value of Object.values(item)) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  }
  return "";
}

function firstBoolean(item, keys) {
  if (!item || typeof item !== "object") return null;
  for (const key of keys) {
    const value = getObjectValue(item, key);
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/^(true|yes|indexed|found)$/i.test(value)) return true;
      if (/^(false|no|not indexed|not found)$/i.test(value)) return false;
    }
  }
  return null;
}

function getObjectValue(item, key) {
  if (!item || typeof item !== "object") return undefined;
  if (Object.hasOwn(item, key)) return item[key];
  const lowerKey = key.toLowerCase();
  const entry = Object.entries(item).find(([itemKey]) => itemKey.toLowerCase() === lowerKey);
  return entry ? entry[1] : undefined;
}

function flattenItemText(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveDomains(inputDomains, latestRun) {
  if (Array.isArray(inputDomains) && inputDomains.length > 0) {
    return unique(inputDomains.map(normalizeDomain).filter(Boolean));
  }

  return unique(
    (latestRun?.results || [])
      .filter((result) => Number(result.total) > 0)
      .map((result) => normalizeDomain(result.domain))
      .filter(Boolean)
  );
}

async function discoverSitemapUrls(domain, options = {}) {
  const sitemapUrls = await discoverSitemapSeeds(domain, options);
  const queue = [...sitemapUrls];
  const seenSitemaps = new Set();
  const seenUrls = new Set();
  const errors = [];
  const maxSitemaps = Number(options.maxSitemaps || 120);
  const sitemapTimeoutMs = Number(options.sitemapTimeoutMs || 25000);

  while (queue.length > 0 && seenSitemaps.size < maxSitemaps) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const xml = await fetchText(sitemapUrl, sitemapTimeoutMs);
      const locations = parseSitemapLocations(xml);
      const isIndex =
        /<\s*sitemapindex[\s>]/i.test(xml) ||
        locations.some((location) => /\.(?:xml|xml\.gz)(?:[?#].*)?$/i.test(location));

      if (isIndex) {
        for (const location of locations) {
          if (sameDomain(location, domain) && !seenSitemaps.has(location)) {
            queue.push(location);
          }
        }
      } else {
        for (const location of locations) {
          if (sameDomain(location, domain)) {
            seenUrls.add(stripHash(location));
          }
        }
      }
    } catch (error) {
      errors.push({
        sitemapUrl,
        error: cleanSearchError(error)
      });
    }
  }

  return {
    sitemapUrls: Array.from(seenSitemaps),
    urls: Array.from(seenUrls).sort((left, right) => left.localeCompare(right)),
    errors
  };
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function discoverSitemapSeeds(domain, options = {}) {
  const candidates = [
    `https://${domain}/robots.txt`,
    domain.startsWith("www.") ? "" : `https://www.${domain}/robots.txt`,
    `http://${domain}/robots.txt`
  ].filter(Boolean);
  const seeds = new Set();
  const robotsTimeoutMs = Number(options.robotsTimeoutMs || 12000);

  await Promise.all(
    candidates.map(async (robotsUrl) => {
    try {
      const text = await fetchText(robotsUrl, robotsTimeoutMs);
      for (const match of text.matchAll(/^sitemap:\s*(\S+)\s*$/gim)) {
        if (sameDomain(match[1], domain)) seeds.add(match[1].trim());
      }
    } catch {
      // Robots discovery is opportunistic; fallback sitemap URLs below cover common cases.
    }
    })
  );

  for (const base of [`https://${domain}`, domain.startsWith("www.") ? "" : `https://www.${domain}`, `http://${domain}`].filter(Boolean)) {
    seeds.add(`${base}/sitemap.xml`);
    seeds.add(`${base}/sitemap_index.xml`);
  }

  return Array.from(seeds);
}

async function createGoogleSearchBrowser({ timeoutMs }) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    throw new Error(`URL deep scan needs Playwright available locally: ${error.message}`);
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
  page.setDefaultTimeout(timeoutMs);

  return {
    async search(pageUrl) {
      return searchGoogleForUrl(page, pageUrl, { timeoutMs });
    },
    async close() {
      await browser.close().catch(() => {});
    }
  };
}

async function searchGoogleForUrl(page, pageUrl, { timeoutMs }) {
  const searchUrl = buildGoogleSearchUrl(pageUrl);
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });
  await handleGoogleConsent(page);
  await page.waitForTimeout(1200);

  const snapshot = await page.evaluate(() => {
    const bodyText = document.body.innerText || "";
    const links = Array.from(document.querySelectorAll("a[href]")).map((anchor) => ({
      href: anchor.href,
      text: anchor.textContent || ""
    }));
    return { bodyText, links };
  });
  const text = snapshot.bodyText.replace(/\s+/g, " ").trim();

  if (/unusual traffic|detected unusual|not a robot|captcha/i.test(text)) {
    return {
      url: pageUrl,
      status: "blocked",
      searchUrl,
      signal: "Google blocked automated search."
    };
  }

  const complaintSignal = /in response to (?:a|legal) complaint|results? (?:may have been )?removed|dmca|copyright complaint|lumendatabase|chilling effects/i.test(text);
  const notFoundSignal = /did not match any documents|no results found|try different keywords/i.test(text);
  const matchedUrl = findMatchingUrl(pageUrl, snapshot.links);

  return {
    url: pageUrl,
    status: complaintSignal ? "possible_removal" : matchedUrl ? "indexed" : "not_found",
    searchUrl,
    matchedUrl,
    signal: complaintSignal
      ? "Google search showed a copyright/removal complaint signal."
      : notFoundSignal
        ? "Google search returned no exact result."
        : matchedUrl
          ? "Exact URL was found in Google results."
          : "Exact URL was not found in the first Google result page."
  };
}

async function handleGoogleConsent(page) {
  const buttons = [
    page.getByRole("button", { name: /Accept all/i }),
    page.getByRole("button", { name: /I agree/i }),
    page.getByRole("button", { name: /Reject all/i })
  ];

  for (const button of buttons) {
    try {
      if ((await button.count()) === 1) {
        await button.click({ timeout: 2000 });
        await page.waitForTimeout(800);
        return;
      }
    } catch {
      // Consent controls differ by region; absence is fine.
    }
  }
}

function findMatchingUrl(targetUrl, links) {
  const target = comparableUrl(targetUrl);
  for (const link of links) {
    const href = unwrapGoogleHref(link.href);
    if (comparableUrl(href) === target) return href;
    if (comparableUrl(link.text) === target) return href || link.text;
  }
  return "";
}

function unwrapGoogleHref(href) {
  try {
    const parsed = new URL(href);
    if (parsed.hostname.endsWith("google.com") && parsed.pathname === "/url") {
      return parsed.searchParams.get("q") || href;
    }
  } catch {
    return href;
  }
  return href;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": DEFAULT_USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const body =
      buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer) : buffer;
    return body.toString("utf8");
  } finally {
    clearTimeout(timeout);
  }
}

function parseSitemapLocations(xml) {
  return Array.from(String(xml || "").matchAll(/<loc[^>]*>\s*([\s\S]*?)\s*<\/loc>/gi))
    .map((match) => decodeXml(match[1].trim()))
    .filter((value) => /^https?:\/\//i.test(value));
}

function sameDomain(value, domain) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    const normalizedDomain = normalizeDomain(domain);
    const withoutWww = normalizedDomain.replace(/^www\./, "");
    return hostname === normalizedDomain || hostname === `www.${withoutWww}` || hostname.replace(/^www\./, "") === withoutWww;
  } catch {
    return false;
  }
}

function comparableUrl(value) {
  try {
    const parsed = new URL(String(value).trim());
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname}${decodeURIComponent(path)}${parsed.search}`;
  } catch {
    return "";
  }
}

function stripHash(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function decodeXml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function domainStatus(sitemap, results) {
  if (sitemap.urls.length === 0 && sitemap.errors.length > 0) return "sitemap_error";
  if (sitemap.urls.length === 0) return "no_urls";
  if (results.some((result) => result.status === "possible_removal")) return "attention";
  if (results.some((result) => result.status === "blocked" || result.status === "error")) return "error";
  if (results.some((result) => result.status === "not_found")) return "review";
  return "clean";
}

function summarizeUrlResults(results) {
  return {
    indexedCount: results.filter((result) => result.status === "indexed").length,
    possibleRemovalCount: results.filter((result) => result.status === "possible_removal").length,
    notFoundCount: results.filter((result) => result.status === "not_found").length,
    blockedCount: results.filter((result) => result.status === "blocked").length,
    errorCount: results.filter((result) => result.status === "error").length
  };
}

function summarizeDomainResults(domains) {
  return domains.reduce(
    (totals, domain) => {
      totals.totalUrls += domain.scannedUrls;
      totals.indexedCount += domain.summary.indexedCount;
      totals.possibleRemovalCount += domain.summary.possibleRemovalCount;
      totals.notFoundCount += domain.summary.notFoundCount;
      totals.blockedCount += domain.summary.blockedCount;
      totals.errorCount += domain.summary.errorCount;
      return totals;
    },
    {
      totalUrls: 0,
      indexedCount: 0,
      possibleRemovalCount: 0,
      notFoundCount: 0,
      blockedCount: 0,
      errorCount: 0
    }
  );
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

function cleanSearchError(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function unique(values) {
  return Array.from(new Set(values));
}

function chunk(values, size) {
  const output = [];
  const chunkSize = Math.max(1, Number(size) || 50);
  for (let index = 0; index < values.length; index += chunkSize) {
    output.push(values.slice(index, index + chunkSize));
  }
  return output;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, values.length || 1));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index], index);
      }
    })
  );

  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
