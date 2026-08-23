import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesQuery } from '../src/boards/base.js';
import { ApplicationStore } from '../src/store.js';
import { renderTemplate } from '../src/profile.js';
import { findAnswer, resolveFieldValue } from '../src/apply/autofill.js';
import { pollAndApply } from '../src/pipeline.js';

test('matchesQuery filters by title and keyword', () => {
  const job = { title: 'Senior Backend Engineer', description: 'We use TypeScript and Node.js' };
  assert.equal(matchesQuery(job, { titles: ['Backend Engineer'] }), true);
  assert.equal(matchesQuery(job, { titles: ['Product Manager'] }), false);
  assert.equal(matchesQuery(job, { keywords: ['typescript'] }), true);
  assert.equal(matchesQuery(job, { keywords: ['ruby'] }), false);
  assert.equal(matchesQuery(job, {}), true);
});

test('renderTemplate substitutes known variables and blanks unknowns', () => {
  const out = renderTemplate('Hi {{company}}, re: {{title}} ({{missing}})', {
    company: 'Acme',
    title: 'Engineer',
  });
  assert.equal(out, 'Hi Acme, re: Engineer ()');
});

test('findAnswer matches exact label first, then substring either direction', () => {
  const answers = {
    'Why do you want to work here?': 'Because of the mission.',
    salary: '$150k',
  };
  assert.equal(findAnswer('Why do you want to work here?', answers), 'Because of the mission.');
  assert.equal(findAnswer('Why do you want to work here? *', answers), 'Because of the mission.');
  assert.equal(findAnswer('Desired salary range', answers), '$150k');
  assert.equal(findAnswer('Unrelated field', answers), undefined);
  assert.equal(findAnswer('Anything', {}), undefined);
});

test('resolveFieldValue prefers a per-application answer over the static profile', () => {
  const profile = { email: 'a@example.com', defaultAnswers: { 'Start date': 'Immediately' } };
  assert.equal(resolveFieldValue('Email', profile, {}, {}), 'a@example.com');
  assert.equal(
    resolveFieldValue('Start date', profile, {}, { 'Start date': '2 weeks notice' }),
    '2 weeks notice',
  );
  assert.equal(resolveFieldValue('Start date', profile, {}, {}), 'Immediately');
});

test('ApplicationStore dedupes and tracks status across calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  const store = new ApplicationStore(join(dir, 'applications.json'));
  const job = { board: 'greenhouse', id: '123', title: 'Engineer', company: 'Acme', url: 'https://example.com' };

  assert.equal(await store.has(job), false);
  await store.record(job, { status: 'seen' });
  assert.equal(await store.has(job), true);

  await store.record(job, { status: 'applied' });
  const [record] = await store.list({ status: 'applied' });
  assert.equal(record.id, '123');

  await rm(dir, { recursive: true, force: true });
});

test('ApplicationStore.record with no explicit status preserves the existing one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  const store = new ApplicationStore(join(dir, 'applications.json'));
  const job = { board: 'greenhouse', id: '123', title: 'Engineer', company: 'Acme', url: 'https://example.com' };

  await store.record(job, { status: 'applied' });

  // Mirrors how search_jobs/cmdSearch re-record an already-tracked job to
  // refresh title/url without touching status: `status: alreadySeen ?
  // undefined : 'seen'`. This must NOT reset 'applied' back to 'seen' --
  // that would let pollAndApply re-submit a job it already applied to.
  const alreadySeen = await store.has(job);
  await store.record(job, { status: alreadySeen ? undefined : 'seen' });

  const [record] = await store.list({ status: 'applied' });
  assert.equal(record.id, '123');
  assert.equal((await store.list({ status: 'seen' })).length, 0);
});

test('pollAndApply submits only up to the limit, leaving the rest tracked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  const store = new ApplicationStore(join(dir, 'applications.json'));
  const jobs = [1, 2, 3].map((n) => ({
    board: 'greenhouse',
    id: String(n),
    title: `Role ${n}`,
    company: 'acme',
    url: `https://boards.greenhouse.io/acme/jobs/${n}`,
  }));

  class FakeAdapter {
    async search() {
      return jobs;
    }
  }
  const applyOk = async (client, job) => ({
    job,
    filled: [],
    skipped: [],
    screenshotPath: join(dir, `${job.id}.png`),
    submitted: true,
    dryRun: false,
    blockedByRequiredFields: false,
  });

  const result = await pollAndApply({
    client: {},
    board: 'greenhouse',
    companies: ['acme'],
    profile: {},
    limit: 2,
    submit: true,
    store,
    screenshotDir: dir,
    adapters: { greenhouse: FakeAdapter },
    appliers: { greenhouse: applyOk },
  });

  assert.equal(result.matched, 3);
  assert.equal(result.submitted, 2);
  assert.equal(result.attempted, 2);
  assert.equal((await store.list({ status: 'applied' })).length, 2);
  assert.equal((await store.list({ status: 'seen' })).length, 1);

  await rm(dir, { recursive: true, force: true });
});

test('pollAndApply never retries a job already marked applied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  const store = new ApplicationStore(join(dir, 'applications.json'));
  const job = { board: 'lever', id: 'abc', title: 'Role', company: 'acme', url: 'https://jobs.lever.co/acme/abc' };
  await store.record(job, { status: 'applied' });

  let applyCalls = 0;
  class FakeAdapter {
    async search() {
      return [job];
    }
  }
  const apply = async () => {
    applyCalls += 1;
    throw new Error('should not be called');
  };

  const result = await pollAndApply({
    client: {},
    board: 'lever',
    companies: ['acme'],
    profile: {},
    submit: true,
    store,
    screenshotDir: dir,
    adapters: { lever: FakeAdapter },
    appliers: { lever: apply },
  });

  assert.equal(applyCalls, 0);
  assert.equal(result.attempted, 0);
  const [record] = await store.list({ status: 'applied' });
  assert.equal(record.id, 'abc');

  await rm(dir, { recursive: true, force: true });
});

test('pollAndApply marks a blocked (unanswered required field) job needs-answers, not applied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  const store = new ApplicationStore(join(dir, 'applications.json'));
  const job = { board: 'greenhouse', id: '1', title: 'Role', company: 'acme', url: 'https://boards.greenhouse.io/acme/jobs/1' };

  class FakeAdapter {
    async search() {
      return [job];
    }
  }
  const applyBlocked = async (client, j) => ({
    job: j,
    filled: [],
    skipped: [{ name: 'Are you legally authorized to work?', required: true }],
    screenshotPath: join(dir, '1.png'),
    submitted: false,
    dryRun: false,
    blockedByRequiredFields: true,
  });

  const result = await pollAndApply({
    client: {},
    board: 'greenhouse',
    companies: ['acme'],
    profile: {},
    submit: true,
    store,
    screenshotDir: dir,
    adapters: { greenhouse: FakeAdapter },
    appliers: { greenhouse: applyBlocked },
  });

  assert.equal(result.submitted, 0);
  assert.equal(result.attempted, 1);
  const [record] = await store.list({ status: 'needs-answers' });
  assert.equal(record.id, '1');

  await rm(dir, { recursive: true, force: true });
});

test('pollAndApply rejects boards outside the Greenhouse/Lever allowlist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  const store = new ApplicationStore(join(dir, 'applications.json'));
  await assert.rejects(
    () => pollAndApply({ client: {}, board: 'linkedin', profile: {}, store, screenshotDir: dir }),
    /only supports "greenhouse" or "lever"/,
  );
  await rm(dir, { recursive: true, force: true });
});
