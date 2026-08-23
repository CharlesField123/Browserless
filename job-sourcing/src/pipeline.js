import { GreenhouseAdapter } from './boards/greenhouse.js';
import { LeverAdapter } from './boards/lever.js';
import { applyOnGreenhouse } from './apply/greenhouse-apply.js';
import { applyOnLever } from './apply/lever-apply.js';
import { humanDelay } from './throttle.js';
import { logger } from './logger.js';

const DEFAULT_ADAPTERS = { greenhouse: GreenhouseAdapter, lever: LeverAdapter };
const DEFAULT_APPLIERS = { greenhouse: applyOnGreenhouse, lever: applyOnLever };

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;

/**
 * Poll-then-apply: searches a board and, for jobs it hasn't already acted
 * on, immediately autofills and (when `submit` is true) submits each one —
 * no per-job review step in between. This is the fully-automated
 * counterpart to the manual `search -> review a screenshot -> apply(submit:
 * true)` flow (see job-sourcing/README.md, MCP.md); use that instead when
 * you want to look at each application before it goes out.
 *
 * Because there's no human in the loop here, this leans on guardrails the
 * manual flow doesn't need:
 *   - `limit` (default 5, hard-capped at MAX_LIMIT) bounds how many
 *     applications a single call can submit — some boards (staffing
 *     firms especially) can return thousands of matches.
 *   - Only "seen" jobs (found, never touched) are attempted. A job this
 *     pipeline already filled-but-couldn't-submit, or that a previous
 *     apply_to_job call touched, is left alone — it needs a human with
 *     tailored `answers`, not a blind retry.
 *   - autofillApplication itself refuses to submit any application with
 *     an unanswered *required* field (see apply/autofill.js) — this
 *     pipeline surfaces that per-job as `blockedByRequiredFields` rather
 *     than silently sending an incomplete application.
 *   - `humanDelay()` between applications, same as search.
 *
 * Only Greenhouse and Lever are supported, same ToS-driven restriction as
 * the rest of auto-apply (see JOB_SOURCING.md's Ethics section).
 *
 * @param {object} options
 * @param {import('./client.js').BrowserlessClient} options.client
 * @param {'greenhouse'|'lever'} options.board
 * @param {string[]} [options.companies] - board slugs to search; required unless the adapter has its own default.
 * @param {object} [options.query] - {titles, keywords, locations} passed to the board adapter's search().
 * @param {object} options.profile - candidate profile, see profile.js.
 * @param {Record<string,string>} [options.answers] - applied to every job in this batch (see apply/autofill.js).
 * @param {number} [options.limit] - max applications to submit this call (1..MAX_LIMIT).
 * @param {boolean} [options.submit] - actually submit (vs. fill + screenshot only). Defaults to false.
 * @param {import('./store.js').ApplicationStore} options.store
 * @param {string} [options.screenshotDir]
 * @param {Record<string, Function>} [options.adapters] - injectable for testing.
 * @param {Record<string, Function>} [options.appliers] - injectable for testing.
 */
export async function pollAndApply({
  client,
  board,
  companies,
  query = {},
  profile,
  answers = {},
  limit = DEFAULT_LIMIT,
  submit = false,
  store,
  screenshotDir,
  adapters = DEFAULT_ADAPTERS,
  appliers = DEFAULT_APPLIERS,
}) {
  const Adapter = adapters[board];
  const apply = appliers[board];
  if (!Adapter || !apply) {
    throw new Error(
      `pollAndApply only supports "greenhouse" or "lever" (got "${board}") — other boards' ` +
        "Terms of Service restrict automated applications.",
    );
  }
  const cappedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));

  const jobs = await new Adapter(companies).search(query);

  let newlySeen = 0;
  for (const job of jobs) {
    const alreadyTracked = await store.has(job);
    await store.record(job, { status: alreadyTracked ? undefined : 'seen' });
    if (!alreadyTracked) newlySeen += 1;
  }

  const candidates = (await store.list({ status: 'seen' })).filter((r) =>
    jobs.some((j) => j.board === r.board && j.id === r.id),
  );

  const applied = [];
  for (const record of candidates) {
    if (applied.filter((r) => r.submitted).length >= cappedLimit) break;

    const job = jobs.find((j) => j.board === record.board && j.id === record.id);
    await humanDelay();

    let result;
    try {
      result = await apply(client, job, profile, {
        dryRun: !submit,
        screenshotDir,
        answers,
      });
    } catch (err) {
      logger.error(`pollAndApply: ${job.board}:${job.id} failed: ${err.message}`);
      await store.record(job, { status: 'seen' });
      applied.push({ job, submitted: false, error: err.message });
      continue;
    }

    const status = result.submitted ? 'applied' : result.blockedByRequiredFields ? 'needs-answers' : 'filled';
    await store.record(job, { status });
    applied.push({ job, ...result });
  }

  return {
    board,
    matched: jobs.length,
    newlySeen,
    attempted: applied.length,
    submitted: applied.filter((r) => r.submitted).length,
    limit: cappedLimit,
    results: applied,
  };
}
