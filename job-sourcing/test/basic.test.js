import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesQuery } from '../src/boards/base.js';
import { ApplicationStore } from '../src/store.js';
import { renderTemplate } from '../src/profile.js';

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
