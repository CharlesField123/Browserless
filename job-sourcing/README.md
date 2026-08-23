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
node src/cli.js apply <board>:<id> --answers=answers.json  # + custom per-application answers
node src/cli.js poll-apply greenhouse --companies=acme --limit=5           # search+fill+apply, no per-job review (dry-run by default)
node src/cli.js poll-apply greenhouse --companies=acme --limit=5 --submit  # same, for real
```

`poll-apply` is the batch/automated counterpart to `apply` — it searches,
autofills, and (with `--submit`) submits every new match up to `--limit`
(default 5, hard max 20) in one shot, no per-job screenshot review. It
still refuses to submit any single application with an unanswered field
the page marks required (reported as `needs-answers`, not silently sent
incomplete), and it never re-applies to something already `applied`. See
[`../JOB_SOURCING.md`](../JOB_SOURCING.md)'s Ethics section before relying
on this — `apply` (one job, reviewed) is the safer default; use `poll-apply`
deliberately, not as a habit.

The candidate profile can't anticipate a given company's custom screening
questions. Run `apply` once without `--answers`, check the printed "Skipped
fields" list (each with its type and, for dropdowns, its options), write
those into a `{"field label": "answer"}` JSON file, and re-run pointing
`--answers` at it — those answers take priority over the profile for any
field they match. Still dry-run by default either way; re-run with
`DRY_RUN=false` only once you've reviewed the screenshot.

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
  profile.js            loadCandidateProfile (strict, throws if incomplete),
                         readCandidateProfileRaw (lenient, for inspection),
                         saveCandidateProfile/mergeProfile (partial update —
                         nested objects like defaultAnswers merge, not replace).
  uploads.js             saveUploadedFile: writes a base64-decoded file to
                         disk with a sanitized filename (path traversal safe).
                         Used by the MCP upload_resume tool to get a resume
                         onto a remote deployment with no filesystem access.
  store.js              JSON-file dedupe/status tracker (data/applications.json).
                         Statuses: seen -> filled | needs-answers -> applied.
  pipeline.js            pollAndApply: search + autofill + submit a batch
                         in one call, with its own guardrails (limit,
                         never re-apply, refuse incomplete submissions) —
                         see apply/autofill.js's blockedByRequiredFields.
  throttle.js           Human-scale delays between actions.
  boards/
    base.js              Adapter contract + query matching.
    greenhouse.js         Official Greenhouse Job Board API.
    lever.js               Official Lever Postings API.
    indeed.js              Browser-driven search (opt-in, read-only).
    linkedin.js            Browser-driven search (opt-in, read-only).
  apply/
    autofill.js           Generic label-driven form filler + screenshot.
                         Blocks submission on any unanswered field the
                         page marks required.
    greenhouse-apply.js    Greenhouse entry point.
    lever-apply.js          Lever entry point.
  cli.js                 search | apply | poll-apply | list
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
