# DMCA Deployment Checklist

This checklist is for deploying the DMCA Claims Queue app from GitHub to Vercel.

## Current Deployment

- GitHub repo: `deniscumulus/dmca`
- Vercel scope/team: `denis-cumulus`
- Vercel project: `dmca`
- Production alias: `https://dmca-murex.vercel.app`
- Current production deployment checked on `2026-07-27`: `READY`
- Vercel framework preset: `Services`
- Vercel entrypoint: `api/index.js`
- Vercel config: `vercel.json`

Important: the repo also has `Dockerfile` and `render.yaml`, but those are for a Render/VPS/container deployment path. Vercel does not use that Dockerfile for the current deployment.

## Pre-Flight

- Confirm local dependencies install:

```sh
npm install
```

- Confirm syntax checks pass:

```sh
node --check server.mjs
node --check api/index.js
node --check lib/store.mjs
node --check lib/lumen-claims.mjs
node --check lib/notify.mjs
```

- Confirm local app starts:

```sh
npm start
```

- Open local app:

```text
http://127.0.0.1:4177/
```

- Confirm local state has expected portfolio/claim data:

```sh
curl -s http://127.0.0.1:4177/api/state \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s); console.log({domains:x.portfolio.domains.length, claims:Object.keys(x.lumenClaims.notices||{}).length});})'
```

Expected initial seeded state was:

```text
190 portfolio domains
551 claim notices
```

## Vercel Project Link

- Login if needed:

```sh
npx vercel login
```

- Link local repo to the existing Vercel project:

```sh
npx vercel link --yes --project dmca --scope denis-cumulus
```

- Confirm project settings:

```sh
npx vercel project inspect dmca --scope denis-cumulus
```

Expected:

```text
Framework Preset: Services
Node.js Version: 24.x
Root Directory: .
```

## Required Vercel Environment Variables

Production must have:

```text
BLOB_READ_WRITE_TOKEN
BASIC_AUTH_USER
BASIC_AUTH_PASS
```

Preview should also have:

```text
BLOB_READ_WRITE_TOKEN
BASIC_AUTH_USER
BASIC_AUTH_PASS
```

As of `2026-07-27`, production has all three. Preview has `BLOB_READ_WRITE_TOKEN`; add preview Basic Auth before relying on preview deployments.

Check environment variables without printing secret values:

```sh
npx vercel env list production --scope denis-cumulus
npx vercel env list preview --scope denis-cumulus
```

Optional email notification variables:

```text
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
SMTP_FROM
SMTP_TO
SMTP_SECURE
```

Do not commit `.env.local`, `.vercel/`, `data/`, or any token files.

## Vercel Blob Storage

The app uses local JSON files in development. On Vercel, it uses private Vercel Blob storage when `BLOB_READ_WRITE_TOKEN` exists.

Create and connect the private Blob store if it does not exist:

```sh
npx vercel blob create-store dmca-data \
  --access private \
  --yes \
  --environment production \
  --environment preview \
  --scope denis-cumulus
```

Pull production env locally before seeding Blob:

```sh
npx vercel env pull .env.local --environment=production --yes --scope denis-cumulus
```

Seed the private Blob store from the local JSON database:

```sh
node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { put } from "@vercel/blob";

const env = await readFile(".env.local", "utf8");
const tokenLine = env.split(/\n/).find((line) => line.startsWith("BLOB_READ_WRITE_TOKEN="));
if (!tokenLine) throw new Error("Missing BLOB_READ_WRITE_TOKEN");
process.env.BLOB_READ_WRITE_TOKEN = tokenLine.slice("BLOB_READ_WRITE_TOKEN=".length).replace(/^"|"$/g, "");

const files = [
  "config.json",
  "portfolio.json",
  "cases.json",
  "history.json",
  "url-audits.json",
  "serp-audits.json",
  "lumen-claims.json"
];

for (const name of files) {
  const body = await readFile(`data/${name}`, "utf8");
  await put(`data/${name}`, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json"
  });
  console.log(`uploaded ${name}`);
}
'
```

Do not upload `data/secrets.json` unless there is a deliberate reason.

Confirm Blob data exists:

```sh
node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { list } from "@vercel/blob";

const env = await readFile(".env.local", "utf8");
const tokenLine = env.split(/\n/).find((line) => line.startsWith("BLOB_READ_WRITE_TOKEN="));
process.env.BLOB_READ_WRITE_TOKEN = tokenLine.slice("BLOB_READ_WRITE_TOKEN=".length).replace(/^"|"$/g, "");

const result = await list({ prefix: "data/", limit: 20 });
console.log(result.blobs.map((blob) => blob.pathname).sort().join("\n"));
'
```

Expected files:

```text
data/cases.json
data/config.json
data/history.json
data/lumen-claims.json
data/portfolio.json
data/serp-audits.json
data/url-audits.json
```

## Build And Deploy

- Pull production settings:

```sh
npx vercel pull --yes --environment=production --scope denis-cumulus
```

- Build production output:

```sh
npx vercel build --prod --yes --scope denis-cumulus
```

- Deploy prebuilt output to production:

```sh
npx vercel deploy --prebuilt --prod --yes --scope denis-cumulus
```

- Inspect latest deployment:

```sh
npx vercel ls dmca --scope denis-cumulus
npx vercel inspect https://dmca-murex.vercel.app --scope denis-cumulus
```

## GitHub-Controlled Deploys

The Vercel project is connected to:

```text
https://github.com/deniscumulus/dmca
```

After this repo contains the Vercel changes, normal flow should be:

```sh
git status
git add api/index.js vercel.json server.mjs lib/store.mjs package.json package-lock.json .gitignore DEPLOYMENT_CHECKLIST.md
git commit -m "Prepare DMCA app for Vercel deployment"
git push origin main
```

Then Vercel should build/deploy from GitHub.

## Post-Deploy Verification

- Production should require Basic Auth:

```sh
curl -I https://dmca-murex.vercel.app/
```

Expected:

```text
HTTP/2 401
```

- With valid Basic Auth, `/api/state` should return seeded data:

```sh
curl -s -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" https://dmca-murex.vercel.app/api/state \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s); console.log({domains:x.portfolio.domains.length, claims:Object.keys(x.lumenClaims.notices||{}).length, dataDir:x.dataDir});})'
```

Expected initial seeded state:

```text
domains: 190
claims: 551
```

## Important Vercel Limitations

- The local `setInterval` daily scheduler only runs under `npm start`. It does not run as a long-running process on Vercel.
- To make the daily scan automatic on Vercel, add a Vercel Cron endpoint and a `crons` entry in `vercel.json`.
- Browser-based scans should be tested in production logs. The Vercel build completed, but Playwright/Chromium runtime behavior must be verified after deployment.
- If the dashboard loads but data is empty, check `BLOB_READ_WRITE_TOKEN` and the private Blob seed files.
- If preview deployments are public, add `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` to Preview env too.

## Quick Troubleshooting

- `project_settings_required`: run `npx vercel pull --yes --environment=production --scope denis-cumulus`.
- Blank data after deploy: seed Vercel Blob again and confirm `data/*.json` blobs exist.
- `401` in browser: Basic Auth is enabled; use the production username/password from Vercel env owner.
- GitHub push does not deploy: confirm Vercel Git connection under Project Settings and inspect latest GitHub deployment in Vercel.
- Docker confusion: ignore `Dockerfile` for Vercel. Use it only for Render/VPS/container hosting.
