import { JobBoardAdapter, matchesQuery } from './base.js';
import { logger } from '../logger.js';

/**
 * Lever's Postings API is a public, unauthenticated JSON endpoint meant
 * for embedding a company's open roles elsewhere — no scraping or ToS
 * risk. Docs: https://github.com/lever/postings-api
 *
 * `sites` are the company's Lever slugs, e.g. for
 * https://jobs.lever.co/acme it's "acme".
 */
export class LeverAdapter extends JobBoardAdapter {
  name = 'lever';

  constructor(sites = []) {
    super();
    this.sites = sites;
  }

  async search(query = {}) {
    const results = [];
    for (const site of this.sites) {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn(`Lever site "${site}" fetch failed: ${res.status}`);
        continue;
      }
      const postings = await res.json();
      for (const posting of postings) {
        const normalized = {
          board: this.name,
          id: posting.id,
          title: posting.text,
          company: site,
          location: posting.categories?.location,
          url: posting.hostedUrl,
          applyUrl: posting.applyUrl ?? posting.hostedUrl,
          description: stripHtml(`${posting.descriptionPlain ?? posting.description ?? ''}`),
          postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : undefined,
        };
        if (matchesQuery(normalized, query)) results.push(normalized);
      }
    }
    return results;
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
