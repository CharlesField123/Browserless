import { JobBoardAdapter, matchesQuery } from './base.js';
import { humanDelay } from '../throttle.js';
import { logger } from '../logger.js';
import { serverProfileDir } from '../profile-dir.js';

/**
 * LinkedIn's Terms of Service explicitly prohibit automated scraping and
 * automated ("Easy Apply") submissions, and LinkedIn actively detects and
 * bans accounts that do this. This adapter is therefore:
 *
 *  - disabled unless ALLOW_LINKEDIN=true is set explicitly
 *  - read-only: it only ever lists jobs from search results, it never
 *    clicks "Apply" or "Easy Apply" — use the returned `url` to apply
 *    yourself, or feed listings whose employer links out to a
 *    Greenhouse/Lever board to those adapters/fillers instead
 *  - built to reuse a persistent on-disk profile (`userDataDir`) you log
 *    into manually once via the Debug Viewer, rather than automating
 *    credentials/2FA — see JOB_SOURCING.md's "Persistent logins" section
 *
 * Use at your own risk and read LinkedIn's User Agreement before enabling.
 */
export class LinkedInAdapter extends JobBoardAdapter {
  name = 'linkedin';

  constructor(client) {
    super();
    if (process.env.ALLOW_LINKEDIN !== 'true') {
      throw new Error(
        'LinkedInAdapter is disabled by default because LinkedIn\'s Terms of Service ' +
          'prohibit automated scraping/applying. Set ALLOW_LINKEDIN=true only if you ' +
          'have read those terms and accept the risk to your account.',
      );
    }
    this.client = client;
  }

  async search({ titles = [''], locations = [''], keywords = [] } = {}) {
    const results = [];
    for (const title of titles) {
      for (const locationQuery of locations) {
        await humanDelay();
        const jobs = await this.#searchOne(title, locationQuery);
        for (const job of jobs) {
          if (matchesQuery(job, { titles, keywords })) results.push(job);
        }
      }
    }
    return results;
  }

  async #searchOne(query, locationQuery) {
    const url = new URL('https://www.linkedin.com/jobs/search/');
    if (query) url.searchParams.set('keywords', query);
    if (locationQuery) url.searchParams.set('location', locationQuery);

    return this.client.withPage(
      { trackingId: 'linkedin', userDataDir: serverProfileDir('linkedin') },
      async (page) => {
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

        const loggedOut = await page.$('a[href*="/login"]');
        if (loggedOut) {
          logger.warn(
            'LinkedIn session appears logged out. Log in once through the Debug Viewer ' +
              '(http://localhost:3000/docs) using userDataDir="' +
              serverProfileDir('linkedin') +
              '" so this profile stays authenticated — see JOB_SOURCING.md.',
          );
        }

        await page
          .waitForSelector('.jobs-search__results-list, .scaffold-layout__list', { timeout: 15000 })
          .catch(() => logger.warn('LinkedIn results selector not found; page markup may have changed.'));

        return page.evaluate((board) => {
          const cards = Array.from(document.querySelectorAll('.jobs-search__results-list > li, .scaffold-layout__list li'));
          return cards
            .map((card) => {
              const titleEl = card.querySelector('.base-search-card__title, .job-card-list__title');
              const companyEl = card.querySelector('.base-search-card__subtitle, .job-card-container__company-name');
              const locationEl = card.querySelector('.job-search-card__location');
              const linkEl = card.querySelector('a.base-card__full-link, a.job-card-list__title');
              const href = linkEl?.getAttribute('href') ?? '';
              const idMatch = href.match(/-(\d+)(?:\?|$)/);
              return {
                board,
                id: idMatch?.[1] ?? href,
                title: titleEl?.textContent?.trim() ?? '',
                company: companyEl?.textContent?.trim() ?? '',
                location: locationEl?.textContent?.trim(),
                url: href.split('?')[0],
              };
            })
            .filter((job) => job.title);
        }, this.name);
      },
    );
  }
}
