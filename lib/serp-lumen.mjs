import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  appendSerpAudit,
  DATA_DIR,
  loadConfig,
  loadHistory,
  normalizeDomain
} from "./store.mjs";

const DEFAULT_USER_AGENT =
  process.env.LUMEN_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PortfolioCopyrightMonitor/0.1";

export async function runSerpLumenScan(options = {}) {
  const startedAt = new Date().toISOString();
  const source = options.source || "manual";
  const [config, history] = await Promise.all([loadConfig(), loadHistory()]);
  const sourceSelection = resolveSerpDomains(options.domains, history);
  const domains = sourceSelection.domains;
  const results = [];
  let searcher = null;
  let consecutiveBlocks = 0;

  options.onProgress?.({
    phase: "started",
    provider: "google_serp",
    totalDomains: domains.length,
    checkedDomains: 0,
    currentDomain: null
  });

  try {
    searcher = await createGoogleSerpSearcher(config);
  } catch (error) {
    const cleaned = cleanSerpError(error);
    for (const domain of domains) {
      results.push(buildErrorResult(domain, "error", cleaned));
    }
  }

  if (searcher) {
    try {
      for (const [index, domain] of domains.entries()) {
        options.onProgress?.({
          phase: "checking",
          provider: "google_serp",
          totalDomains: domains.length,
          checkedDomains: index,
          currentDomain: domain
        });

        try {
          const result = await searcher.search(domain);
          results.push(result);
          consecutiveBlocks = result.status === "blocked" ? consecutiveBlocks + 1 : 0;
        } catch (error) {
          const cleaned = cleanSerpError(error);
          const status = /unusual traffic|automated queries|captcha|not a robot|consent/i.test(cleaned)
            ? "blocked"
            : "error";
          results.push(buildErrorResult(domain, status, cleaned));
          consecutiveBlocks = status === "blocked" ? consecutiveBlocks + 1 : 0;
        }

        options.onProgress?.({
          phase: "checked",
          provider: "google_serp",
          totalDomains: domains.length,
          checkedDomains: index + 1,
          currentDomain: domain,
          lastStatus: results.at(-1)?.status || "unknown"
        });

        if (consecutiveBlocks >= 3 && index < domains.length - 1) {
          for (const skippedDomain of domains.slice(index + 1)) {
            results.push(
              buildErrorResult(
                skippedDomain,
                "skipped",
                "Skipped after repeated Google SERP blocks."
              )
            );
          }
          options.onProgress?.({
            phase: "stopped",
            provider: "google_serp",
            totalDomains: domains.length,
            checkedDomains: domains.length,
            currentDomain: null,
            lastStatus: "stopped"
          });
          break;
        }

        if (index < domains.length - 1) {
          await sleep(Number(config.browserDelayMs || 3000));
        }
      }
    } finally {
      await searcher.close();
    }
  }

  const totals = summarizeSerpResults(results);
  const run = {
    id: crypto.randomUUID(),
    source,
    provider: "google_serp",
    sourceRunId: sourceSelection.sourceRunId,
    sourceRunStartedAt: sourceSelection.sourceRunStartedAt,
    status:
      domains.length === 0
        ? "empty"
        : totals.foundCount > 0
          ? "attention"
          : totals.blockedCount > 0 || totals.skippedCount > 0
            ? "blocked"
            : totals.errorCount > 0
              ? "error"
              : "clean",
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDomains: domains.length,
    checkedDomains: results.length,
    foundCount: totals.foundCount,
    noNoticeCount: totals.noNoticeCount,
    noticeWithoutLinkCount: totals.noticeWithoutLinkCount,
    blockedCount: totals.blockedCount,
    skippedCount: totals.skippedCount,
    errorCount: totals.errorCount,
    lumenLinkCount: totals.lumenLinkCount,
    lumenNoticeIds: totals.lumenNoticeIds,
    results
  };

  run.exportPath = await exportSerpAudit(run);
  await appendSerpAudit(run);

  options.onProgress?.({
    phase: "finished",
    provider: "google_serp",
    totalDomains: domains.length,
    checkedDomains: results.length,
    runId: run.id,
    status: run.status
  });

  return run;
}

export function buildGoogleDomainSearchUrl(domain) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("hl", "en");
  url.searchParams.set("num", "10");
  url.searchParams.set("q", `site:${normalizeDomain(domain)}`);
  return url.toString();
}

export function extractLumenUrl(value) {
  const raw = String(value || "").replaceAll("&amp;", "&");
  const direct = directLumenMatch(raw);
  if (direct) return direct;

  try {
    const parsed = new URL(raw, "https://www.google.com");
    for (const key of ["q", "url", "u"]) {
      const param = parsed.searchParams.get(key);
      const fromParam = directLumenMatch(param);
      if (fromParam) return fromParam;
    }
  } catch {
    // Non-URL anchor values are handled by the decoded string fallback below.
  }

  const decoded = decodeLoose(raw);
  return directLumenMatch(decoded);
}

async function createGoogleSerpSearcher(config) {
  const { chromium } = await import("playwright");
  const executablePath = findLocalBrowserExecutable();
  const browser = await chromium.launch({
    headless: process.env.GOOGLE_SERP_HEADLESS === "false" ? false : true,
    executablePath,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    locale: "en-US",
    timezoneId: "Europe/Belgrade",
    viewport: { width: 1360, height: 960 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(Number(config.browserTimeoutMs || 30000));

  return {
    async search(domain) {
      const googleSearchUrl = buildGoogleDomainSearchUrl(domain);
      await page.goto(googleSearchUrl, {
        waitUntil: "domcontentloaded",
        timeout: Number(config.browserTimeoutMs || 30000)
      });
      await page.waitForTimeout(Math.min(5000, Math.max(1500, Number(config.browserDelayMs || 3000))));
      return extractSerpPage(page, domain, googleSearchUrl);
    },
    async close() {
      await browser.close().catch(() => {});
    }
  };
}

async function extractSerpPage(page, domain, googleSearchUrl) {
  const payload = await page.evaluate(() => {
    const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() || "";
    const anchors = Array.from(document.querySelectorAll("a[href]")).map((link) => ({
      href: link.getAttribute("href") || "",
      text: link.textContent?.replace(/\s+/g, " ").trim() || ""
    }));
    const noticeSnippets = Array.from(document.querySelectorAll("div, p, span"))
      .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter((text) => /lumendatabase|dmca|copyright complaint|removed results?|legal removal/i.test(text))
      .filter(Boolean)
      .slice(0, 40);

    return {
      finalUrl: location.href,
      title: document.title || "",
      bodyText,
      textSample: bodyText.slice(0, 900),
      anchors,
      noticeSnippets,
      resultStats: extractResultStats(bodyText)
    };

    function extractResultStats(text) {
      const match =
        text.match(/About\s+[\d,.]+\s+results?/i) ||
        text.match(/[\d,.]+\s+results?\s+\([\d.]+\s+seconds?\)/i);
      return match ? match[0] : "";
    }
  });

  const blockReason = detectGoogleBlock(payload);
  const lumenLinks = collectLumenLinks(payload);
  const noticeSnippets = normalizeSnippets(payload.noticeSnippets);

  if (blockReason) {
    return {
      domain,
      status: "blocked",
      query: `site:${domain}`,
      googleSearchUrl,
      checkedAt: new Date().toISOString(),
      finalUrl: payload.finalUrl,
      resultStats: payload.resultStats,
      noticeSnippets: [],
      lumenLinks: [],
      textSample: payload.textSample,
      error: blockReason
    };
  }

  const status =
    lumenLinks.length > 0 ? "found" : noticeSnippets.length > 0 ? "notice_without_link" : "no_notice";

  return {
    domain,
    status,
    query: `site:${domain}`,
    googleSearchUrl,
    checkedAt: new Date().toISOString(),
    finalUrl: payload.finalUrl,
    resultStats: payload.resultStats,
    noticeSnippets,
    lumenLinks,
    textSample: payload.textSample
  };
}

function collectLumenLinks(payload) {
  const links = [];
  const seen = new Set();

  for (const anchor of payload.anchors || []) {
    const url = extractLumenUrl(anchor.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({
      url,
      noticeId: extractNoticeId(url),
      label: anchor.text || "Lumen complaint"
    });
  }

  for (const match of String(payload.bodyText || "").matchAll(/https?:\/\/(?:www\.)?lumendatabase\.org\/[^\s"'<>\\)]+/gi)) {
    const url = extractLumenUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({
      url,
      noticeId: extractNoticeId(url),
      label: "Lumen complaint"
    });
  }

  return links;
}

function directLumenMatch(value) {
  const text = decodeLoose(String(value || "").replaceAll("&amp;", "&"));
  const match = text.match(/https?:\/\/(?:www\.)?lumendatabase\.org\/[^\s"'<>\\)&#]+/i);
  return match ? cleanLumenUrl(match[0]) : "";
}

function cleanLumenUrl(value) {
  const cleaned = String(value || "").replace(/[.,;:]+$/, "");
  try {
    const url = new URL(cleaned);
    url.protocol = "https:";
    url.hostname = "lumendatabase.org";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return cleaned;
  }
}

function extractNoticeId(url) {
  const match = String(url || "").match(/\/notices\/(\d+)/i);
  return match ? match[1] : "";
}

function normalizeSnippets(snippets) {
  const unique = [];
  const seen = new Set();

  for (const snippet of snippets || []) {
    const normalized = String(snippet || "").replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length < 20) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized.slice(0, 600));
  }

  return unique
    .sort((left, right) => left.length - right.length)
    .filter((snippet, index, all) => {
      const lower = snippet.toLowerCase();
      return !all.some(
        (other, otherIndex) =>
          otherIndex < index && lower.includes(other.toLowerCase()) && other.length < snippet.length
      );
    })
    .slice(0, 5);
}

function detectGoogleBlock(payload) {
  const text = `${payload.title || ""} ${payload.finalUrl || ""} ${payload.bodyText || ""}`;
  if (/\/sorry\/index|sorry\.google\.com/i.test(text)) {
    return "Google returned an unusual traffic page.";
  }
  if (/our systems have detected unusual traffic|automated queries|unusual traffic|not a robot|captcha/i.test(text)) {
    return "Google blocked the automated search with an unusual traffic or CAPTCHA page.";
  }
  if (/before you continue to google|consent\.google/i.test(text)) {
    return "Google returned a consent page instead of search results.";
  }
  return "";
}

function buildErrorResult(domain, status, error) {
  return {
    domain,
    status,
    query: `site:${domain}`,
    googleSearchUrl: buildGoogleDomainSearchUrl(domain),
    checkedAt: new Date().toISOString(),
    finalUrl: "",
    resultStats: "",
    noticeSnippets: [],
    lumenLinks: [],
    error
  };
}

function summarizeSerpResults(results) {
  const ids = new Set();
  const totals = {
    foundCount: 0,
    noNoticeCount: 0,
    noticeWithoutLinkCount: 0,
    blockedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    lumenLinkCount: 0,
    lumenNoticeIds: []
  };

  for (const result of results) {
    if (result.status === "found") totals.foundCount += 1;
    if (result.status === "no_notice") totals.noNoticeCount += 1;
    if (result.status === "notice_without_link") totals.noticeWithoutLinkCount += 1;
    if (result.status === "blocked") totals.blockedCount += 1;
    if (result.status === "skipped") totals.skippedCount += 1;
    if (result.status === "error") totals.errorCount += 1;

    for (const link of result.lumenLinks || []) {
      totals.lumenLinkCount += 1;
      if (link.noticeId) ids.add(link.noticeId);
    }
  }

  totals.lumenNoticeIds = Array.from(ids).sort((left, right) => left.localeCompare(right));
  return totals;
}

function resolveSerpDomains(inputDomains, history) {
  if (Array.isArray(inputDomains) && inputDomains.length > 0) {
    return {
      domains: unique(inputDomains.map(normalizeDomain).filter(Boolean)),
      sourceRunId: null,
      sourceRunStartedAt: null
    };
  }

  const sourceRun = (history.runs || []).find((run) =>
    (run.results || []).some((result) => Number(result.total || 0) > 0)
  );

  return {
    domains: unique(
      (sourceRun?.results || [])
        .filter((result) => Number(result.total || 0) > 0)
        .map((result) => normalizeDomain(result.domain))
        .filter(Boolean)
    ),
    sourceRunId: sourceRun?.id || null,
    sourceRunStartedAt: sourceRun?.startedAt || null
  };
}

async function exportSerpAudit(run) {
  const exportDir = path.join(DATA_DIR, "exports");
  await fs.mkdir(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(exportDir, `google-serp-lumen-${timestamp}.csv`);
  const rows = [
    [
      "domain",
      "status",
      "google_site_query",
      "google_search_url",
      "lumen_url",
      "lumen_notice_id",
      "notice_text",
      "result_stats",
      "error"
    ]
  ];

  for (const result of run.results || []) {
    const links = result.lumenLinks?.length ? result.lumenLinks : [null];
    for (const link of links) {
      rows.push([
        result.domain,
        result.status,
        result.query,
        result.googleSearchUrl,
        link?.url || "",
        link?.noticeId || "",
        (result.noticeSnippets || []).join(" | "),
        result.resultStats || "",
        result.error || ""
      ]);
    }
  }

  await fs.writeFile(filePath, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`, "utf8");
  return filePath;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
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

function unique(values) {
  return Array.from(new Set(values));
}

function decodeLoose(value) {
  let output = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(output);
      if (decoded === output) break;
      output = decoded;
    } catch {
      break;
    }
  }
  return output;
}

function cleanSerpError(error) {
  return String(error?.message || error || "Unknown error.")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
