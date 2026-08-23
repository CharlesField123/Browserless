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
 * known pattern for the candidate profile. Anything it can't confidently
 * match is left alone and reported, so you can review before submitting.
 *
 * This is deliberately conservative: it NEVER clicks submit unless
 * `dryRun: false` is passed explicitly, and it always screenshots the
 * filled form first so you can sanity-check the result.
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
    return els.map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || 'text',
      name: labelFor(el),
    }));
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

/**
 * Fills `job.applyUrl` using `profile`. Returns a report of what was
 * filled, what was skipped, and where the review screenshot was saved.
 */
export async function autofillApplication(
  client,
  job,
  profile,
  { dryRun = true, screenshotDir = './data/screenshots' } = {},
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

      const value = matchProfileValue(field.name, profile, job);
      if (value === undefined) {
        skipped.push(field);
        continue;
      }

      const handle = (await page.$$('input, textarea, select'))[field.index];
      if (field.tag === 'select') {
        await handle.select(String(value)).catch(() => skipped.push(field));
      } else {
        await handle.click({ clickCount: 3 }).catch(() => {});
        await handle.type(String(value), { delay: 15 });
      }
      filled.push({ ...field, value });
    }

    const screenshotPath = resolve(screenshotDir, `${job.board}-${job.id}.png`);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    let submitted = false;
    if (!dryRun) {
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

    return { job, filled, skipped, screenshotPath, submitted, dryRun };
  });
}
