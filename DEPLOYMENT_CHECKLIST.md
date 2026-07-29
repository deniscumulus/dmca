# DMCA VPS/Docker Deployment Checklist

This checklist is for deploying the DMCA Claims Queue app on a VPS or any Docker-capable server.

For historical Vercel notes, see `VERCEL_DEPLOYMENT_CHECKLIST.md`. The current live-server path should use this Docker checklist.

## What This App Needs

- A long-running Node container.
- Persistent storage mounted at `/app/data`.
- Basic Auth enabled before exposing the dashboard.
- Optional SMTP variables for email notifications.
- Outbound HTTPS access from the server for Google Transparency/Lumen checks.

The Docker image already uses Microsoft Playwright's base image:

```text
mcr.microsoft.com/playwright:v1.60.0-noble
```

That image includes the browser dependencies needed by Playwright. Do not deploy this as a plain Node image unless you also install browser dependencies.

## Repository Files

Relevant deployment files:

```text
Dockerfile
docker-compose.yml
.env.example
.dockerignore
DEPLOYMENT_CHECKLIST.md
```

Vercel-only files can remain in the repo, but they are not used for VPS/Docker deployment:

```text
api/index.js
vercel.json
VERCEL_DEPLOYMENT_CHECKLIST.md
```

## Server Prerequisites

On the VPS, install:

```sh
docker --version
docker compose version
git --version
```

Recommended server directory:

```sh
/opt/dmca
```

Recommended public port behind reverse proxy:

```text
127.0.0.1:4177
```

If there is no reverse proxy yet, expose `4177` temporarily only while testing.

## First-Time Server Setup

Clone the repo:

```sh
sudo mkdir -p /opt/dmca
sudo chown "$USER":"$USER" /opt/dmca
git clone https://github.com/deniscumulus/dmca.git /opt/dmca
cd /opt/dmca
```

Create runtime data directory:

```sh
mkdir -p data
chmod 700 data
```

Create env file:

```sh
cp .env.example .env
nano .env
```

Minimum required values:

```text
BASIC_AUTH_USER=change-me
BASIC_AUTH_PASS=change-me
PUBLIC_PORT=4177
```

Important: do not set `BLOB_READ_WRITE_TOKEN` on VPS unless you intentionally want to use Vercel Blob instead of the mounted `/app/data` volume.

## Required Environment Variables

Required:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=4177
DATA_DIR=/app/data
BASIC_AUTH_USER
BASIC_AUTH_PASS
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

Optional third-party variables:

```text
APIFY_TOKEN
LUMEN_AUTH_TOKEN
```

Do not commit `.env`, `data/`, `.vercel/`, screenshots, or logs.

## Seed Existing Data

The Docker image intentionally does not include `data/`. The live server must keep JSON state on a mounted volume.

From a machine that has the current local app data, seed the server:

```sh
rsync -av \
  --exclude 'backups/' \
  --exclude 'exports/' \
  --exclude 'secrets.json' \
  data/config.json \
  data/portfolio.json \
  data/cases.json \
  data/history.json \
  data/url-audits.json \
  data/serp-audits.json \
  data/lumen-claims.json \
  USER@SERVER_IP:/opt/dmca/data/
```

Only copy `data/secrets.json` if you intentionally want to migrate local stored tokens. Prefer env vars for secrets.

Expected current seeded state:

```text
portfolio domains: 190
claim notices: 551+
```

## Build And Start

From `/opt/dmca`:

```sh
docker compose build
docker compose up -d
```

Confirm the container is running:

```sh
docker compose ps
docker compose logs --tail=100 dmca
```

Confirm local server response on the VPS:

```sh
curl -I http://127.0.0.1:4177/
```

Expected with Basic Auth enabled:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="DMCA Claims Queue"
```

Confirm seeded state with credentials:

```sh
curl -s -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" http://127.0.0.1:4177/api/state \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s); console.log({domains:x.portfolio.domains.length, claims:Object.keys(x.lumenClaims.notices||{}).length, dataDir:x.dataDir});})'
```

Expected:

```text
domains: 190
claims: 551+
dataDir: /app/data
```

## Reverse Proxy

Put the app behind Nginx, Caddy, Traefik, or Cloudflare Tunnel.

Nginx example:

```nginx
server {
  listen 80;
  server_name dmca.example.com;

  client_max_body_size 20m;

  location / {
    proxy_pass http://127.0.0.1:4177;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then add TLS with Certbot or your existing proxy automation.

## Daily Automation

On VPS/Docker, the local scheduler inside `server.mjs` runs while the container is up.

Checklist:

- `scheduleEnabled` should be `true` in `data/config.json`.
- `dailyAt` should be set to the desired time.
- Container timezone defaults to UTC unless configured by the host/container environment.
- Use server logs to confirm scheduled checks.

Optional timezone setting in `.env`:

```text
TZ=Europe/Belgrade
```

If strict scheduling matters, add `TZ=Europe/Belgrade` to `.env` and ensure Docker Compose passes it through.

## Update Flow

Use this for future code updates:

```sh
cd /opt/dmca
git pull origin main
docker compose build
docker compose up -d
docker compose logs --tail=100 dmca
```

Do not delete `/opt/dmca/data`.

Before risky updates, back up the data directory:

```sh
tar -czf "dmca-data-backup-$(date +%F-%H%M).tar.gz" data
```

## Rollback

List commits:

```sh
git log --oneline -10
```

Rollback code only:

```sh
git checkout COMMIT_SHA
docker compose build
docker compose up -d
```

Rollback data only:

```sh
docker compose down
mv data "data-before-rollback-$(date +%F-%H%M)"
tar -xzf dmca-data-backup-YYYY-MM-DD-HHMM.tar.gz
docker compose up -d
```

## Logs And Debugging

Runtime logs:

```sh
docker compose logs -f dmca
```

Container shell:

```sh
docker compose exec dmca bash
```

Check mounted data from inside the container:

```sh
docker compose exec dmca ls -lah /app/data
```

Check app state:

```sh
docker compose exec dmca node -e 'fetch("http://127.0.0.1:4177/api/state", {headers:{Authorization:"Basic "+Buffer.from(process.env.BASIC_AUTH_USER+":"+process.env.BASIC_AUTH_PASS).toString("base64")}}).then(r=>r.json()).then(x=>console.log({domains:x.portfolio.domains.length, claims:Object.keys(x.lumenClaims.notices||{}).length, dataDir:x.dataDir})).catch(e=>{console.error(e); process.exit(1);})'
```

## Common Failure Cases

- Dashboard asks for login: expected if Basic Auth is enabled.
- Dashboard returns empty data: mounted `/app/data` is empty or wrong `DATA_DIR`.
- Data resets after deploy: `data` directory is not mounted as a persistent volume.
- Browser scan fails: check outbound network, Playwright logs, and whether the Docker image is the Playwright base image.
- Claim scan is slow: expected for first full run; later runs reuse cached `domain + requestId` rows.
- App writes to Vercel Blob on VPS: remove `BLOB_READ_WRITE_TOKEN` from `.env`.
- Nginx returns 502: container is down, wrong `PUBLIC_PORT`, or proxy points to the wrong upstream.

## Security Checklist

- Basic Auth set before exposing public domain.
- `.env` never committed.
- `data/secrets.json` not copied unless intentionally needed.
- VPS firewall only exposes SSH, HTTP, and HTTPS.
- Docker port `4177` preferably bound behind reverse proxy only.
- Regular backups of `/opt/dmca/data`.
