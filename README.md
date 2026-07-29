# Copyright Portfolio Monitor

Local dashboard for checking a portfolio of domains against Google Transparency Report copyright delisting data.

## Run locally

```sh
npm start
```

Open `http://127.0.0.1:4177`.

The server listens on `0.0.0.0` by default so it can also run on a hosted container. Locally, keep using `http://127.0.0.1:4177`.

The dashboard is in English. Paste one site or a full list of sites into the portfolio panel; the bulk importer accepts spaces, commas, semicolons, and new lines. Use "Replace existing list" when you want to overwrite the current local database.

## Browser-based Google checks

The app defaults to `Google` mode. It does not use an API token. It opens the public Google Transparency Report copyright `Explore the data` page for each site, searches the `Domains` table, reads requested URL counts, waits between sites, and stores the run in `data/history.json`.

`Demo` mode remains available only for UI testing.

## Daily checks

The local scheduler runs once a day at the configured time while `npm start` is running. Results are saved into `data/history.json`; when you open the app, the dashboard shows the latest run, total requested URLs, and new changes since the previous check.

## Deploy online

This app is a Node server, not a static GitHub Pages site. GitHub can store the code, but a hosting provider such as Render, Railway, Fly, or a VPS must run it.

The repo includes:

```text
Dockerfile
docker-compose.yml
render.yaml
```

For VPS/Docker deployment, use:

```text
DEPLOYMENT_CHECKLIST.md
```

Recommended Render flow:

1. Push the code to GitHub.
2. In Render, create a new Blueprint from the GitHub repo.
3. Set the secret environment variables listed below.
4. Use the persistent disk mounted at `/app/data` so JSON data survives deploys.

Required production env vars:

```sh
BASIC_AUTH_USER=your-login
BASIC_AUTH_PASS=strong-password
DATA_DIR=/app/data
HOST=0.0.0.0
```

Optional email env vars:

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=secret
SMTP_FROM=user@example.com
SMTP_TO=denis@cumuluseo.com
```

Do not commit local runtime data. The `data/` directory is ignored except for `data/.gitkeep`.

## Case tracking

Each result can be marked as `To review`, `Monitoring`, `Claim filed`, `In progress`, `Resolved`, or `Ignored`. These manual statuses and notes are saved locally in `data/cases.json` and are shown with colored markers in the dashboard.

## URL deep scan

After a domain check, use `Export URLs` to extract sitemap URLs only for domains that have Google Transparency requested URL data. The export is saved as a CSV under `data/exports/` and can be uploaded to a bulk index checker such as IndexPulse, IndexCheckr, or UltraIndexer.

Use `Scan reported URLs` for a local browser-based experiment. The scanner reads sitemap URLs, searches each URL on Google Search, and saves the URL-level audit in `data/url-audits.json`.

Google Search may block automated browser searches. When that happens, URL results are marked as `Blocked` instead of being treated as clean.

## Email alerts

Email alerts are optional. Turn them on in the UI and set a notification address, then start the app with SMTP settings:

```sh
SMTP_HOST=smtp.example.com \
SMTP_PORT=587 \
SMTP_USER=user@example.com \
SMTP_PASS=secret \
SMTP_FROM=user@example.com \
npm start
```

The app only attempts email delivery when a run has new changes or errors. Without SMTP settings, changes still appear in the dashboard.

## CLI check

```sh
npm run check
```

The CLI uses the same local data files as the web app and appends each run to `data/history.json`.
By default CLI runs are treated as scheduled runs, so the web scheduler will not duplicate the same daily check.
