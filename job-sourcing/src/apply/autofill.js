import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { renderTemplate } from '../profile.js';
import { logger } from '../logger.js';

/**
 * Generic, label-driven ATS form filler.
 *
 * Application forms vary a lot between employers, so instead of hardcoding
 * selectors this walks every input/textarea/select on the page, works out
 * a human-readable "field name" for it (its <label>, aria-label,
 * placeholder, or name attribute), and fills it if that name matches a
 * known pattern for the candidate profile — or, more usefully for the
 * many custom per-company questions a static profile can't anticipate
 * ("why do you want to work here?", role-specific screening questions,
 * salary expectations for *this* role), an `answers` map supplied for
 * this specific application. Anything still unmatched is left alone and
 * reported (with its type and, for <select>, its options) so a caller —
 * a human, or an LLM reading the skipped list and composing answers from
 * the job description — can supply `answers` and re-run before submitting.
 *
 * This is deliberately conservative: it NEVER clicks submit unless
 * `dryRun: false` is passed explicitly, it always screenshots the filled
 * form first so you can sanity-check the result, and even with
 * `dryRun: false` it refuses to click submit if any *required* field
 * (`el.required`/`aria-required`) went unanswered — better to return an
 * unsubmitted, reviewable form (`blockedByRequiredFields: true`) than send
 * something incomplete. This matters most for the fully-automated
 * pollAndApply pipeline (../pipeline.js), which has no per-job human
 * review step to catch it otherwise.
 */

const FIELD_PATTERNS = [
  { test: /first.?name/i, fill: (p) => p.firstName },
  { test: /last.?name/i, fill: (p) => p.lastName },
  { test: /full.?name|your.?name|^name$/i, fill: (p) => p.fullName },
  { test: /e-?mail/i, fill: (p) => p.email },
  { test: /phone/i, fill: (p) => p.phone },
  { test: /linked.?in/i, fill: (p) => p.links?.linkedin },
  { test: /git.?hub/i, fill: (p) => p.links?.github },
  { test: /portfolio|website|personal site/i, fill: (p) => p.links?.portfolio },
  { test: /city/i, fill: (p) => p.location?.city },
  { test: /^state$|province/i, fill: (p) => p.location?.state },
  { test: /country/i, fill: (p) => p.location?.country },
];

function matchProfileValue(fieldName, profile, job) {
  for (const { test, fill } of FIELD_PATTERNS) {
    if (test.test(fieldName)) {
      const value = fill(profile);
      if (value) return value;
    }
  }
  if (/cover.?letter/i.test(fieldName) && profile.coverLetterTemplate) {
    return renderTemplate(profile.coverLetterTemplate, {
      company: job?.company ?? '',
      title: job?.title ?? '',
    });
  }
  const defaultAnswer = Object.entries(profile.defaultAnswers ?? {}).find(([question]) =>
    fieldName.toLowerCase().includes(question.toLowerCase().slice(0, 20)),
  );
  return defaultAnswer?.[1];
}

/**
 * Looks up a per-application override for `fieldName` in `answers`
 * (a plain {question: answer} map — see autofillApplication's `answers`
 * option). Tries an exact case-insensitive match first — the reliable
 * path when a caller copies a field name verbatim from a previous
 * autofillApplication result's `skipped` list — then falls back to a
 * substring match either direction for minor label drift.
 */
export function findAnswer(fieldName, answers = {}) {
  const target = fieldName.trim().toLowerCase();
  for (const [question, value] of Object.entries(answers)) {
    if (question.trim().toLowerCase() === target) return value;
  }
  for (const [question, value] of Object.entries(answers)) {
    const q = question.trim().toLowerCase();
    if (q && (target.includes(q) || q.includes(target))) return value;
  }
  return undefined;
}

/** Per-application `answers` take priority over the static candidate profile. */
export function resolveFieldValue(fieldName, profile, job, answers) {
  const manual = findAnswer(fieldName, answers);
  if (manual !== undefined) return manual;
  return matchProfileValue(fieldName, profile, job);
}

async function describeFields(page) {
  return page.evaluate(() => {
    function labelFor(el) {
      if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder;
      return el.getAttribute('name') || el.id || '';
    }
    const els = Array.from(document.querySelectorAll('input, textarea, select'));
    return els.map((el, index) => {
      const tag = el.tagName.toLowerCase();
      const field = {
        index,
        tag,
        type: el.getAttribute('type') || 'text',
        name: labelFor(el),
        required: el.required || el.getAttribute('aria-required') === 'true',
      };
      if (tag === 'select') {
        field.options = Array.from(el.options)
          .map((o) => o.textContent.trim())
          .filter(Boolean);
      }
      return field;
    });
  });
}

/** Best-effort dismissal of cookie-consent/GDPR overlays that otherwise block form fields. */
async function dismissCommonBanners(page) {
  const selectors = ['button#onetrust-accept-btn-handler', 'button[aria-label*="accept" i][aria-label*="cookie" i]'];
  for (const selector of selectors) {
    const el = await page.$(selector).catch(() => null);
    if (el) {
      await el.click().catch(() => {});
      return;
    }
  }
  await page
    .evaluate(() => {
      const needle = /^(accept all|accept all cookies|accept cookies|i accept)$/i;
      const button = Array.from(document.querySelectorAll('button')).find((b) =>
        needle.test(b.textContent.trim()),
      );
      button?.click();
    })
    .catch(() => {});
}

/** Selects a <select> option by matching `want` against option text (preferred), then value. */
async function selectOption(page, index, want) {
  return page.evaluate(
    (i, wantValue) => {
      const el = document.querySelectorAll('input, textarea, select')[i];
      const options = Array.from(el.options);
      const wanted = String(wantValue).trim().toLowerCase();
      const match =
        options.find((o) => o.textContent.trim().toLowerCase() === wanted) ||
        options.find((o) => o.value.toLowerCase() === wanted) ||
        options.find((o) => o.textContent.trim().toLowerCase().includes(wanted));
      if (!match) return false;
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    index,
    want,
  );
}

/**
 * Fills `job.applyUrl` using `profile`, optionally overridden per-field by
 * `answers` (see resolveFieldValue). Returns a report of what was filled,
 * what was skipped (with enough detail — type, and options for selects —
 * to compose an `answers` entry for it), and where the review screenshot
 * was saved.
 */
export async function autofillApplication(
  client,
  job,
  profile,
  { dryRun = true, screenshotDir = './data/screenshots', answers = {} } = {},
) {
  return client.withPage({}, async (page) => {
    await page.goto(job.applyUrl ?? job.url, { waitUntil: 'domcontentloaded' });
    await dismissCommonBanners(page);

    const fields = await describeFields(page);
    const filled = [];
    const skipped = [];

    for (const field of fields) {
      if (field.type === 'file') {
        if (/resume|cv/i.test(field.name) && profile.resumePath) {
          const input = (await page.$$('input, textarea, select'))[field.index];
          await input.uploadFile(resolve(profile.resumePath));
          filled.push({ ...field, value: profile.resumePath });
          continue;
        }
        if (/cover/i.test(field.name) && profile.coverLetterPath) {
          const input = (await page.$$('input, textarea, select'))[field.index];
          await input.uploadFile(resolve(profile.coverLetterPath));
          filled.push({ ...field, value: profile.coverLetterPath });
          continue;
        }
        skipped.push(field);
        continue;
      }

      const value = resolveFieldValue(field.name, profile, job, answers);
      if (value === undefined) {
        skipped.push(field);
        continue;
      }

      if (field.tag === 'select') {
        const ok = await selectOption(page, field.index, value);
        if (!ok) {
          skipped.push(field);
          continue;
        }
      } else {
        const handle = (await page.$$('input, textarea, select'))[field.index];
        await handle.click({ clickCount: 3 }).catch(() => {});
        await handle.type(String(value), { delay: 15 });
      }
      filled.push({ ...field, value });
    }

    const screenshotPath = resolve(screenshotDir, `${job.board}-${job.id}.png`);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    let submitted = false;
    const unansweredRequired = skipped.filter((f) => f.required);
    const blockedByRequiredFields = unansweredRequired.length > 0;
    if (!dryRun) {
      if (blockedByRequiredFields) {
        logger.warn(
          `${job.board}:${job.id} has unanswered required field(s) — not submitting: ` +
            unansweredRequired.map((f) => f.name).join(', '),
        );
      } else {
        const submitButton = await page.$(
          'button[type="submit"], input[type="submit"], button[aria-label*="submit" i]',
        );
        if (submitButton) {
          await submitButton.click();
          submitted = true;
        } else {
          logger.warn(`No submit button found for ${job.board}:${job.id} — leaving unsubmitted.`);
        }
      }
    }

    return { job, filled, skipped, screenshotPath, submitted, dryRun, blockedByRequiredFields };
  });
}
