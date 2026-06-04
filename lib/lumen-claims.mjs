import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { maybeSendLumenClaimsNotification } from "./notify.mjs";
import { appendLumenClaimRun, DATA_DIR, loadHistory, loadLumenClaims, normalizeDomain } from "./store.mjs";

const GOOGLE_BASE_URL = "https://transparencyreport.google.com";
const DEFAULT_USER_AGENT =
  process.env.LUMEN_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PortfolioCopyrightMonitor/0.1";

export async function runLumenClaimsQueueScan(options = {}) {
  const startedAt = new Date().toISOString();
  const source = options.source || "manual";
  const [history, existingClaims] = await Promise.all([loadHistory(), loadLumenClaims()]);
  const domains = resolveDomains(options, history);
  const previousNoticeKeys = new Set(Object.keys(existingClaims.notices || {}));
  const maxRequestsPerDomain = Math.max(0, Number(options.maxRequestsPerDomain || 0));
  const domainResults = [];
  const notices = [];
  let browser = null;

  options.onProgress?.({
    phase: "started",
    totalDomains: domains.length,
    checkedDomains: 0,
    currentDomain: null,
    noticeCount: 0
  });

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      executablePath: findLocalBrowserExecutable()
    });
    const context = await browser.newContext({
      userAgent: DEFAULT_USER_AGENT,
      viewport: { width: 1360, height: 960 }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(options.timeoutMs || 45000));

    for (const [domainIndex, domain] of domains.entries()) {
      options.onProgress?.({
        phase: "domain",
        totalDomains: domains.length,
        checkedDomains: domainIndex,
        currentDomain: domain,
        noticeCount: notices.length
      });

      try {
        const summary = await extractDomainSummary(page, domain);
        let requestRows = await extractRequestRows(page, domain);
        const totalRequestRows = requestRows.length;
        if (maxRequestsPerDomain > 0) {
          requestRows = requestRows.slice(0, maxRequestsPerDomain);
        }

        const domainNotices = [];
        for (const [requestIndex, row] of requestRows.entries()) {
          options.onProgress?.({
            phase: "request",
            totalDomains: domains.length,
            checkedDomains: domainIndex,
            currentDomain: domain,
            currentRequestId: row.requestId,
            checkedRequests: requestIndex,
            totalRequests: requestRows.length,
            noticeCount: notices.length
          });

          const details = await extractRequestDetails(page, row.requestId, domain);
          const notice = normalizeNotice(domain, row, details);
          notice.isNew = !previousNoticeKeys.has(getNoticeKey(notice));
          domainNotices.push(notice);
          notices.push(notice);
          await page.waitForTimeout(Number(options.requestDelayMs || 650));
        }

        domainResults.push({
          domain,
          status: domainNotices.length > 0 ? "access_needed" : "no_lumen_notices",
          summary,
          totalRequestRows,
          scannedRequestRows: requestRows.length,
          noticeCount: domainNotices.length,
          targetDomainUrlCount: domainNotices.reduce(
            (sum, notice) => sum + Number(notice.targetDomainUrls || 0),
            0
          ),
          accessNeededCount: domainNotices.filter((notice) => notice.status === "access_needed").length,
          newNoticeCount: domainNotices.filter((notice) => notice.isNew).length,
          notices: domainNotices.map(getNoticeKey)
        });
      } catch (error) {
        domainResults.push({
          domain,
          status: "error",
          summary: null,
          totalRequestRows: 0,
          scannedRequestRows: 0,
          noticeCount: 0,
          targetDomainUrlCount: 0,
          accessNeededCount: 0,
          notices: [],
          error: cleanError(error)
        });
      }

      options.onProgress?.({
        phase: "domain_finished",
        totalDomains: domains.length,
        checkedDomains: domainIndex + 1,
        currentDomain: domain,
        noticeCount: notices.length
      });
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  const exportPath = await exportLumenClaimQueue(notices);
  const accessRequestQueue = buildAccessRequestQueue(notices, existingClaims);
  const accessRequestExportPath = await exportLumenAccessRequestQueue(accessRequestQueue);
  const totals = summarizeDomainResults(domainResults, notices);
  const newNotices = notices
    .filter((notice) => notice.isNew)
    .map((notice) => ({
      noticeId: notice.noticeId,
      domain: notice.domain,
      requestId: notice.requestId,
      requestDate: notice.requestDate,
      targetDomainUrls: notice.targetDomainUrls,
      lumenUrl: notice.lumenUrl,
      requestAccessUrl: notice.requestAccessUrl,
      googleRequestUrl: notice.googleRequestUrl
    }));
  const run = {
    id: crypto.randomUUID(),
    source,
    status:
      domains.length === 0
        ? "empty"
        : totals.errorCount > 0
          ? "error"
          : totals.noticeCount > 0
            ? "access_needed"
            : "clean",
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDomains: domains.length,
    checkedDomains: domainResults.length,
    noticeCount: totals.noticeCount,
    newNoticeCount: newNotices.length,
    newNotices,
    targetDomainUrlCount: totals.targetDomainUrlCount,
    accessNeededCount: totals.accessNeededCount,
    exactUrlCount: totals.exactUrlCount,
    errorCount: totals.errorCount,
    accessRequestQueue: {
      claimCount: accessRequestQueue.length,
      domainCount: new Set(accessRequestQueue.map((notice) => notice.domain).filter(Boolean)).size,
      claimedUrlCount: accessRequestQueue.reduce((sum, notice) => sum + Number(notice.targetDomainUrls || 0), 0),
      exportPath: accessRequestExportPath
    },
    exportPath,
    domains: domainResults
  };

  run.notification = await maybeSendLumenClaimsNotification(run);
  await appendLumenClaimRun(run, notices);

  options.onProgress?.({
    phase: "finished",
    totalDomains: domains.length,
    checkedDomains: domainResults.length,
    noticeCount: notices.length,
    runId: run.id,
    status: run.status
  });

  return {
    ...run,
    notices
  };
}

export function buildRequestAccessUrl(lumenUrl) {
  const noticeId = extractNoticeId(lumenUrl);
  return noticeId ? `https://lumendatabase.org/notices/${noticeId}/request_access` : "";
}

function resolveDomains(options, history) {
  if (Array.isArray(options.domains) && options.domains.length > 0) {
    const domains = unique(options.domains.map(normalizeDomain).filter(Boolean));
    const limit = normalizeLimit(options.limit, 0);
    return limit > 0 ? domains.slice(0, limit) : domains;
  }

  const sourceRun = (history.runs || []).find((run) =>
    (run.results || []).some((result) => Number(result.total || 0) > 0)
  );
  const limit = normalizeLimit(options.limit, 0);
  const domains = unique(
    (sourceRun?.results || [])
      .filter((result) => Number(result.total || 0) > 0)
      .sort((left, right) => Number(right.total || 0) - Number(left.total || 0))
      .map((result) => normalizeDomain(result.domain))
      .filter(Boolean)
  );
  return limit > 0 ? domains.slice(0, limit) : domains;
}

function normalizeLimit(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(0, Math.floor(limit));
}

async function extractDomainSummary(page, domain) {
  const url = `${GOOGLE_BASE_URL}/copyright/domains/${encodeURIComponent(domain)}?hl=en`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  return page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, " ").trim();
    const requested = text.match(/This domain had\s+([\d,]+)\s+URLs?/i);
    const outcomeCounts = extractOutcomeCounts();

    return {
      requestedUrls: requested ? Number(requested[1].replace(/,/g, "")) : null,
      ...outcomeCounts
    };

    function extractOutcomeCounts() {
      const counts = {
        removed: null,
        notInIndex: null,
        noActionTaken: null,
        pending: null,
        duplicate: null
      };
      const labels = new Map([
        ["removed", "removed"],
        ["not in index", "notInIndex"],
        ["no action taken", "noActionTaken"],
        ["pending", "pending"],
        ["duplicate", "duplicate"]
      ]);

      for (const tr of document.querySelectorAll("table tr")) {
        const cells = Array.from(tr.querySelectorAll("td,th")).map((cell) =>
          cell.textContent.replace(/\s+/g, " ").trim()
        );
        if (cells.length < 2) continue;
        const key = labels.get(cells[0].toLowerCase());
        if (!key) continue;
        counts[key] = Number(cells[1].replace(/[^\d]/g, "")) || 0;
      }

      return counts;
    }
  });
}

async function extractRequestRows(page, domain) {
  const url = `${GOOGLE_BASE_URL}/copyright/domains/${encodeURIComponent(domain)}?hl=en`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const rows = [];
  const seen = new Set();

  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const pageRows = await page.evaluate(() => {
      const table = document.querySelector("data-table#request_by_org table");
      if (!table) return [];

      return Array.from(table.querySelectorAll("tr"))
        .map((tr) => {
          const cells = Array.from(tr.querySelectorAll("td,th")).map((cell) =>
            cell.textContent.replace(/\s+/g, " ").trim()
          );
          const link = tr.querySelector('a[href*="/copyright/request/"]');
          const href = link ? new URL(link.getAttribute("href"), location.origin).toString() : "";
          const idMatch = href.match(/\/copyright\/request\/(\d+)/);

          return {
            cells,
            href,
            requestId: idMatch ? idMatch[1] : ""
          };
        })
        .filter((row) => row.requestId && row.cells.length >= 7);
    });

    for (const row of pageRows) {
      if (seen.has(row.requestId)) continue;
      seen.add(row.requestId);
      rows.push(normalizeRequestRow(row));
    }

    const clicked = await page.evaluate(() => {
      const table = document.querySelector("data-table#request_by_org");
      if (!table) return false;
      const next = Array.from(table.querySelectorAll("pagination-filter a.tr-action-text")).find((link) => {
        const text = link.textContent.replace(/\s+/g, " ").trim().toLowerCase();
        return text === "next" && !link.classList.contains("disabled") && link.getAttribute("aria-disabled") !== "true";
      });
      if (!next) return false;
      next.click();
      return true;
    });

    if (!clicked) break;
    await page.waitForTimeout(1600);
  }

  return rows;
}

function normalizeRequestRow(row) {
  const [requestId, date, copyrightOwner, reportingOrganization, requestUrls, delisted, notInIndex] = row.cells;
  return {
    requestId,
    date,
    copyrightOwner,
    reportingOrganization,
    requestUrls: numberFromText(requestUrls),
    percentDelisted: delisted,
    percentNotInIndex: notInIndex,
    googleRequestUrl: row.href
  };
}

async function extractRequestDetails(page, requestId, domain) {
  const googleRequestUrl = `${GOOGLE_BASE_URL}/copyright/request/${requestId}?hl=en`;
  await page.goto(googleRequestUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2200);

  return page.evaluate((targetDomain) => {
    const targetDomainRow = findTargetDomainRow(targetDomain);
    const requestOutcomeCounts = extractOutcomeCounts();
    const lumenLink = Array.from(document.querySelectorAll("a[href]"))
      .map((link) => ({
        text: link.textContent.replace(/\s+/g, " ").trim(),
        href: new URL(link.getAttribute("href"), location.origin).toString()
      }))
      .find((link) => link.href.includes("lumendatabase.org/"));

    return {
      lumenUrl: lumenLink?.href || "",
      targetDomainUrls: targetDomainRow?.requested ?? 0,
      targetDomainUrlsNotDelisted: targetDomainRow?.notDelisted ?? 0,
      requestOutcomeCounts
    };

    function findTargetDomainRow(rawDomain) {
      const normalizedTarget = normalizeHost(rawDomain);
      for (const tr of document.querySelectorAll("table tr")) {
        const cells = Array.from(tr.querySelectorAll("td,th")).map((cell) =>
          cell.textContent.replace(/\s+/g, " ").trim()
        );
        if (cells.length < 3 || normalizeHost(cells[0]) !== normalizedTarget) continue;
        return {
          requested: Number(cells[1].replace(/[^\d]/g, "")) || 0,
          notDelisted: Number(cells[2].replace(/[^\d]/g, "")) || 0
        };
      }
      return null;
    }

    function extractOutcomeCounts() {
      const counts = {
        removed: 0,
        notInIndex: 0,
        noActionTaken: 0,
        pending: 0,
        duplicate: 0
      };
      const labels = new Map([
        ["removed", "removed"],
        ["not in index", "notInIndex"],
        ["no action taken", "noActionTaken"],
        ["pending", "pending"],
        ["duplicate", "duplicate"]
      ]);

      for (const tr of document.querySelectorAll("table tr")) {
        const cells = Array.from(tr.querySelectorAll("td,th")).map((cell) =>
          cell.textContent.replace(/\s+/g, " ").trim()
        );
        if (cells.length < 2) continue;
        const key = labels.get(cells[0].toLowerCase());
        if (!key) continue;
        counts[key] = Number(cells[1].replace(/[^\d]/g, "")) || 0;
      }
      return counts;
    }

    function normalizeHost(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .split("/")[0]
        .split(":")[0]
        .replace(/^www\./, "")
        .replace(/\.$/, "");
    }
  }, domain);
}

function normalizeNotice(domain, row, details) {
  const noticeId = extractNoticeId(details.lumenUrl);
  const requestAccessUrl = details.lumenUrl ? buildRequestAccessUrl(details.lumenUrl) : "";
  const exactUrls = [];
  return {
    noticeId,
    domain,
    requestId: row.requestId,
    requestDate: row.date,
    copyrightOwner: row.copyrightOwner,
    reportingOrganization: row.reportingOrganization,
    requestUrls: row.requestUrls,
    percentDelisted: row.percentDelisted,
    percentNotInIndex: row.percentNotInIndex,
    googleRequestUrl: row.googleRequestUrl,
    lumenUrl: details.lumenUrl,
    requestAccessUrl,
    targetDomainUrls: details.targetDomainUrls,
    targetDomainUrlsNotDelisted: details.targetDomainUrlsNotDelisted,
    requestOutcomeCounts: details.requestOutcomeCounts,
    status: exactUrls.length > 0 ? "urls_extracted" : details.lumenUrl ? "access_needed" : "no_lumen_link",
    exactUrls,
    exactUrlCount: exactUrls.length,
    note: details.lumenUrl
      ? "Full claimed URLs require the per-notice Lumen request-access flow."
      : "No Lumen notice link was visible on the Google request page."
  };
}

async function exportLumenClaimQueue(notices) {
  const exportDir = path.join(DATA_DIR, "exports");
  await fs.mkdir(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(exportDir, `lumen-claims-queue-${timestamp}.csv`);
  const rows = [
    [
      "domain",
      "notice_id",
      "request_id",
      "request_date",
      "copyright_owner",
      "reporting_organization",
      "target_domain_urls",
      "target_domain_urls_not_delisted",
      "request_removed",
      "request_pending",
      "lumen_url",
      "request_access_url",
      "status",
      "exact_url_count",
      "note"
    ],
    ...notices.map((notice) => [
      notice.domain,
      notice.noticeId,
      notice.requestId,
      notice.requestDate,
      notice.copyrightOwner,
      notice.reportingOrganization,
      notice.targetDomainUrls,
      notice.targetDomainUrlsNotDelisted,
      notice.requestOutcomeCounts?.removed ?? "",
      notice.requestOutcomeCounts?.pending ?? "",
      notice.lumenUrl,
      notice.requestAccessUrl,
      notice.status,
      notice.exactUrlCount,
      notice.note
    ])
  ];
  await fs.writeFile(filePath, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`, "utf8");
  return filePath;
}

async function exportLumenAccessRequestQueue(notices) {
  const exportDir = path.join(DATA_DIR, "exports");
  await fs.mkdir(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(exportDir, `lumen-access-request-queue-${timestamp}.csv`);
  const rows = [
    [
      "domain",
      "claim_key",
      "notice_id",
      "request_id",
      "request_date",
      "claimed_urls",
      "request_access_url",
      "lumen_url",
      "google_request_url",
      "review_status"
    ],
    ...notices.map((notice) => [
      notice.domain,
      getNoticeKey(notice),
      notice.noticeId,
      notice.requestId,
      notice.requestDate,
      notice.targetDomainUrls,
      notice.requestAccessUrl,
      notice.lumenUrl,
      notice.googleRequestUrl,
      "to_review"
    ])
  ];
  await fs.writeFile(filePath, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`, "utf8");
  return filePath;
}

function buildAccessRequestQueue(notices, existingClaims) {
  return notices.filter((notice) => getExistingReviewStatus(existingClaims, notice) === "to_review");
}

function getExistingReviewStatus(existingClaims, notice) {
  const key = getNoticeKey(notice);
  const existing =
    existingClaims.notices?.[key] ||
    existingClaims.notices?.[notice.noticeId] ||
    Object.values(existingClaims.notices || {}).find(
      (item) => item?.noticeId && item.noticeId === notice.noticeId && item?.domain === notice.domain
    );
  return normalizeReviewStatus(existing?.reviewStatus);
}

function normalizeReviewStatus(value) {
  const status = String(value || "to_review");
  if (status === "resolved" || status === "claim_submitted") return status;
  if (["access_requested", "full_link_received", "urls_extracted"].includes(status)) return "claim_submitted";
  return "to_review";
}

function summarizeDomainResults(domainResults, notices) {
  return {
    noticeCount: notices.length,
    targetDomainUrlCount: notices.reduce((sum, notice) => sum + Number(notice.targetDomainUrls || 0), 0),
    accessNeededCount: notices.filter((notice) => notice.status === "access_needed").length,
    exactUrlCount: notices.reduce((sum, notice) => sum + Number(notice.exactUrlCount || 0), 0),
    errorCount: domainResults.filter((domain) => domain.status === "error").length
  };
}

function getNoticeKey(notice) {
  const domain = normalizeDomain(notice.domain || "");
  const id = String(notice.noticeId || notice.requestId || notice.lumenUrl || "").trim();
  return domain && id ? `${domain}::${id}` : id;
}

function extractNoticeId(lumenUrl) {
  const match = String(lumenUrl || "").match(/\/notices\/(\d+)/i);
  return match ? match[1] : "";
}

function numberFromText(value) {
  return Number(String(value || "0").replace(/[^\d]/g, "")) || 0;
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

function cleanError(error) {
  return String(error?.message || error || "Unknown error.")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
