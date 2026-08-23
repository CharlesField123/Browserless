#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from './env.js';
import { BrowserlessClient } from './client.js';
import { loadCandidateProfile } from './profile.js';
import { ApplicationStore } from './store.js';
import { GreenhouseAdapter } from './boards/greenhouse.js';
import { LeverAdapter } from './boards/lever.js';
import { logger } from './logger.js';
import { pollAndApply, DEFAULT_LIMIT, MAX_LIMIT } from './pipeline.js';

await loadEnvFile();

const [, , command, ...rest] = process.argv;

async function loadBoardsConfig(path = process.env.BOARDS_CONFIG_PATH ?? './config/boards.json') {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No boards config found at ${path}. Copy config/boards.example.json to ` +
          `config/boards.json and list the companies you want to track.`,
      );
    }
    throw err;
  }
}

async function buildAdapters(client) {
  const config = await loadBoardsConfig();
  const adapters = [];
  if (config.greenhouse?.length) adapters.push(new GreenhouseAdapter(config.greenhouse));
  if (config.lever?.length) adapters.push(new LeverAdapter(config.lever));
  if (config.indeed) {
    const { IndeedAdapter } = await import('./boards/indeed.js');
    adapters.push(new IndeedAdapter(client));
  }
  if (config.linkedin) {
    const { LinkedInAdapter } = await import('./boards/linkedin.js');
    adapters.push(new LinkedInAdapter(client));
  }
  return adapters;
}

async function cmdSearch() {
  const profile = await loadCandidateProfile();
  const client = new BrowserlessClient();
  const store = new ApplicationStore();
  const adapters = await buildAdapters(client);

  if (!adapters.length) {
    logger.warn('No boards configured in config/boards.json — nothing to search.');
    return;
  }

  let total = 0;
  for (const adapter of adapters) {
    logger.info(`Searching ${adapter.name}...`);
    const jobs = await adapter.search(profile.search ?? {});
    for (const job of jobs) {
      const alreadySeen = await store.has(job);
      await store.record(job, { status: alreadySeen ? undefined : 'seen' });
      if (!alreadySeen) {
        total += 1;
        console.log(`[new] ${job.board}:${job.id}  ${job.title} @ ${job.company}  ${job.url}`);
      }
    }
  }
  logger.info(`Done. ${total} new job(s) recorded (run "job-sourcing list" to see all).`);
}

async function cmdApply() {
  const [key, ...flags] = rest;
  if (!key) {
    console.error('Usage: job-sourcing apply <board>:<id> [--answers=path/to/answers.json]');
    process.exitCode = 1;
    return;
  }

  const answersFlag = flags.find((f) => f.startsWith('--answers='));
  let answers = {};
  if (answersFlag) {
    const answersPath = answersFlag.slice('--answers='.length);
    try {
      answers = JSON.parse(await readFile(answersPath, 'utf8'));
    } catch (err) {
      console.error(`Couldn't read --answers file at ${answersPath}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  const [board, id] = key.split(':');
  const store = new ApplicationStore();
  const [record] = await store.list().then((all) => all.filter((r) => r.board === board && r.id === id));
  if (!record) {
    console.error(`No tracked job found for ${key}. Run "job-sourcing search" first.`);
    process.exitCode = 1;
    return;
  }

  if (board !== 'greenhouse' && board !== 'lever') {
    console.error(
      `Auto-apply isn't supported for "${board}" — its ToS restricts automated applications. ` +
        `Open ${record.url} and apply manually.`,
    );
    process.exitCode = 1;
    return;
  }

  const profile = await loadCandidateProfile();
  const client = new BrowserlessClient();
  const dryRun = process.env.DRY_RUN !== 'false';
  const applier = board === 'greenhouse' ? (await import('./apply/greenhouse-apply.js')).applyOnGreenhouse
                                          : (await import('./apply/lever-apply.js')).applyOnLever;

  const job = { board: record.board, id: record.id, title: record.title, company: record.company, url: record.url, applyUrl: record.url };
  const result = await applier(client, job, profile, { dryRun, answers });

  await store.record(job, { status: result.submitted ? 'applied' : 'filled' });

  console.log(`Screenshot saved to ${result.screenshotPath}`);
  console.log(`Filled ${result.filled.length} field(s); skipped ${result.skipped.length} field(s).`);
  if (result.skipped.length) {
    console.log('Skipped fields — add these to an --answers JSON file to fill them:');
    for (const f of result.skipped) {
      const options = f.options?.length ? ` [options: ${f.options.join(' | ')}]` : '';
      console.log(`  - "${f.name}" (${f.tag}${f.type && f.type !== 'text' ? `/${f.type}` : ''})${options}`);
    }
  }
  console.log(
    result.dryRun
      ? 'DRY_RUN is on — nothing was submitted. Review the screenshot, then re-run with DRY_RUN=false to submit.'
      : result.submitted
        ? 'Application submitted.'
        : result.blockedByRequiredFields
          ? 'NOT submitted: a required field was left unanswered. Add it to --answers and re-run.'
          : 'Form filled but no submit button was found — submit manually.',
  );
}

async function cmdPollApply() {
  const [board, ...flags] = rest;
  if (board !== 'greenhouse' && board !== 'lever') {
    console.error(
      'Usage: job-sourcing poll-apply <greenhouse|lever> [--companies=a,b] [--limit=N] ' +
        '[--submit] [--answers=file.json] [--titles=a,b] [--keywords=a,b] [--locations=a,b]\n\n' +
        "Only greenhouse and lever are supported for auto-apply — other boards' Terms of " +
        'Service restrict automated applications.',
    );
    process.exitCode = 1;
    return;
  }

  const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
  const list = (name) => flag(name)?.split(',').map((s) => s.trim()).filter(Boolean);

  let companies = list('companies');
  if (!companies?.length) {
    const boardsConfig = await loadBoardsConfig();
    companies = boardsConfig[board];
  }
  if (!companies?.length) {
    console.error(
      `No ${board} companies given. Pass --companies=a,b or add them to config/boards.json.`,
    );
    process.exitCode = 1;
    return;
  }

  let answers = {};
  const answersPath = flag('answers');
  if (answersPath) {
    try {
      answers = JSON.parse(await readFile(answersPath, 'utf8'));
    } catch (err) {
      console.error(`Couldn't read --answers file at ${answersPath}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const limitFlag = flag('limit');
  const limit = limitFlag ? Number(limitFlag) : DEFAULT_LIMIT;
  const submit = flags.includes('--submit');

  console.log(
    submit
      ? `Polling ${board} (${companies.join(', ')}) and submitting up to ${Math.min(limit, MAX_LIMIT)} ` +
        `new application(s) — no per-job review. Ctrl+C now to abort.`
      : `Polling ${board} (${companies.join(', ')}) — DRY RUN, nothing will be submitted ` +
        `(pass --submit to actually apply).`,
  );

  const profile = await loadCandidateProfile();
  const client = new BrowserlessClient();
  const store = new ApplicationStore();

  const result = await pollAndApply({
    client,
    board,
    companies,
    query: { titles: list('titles'), keywords: list('keywords'), locations: list('locations') },
    profile,
    answers,
    limit,
    submit,
    store,
    screenshotDir: './data/screenshots',
  });

  console.log(
    `Matched ${result.matched} job(s), attempted ${result.attempted}, submitted ${result.submitted}.`,
  );
  for (const r of result.results) {
    const label = `${r.job.board}:${r.job.id}  ${r.job.title} @ ${r.job.company}`;
    if (r.error) {
      console.log(`  [error] ${label} — ${r.error}`);
    } else if (r.submitted) {
      console.log(`  [applied] ${label}`);
    } else if (r.blockedByRequiredFields) {
      console.log(`  [needs-answers] ${label} — required field(s) unanswered, see screenshot: ${r.screenshotPath}`);
    } else {
      console.log(`  [filled, dry-run] ${label} — screenshot: ${r.screenshotPath}`);
    }
  }
}

async function cmdList() {
  const store = new ApplicationStore();
  const status = rest.find((arg) => !arg.startsWith('--'));
  const records = await store.list(status ? { status } : {});
  if (!records.length) {
    console.log('No tracked jobs yet. Run "job-sourcing search" first.');
    return;
  }
  for (const r of records) {
    console.log(`${r.board}:${r.id}\t${r.status}\t${r.title} @ ${r.company}\t${r.url}`);
  }
}

const commands = { search: cmdSearch, apply: cmdApply, 'poll-apply': cmdPollApply, list: cmdList };

if (!commands[command]) {
  console.log(`Usage: job-sourcing <search|apply|poll-apply|list> [args]

  search              Search all boards configured in config/boards.json
                      and record new results.
  apply <board>:<id>  Autofill (and, unless DRY_RUN=true, submit) an
    [--answers=file]  application for a tracked job, with a screenshot to
                      review before submitting. Only Greenhouse and Lever
                      support auto-apply. --answers points to a JSON file
                      of {"field label": "answer"} for questions the
                      candidate profile can't cover (run once without it
                      to see which fields were skipped, then fill those
                      in and re-run).
  poll-apply <board>  Search + autofill + (with --submit) apply, all in
                      one shot, no per-job review — the automated
                      counterpart to search+apply above. greenhouse or
                      lever only. Flags: --companies=a,b (else uses
                      config/boards.json), --limit=N (default 5, max 20
                      applications per run), --submit (omit for a dry
                      run), --answers=file.json, --titles/--keywords/
                      --locations=a,b. Skips anything already applied;
                      refuses to submit an application with an
                      unanswered required field.
  list [status]       List tracked jobs, optionally filtered by status
                      (seen | filled | needs-answers | applied).`);
  process.exitCode = command ? 1 : 0;
} else {
  try {
    await commands[command]();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
