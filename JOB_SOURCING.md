# Job Sourcing on Browserless

This repository is a fork of [browserless/browserless](https://github.com/browserless/browserless)
— the same battle-tested headless browser server, plus a small toolkit
in [`job-sourcing/`](./job-sourcing) for finding and applying to jobs:
searching multiple job boards, tracking what you've seen/applied to, and
autofilling application forms on ATS platforms that expose them.

Everything else in this repo (the Docker images, the WebSocket/REST API,
stealth and ad-blocking, etc.) is unmodified upstream Browserless. See the
main [README.md](./README.md) for that.

## Why fork instead of just scripting against Browserless?

You can absolutely just point Puppeteer/Playwright at a stock Browserless
instance and write your own job-search script. This fork exists because
that script gets reinvented for every job search: a place to keep a
candidate profile, a dedupe store so you don't apply twice, adapters for
the boards that actually matter (Greenhouse, Lever), and an autofill
engine with a dry-run safety net. `job-sourcing/` is that reusable layer.

## Architecture

```
 job-sourcing/ (this toolkit)          Browserless server (this repo, unmodified)
 ┌─────────────────────────┐           ┌──────────────────────────────┐
 │ boards/greenhouse.js  ───┼─ HTTPS ──▶│ Public Greenhouse/Lever APIs │
 │ boards/lever.js       ───┼─ HTTPS ──▶│ (no browser needed)          │
 │ boards/indeed.js      ───┼─ WS ─────▶│                                │
 │ boards/linkedin.js    ───┼─ WS ─────▶│  puppeteer-core over          │
 │                          │           │  ws://.../?stealth&blockAds  │
 │ apply/autofill.js     ───┼─ WS ─────▶│  &trackingId=<board>          │
 │                          │           └──────────────────────────────┘
 │ store.js  (data/applications.json)
 │ profile.js (config/candidate.json)
 │ cli.js  (search | apply | list)
 └─────────────────────────┘
```

- **Greenhouse and Lever** are read via their official, public, unauthenticated
  Job Board APIs — the same data those companies embed on their own careers
  pages. No scraping, no ToS risk.
- **Indeed and LinkedIn** have no public search API, so those adapters
  drive a real browser through this fork's own Browserless server
  (stealth + ad-block already built in). They're **off by default** — see
  [Ethics & Terms of Service](#ethics--terms-of-service) below.
- **Autofill** drives a real browser to your application form, fills every
  field it can confidently match to your candidate profile, uploads your
  resume/cover letter, and screenshots the result. It **never submits**
  unless you explicitly set `DRY_RUN=false`.

Deploying the server itself to Railway instead of running it locally? See
[RAILWAY.md](./RAILWAY.md). Want to drive this from Claude conversationally
instead of the CLI below? See [MCP.md](./MCP.md) — this fork exposes
search/apply as MCP tools at `/mcp`, usable as a claude.ai custom connector.

## Quick start

```bash
# 1. Run this fork's Browserless server
docker run -d -p 3000:3000 --name browserless ghcr.io/browserless/chromium
# (or: docker compose -f docker-compose.job-sourcing.yml up -d, for persistent
#  login sessions across restarts — see below)

cd job-sourcing
npm install

# 2. Set up your candidate profile and the boards you want to track
cp config/candidate.example.json config/candidate.json
cp config/boards.example.json config/boards.json
cp .env.example .env
# edit config/candidate.json, config/boards.json, and .env to taste
# (both config/candidate.json and config/boards.json are gitignored)

# 3. Search
npm run search
# -> [new] greenhouse:123456  Backend Engineer @ acme  https://...
# -> [new] lever:abc-def      Platform Engineer @ acme  https://...

npm run list

# 4. Review an application before touching anything live
node src/cli.js apply greenhouse:123456
# -> fills the form, saves data/screenshots/greenhouse-123456.png, does NOT submit

# 5. Once you've reviewed the screenshot and trust the autofill:
DRY_RUN=false node src/cli.js apply greenhouse:123456
```

See [`job-sourcing/README.md`](./job-sourcing/README.md) for the full CLI/API reference.

## Persistent logins (Indeed/LinkedIn search)

A live Browserless session doesn't outlive your connection to it, so
staying logged in across separate `job-sourcing search` runs relies on
Chrome's **on-disk profile**, not the WebSocket session itself: the
`indeed`/`linkedin` adapters launch with a `userDataDir` (see
`src/profile-dir.js`) pointing at a path on the *server's* filesystem,
under `/tmp/job-sourcing-profiles/<board>` by default. `docker-compose.job-sourcing.yml`
mounts a named volume there so that directory survives container restarts.
(`trackingId` is a separate, unrelated feature — it just labels a
currently-open session for Browserless's `/sessions`/`/kill` management
APIs.)

To log in once:

```bash
docker compose -f docker-compose.job-sourcing.yml up -d
node -e "
  import('./job-sourcing/src/client.js').then(async ({ BrowserlessClient }) => {
    const { serverProfileDir } = await import('./job-sourcing/src/profile-dir.js');
    const client = new BrowserlessClient();
    await client.withPage({ userDataDir: serverProfileDir('linkedin') }, async (page) => {
      await page.goto('https://www.linkedin.com/login');
      console.log('Open the Debug Viewer at http://localhost:3000/docs, find this session, and log in.');
      console.log('Leave this running until you are done, then Ctrl+C.');
      await new Promise(() => {});
    });
  });
"
```

Every later `job-sourcing search` run against the same board reuses that
same on-disk profile directory automatically, so it picks up the cookies
from that login.

## Ethics & Terms of Service

Please read this before enabling anything beyond Greenhouse/Lever.

- **Greenhouse and Lever** adapters use those companies' official public
  APIs, intended for exactly this kind of third-party consumption. No
  concerns there.
- **Indeed** (`ALLOW_INDEED=true`) and **LinkedIn** (`ALLOW_LINKEDIN=true`)
  have no such API. Both companies' Terms of Service restrict automated
  access, and both can rate-limit, CAPTCHA, or ban accounts that scrape.
  These adapters are opt-in, read-only (they never auto-apply), and
  throttle themselves with human-scale delays — but that reduces risk,
  it doesn't eliminate it. Use your own account at your own risk, for
  your own personal search, and stop if a site pushes back with
  CAPTCHAs or errors.
- **Auto-apply is intentionally limited to Greenhouse and Lever.** Sites
  like LinkedIn "Easy Apply" are explicitly excluded — automating
  submissions there is against their terms and is also generally bad
  etiquette (employers can tell when an application is spam-filled).
- **`DRY_RUN` defaults to `true`.** Autofill always screenshots the
  filled form for your review before you opt into real submission.
- **You are responsible for what you submit.** Review every autofilled
  application; the matcher is best-effort pattern matching, not a
  guarantee of correctness (salary expectations, work-authorization
  answers, and free-text questions especially deserve a human look).
- This fork keeps upstream's SSPL/commercial dual license (see
  [LICENSE](./LICENSE)) unchanged. It's built here for personal use, not
  as a hosted service offered to others — if you want to offer this (or
  Browserless itself) as a service to third parties, see
  [browserless.io](https://www.browserless.io/contact) about a commercial
  license.
