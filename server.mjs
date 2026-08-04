import http from "node:http";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDomain,
  addDomains,
  ensureDataFiles,
  getPublicState,
  replaceDomains,
  removeDomain,
  saveDomainCase,
  saveApifyToken,
  saveConfigPatch,
  saveLumenClaimNotice,
  saveLumenToken
} from "./lib/store.mjs";
import { runPortfolioCheck } from "./lib/lumen.mjs";
import { runLumenClaimsQueueScan } from "./lib/lumen-claims.mjs";
import { runSerpLumenScan } from "./lib/serp-lumen.mjs";
import { exportReportedUrls, runUrlDeepScan } from "./lib/url-audit.mjs";

const SERVER_FILE = fileURLToPath(import.meta.url);
const ROOT_DIR = path.dirname(SERVER_FILE);
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PORT = Number(process.env.PORT || 4177);
const HOST = process.env.HOST || "0.0.0.0";
const BASIC_AUTH_USER = String(process.env.BASIC_AUTH_USER || "").trim();
const BASIC_AUTH_PASS = String(process.env.BASIC_AUTH_PASS || "").trim();

let activeRun = null;
let activeRunStatus = {
  running: false
};
let activeUrlAudit = null;
let activeUrlAuditStatus = {
  running: false
};
let activeSerpAudit = null;
let activeSerpAuditStatus = {
  running: false
};
let activeLumenClaimsScan = null;
let activeLumenClaimsStatus = {
  running: false
};

await ensureDataFiles();

export async function handleRequest(request, response) {
  try {
    if (!isAuthorized(request)) {
      response.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="DMCA Cumulus"'
      });
      response.end("Authentication required");
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname.startsWith("/api/")) {
      await routeApi(request, response, url);
      return;
    }

    await routeStatic(response, url);
  } catch (error) {
    sendJson(response, 500, {
      error: error.message || "Unexpected server error."
    });
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

if (isCliEntrypoint()) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
    console.log(`Copyright Portfolio Monitor running at http://${displayHost}:${PORT}`);
  });

  setInterval(() => {
    checkSchedule().catch((error) => {
      console.error("Scheduled check failed:", error.message);
    });
  }, 30000);
}

async function routeApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") {
    const state = await getPublicState();
    sendJson(response, 200, {
      ...state,
      serverTime: new Date().toISOString(),
      scheduler: {
        running: Boolean(activeRun),
        nextRunAt: computeNextRunAt(state.config)
      },
      runStatus: activeRunStatus || {
        running: false
      },
      urlAuditStatus: activeUrlAuditStatus || {
        running: false
      },
      serpAuditStatus: activeSerpAuditStatus || {
        running: false
      },
      lumenClaimsStatus: activeLumenClaimsStatus || {
        running: false
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/check") {
    if (activeRun) {
      sendJson(response, 409, { error: "A check is already running." });
      return;
    }

    const body = await readJsonBody(request);
    const runStatus = startRun({
      source: body.source || "manual",
      domains: body.domains
    });
    sendJson(response, 202, { runStatus });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/url-audit") {
    if (activeUrlAudit) {
      sendJson(response, 409, { error: "A URL scan is already running." });
      return;
    }

    const body = await readJsonBody(request);
    const urlAuditStatus = startUrlAudit({
      source: body.source || "manual",
      domains: body.domains,
      maxUrlsPerDomain: body.maxUrlsPerDomain
    });
    sendJson(response, 202, { urlAuditStatus });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/serp-audit") {
    if (activeSerpAudit) {
      sendJson(response, 409, { error: "A Google SERP Lumen scan is already running." });
      return;
    }

    const body = await readJsonBody(request);
    const serpAuditStatus = startSerpAudit({
      source: body.source || "manual",
      domains: body.domains
    });
    sendJson(response, 202, { serpAuditStatus });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/lumen-claims/scan") {
    if (activeLumenClaimsScan) {
      sendJson(response, 409, { error: "A Lumen claims queue scan is already running." });
      return;
    }

    const body = await readJsonBody(request);
    const lumenClaimsStatus = startLumenClaimsScan({
      source: body.source || "manual",
      domains: body.domains,
      limit: body.limit,
      maxRequestsPerDomain: body.maxRequestsPerDomain
    });
    sendJson(response, 202, { lumenClaimsStatus });
    return;
  }

  if ((request.method === "PUT" || request.method === "PATCH") && url.pathname.startsWith("/api/lumen-claims/")) {
    const noticeId = decodeURIComponent(url.pathname.replace("/api/lumen-claims/", ""));
    const body = await readJsonBody(request);
    const notice = await saveLumenClaimNotice(noticeId, body);
    sendJson(response, 200, { notice });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/url-export") {
    const body = await readJsonBody(request);
    const exportResult = await exportReportedUrls({
      domains: body.domains,
      maxUrlsPerDomain: body.maxUrlsPerDomain
    });
    sendJson(response, 200, { export: exportResult });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/domains") {
    const body = await readJsonBody(request);
    const portfolio = body.replace
      ? await replaceDomains(Array.isArray(body.domains) ? body.domains : [body.domain])
      : Array.isArray(body.domains)
      ? await addDomains(body.domains)
      : await addDomain(body.domain);
    sendJson(response, 200, { portfolio });
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/domains/")) {
    const domain = decodeURIComponent(url.pathname.replace("/api/domains/", ""));
    const portfolio = await removeDomain(domain);
    sendJson(response, 200, { portfolio });
    return;
  }

  if ((request.method === "PUT" || request.method === "PATCH") && url.pathname.startsWith("/api/cases/")) {
    const domain = decodeURIComponent(url.pathname.replace("/api/cases/", ""));
    const body = await readJsonBody(request);
    const caseEntry = await saveDomainCase(domain, body);
    sendJson(response, 200, { case: caseEntry });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    const config = await saveConfigPatch(body);
    sendJson(response, 200, { config });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/token") {
    const body = await readJsonBody(request);
    const result = await saveLumenToken(body.token);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/apify-token") {
    const body = await readJsonBody(request);
    const result = await saveApifyToken(body.token);
    sendJson(response, 200, result);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function routeStatic(response, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store"
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

async function checkSchedule() {
  if (activeRun || activeLumenClaimsScan) return;

  const state = await getPublicState();
  const config = state.config;
  if (!config.scheduleEnabled || !isScheduleDue(config)) return;

  startRun({ source: "scheduled" });
  await activeRun;

  if (!activeLumenClaimsScan) {
    startLumenClaimsScan({ source: "scheduled", limit: 0 });
    await activeLumenClaimsScan;
  }
}

function startRun(options) {
  activeRunStatus = {
    running: true,
    phase: "queued",
    source: options.source,
    checked: 0,
    totalDomains: 0,
    currentDomain: null,
    startedAt: new Date().toISOString()
  };

  activeRun = runPortfolioCheck({
    ...options,
    onProgress(progress) {
      activeRunStatus = {
        ...activeRunStatus,
        ...progress,
        running: progress.phase !== "finished",
        updatedAt: new Date().toISOString()
      };
    }
  })
    .then((run) => {
      activeRunStatus = {
        ...activeRunStatus,
        running: false,
        phase: "finished",
        checked: run.totalDomains,
        totalDomains: run.totalDomains,
        currentDomain: null,
        runId: run.id,
        status: run.status,
        finishedAt: run.finishedAt,
        updatedAt: new Date().toISOString()
      };
      return run;
    })
    .catch((error) => {
      console.error("Portfolio check failed:", error.message);
      activeRunStatus = {
        ...activeRunStatus,
        running: false,
        phase: "failed",
        error: error.message,
        updatedAt: new Date().toISOString()
      };
      return null;
    })
    .finally(() => {
      activeRun = null;
    });

  return activeRunStatus;
}

function startUrlAudit(options) {
  activeUrlAuditStatus = {
    running: true,
    phase: "queued",
    source: options.source,
    checkedDomains: 0,
    totalDomains: 0,
    checkedUrls: 0,
    totalUrls: 0,
    currentDomain: null,
    currentUrl: null,
    startedAt: new Date().toISOString()
  };

  activeUrlAudit = runUrlDeepScan({
    ...options,
    onProgress(progress) {
      activeUrlAuditStatus = {
        ...activeUrlAuditStatus,
        ...progress,
        running: progress.phase !== "finished",
        updatedAt: new Date().toISOString()
      };
    }
  })
    .then((run) => {
      activeUrlAuditStatus = {
        ...activeUrlAuditStatus,
        running: false,
        phase: "finished",
        checkedDomains: run.checkedDomains,
        totalDomains: run.totalDomains,
        checkedUrls: run.totalUrls,
        totalUrls: run.totalUrls,
        currentDomain: null,
        currentUrl: null,
        runId: run.id,
        status: run.status,
        finishedAt: run.finishedAt,
        updatedAt: new Date().toISOString()
      };
      return run;
    })
    .catch((error) => {
      console.error("URL scan failed:", error.message);
      activeUrlAuditStatus = {
        ...activeUrlAuditStatus,
        running: false,
        phase: "failed",
        error: error.message,
        updatedAt: new Date().toISOString()
      };
      return null;
    })
    .finally(() => {
      activeUrlAudit = null;
    });

  return activeUrlAuditStatus;
}

function startSerpAudit(options) {
  activeSerpAuditStatus = {
    running: true,
    phase: "queued",
    source: options.source,
    checkedDomains: 0,
    totalDomains: 0,
    currentDomain: null,
    startedAt: new Date().toISOString()
  };

  activeSerpAudit = runSerpLumenScan({
    ...options,
    onProgress(progress) {
      activeSerpAuditStatus = {
        ...activeSerpAuditStatus,
        ...progress,
        running: progress.phase !== "finished",
        updatedAt: new Date().toISOString()
      };
    }
  })
    .then((run) => {
      activeSerpAuditStatus = {
        ...activeSerpAuditStatus,
        running: false,
        phase: "finished",
        checkedDomains: run.checkedDomains,
        totalDomains: run.totalDomains,
        currentDomain: null,
        runId: run.id,
        status: run.status,
        finishedAt: run.finishedAt,
        updatedAt: new Date().toISOString()
      };
      return run;
    })
    .catch((error) => {
      console.error("Google SERP Lumen scan failed:", error.message);
      activeSerpAuditStatus = {
        ...activeSerpAuditStatus,
        running: false,
        phase: "failed",
        error: error.message,
        updatedAt: new Date().toISOString()
      };
      return null;
    })
    .finally(() => {
      activeSerpAudit = null;
    });

  return activeSerpAuditStatus;
}

function startLumenClaimsScan(options) {
  activeLumenClaimsStatus = {
    running: true,
    phase: "queued",
    source: options.source,
    checkedDomains: 0,
    totalDomains: 0,
    noticeCount: 0,
    newNoticeCount: 0,
    cachedRequestCount: 0,
    refreshedRequestCount: 0,
    currentDomain: null,
    currentRequestId: null,
    startedAt: new Date().toISOString()
  };

  activeLumenClaimsScan = runLumenClaimsQueueScan({
    ...options,
    onProgress(progress) {
      activeLumenClaimsStatus = {
        ...activeLumenClaimsStatus,
        ...progress,
        running: progress.phase !== "finished",
        updatedAt: new Date().toISOString()
      };
    }
  })
    .then((run) => {
      activeLumenClaimsStatus = {
        ...activeLumenClaimsStatus,
        running: false,
        phase: "finished",
        checkedDomains: run.checkedDomains,
        totalDomains: run.totalDomains,
        noticeCount: run.noticeCount,
        newNoticeCount: run.newNoticeCount,
        cachedRequestCount: run.cachedRequestCount,
        refreshedRequestCount: run.refreshedRequestCount,
        currentDomain: null,
        currentRequestId: null,
        runId: run.id,
        status: run.status,
        finishedAt: run.finishedAt,
        updatedAt: new Date().toISOString()
      };
      return run;
    })
    .catch((error) => {
      console.error("Lumen claims queue scan failed:", error.message);
      activeLumenClaimsStatus = {
        ...activeLumenClaimsStatus,
        running: false,
        phase: "failed",
        error: error.message,
        updatedAt: new Date().toISOString()
      };
      return null;
    })
    .finally(() => {
      activeLumenClaimsScan = null;
    });

  return activeLumenClaimsStatus;
}

function isScheduleDue(config) {
  const [hour, minute] = config.dailyAt.split(":").map(Number);
  const now = new Date();
  const dateKey = localDateKey(now);
  if (config.lastScheduledDate === dateKey) return false;

  const dueAt = new Date(now);
  dueAt.setHours(hour, minute, 0, 0);
  return now >= dueAt;
}

function computeNextRunAt(config) {
  if (!config.scheduleEnabled) return null;

  const [hour, minute] = config.dailyAt.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (now >= next || config.lastScheduledDate === localDateKey(now)) {
    next.setDate(next.getDate() + 1);
  }

  return next.toISOString();
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isCliEntrypoint() {
  return process.argv[1] && path.resolve(process.argv[1]) === SERVER_FILE;
}

function isAuthorized(request) {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return true;

  const header = request.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;

  let credentials = "";
  try {
    credentials = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }

  const separatorIndex = credentials.indexOf(":");
  if (separatorIndex === -1) return false;

  const username = credentials.slice(0, separatorIndex);
  const password = credentials.slice(separatorIndex + 1);
  return safeEqual(username, BASIC_AUTH_USER) && safeEqual(password, BASIC_AUTH_PASS);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) {
      throw new Error("Request body is too large.");
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(text);
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml"
    }[extension] || "application/octet-stream"
  );
}
