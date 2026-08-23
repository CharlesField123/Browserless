import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesQuery } from '../src/boards/base.js';
import { ApplicationStore } from '../src/store.js';
import { renderTemplate, mergeProfile, saveCandidateProfile } from '../src/profile.js';
import { findAnswer, resolveFieldValue } from '../src/apply/autofill.js';
import { pollAndApply } from '../src/pipeline.js';
import { saveUploadedFile } from '../src/uploads.js';

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

test('mergeProfile merges nested objects (defaultAnswers) instead of replacing them', () => {
  const existing = {
    fullName: 'Jordan Candidate',
    defaultAnswers: { 'Start date': 'Immediately', Salary: '$150k' },
    location: { city: 'NYC', state: 'NY' },
  };
  const merged = mergeProfile(existing, {
    defaultAnswers: { 'Why us?': 'Because of the mission.' },
    location: { state: 'CA' },
  });

  // New defaultAnswers key added, existing ones preserved.
  assert.deepEqual(merged.defaultAnswers, {
    'Start date': 'Immediately',
    Salary: '$150k',
    'Why us?': 'Because of the mission.',
  });
  // location merged one level deep: city preserved, state overwritten.
  assert.deepEqual(merged.location, { city: 'NYC', state: 'CA' });
  // Untouched top-level field survives.
  assert.equal(merged.fullName, 'Jordan Candidate');
});

test('mergeProfile overwrites scalars and ignores explicit undefined', () => {
  const merged = mergeProfile({ email: 'old@example.com', phone: '111' }, { email: 'new@example.com', phone: undefined });
  assert.equal(merged.email, 'new@example.com');
  assert.equal(merged.phone, '111');
});

test('saveCandidateProfile creates a new profile, then merges subsequent updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  const path = join(dir, 'candidate.json');

  const first = await saveCandidateProfile(path, { fullName: 'Jordan Candidate', email: 'j@example.com' });
  assert.equal(first.fullName, 'Jordan Candidate');

  const second = await saveCandidateProfile(path, {
    defaultAnswers: { 'Work authorized?': 'Yes' },
    resumePath: './resume.pdf',
  });
  assert.equal(second.fullName, 'Jordan Candidate'); // preserved from first call
  assert.equal(second.email, 'j@example.com');
  assert.equal(second.resumePath, './resume.pdf');
  assert.deepEqual(second.defaultAnswers, { 'Work authorized?': 'Yes' });

  const third = await saveCandidateProfile(path, { defaultAnswers: { 'Why us?': 'Mission fit.' } });
  assert.deepEqual(third.defaultAnswers, { 'Work authorized?': 'Yes', 'Why us?': 'Mission fit.' });

  await rm(dir, { recursive: true, force: true });
});

test('saveUploadedFile decodes base64 and writes the file, sanitizing the name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  const content = Buffer.from('%PDF-1.4 fake resume content').toString('base64');

  const { path, bytes } = await saveUploadedFile(dir, 'resume.pdf', content);
  assert.equal(path, join(dir, 'resume.pdf'));
  assert.equal(bytes, Buffer.from(content, 'base64').length);
  assert.equal((await readFile(path, 'utf8')).startsWith('%PDF'), true);

  // Path traversal in the filename is neutralized, not honored.
  const { path: safePath } = await saveUploadedFile(dir, '../../etc/evil.pdf', content);
  assert.equal(safePath, join(dir, '.._.._etc_evil.pdf'));

  await rm(dir, { recursive: true, force: true });
});

test('saveUploadedFile rejects empty content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-sourcing-'));
  await assert.rejects(() => saveUploadedFile(dir, 'resume.pdf', ''), /empty/i);
  await rm(dir, { recursive: true, force: true });
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

test('findAnswer never matches a blank field label against any answer', () => {
  // Regression test: JS's ''.includes('') (and 'anything'.includes(''))
  // is always true, so the substring fallback used to treat an empty
  // field label as matching every answer key — silently handing a
  // blank-labelled field (describeFields() reports these for custom
  // widgets' unnamed internal sub-elements) whichever answer happened to
  // be first in iteration order.
  const answers = { Country: 'United States', 'Current Company': 'Acme' };
  assert.equal(findAnswer('', answers), undefined);
  assert.equal(findAnswer('   ', answers), undefined);
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
