import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesQuery } from '../src/boards/base.js';
import { ApplicationStore } from '../src/store.js';
import { renderTemplate } from '../src/profile.js';
import { findAnswer, resolveFieldValue } from '../src/apply/autofill.js';

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
