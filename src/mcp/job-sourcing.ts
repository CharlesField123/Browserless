import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'path';
import { pathToFileURL } from 'url';
import { readFile } from 'fs/promises';
import { z } from 'zod';

/**
 * Bridges this server's built-in MCP endpoint (src/routes/management/http/mcp.post.ts)
 * to the job-sourcing/ toolkit (see JOB_SOURCING.md), which ships as plain,
 * un-compiled ESM alongside this repo rather than as part of the `src/`
 * TypeScript build. It's copied into the runtime image by
 * docker/chromium/Dockerfile so it's available at `<cwd>/job-sourcing` when
 * this server runs.
 *
 * These tools call the *same* Browserless server they're running inside of,
 * over a loopback WebSocket connection (`ws://127.0.0.1:<port>`) — see
 * MCP.md for why that's the "one Railway service" way to expose job search
 * and application-autofill to an MCP client like a claude.ai custom
 * connector, without standing up a second service.
 */

const jobSourcingRoot = () => path.join(process.cwd(), 'job-sourcing');
const jobSourcingSrc = (...parts: string[]) =>
  path.join(jobSourcingRoot(), 'src', ...parts);
const jobSourcingConfig = (...parts: string[]) =>
  path.join(jobSourcingRoot(), 'config', ...parts);
const jobSourcingData = (...parts: string[]) =>
  path.join(jobSourcingRoot(), 'data', ...parts);

// job-sourcing/ has no type declarations (it's plain JS by design, see its
// own README) so these imports are necessarily untyped at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = any;

async function importJobSourcing(relativePath: string): Promise<AnyModule> {
  const file = jobSourcingSrc(relativePath);
  try {
    return await import(pathToFileURL(file).href);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Couldn't load job-sourcing module "${relativePath}" from ${file}: ${cause}. ` +
        `Is job-sourcing/ present in this image? (see docker/chromium/Dockerfile)`,
    );
  }
}

interface BoardsConfig {
  greenhouse?: string[];
  lever?: string[];
  indeed?: boolean;
  linkedin?: boolean;
}

async function loadBoardsConfig(): Promise<BoardsConfig> {
  try {
    const raw = await readFile(jobSourcingConfig('boards.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function makeClient(config: Config): Promise<AnyModule> {
  const { BrowserlessClient } = await importJobSourcing('client.js');
  const token = config.getToken();
  return new BrowserlessClient({
    wsUrl: `ws://127.0.0.1:${config.getPort()}`,
    token: token ?? undefined,
  });
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Recognizes a direct Greenhouse/Lever job-posting URL so apply_to_job can
 * target a listing the caller found on their own, without a prior
 * search_jobs call. Deliberately narrow: only these two hosts, since
 * auto-apply is restricted to boards whose ToS allow it (see JOB_SOURCING.md).
 */
function parseJobUrl(rawUrl: string): { board: 'greenhouse' | 'lever'; company: string; id: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    const match = url.pathname.match(/^\/([^/]+)\/jobs\/([^/?#]+)/);
    if (!match) return null;
    return { board: 'greenhouse', company: match[1], id: match[2] };
  }

  if (host === 'jobs.lever.co') {
    const match = url.pathname.match(/^\/([^/]+)\/([^/?#]+)/);
    if (!match) return null;
    return { board: 'lever', company: match[1], id: match[2] };
  }

  return null;
}

const boardEnum = z.enum(['greenhouse', 'lever', 'indeed', 'linkedin']);
const applyBoardEnum = z.enum(['greenhouse', 'lever']);
const statusEnum = z.enum(['seen', 'filled', 'applied']);

export function registerJobSourcingTools(server: McpServer, config: Config, logger: Logger): void {
  server.registerTool(
    'list_boards',
    {
      description:
        'Lists which job boards are configured/enabled on this server, reading ' +
        'job-sourcing/config/boards.json. Call this first if you are not sure what ' +
        'company slugs or boards are already set up.',
      inputSchema: {},
    },
    async () => {
      const boards = await loadBoardsConfig();
      return textResult(JSON.stringify(boards, null, 2));
    },
  );

  server.registerTool(
    'get_candidate_profile',
    {
      description:
        'Returns the candidate profile (contact info, resume path, search preferences) ' +
        'used to autofill job applications, from job-sourcing/config/candidate.json.',
      inputSchema: {},
    },
    async () => {
      const { loadCandidateProfile } = await importJobSourcing('profile.js');
      const profile = await loadCandidateProfile(jobSourcingConfig('candidate.json'));
      return textResult(JSON.stringify(profile, null, 2));
    },
  );

  server.registerTool(
    'search_jobs',
    {
      description:
        'Searches a job board for openings and records new results as "seen" so they ' +
        'can be applied to later. Greenhouse and Lever use those companies\' official ' +
        'public job-board APIs (pass their board "companies" — the slug in their careers ' +
        'URL, e.g. "stripe" for boards.greenhouse.io/stripe — or omit to use the ones in ' +
        'job-sourcing/config/boards.json). Indeed and LinkedIn drive a real browser and ' +
        'are read-only, opt-in features (ALLOW_INDEED / ALLOW_LINKEDIN) given their Terms ' +
        'of Service — see JOB_SOURCING.md before enabling them.',
      inputSchema: {
        board: boardEnum,
        companies: z
          .array(z.string())
          .optional()
          .describe('Greenhouse/Lever board slugs to search. Defaults to config/boards.json.'),
        titles: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
        locations: z.array(z.string()).optional(),
      },
    },
    async ({ board, companies, titles, keywords, locations }) => {
      const { ApplicationStore } = await importJobSourcing('store.js');
      const store = new ApplicationStore(jobSourcingData('applications.json'));
      const query = { titles, keywords, locations };

      let jobs: AnyModule[];
      if (board === 'greenhouse' || board === 'lever') {
        const boardsConfig = await loadBoardsConfig();
        const slugs = companies?.length ? companies : boardsConfig[board];
        if (!slugs?.length) {
          throw new Error(
            `No ${board} companies given, and none configured in job-sourcing/config/boards.json. ` +
              `Pass "companies" (e.g. ["stripe"]) or add them to boards.json.`,
          );
        }
        const modName = board === 'greenhouse' ? 'boards/greenhouse.js' : 'boards/lever.js';
        const ClassName = board === 'greenhouse' ? 'GreenhouseAdapter' : 'LeverAdapter';
        const { [ClassName]: Adapter } = await importJobSourcing(modName);
        jobs = await new Adapter(slugs).search(query);
      } else {
        const client = await makeClient(config);
        const modName = board === 'indeed' ? 'boards/indeed.js' : 'boards/linkedin.js';
        const ClassName = board === 'indeed' ? 'IndeedAdapter' : 'LinkedInAdapter';
        const { [ClassName]: Adapter } = await importJobSourcing(modName);
        jobs = await new Adapter(client).search(query);
      }

      let newCount = 0;
      for (const job of jobs) {
        const alreadySeen = await store.has(job);
        await store.record(job, { status: alreadySeen ? undefined : 'seen' });
        if (!alreadySeen) newCount += 1;
      }

      logger.info(`MCP search_jobs: ${board} returned ${jobs.length} job(s), ${newCount} new`);
      return textResult(
        `Found ${jobs.length} job(s) on ${board} (${newCount} new). ` +
          `Use each job's "board" and "id" with apply_to_job or list_tracked_jobs.\n\n` +
          JSON.stringify(jobs, null, 2),
      );
    },
  );

  server.registerTool(
    'list_tracked_jobs',
    {
      description: 'Lists jobs previously found by search_jobs, optionally filtered by status.',
      inputSchema: { status: statusEnum.optional() },
    },
    async ({ status }) => {
      const { ApplicationStore } = await importJobSourcing('store.js');
      const store = new ApplicationStore(jobSourcingData('applications.json'));
      const jobs = await store.list(status ? { status } : {});
      return textResult(JSON.stringify(jobs, null, 2));
    },
  );

  server.registerTool(
    'apply_to_job',
    {
      description:
        'Autofills a job application, using the candidate profile. Target it either way: ' +
        'pass "url" — a direct link to a Greenhouse or Lever job posting you already have ' +
        '(e.g. from a listing the human found themselves, not through search_jobs) — or ' +
        'pass "board"+"id" for a job previously found by search_jobs/list_tracked_jobs. ' +
        "Only Greenhouse and Lever are supported (other boards' ToS restrict automated " +
        "submission — you'd apply manually via the listing URL for those). By default this " +
        'only fills the form and returns a screenshot for review — it does NOT submit. Pass ' +
        'submit=true only after the human has reviewed that screenshot and told you to go ahead.',
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            'Direct link to a Greenhouse or Lever job posting, e.g. ' +
              'https://boards.greenhouse.io/acme/jobs/123 or https://jobs.lever.co/acme/<id>. ' +
              'Takes precedence over board/id when given.',
          ),
        board: applyBoardEnum.optional(),
        id: z.string().optional().describe('The job id from search_jobs/list_tracked_jobs.'),
        submit: z
          .boolean()
          .optional()
          .default(false)
          .describe('Actually submit the application. Defaults to false (fill + screenshot only).'),
      },
    },
    async ({ url, board, id, submit }) => {
      const { ApplicationStore } = await importJobSourcing('store.js');
      const store = new ApplicationStore(jobSourcingData('applications.json'));

      let job: { board: 'greenhouse' | 'lever'; id: string; title: string; company: string; url: string; applyUrl: string };
      if (url) {
        const parsed = parseJobUrl(url);
        if (!parsed) {
          throw new Error(
            `"${url}" isn't a recognized Greenhouse or Lever job URL. Auto-apply only supports ` +
              'links under boards.greenhouse.io, job-boards.greenhouse.io, or jobs.lever.co — ' +
              'other boards\' Terms of Service restrict automated applications.',
          );
        }
        job = { board: parsed.board, id: parsed.id, title: '', company: parsed.company, url, applyUrl: url };
      } else {
        if (!board || !id) {
          throw new Error(
            'Provide either "url" (a direct Greenhouse/Lever job link) or both "board" and ' +
              '"id" (from search_jobs/list_tracked_jobs).',
          );
        }
        const tracked = (await store.list()).find((r: AnyModule) => r.board === board && r.id === id);
        if (!tracked) {
          throw new Error(`No tracked job for ${board}:${id}. Run search_jobs first, or pass "url" directly.`);
        }
        job = {
          board,
          id: tracked.id,
          title: tracked.title,
          company: tracked.company,
          url: tracked.url,
          applyUrl: tracked.url,
        };
      }

      const client = await makeClient(config);
      const { loadCandidateProfile } = await importJobSourcing('profile.js');
      const profile = await loadCandidateProfile(jobSourcingConfig('candidate.json'));

      const modName = job.board === 'greenhouse' ? 'apply/greenhouse-apply.js' : 'apply/lever-apply.js';
      const fnName = job.board === 'greenhouse' ? 'applyOnGreenhouse' : 'applyOnLever';
      const { [fnName]: apply } = await importJobSourcing(modName);

      const result = await apply(client, job, profile, {
        dryRun: !submit,
        screenshotDir: jobSourcingData('screenshots'),
      });

      await store.record(job, { status: result.submitted ? 'applied' : 'filled' });

      const screenshot = await readFile(result.screenshotPath);
      const summary = [
        `Filled ${result.filled.length} field(s), skipped ${result.skipped.length}.`,
        result.skipped.length
          ? `Skipped (review manually): ${result.skipped.map((f: AnyModule) => f.name).join(', ')}`
          : '',
        result.submitted
          ? 'Application submitted.'
          : submit
            ? 'Form filled but no submit button was found — submit manually.'
            : 'Not submitted (dry run). Review the screenshot, then call apply_to_job again with submit=true to send it.',
      ]
        .filter(Boolean)
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: summary },
          {
            type: 'image' as const,
            data: screenshot.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      };
    },
  );
}
