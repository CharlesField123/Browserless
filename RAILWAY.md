# Deploying to Railway

This fork includes [`railway.json`](./railway.json), which tells Railway to
build [`docker/chromium/Dockerfile`](./docker/chromium/Dockerfile) — the
same image referenced in the main README (`ghcr.io/browserless/chromium`) —
rather than trying to auto-detect a build (Nixpacks won't know how to run
the Chromium install/asset-build steps this project needs).

## Option A: Railway dashboard (no CLI needed)

1. **New Project → Deploy from GitHub repo**, pick this repo
   (`CharlesField123/Browserless`) and the branch you want live.
   Railway reads `railway.json` automatically and builds the Dockerfile
   above — no other setup required to get it building.
2. **Variables** tab, add:
   - `TOKEN` — pick a long random string. Required: without it, anyone
     with your Railway URL can drive the browser.
   - `CONCURRENT` — max simultaneous sessions. Start at `1` on a small
     plan (each Chromium instance is memory-hungry); raise it once you
     know your plan's headroom.
   - `TIMEOUT` — idle session timeout in ms, e.g. `60000`.
3. **Settings → Networking → Generate Domain** to get a public
   `<app>.up.railway.app` URL. Railway terminates TLS for you, so connect
   over `wss://`, not `ws://`.
4. Deploy. Watch the build logs — first build takes a few minutes
   (installing Chromium). Once it's up, `https://<app>.up.railway.app/docs/`
   should return 200 and load the API docs (that's also the health check
   Railway itself polls — it's unauthenticated by design, so it works
   before you've wired up a token anywhere; note the trailing slash,
   `/docs` without it 301-redirects, which some health checkers won't
   follow). Two paths that look like reasonable health checks but
   **aren't**: `/` 404s (there's no file served at the static root, only
   under `/docs/`), and `/pressure` requires auth once `TOKEN` is set, so
   it 401s without `?token=<TOKEN>` appended.

### Persisting job-board logins (optional)

The `job-sourcing/` Indeed/LinkedIn adapters keep you logged in via a
Chrome profile on disk (`userDataDir`, see `JOB_SOURCING.md`). Railway
container disks are **ephemeral** — wiped on every redeploy — unless you
attach a volume:

1. **Settings → Volumes → New Volume**, mount path `/data/job-sourcing-profiles`.
2. Set the variable `JOB_SOURCING_SERVER_PROFILES_DIR=/data/job-sourcing-profiles`
   (the toolkit defaults to `/tmp/job-sourcing-profiles`, which is fine for
   local `docker-compose.job-sourcing.yml` testing but not for Railway).

Skip this if you only plan to use the Greenhouse/Lever adapters — those
call public JSON APIs directly and don't need a browser session at all.

## Option B: Railway CLI (if you'd rather run it yourself)

```bash
npm i -g @railway/cli
railway login
railway link          # or: railway init, for a new project
railway variables --set TOKEN=$(openssl rand -hex 24) --set CONCURRENT=1 --set TIMEOUT=60000
railway up
railway domain        # generates/prints the public URL
```

## After it's deployed

Point `job-sourcing/.env` at it:

```bash
BROWSERLESS_WS_URL=wss://<app>.up.railway.app
BROWSERLESS_TOKEN=<the TOKEN you set above>
```

Then `job-sourcing search` / `apply` / `list` work exactly as in
`JOB_SOURCING.md`, just against the Railway instance instead of a local one.
