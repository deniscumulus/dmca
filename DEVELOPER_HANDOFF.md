# DMCA Claims Queue - Developer Handoff

## Purpose

This local tool monitors a portfolio of domains and builds a manual review queue for DMCA/copyright claims. The current UI is intentionally simple and only contains:

- Portfolio: add, remove, or bulk import domains.
- Claims Queue: view Lumen notice candidates and manually mark their review status.

The app is written in English for the end user.

## Current Local URL

```bash
npm start
```

Then open:

```text
http://127.0.0.1:4177/
```

Node.js 20+ is required.

## Project Structure

```text
server.mjs                 HTTP server, static files, API routes, background scan state
public/index.html          Simplified UI shell
public/app.js              Frontend state, rendering, forms, status updates
public/app.css             Simplified two-panel layout and status highlighting
lib/store.mjs              JSON data store, config, portfolio, claims queue persistence
lib/lumen-claims.mjs       Google Transparency -> Lumen notice queue scanner
lib/lumen.mjs              Existing Google Transparency portfolio checker
lib/serp-lumen.mjs         Existing SERP/Lumen search helper
lib/url-audit.mjs          Existing sitemap/index audit helper
data/portfolio.json        Portfolio domain list
data/lumen-claims.json     Claims queue database
data/secrets.json          Local secrets, do not commit or expose
```

## Current Data Snapshot

At the time of this handoff:

- Portfolio contains 190 sites.
- The latest full Google Transparency scan checked all 190 portfolio sites.
- The latest full Claims Queue scan checked 73 claimed domains.
- Claims Queue contains 551 per-domain Lumen notice candidates.
- Current active claim metrics show 73 claimed domains and 997 claimed URLs after excluding notices marked `resolved`.
- Exact claimed URLs are not available yet because public Lumen pages hide full URL paths.

## Main API Routes

```text
GET    /api/state
POST   /api/domains
DELETE /api/domains/:domain
POST   /api/lumen-claims/scan
PUT    /api/lumen-claims/:noticeId
PATCH  /api/lumen-claims/:noticeId
```

Useful request examples:

```bash
curl -s http://127.0.0.1:4177/api/state
```

```bash
curl -s -X PUT http://127.0.0.1:4177/api/lumen-claims/NOTICE_ID \
  -H "Content-Type: application/json" \
  -d '{"reviewStatus":"claim_submitted"}'
```

## Claim Review Statuses

Manual claim statuses are stored on each notice as `reviewStatus`.

Each queue item is keyed by `claimKey`, currently `domain::noticeId` or `domain::requestId`. This is intentional because one Lumen notice can cover more than one portfolio domain, and those domain-specific rows must not collapse into one queue item.

Allowed values:

```text
to_review
claim_submitted
resolved
```

Default status is:

```text
to_review
```

The frontend highlights each claim card based on this manual status. The backend validates the allowed values in `lib/store.mjs`.

Top-level metrics:

- `claimed domains` counts unique domains that still have at least one non-resolved notice.
- `claimed URLs` sums `targetDomainUrls` only from non-resolved notices.
- When all notices for a domain are marked `resolved`, that domain and its active URL count are removed from the headline metrics.

Important distinction:

- `status` is the system/access state, for example `access_needed` or `urls_extracted`.
- `reviewStatus` is the user-facing manual workflow status.

## Lumen URL Limitation

Google Transparency Report can identify problematic domains and request rows, but it does not expose the exact affected URL paths.

Public Lumen notice pages usually show domain-level information and a prompt to request access for full URLs. The full URL extraction flow currently requires:

1. Open the notice's `request_access` URL.
2. Submit an email address and complete Lumen's required access flow.
3. Receive a single-use access link from Lumen.
4. Extract full URLs from the accessed notice page.

There is no Lumen API token configured, and the app must not rely on leaked/shared tokens.

CAPTCHA solver integration is intentionally not implemented. Lumen's request-access CAPTCHA must remain a manual user action. The app can track the request/access workflow, but it should not automate CAPTCHA solving or submit Lumen access forms on the user's behalf.

## Scanner Behavior

`POST /api/lumen-claims/scan` starts a background scan. The current button label is `Scan all claims`.

The scanner:

1. Uses Google Transparency data to find domains with copyright request rows.
2. Collects request IDs, notice IDs, owner/reporting organization data, and Lumen links.
3. Stores or updates queue items in `data/lumen-claims.json`.
4. Preserves existing manual `reviewStatus` and `reviewNote` when rescanning.

Daily scheduled flow:

1. Run the Google Transparency portfolio check for all portfolio domains.
2. Use the newest Transparency run to find every domain with claim rows.
3. Run the Claims Queue scanner for all of those claimed domains.
4. Reuse existing per-request Lumen details from `data/lumen-claims.json` whenever the `domain + requestId` pair is already known.
5. Open Google request detail pages only for newly discovered request IDs, unless `forceRefreshKnown` is explicitly enabled.
6. Mark only previously unseen notice IDs as new for that run.
7. Send an email digest only when `newNoticeCount > 0` or when scan errors occur, and only if SMTP/email alerts are configured.
8. Export a Lumen access-request queue containing only active `to_review` claims. Claims already marked `claim_submitted` or `resolved` are excluded from this export.

`limit: 0` means scan all claimed domains from the latest Google Transparency run. A positive limit can still be passed for small test runs.

The latest access-request queue export is stored on the run as `accessRequestQueue.exportPath`.

The latest run also records `cachedRequestCount` and `refreshedRequestCount` so it is easy to confirm how much work was reused versus newly fetched.

## Verification Already Done

These checks passed:

```bash
node --check public/app.js
node --check server.mjs
node --check lib/store.mjs
node --check lib/lumen-claims.mjs
node --check lib/notify.mjs
```

Manual UI/API verification:

- App loads at `http://127.0.0.1:4177/`.
- UI only shows `Portfolio` and `Claims Queue`.
- Claims counter and rendered claim cards both show 179.
- A claim can be changed from `To review` to `Claim submitted`.
- The status change is saved through the API and the card gets highlighted.
- The test claim was reset to `To review` after verification.

Screenshot:

```text
screenshots/claims-queue-simplified.png
```

## Recommended Next Development Steps

1. Add pagination or virtual scrolling if the queue grows into thousands of notices.
2. Add optional notes per claim in the UI using the existing `reviewNote` backend field.
3. Add a dedicated `Claim submitted at` / `Resolved at` timeline if workflow reporting matters.
4. Build the Lumen access-link ingestion flow once the user receives Lumen email links.
5. Add email notifications only for changed queue counts or new notice IDs, not every scan.
6. Move secrets and production data outside the repository before deployment.

## Sensitive Data

Do not print, commit, or share:

```text
data/secrets.json
```

That file may contain third-party API tokens.
