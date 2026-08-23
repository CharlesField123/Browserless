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
 *
 * Some fields describeFields() walks have no usable label at all (custom
 * widgets' internal sub-elements, reported upstream as an empty-string
 * name) — `target` is `""` for those. Every string's `.includes("")` is
 * `true` in JS, so without the `target &&` guard below, the substring
 * fallback's `q.includes(target)` check was trivially true for ANY
 * answer key against ANY blank-labelled field, silently handing it
 * whichever answer happened to be first in iteration order rather than
 * correctly falling through to "unanswered". A blank label has nothing
 * to substring-match against, so it must never match here.
 */
export function findAnswer(fieldName, answers = {}) {
  const target = fieldName.trim().toLowerCase();
  for (const [question, value] of Object.entries(answers)) {
    if (question.trim().toLowerCase() === target) return value;
  }
  if (!target) return undefined;
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

const AUTOFILL_ID_ATTR = 'data-job-sourcing-field-id';

/**
 * Tags every input/textarea/select with a stable, unique attribute and
 * returns a description of each. The attribute (not positional index into
 * a re-queried NodeList) is what fill-time code uses to find the element
 * again — see the comment on AUTOFILL_ID_ATTR lookups below for why.
 */
async function describeFields(page) {
  return page.evaluate((idAttr) => {
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
      el.setAttribute(idAttr, String(index));
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
  }, AUTOFILL_ID_ATTR);
}

/**
 * Finds the element for `field` by the stable attribute describeFields()
 * tagged it with, NOT by re-querying and indexing into
 * `document.querySelectorAll('input, textarea, select')` fresh.
 *
 * That re-query approach is what this replaces, and it was actively wrong:
 * typing into one field or selecting a <select> option fires input/change
 * events, and on these React-driven ATS forms that routinely mounts or
 * unmounts other elements (conditional fields, inline validation nodes,
 * live-search widgets). Every element after the mutation point shifts by
 * one or more positions in document order, so a later field's captured
 * index silently pointed at a different element than the one we described
 * — symptoms seen in practice: an answer meant for field N landing in
 * field N+1, and some fields (custom country/phone widgets in particular)
 * ending up targeting a hidden or unrelated node and never visibly filling.
 * Tagging the actual element up front and looking it up by that tag is
 * immune to how many siblings come and go around it.
 */
function findFieldHandle(page, field) {
  return page.$(`[${AUTOFILL_ID_ATTR}="${field.index}"]`);
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

/**
 * Selects a <select> option by matching `want` against option text
 * (preferred), then value.
 *
 * Greenhouse's newer application forms render these as React-controlled
 * selects. React overrides the native `value` property setter on the
 * element instance so it can track whether a change came through its own
 * controlled-input path. A plain `el.value = ...` bypasses that tracked
 * setter entirely: the assignment "sticks" on the raw DOM node for a
 * moment, but React's own state never learns about it, so the *next*
 * re-render (routinely triggered by filling any other field further down
 * the same form) snaps the element back to whatever React still believes
 * the value is — typically empty. That matched the observed symptom
 * exactly: the field is reported filled, but the page keeps showing the
 * unselected placeholder.
 *
 * The fix is the standard workaround for scripting React-controlled
 * inputs: call the *native* value setter (grabbed from the prototype,
 * before React's per-instance override shadows it) so the assignment goes
 * through the same path React itself uses, then dispatch input/change so
 * React's synthetic event system picks it up and updates its own state to
 * match — at which point later re-renders preserve it instead of
 * reverting it.
 */
async function selectOption(page, index, want) {
  return page.evaluate(
    (i, wantValue, idAttr) => {
      const el = document.querySelector(`[${idAttr}="${i}"]`);
      if (!el) return false;
      const options = Array.from(el.options);
      const wanted = String(wantValue).trim().toLowerCase();
      const match =
        options.find((o) => o.textContent.trim().toLowerCase() === wanted) ||
        options.find((o) => o.value.toLowerCase() === wanted) ||
        options.find((o) => o.textContent.trim().toLowerCase().includes(wanted));
      if (!match) return false;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, match.value);
      } else {
        el.value = match.value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    index,
    want,
    AUTOFILL_ID_ATTR,
  );
}

/**
 * Surveys `job.applyUrl`'s form without filling or submitting anything —
 * just navigates, reads every field (same detail as autofillApplication's
 * `skipped` report: type, required, and select options), and marks
 * whether the candidate profile/`answers` would currently resolve it.
 * No screenshot, no typing, no status side effects.
 *
 * Use this to survey a job's custom questions cheaply — across many jobs,
 * before committing to a real autofillApplication run — and answer them
 * via the MCP set_candidate_profile tool's `defaultAnswers` (to persist
 * across applications) rather than discovering them one at a time through
 * a full dry-run apply.
 */
export async function inspectApplication(client, job, profile, { answers = {} } = {}) {
  return client.withPage({}, async (page) => {
    await page.goto(job.applyUrl ?? job.url, { waitUntil: 'domcontentloaded' });
    await dismissCommonBanners(page);

    const fields = await describeFields(page);
    return fields.map((field) => {
      if (field.type === 'file') {
        const covered =
          (/resume|cv/i.test(field.name) && Boolean(profile.resumePath)) ||
          (/cover/i.test(field.name) && Boolean(profile.coverLetterPath));
        return { ...field, covered };
      }
      const value = resolveFieldValue(field.name, profile, job, answers);
      return { ...field, covered: value !== undefined };
    });
  });
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
          const input = await findFieldHandle(page, field);
          if (!input) {
            skipped.push(field);
            continue;
          }
          await input.uploadFile(resolve(profile.resumePath));
          filled.push({ ...field, value: profile.resumePath });
          continue;
        }
        if (/cover/i.test(field.name) && profile.coverLetterPath) {
          const input = await findFieldHandle(page, field);
          if (!input) {
            skipped.push(field);
            continue;
          }
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
        const handle = await findFieldHandle(page, field);
        if (!handle) {
          skipped.push(field);
          continue;
        }
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
