import {
  APITags,
  BrowserlessRoutes,
  HTTPManagementRoutes,
  HTTPRoute,
  Methods,
  Request,
  contentTypes,
  dedent,
} from '@browserless.io/browserless';
import { ServerResponse } from 'http';

/**
 * This MCP endpoint runs in stateless mode (see mcp.post.ts) and doesn't
 * offer a server-initiated SSE stream, so per the Streamable HTTP spec a
 * GET here correctly returns 405 rather than upgrading to SSE.
 */
export type ResponseSchema = unknown;

export default class McpGetRoute extends HTTPRoute {
  name = BrowserlessRoutes.McpGetRoute;
  accepts = [contentTypes.any];
  auth = true;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json, contentTypes.text];
  description = dedent(`
  Always returns 405: this MCP endpoint is stateless and does not offer
  an SSE stream. Use POST /mcp for MCP requests.`);
  method = Methods.get;
  path = HTTPManagementRoutes.mcp;
  tags = [APITags.management];

  async handler(_req: Request, res: ServerResponse): Promise<void> {
    res.writeHead(405, { 'Content-Type': contentTypes.text });
    res.end('Method Not Allowed: this MCP endpoint is stateless, use POST /mcp');
  }
}
