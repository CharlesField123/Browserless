import { JobBoardAdapter, matchesQuery } from './base.js';
import { humanDelay } from '../throttle.js';
import { logger } from '../logger.js';
import { serverProfileDir } from '../profile-dir.js';

/**
 * Indeed has no public search API and its Terms of Use restrict
 * automated access, so this adapter is opt-in only (ALLOW_INDEED=true)
 * and read-only — it never submits an application. Use it sparingly,
 * for your own personal job search, respecting Indeed's robots.txt and
 * rate limits (the shared BrowserlessClient already adds human-scale
 * delays between actions). Prefer the greenhouse/lever adapters, which
 * use official public APIs, whenever a role is posted on either.
 */
export class IndeedAdapter extends JobBoardAdapter {
  name = 'indeed';

  constructor(client) {
    super();
    if (process.env.ALLOW_INDEED !== 'true') {
      throw new Error(
        'IndeedAdapter is disabled by default because Indeed\'s Terms of Use restrict ' +
          'automated scraping. Set ALLOW_INDEED=true if you have reviewed and accept that risk.',
      );
    }
    this.client = client;
  }

  async search({ titles = [], locations = [''], keywords = [] } = {}) {
    const results = [];
    for (const title of titles.length ? titles : ['']) {
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
    const url = new URL('https://www.indeed.com/jobs');
    if (query) url.searchParams.set('q', query);
    if (locationQuery) url.searchParams.set('l', locationQuery);

    return this.client.withPage({ trackingId: 'indeed', userDataDir: serverProfileDir('indeed') }, async (page) => {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      await page
        .waitForSelector('[data-testid="slider_item"], .jobsearch-ResultsList', { timeout: 15000 })
        .catch(() => logger.warn('Indeed results selector not found; page markup may have changed.'));

      return page.evaluate((board) => {
        const cards = Array.from(document.querySelectorAll('[data-testid="slider_item"]'));
        return cards.map((card) => {
          const titleEl = card.querySelector('h2 a, [data-testid="job-title"] a');
          const companyEl = card.querySelector('[data-testid="company-name"]');
          const locationEl = card.querySelector('[data-testid="text-location"]');
          const href = titleEl?.getAttribute('href') ?? '';
          const id = new URL(href, location.href).searchParams.get('jk') ?? href;
          return {
            board,
            id,
            title: titleEl?.textContent?.trim() ?? '',
            company: companyEl?.textContent?.trim() ?? '',
            location: locationEl?.textContent?.trim(),
            url: new URL(href, location.href).toString(),
          };
        });
      }, this.name);
    });
  }
}
