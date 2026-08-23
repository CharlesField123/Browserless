# job-sourcing

A small toolkit for finding and applying to jobs, built on top of this
Browserless fork. See [`../JOB_SOURCING.md`](../JOB_SOURCING.md) for the
full architecture, quick start, and — importantly — the ethics/Terms of
Service section before you enable the Indeed or LinkedIn adapters.

## Setup

```bash
npm install
cp .env.example .env
cp config/candidate.example.json config/candidate.json
cp config/boards.example.json config/boards.json
```

Edit `.env`, `config/candidate.json`, and `config/boards.json`. The two
config files are gitignored — they're expected to hold your personal
data and won't be committed.

## CLI

```bash
node src/cli.js search              # search every board in config/boards.json
node src/cli.js list                # list all tracked jobs
node src/cli.js list applied        # filter by status: seen | filled | applied
node src/cli.js apply <board>:<id>  # autofill (dry-run by default)
```

npm shortcuts: `npm run search`, `npm run list`, `npm run apply -- <board>:<id>`.

## Library usage

Every piece is a plain ES module you can import directly if the CLI
doesn't fit your workflow:

```js
import { BrowserlessClient } from './src/client.js';
import { GreenhouseAdapter } from './src/boards/greenhouse.js';
import { loadCandidateProfile } from './src/profile.js';
import { autofillApplication } from './src/apply/autofill.js';

const client = new BrowserlessClient(); // reads BROWSERLESS_WS_URL / BROWSERLESS_TOKEN
const profile = await loadCandidateProfile();

const jobs = await new GreenhouseAdapter(['acme']).search(profile.search);

const result = await autofillApplication(client, jobs[0], profile, { dryRun: true });
console.log(result.screenshotPath, result.filled, result.skipped);
```

## Layout

```
src/
  client.js            BrowserlessClient — thin wrapper over this fork's
                        WS endpoint (stealth/blockAds/trackingId) and its
                        open-source /function HTTP endpoint.
  profile.js            Loads + validates config/candidate.json.
  store.js              JSON-file dedupe/status tracker (data/applications.json).
  throttle.js           Human-scale delays between actions.
  boards/
    base.js              Adapter contract + query matching.
    greenhouse.js         Official Greenhouse Job Board API.
    lever.js               Official Lever Postings API.
    indeed.js              Browser-driven search (opt-in, read-only).
    linkedin.js            Browser-driven search (opt-in, read-only).
  apply/
    autofill.js           Generic label-driven form filler + screenshot.
    greenhouse-apply.js    Greenhouse entry point.
    lever-apply.js          Lever entry point.
  cli.js                 search | apply | list
test/
  basic.test.js          node:test unit tests (run: npm test)
```

## Adding a new board

Read-only search adapters implement `search(query)` and return
`{ board, id, title, company, location, url, applyUrl, description, postedAt }[]`
(see `src/boards/base.js`). If the board exposes a public API, prefer that
over browser scraping (see `greenhouse.js`/`lever.js`). Wire it into
`src/cli.js`'s `buildAdapters()` behind a `config/boards.json` flag.

Auto-apply is deliberately opt-in per board (`src/cli.js`'s `cmdApply`) —
only add a new one if that board's terms allow automated submissions.
