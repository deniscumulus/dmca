const elements = {
  siteCountChip: document.querySelector("#siteCountChip"),
  claimCountChip: document.querySelector("#claimCountChip"),
  claimedUrlCountChip: document.querySelector("#claimedUrlCountChip"),
  reviewCountChip: document.querySelector("#reviewCountChip"),
  submittedCountChip: document.querySelector("#submittedCountChip"),
  resolvedCountChip: document.querySelector("#resolvedCountChip"),
  domainCount: document.querySelector("#domainCount"),
  domainForm: document.querySelector("#domainForm"),
  domainInput: document.querySelector("#domainInput"),
  bulkForm: document.querySelector("#bulkForm"),
  bulkInput: document.querySelector("#bulkInput"),
  replacePortfolio: document.querySelector("#replacePortfolio"),
  domainList: document.querySelector("#domainList"),
  scanClaimsButton: document.querySelector("#scanClaimsButton"),
  claimSummary: document.querySelector("#claimSummary"),
  statusFilter: document.querySelector("#statusFilter"),
  claimSearch: document.querySelector("#claimSearch"),
  claimsList: document.querySelector("#claimsList"),
  toast: document.querySelector("#toast")
};

const CLAIM_STATUS_META = {
  to_review: { label: "To review", className: "to_review" },
  claim_submitted: { label: "Claim submitted", className: "claim_submitted" },
  resolved: { label: "Resolved", className: "resolved" }
};

const CLAIM_STATUS_ORDER = ["to_review", "claim_submitted", "resolved"];
const LEGACY_CLAIM_STATUS_MAP = {
  access_requested: "claim_submitted",
  full_link_received: "claim_submitted",
  urls_extracted: "claim_submitted",
  ignored: "to_review"
};

let state = null;
let toastTimer = null;
let refreshTimer = null;

init();

async function init() {
  bindEvents();
  await refreshState();
  refreshTimer = setInterval(() => {
    if (document.activeElement?.matches("input, textarea, select")) return;
    refreshState().catch(() => {});
  }, 5000);
}

function bindEvents() {
  elements.domainForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const domains = splitDomains(elements.domainInput.value);
    if (domains.length === 0) return;

    await api("/api/domains", {
      method: "POST",
      body: { domains }
    });
    elements.domainInput.value = "";
    await refreshState();
    showToast(domains.length === 1 ? "Site added." : "Sites added.");
  });

  elements.bulkForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const domains = splitDomains(elements.bulkInput.value);
    if (domains.length === 0) return;
    const replace = elements.replacePortfolio.checked;

    await api("/api/domains", {
      method: "POST",
      body: {
        domains,
        replace
      }
    });
    elements.bulkInput.value = "";
    elements.replacePortfolio.checked = false;
    await refreshState();
    showToast(replace ? "Portfolio replaced." : `${domains.length} sites imported.`);
  });

  elements.domainList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-domain]");
    if (!button) return;

    await api(`/api/domains/${encodeURIComponent(button.dataset.removeDomain)}`, {
      method: "DELETE"
    });
    await refreshState();
    showToast("Site removed.");
  });

  elements.scanClaimsButton.addEventListener("click", async () => {
    elements.scanClaimsButton.disabled = true;
    elements.scanClaimsButton.textContent = "Starting...";

    try {
      await api("/api/lumen-claims/scan", {
        method: "POST",
        body: { source: "manual", limit: 0 }
      });
      await refreshState();
      showToast("Claims queue scan started.");
    } catch (error) {
      showToast(error.message);
      await refreshState();
    }
  });

  elements.statusFilter.addEventListener("change", renderClaims);
  elements.claimSearch.addEventListener("input", renderClaims);

  elements.claimsList.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-claim-status]");
    if (!select) return;
    await saveClaimStatus(select.dataset.claimStatus, select.value);
  });
}

async function refreshState() {
  state = await api("/api/state");
  render();
}

function render() {
  const portfolio = state.portfolio || { domains: [] };
  const claims = state.lumenClaims || { notices: {}, runs: [] };
  const status = state.lumenClaimsStatus || { running: false };
  const metrics = summarizeClaims(claims);

  elements.siteCountChip.textContent = `${formatNumber(portfolio.domains.length)} portfolio sites`;
  elements.claimCountChip.textContent = `${formatNumber(metrics.claimedDomains)} claimed domains`;
  elements.claimedUrlCountChip.textContent = `${formatNumber(metrics.claimedUrls)} claimed URLs`;
  elements.reviewCountChip.textContent = `${formatNumber(metrics.toReview)} to review`;
  elements.submittedCountChip.textContent = `${formatNumber(metrics.claimSubmitted)} claim submitted`;
  elements.resolvedCountChip.textContent = `${formatNumber(metrics.resolved)} resolved`;
  elements.reviewCountChip.className = `chip ${metrics.toReview > 0 ? "warn" : "ok"}`;
  elements.submittedCountChip.className = `chip ${metrics.claimSubmitted > 0 ? "submitted" : ""}`;
  elements.resolvedCountChip.className = `chip ${metrics.resolved > 0 ? "ok" : ""}`;
  elements.domainCount.textContent = formatNumber(portfolio.domains.length);

  elements.scanClaimsButton.disabled = Boolean(status.running);
  const scanLabel = status.stage === "portfolio" ? "Checking portfolio" : "Scanning claims";
  elements.scanClaimsButton.textContent = status.running
    ? `${scanLabel} ${status.checkedDomains || 0}/${status.totalDomains || 0}`
    : "Scan all claims";

  renderDomains(portfolio.domains);
  renderClaimSummary(claims, status);
  renderClaims();
}

function renderDomains(domains) {
  if (!domains.length) {
    elements.domainList.innerHTML = emptyState("No sites yet.");
    return;
  }

  elements.domainList.innerHTML = domains
    .map(
      (domain) => `
        <div class="domain-item">
          <span class="domain-name">${escapeHtml(domain)}</span>
          <button class="remove-button" type="button" data-remove-domain="${escapeAttribute(domain)}" aria-label="Remove ${escapeAttribute(domain)}">×</button>
        </div>
      `
    )
    .join("");
}

function renderClaimSummary(claims, status) {
  if (status.running) {
    const scanLabel = status.stage === "portfolio" ? "Checking portfolio" : "Scanning claims";
    const domain = status.currentDomain ? ` · ${escapeHtml(status.currentDomain)}` : "";
    const request = status.currentRequestId ? ` · request ${escapeHtml(status.currentRequestId)}` : "";
    elements.claimSummary.innerHTML = `
      <span class="tracking-chip in_progress">${escapeHtml(scanLabel)} <strong>${formatNumber(status.checkedDomains || 0)}/${formatNumber(status.totalDomains || 0)}</strong></span>
      <span class="tracking-chip detected">Notices <strong>${formatNumber(status.noticeCount || 0)}</strong></span>
      <span class="tracking-chip claim_submitted">New <strong>${formatNumber(status.newNoticeCount || 0)}</strong></span>
      <span class="summary-text">${domain}${request}</span>
    `;
    return;
  }

  const latestRun = claims.runs?.[0] || null;
  if (!latestRun) {
    elements.claimSummary.innerHTML = emptyState("No claims queue yet.");
    return;
  }

  const metrics = summarizeClaims(claims);
  elements.claimSummary.innerHTML = `
    <span class="tracking-chip detected">Claimed domains <strong>${formatNumber(metrics.claimedDomains)}</strong></span>
    <span class="tracking-chip detected">Claimed URLs <strong>${formatNumber(metrics.claimedUrls)}</strong></span>
    <span class="tracking-chip to_review">To review <strong>${formatNumber(metrics.toReview)}</strong></span>
    <span class="tracking-chip claim_submitted">Claim submitted <strong>${formatNumber(metrics.claimSubmitted)}</strong></span>
    <span class="tracking-chip resolved">Resolved <strong>${formatNumber(metrics.resolved)}</strong></span>
  `;
}

function renderClaims() {
  const claims = state?.lumenClaims || { notices: {}, runs: [] };
  const statusFilter = elements.statusFilter.value;
  const search = elements.claimSearch.value.trim().toLowerCase();

  const notices = getCurrentClaimNotices(claims)
    .filter((notice) => {
      const reviewStatus = getClaimReviewStatus(notice);
      if (statusFilter !== "all" && reviewStatus !== statusFilter) return false;
      if (!search) return true;
      return [notice.domain, notice.noticeId, notice.requestId, notice.copyrightOwner, notice.reportingOrganization]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .sort(sortClaims);

  if (!notices.length) {
    elements.claimsList.innerHTML = emptyState("No claims match this view.");
    return;
  }

  elements.claimsList.innerHTML = notices.map(renderClaimCard).join("");
}

function renderClaimCard(notice) {
  const claimKey = getClaimKey(notice);
  const reviewStatus = getClaimReviewStatus(notice);
  const statusMeta = getClaimStatusMeta(reviewStatus);
  const targetCount = Number(notice.targetDomainUrls || 0);

  return `
    <article class="claim-card status-${escapeAttribute(statusMeta.className)}">
      <div class="claim-head">
        <div>
          <h3>${escapeHtml(notice.domain)}</h3>
          <div class="history-meta">
            Request ${escapeHtml(notice.requestId || "-")} · Notice ${escapeHtml(notice.noticeId || "-")} · ${escapeHtml(notice.requestDate || "no date")}
          </div>
        </div>
        <label class="status-select">
          <span>Status</span>
          <select data-claim-status="${escapeAttribute(claimKey)}" aria-label="Claim status for ${escapeAttribute(notice.noticeId || notice.requestId || claimKey)}">
            ${renderClaimStatusOptions(reviewStatus)}
          </select>
        </label>
      </div>

      <div class="claim-metrics">
        <span>Claimed URLs <strong>${formatNumber(targetCount)}</strong></span>
        <span class="status-pill ${escapeAttribute(statusMeta.className)}">${escapeHtml(statusMeta.label)}</span>
      </div>

      <div class="claim-parties">
        ${escapeHtml([notice.copyrightOwner, notice.reportingOrganization].filter(Boolean).join(" · ") || "No sender data")}
      </div>

      <div class="notice-actions">
        ${notice.requestAccessUrl ? `<a href="${escapeAttribute(notice.requestAccessUrl)}" target="_blank" rel="noreferrer">Request full URLs</a>` : ""}
        ${notice.lumenUrl ? `<a href="${escapeAttribute(notice.lumenUrl)}" target="_blank" rel="noreferrer">Lumen notice</a>` : ""}
        ${notice.googleRequestUrl ? `<a href="${escapeAttribute(notice.googleRequestUrl)}" target="_blank" rel="noreferrer">Google request</a>` : ""}
      </div>
    </article>
  `;
}

function renderClaimStatusOptions(activeStatus) {
  return CLAIM_STATUS_ORDER.map((status) => {
    const meta = getClaimStatusMeta(status);
    return `<option value="${escapeAttribute(status)}"${status === activeStatus ? " selected" : ""}>${escapeHtml(meta.label)}</option>`;
  }).join("");
}

async function saveClaimStatus(noticeId, reviewStatus) {
  updateLocalClaimStatus(noticeId, reviewStatus);
  renderClaims();

  try {
    await api(`/api/lumen-claims/${encodeURIComponent(noticeId)}`, {
      method: "PUT",
      body: { reviewStatus }
    });
    await refreshState();
    showToast("Claim status saved.");
  } catch (error) {
    showToast(error.message);
    await refreshState();
  }
}

function updateLocalClaimStatus(noticeId, reviewStatus) {
  if (state?.lumenClaims?.notices?.[noticeId]) {
    state.lumenClaims.notices[noticeId].reviewStatus = reviewStatus;
  }
}

function sortClaims(left, right) {
  const leftStatus = CLAIM_STATUS_ORDER.indexOf(getClaimReviewStatus(left));
  const rightStatus = CLAIM_STATUS_ORDER.indexOf(getClaimReviewStatus(right));
  return (
    leftStatus - rightStatus ||
    Number(right.targetDomainUrls || 0) - Number(left.targetDomainUrls || 0) ||
    String(right.firstSeenAt || "").localeCompare(String(left.firstSeenAt || "")) ||
    String(left.domain || "").localeCompare(String(right.domain || ""))
  );
}

function getClaimReviewStatus(notice) {
  const status = String(notice?.reviewStatus || "to_review");
  const normalized = LEGACY_CLAIM_STATUS_MAP[status] || status;
  return CLAIM_STATUS_META[normalized] ? normalized : "to_review";
}

function getClaimStatusMeta(status) {
  return CLAIM_STATUS_META[status] || CLAIM_STATUS_META.to_review;
}

function getCurrentClaimNotices(claims) {
  const latestRun = claims?.runs?.[0] || null;
  const runNoticeIds = new Set((latestRun?.domains || []).flatMap((domain) => domain.notices || []));
  return Object.values(claims?.notices || {}).filter(
    (notice) => runNoticeIds.size === 0 || runNoticeIds.has(getClaimKey(notice)) || runNoticeIds.has(notice.noticeId)
  );
}

function getClaimKey(notice) {
  return String(notice?.claimKey || notice?.noticeId || notice?.requestId || "").trim();
}

function summarizeClaims(claims) {
  const notices = getCurrentClaimNotices(claims);
  const activeNotices = notices.filter((notice) => getClaimReviewStatus(notice) !== "resolved");
  const metrics = {
    noticeCount: notices.length,
    claimedDomains: new Set(activeNotices.map((notice) => notice.domain).filter(Boolean)).size,
    claimedUrls: activeNotices.reduce((total, notice) => total + Number(notice.targetDomainUrls || 0), 0),
    toReview: 0,
    claimSubmitted: 0,
    resolved: 0
  };

  for (const notice of notices) {
    const status = getClaimReviewStatus(notice);
    if (status === "claim_submitted") metrics.claimSubmitted += 1;
    else if (status === "resolved") metrics.resolved += 1;
    else metrics.toReview += 1;
  }

  return metrics;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2200);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function splitDomains(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}
