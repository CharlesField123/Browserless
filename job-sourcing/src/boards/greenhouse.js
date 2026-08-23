import { JobBoardAdapter, matchesQuery } from './base.js';
import { logger } from '../logger.js';

/**
 * Greenhouse's Job Board API is a public, unauthenticated JSON endpoint
 * that Greenhouse itself intends for embedding job listings elsewhere —
 * no scraping or ToS risk. Docs: https://developers.greenhouse.io/job-board.html
 *
 * `boardToken` is the company's Greenhouse slug, e.g. for
 * https://boards.greenhouse.io/acme it's "acme".
 */
export class GreenhouseAdapter extends JobBoardAdapter {
  name = 'greenhouse';

  constructor(boardTokens = []) {
    super();
    this.boardTokens = boardTokens;
  }

  async search(query = {}) {
    const results = [];
    for (const token of this.boardTokens) {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn(`Greenhouse board "${token}" fetch failed: ${res.status}`);
        continue;
      }
      const { jobs = [] } = await res.json();
      for (const job of jobs) {
        const normalized = {
          board: this.name,
          id: String(job.id),
          title: job.title,
          company: token,
          location: job.location?.name,
          url: job.absolute_url,
          applyUrl: job.absolute_url,
          description: stripHtml(job.content ?? ''),
          postedAt: job.updated_at,
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
