#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from './env.js';
import { BrowserlessClient } from './client.js';
import { loadCandidateProfile } from './profile.js';
import { ApplicationStore } from './store.js';
import { GreenhouseAdapter } from './boards/greenhouse.js';
import { LeverAdapter } from './boards/lever.js';
import { logger } from './logger.js';

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
  const [key] = rest;
  if (!key) {
    console.error('Usage: job-sourcing apply <board>:<id>');
    process.exitCode = 1;
    return;
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
  const result = await applier(client, job, profile, { dryRun });

  await store.record(job, { status: result.submitted ? 'applied' : 'filled' });

  console.log(`Screenshot saved to ${result.screenshotPath}`);
  console.log(`Filled ${result.filled.length} field(s); skipped ${result.skipped.length} field(s).`);
  if (result.skipped.length) {
    console.log('Skipped fields (review manually):', result.skipped.map((f) => f.name).join(', '));
  }
  console.log(
    result.dryRun
      ? 'DRY_RUN is on — nothing was submitted. Review the screenshot, then re-run with DRY_RUN=false to submit.'
      : result.submitted
        ? 'Application submitted.'
        : 'Form filled but no submit button was found — submit manually.',
  );
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

const commands = { search: cmdSearch, apply: cmdApply, list: cmdList };

if (!commands[command]) {
  console.log(`Usage: job-sourcing <search|apply|list> [args]

  search              Search all boards configured in config/boards.json
                      and record new results.
  apply <board>:<id>  Autofill (and, unless DRY_RUN=true, submit) an
                      application for a tracked job. Only Greenhouse and
                      Lever support auto-apply.
  list [status]       List tracked jobs, optionally filtered by status
                      (seen | filled | applied).`);
  process.exitCode = command ? 1 : 0;
} else {
  try {
    await commands[command]();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
