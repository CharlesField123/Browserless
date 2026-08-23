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

  async record(job, { status = 'seen', ...extra } = {}) {
    const records = await this.#load();
    const key = ApplicationStore.keyFor(job);
    records[key] = {
      ...records[key],
      board: job.board,
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      status,
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
