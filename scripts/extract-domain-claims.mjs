import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { normalizeDomain } from "../lib/store.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_DIR = path.join(ROOT_DIR, "data", "exports");
const GOOGLE_BASE_URL = "https://transparencyreport.google.com";
const DEFAULT_USER_AGENT =
  process.env.LUMEN_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PortfolioCopyrightMonitor/0.1";

const domain = normalizeDomain(process.argv[2]);
if (!domain) {
  console.error("Usage: node scripts/extract-domain-claims.mjs example.com");
  process.exit(1);
}

const lumenAttemptLimit = Math.max(0, Number(process.env.LUMEN_ATTEMPTS || 1));
let lumenAttempts = 0;

const browser = await chromium.launch({
  headless: true,
  executablePath: findLocalBrowserExecutable()
});

try {
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1360, height: 960 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  const summary = await extractDomainSummary(page, domain);
  console.error(`Summary: ${summary.requestedUrls ?? 0} requested URLs for ${domain}.`);

  const requestRows = await extractRequestRows(page, domain);
  console.error(`Found ${requestRows.length} Google request rows.`);

  const enrichedRows = [];
  const exactUrls = [];

  for (const row of requestRows) {
    console.error(`Checking request ${row.requestId}...`);
    const details = await extractRequestDetails(page, row.requestId, domain, {
      tryLumen: lumenAttempts < lumenAttemptLimit
    });
    if (details.lumenAttempted) lumenAttempts += 1;
    enrichedRows.push({ ...row, ...details });
    exactUrls.push(
      ...details.urls.map((url) => ({
        domain,
        requestId: row.requestId,
        requestDate: row.date,
        status: details.exactUrlStatus,
        url,
        lumenUrl: details.lumenUrl || ""
      }))
    );
    await page.waitForTimeout(700);
  }

  await mkdir(EXPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const requestCsv = rowsToCsv([
    [
      "domain",
      "request_id",
      "date",
      "copyright_owner",
      "reporting_organization",
      "request_urls",
      "target_domain_urls",
      "target_domain_urls_not_delisted",
      "request_removed",
      "request_not_in_index",
      "request_no_action_taken",
      "request_pending",
      "request_duplicate",
      "percent_delisted",
      "percent_not_in_index",
      "google_request_url",
      "lumen_url",
      "exact_url_status",
      "exact_url_count",
      "note"
    ],
    ...enrichedRows.map((row) => [
      domain,
      row.requestId,
      row.date,
      row.copyrightOwner,
      row.reportingOrganization,
      row.requestUrls,
      row.targetDomainUrls,
      row.targetDomainUrlsNotDelisted,
      row.requestOutcomeCounts.removed,
      row.requestOutcomeCounts.notInIndex,
      row.requestOutcomeCounts.noActionTaken,
      row.requestOutcomeCounts.pending,
      row.requestOutcomeCounts.duplicate,
      row.percentDelisted,
      row.percentNotInIndex,
      row.googleRequestUrl,
      row.lumenUrl,
      row.exactUrlStatus,
      row.urls.length,
      row.note
    ])
  ]);

  const requestPath = path.join(EXPORT_DIR, `${domain}-claim-requests-${stamp}.csv`);
  await writeFile(requestPath, requestCsv);

  let urlsPath = "";
  if (exactUrls.length > 0) {
    urlsPath = path.join(EXPORT_DIR, `${domain}-exact-claim-urls-${stamp}.csv`);
    await writeFile(
      urlsPath,
      rowsToCsv([
        ["domain", "request_id", "request_date", "status", "url", "lumen_url"],
        ...exactUrls.map((row) => [row.domain, row.requestId, row.requestDate, row.status, row.url, row.lumenUrl])
      ])
    );
  }

  console.log(
    JSON.stringify(
      {
        domain,
        summary,
        requestCount: enrichedRows.length,
        requestPath,
        urlsPath,
        exactUrlCount: exactUrls.length,
        blockedOrHiddenCount: enrichedRows.filter((row) => row.exactUrlStatus !== "extracted").length,
        requests: enrichedRows
      },
      null,
      2
    )
  );
} finally {
  await browser.close().catch(() => {});
}

async function extractDomainSummary(page, domain) {
  const url = `${GOOGLE_BASE_URL}/copyright/domains/${encodeURIComponent(domain)}?hl=en`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);

  return page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, " ").trim();
    const requested = text.match(/This domain had\s+([\d,]+)\s+URLs?/i);
    const outcomeCounts = extractOutcomeCounts();

    return {
      requestedUrls: numberFromMatch(requested),
      removed: outcomeCounts.removed,
      notInIndex: outcomeCounts.notInIndex,
      noActionTaken: outcomeCounts.noActionTaken,
      pending: outcomeCounts.pending,
      duplicate: outcomeCounts.duplicate,
      pageTextSample: text.slice(0, 500)
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

    function numberFromMatch(match) {
      return match ? Number(match[1].replace(/,/g, "")) : null;
    }
  });
}

async function extractRequestRows(page, domain) {
  const url = `${GOOGLE_BASE_URL}/copyright/domains/${encodeURIComponent(domain)}?hl=en`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);

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
    await page.waitForTimeout(1800);
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

async function extractRequestDetails(page, requestId, domain, options = {}) {
  const googleRequestUrl = `${GOOGLE_BASE_URL}/copyright/request/${requestId}?hl=en`;
  await page.goto(googleRequestUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);

  const details = await page.evaluate((targetDomain) => {
    const text = document.body.innerText.replace(/\s+/g, " ").trim();
    const targetDomainRow = findTargetDomainRow(targetDomain);
    const requestOutcomeCounts = extractOutcomeCounts();
    const lumenLink = Array.from(document.querySelectorAll("a[href]"))
      .map((link) => ({
        text: link.textContent.replace(/\s+/g, " ").trim(),
        href: new URL(link.getAttribute("href"), location.origin).toString()
      }))
      .find((link) => link.href.includes("lumendatabase.org/"));
    const urls = Array.from(
      new Set(
        Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi))
          .map((match) => match[0].replace(/[.,;]+$/, ""))
          .filter((url) => {
            try {
              return new URL(url).hostname.replace(/^www\./, "") === targetDomain.replace(/^www\./, "");
            } catch {
              return false;
            }
          })
      )
    );

    return {
      lumenUrl: lumenLink?.href || "",
      urls,
      targetDomainUrls: targetDomainRow?.requested ?? 0,
      targetDomainUrlsNotDelisted: targetDomainRow?.notDelisted ?? 0,
      requestOutcomeCounts,
      bodyMentionsAccessRequest: /request access|see full urls/i.test(text)
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

  if (details.urls.length > 0) {
    return {
      lumenUrl: details.lumenUrl,
      urls: details.urls,
      targetDomainUrls: details.targetDomainUrls,
      targetDomainUrlsNotDelisted: details.targetDomainUrlsNotDelisted,
      requestOutcomeCounts: details.requestOutcomeCounts,
      exactUrlStatus: "extracted",
      note: "Exact URLs were visible on the Google request page."
    };
  }

  if (!options.tryLumen) {
    return {
      lumenUrl: details.lumenUrl,
      urls: [],
      targetDomainUrls: details.targetDomainUrls,
      targetDomainUrlsNotDelisted: details.targetDomainUrlsNotDelisted,
      requestOutcomeCounts: details.requestOutcomeCounts,
      exactUrlStatus: details.lumenUrl ? "lumen_not_checked" : "hidden",
      lumenAttempted: false,
      note: details.lumenUrl
        ? "Lumen link was found, but this fast test did not open every Lumen page."
        : "No Lumen link was visible on the Google request page."
    };
  }

  const lumenAttempt = details.lumenUrl ? await tryExtractLumenUrls(page, details.lumenUrl, domain) : null;
  if (lumenAttempt?.urls?.length) {
    return {
      lumenUrl: details.lumenUrl,
      urls: lumenAttempt.urls,
      targetDomainUrls: details.targetDomainUrls,
      targetDomainUrlsNotDelisted: details.targetDomainUrlsNotDelisted,
      requestOutcomeCounts: details.requestOutcomeCounts,
      exactUrlStatus: "extracted",
      lumenAttempted: true,
      note: lumenAttempt.note
    };
  }

  return {
    lumenUrl: details.lumenUrl,
    urls: [],
    targetDomainUrls: details.targetDomainUrls,
    targetDomainUrlsNotDelisted: details.targetDomainUrlsNotDelisted,
    requestOutcomeCounts: details.requestOutcomeCounts,
    exactUrlStatus: lumenAttempt?.status || "hidden",
    lumenAttempted: Boolean(details.lumenUrl),
    note:
      lumenAttempt?.note ||
      (details.lumenUrl
        ? "Google links this request to Lumen, but exact URLs were not visible without Lumen access."
        : "No Lumen link was visible on the Google request page.")
  };
}

async function tryExtractLumenUrls(page, lumenUrl, domain) {
  try {
    await page.goto(lumenUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(1200);

    return page.evaluate((targetDomain) => {
      const text = document.body.innerText.replace(/\s+/g, " ").trim();
      const blocked = /too many requests|rate limit|429/i.test(text);
      const accessRequired = /request access|see full urls|click here to request access/i.test(text);
      const urls = Array.from(
        new Set(
          Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi))
            .map((match) => match[0].replace(/[.,;]+$/, ""))
            .filter((url) => {
              try {
                return new URL(url).hostname.replace(/^www\./, "") === targetDomain.replace(/^www\./, "");
              } catch {
                return false;
              }
            })
        )
      );

      if (urls.length > 0) {
        return { status: "extracted", urls, note: "Exact URLs were visible on Lumen." };
      }

      if (blocked) return { status: "blocked", urls: [], note: "Lumen blocked this browser session with a rate-limit page." };
      if (accessRequired) return { status: "access_required", urls: [], note: "Lumen hides exact URLs behind its full-URL access flow." };
      return { status: "hidden", urls: [], note: "Lumen page loaded, but exact URLs were not visible." };
    }, domain);
  } catch (error) {
    return {
      status: "blocked",
      urls: [],
      note: `Could not load Lumen page: ${String(error?.message || error).replace(/\s+/g, " ").slice(0, 160)}`
    };
  }
}

function numberFromText(value) {
  return Number(String(value || "0").replace(/[^\d]/g, "")) || 0;
}

function rowsToCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value) {
  const stringValue = value == null ? "" : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
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
