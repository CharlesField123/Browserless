import {
  APITags,
  BrowserlessRoutes,
  HTTPManagementRoutes,
  HTTPRoute,
  Logger,
  Methods,
  Request,
  contentTypes,
  dedent,
} from '@browserless.io/browserless';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerJobSourcingTools } from '../../../mcp/job-sourcing.js';

/**
 * Remote MCP endpoint for the job-sourcing/ toolkit (see JOB_SOURCING.md and
 * MCP.md), so a claude.ai custom connector — or any other MCP client — can
 * search job boards and autofill applications through this exact
 * Browserless instance, without needing a second deployed service.
 *
 * Runs in "stateless" Streamable HTTP mode (sessionIdGenerator: undefined):
 * a fresh McpServer + transport per request, replying with a single JSON
 * response. That's deliberate — this endpoint doesn't need server-initiated
 * push notifications, and stateless mode avoids holding per-session state
 * in memory across Railway's request routing.
 */
export type ResponseSchema = unknown;

export default class McpPostRoute extends HTTPRoute {
  name = BrowserlessRoutes.McpPostRoute;
  accepts = [contentTypes.json];
  auth = true;
  browser = null;
  concurrency = false;
  // MCP clients send `Accept: application/json, text/event-stream` on every
  // request. The router's content-negotiation only matches a declared
  // contentTypes entry against the client's Accept header verbatim (see
  // Router.getRouteForHTTPRequest) — contentTypes.any ('*/*') does NOT
  // match unless the client literally sends "Accept: */*", which MCP
  // clients don't. Declaring json here is what actually satisfies real
  // MCP clients' Accept header (its "application/json" term matches).
  contentTypes = [contentTypes.json];
  description = dedent(`
  A Model Context Protocol (Streamable HTTP, stateless) endpoint exposing
  the job-sourcing/ toolkit as MCP tools: list_boards, get_candidate_profile,
  search_jobs, list_tracked_jobs, and apply_to_job. Point an MCP client
  (e.g. a claude.ai custom connector) at this URL with your TOKEN, e.g.
  "https://your-deployment/mcp?token=<TOKEN>". See MCP.md for setup.`);
  method = Methods.post;
  path = HTTPManagementRoutes.mcp;
  tags = [APITags.management];

  async handler(req: Request, res: ServerResponse, logger: Logger): Promise<void> {
    const server = new McpServer({
      name: 'browserless-job-sourcing',
      version: '0.1.0',
    });
    registerJobSourcingTools(server, this.config(), logger);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
