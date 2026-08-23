import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Minimal JSON-file backed tracker for jobs seen/applied, keyed by a
 * stable job id (board + external id). Keeps the toolkit dependency-free
 * (no database) while still preventing duplicate applications across runs.
 */
export class ApplicationStore {
  constructor(path = process.env.APPLICATION_STORE_PATH ?? './data/applications.json') {
    this.path = resolve(path);
    this.records = null;
  }

  async #load() {
    if (this.records) return this.records;
    try {
      const raw = await readFile(this.path, 'utf8');
      this.records = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.records = {};
    }
    return this.records;
  }

  async #save() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.records, null, 2));
  }

  static keyFor(job) {
    return `${job.board}:${job.id}`;
  }

  async has(job) {
    const records = await this.#load();
    return Boolean(records[ApplicationStore.keyFor(job)]);
  }

  /**
   * `status` is intentionally *not* defaulted in the destructure: a caller
   * passing `{ status: undefined }` (e.g. search re-recording an
   * already-tracked job to refresh its title/url, without wanting to
   * touch its status) means "leave status as it was" — falling through to
   * the existing record's status, and only to 'seen' for a genuinely new
   * one. Defaulting `status` in the parameter itself would make an
   * explicit `undefined` clobber e.g. 'applied' back to 'seen' on every
   * re-search, which is a real correctness hazard now that pollAndApply
   * (../pipeline.js) relies on 'applied' meaning "already submitted,
   * never retry".
   */
  async record(job, { status, ...extra } = {}) {
    const records = await this.#load();
    const key = ApplicationStore.keyFor(job);
    records[key] = {
      ...records[key],
      board: job.board,
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      status: status ?? records[key]?.status ?? 'seen',
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    await this.#save();
    return records[key];
  }

  async list({ status } = {}) {
    const records = await this.#load();
    const all = Object.values(records);
    return status ? all.filter((r) => r.status === status) : all;
  }
}
