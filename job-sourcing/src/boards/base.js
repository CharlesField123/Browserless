/**
 * @typedef {object} Job
 * @property {string} board        - Adapter name, e.g. "greenhouse".
 * @property {string} id           - Stable id, unique within `board`.
 * @property {string} title
 * @property {string} company
 * @property {string} [location]
 * @property {string} url          - Human-viewable listing URL.
 * @property {string} [applyUrl]   - URL of the actual application form, if different.
 * @property {string} [description]
 * @property {string} [postedAt]   - ISO date string, if known.
 */

/**
 * Base contract every board adapter implements. Adapters that only
 * support read-only search (e.g. LinkedIn) simply omit `apply`.
 */
export class JobBoardAdapter {
  /** @type {string} */
  name = 'base';

  /**
   * @param {{titles?: string[], locations?: string[], keywords?: string[]}} _query
   * @returns {Promise<Job[]>}
   */
  async search(_query) {
    throw new Error(`${this.constructor.name} does not implement search()`);
  }
}

export function matchesQuery(job, { titles = [], keywords = [] } = {}) {
  const haystack = `${job.title} ${job.description ?? ''}`.toLowerCase();
  const titleOk = titles.length === 0 || titles.some((t) => haystack.includes(t.toLowerCase()));
  const keywordOk = keywords.length === 0 || keywords.some((k) => haystack.includes(k.toLowerCase()));
  return titleOk && keywordOk;
}
