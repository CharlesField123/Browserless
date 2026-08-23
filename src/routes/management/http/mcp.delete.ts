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
 * This MCP endpoint runs in stateless mode (see mcp.post.ts), so there's no
 * server-side session to terminate; DELETE correctly returns 405.
 */
export type ResponseSchema = unknown;

export default class McpDeleteRoute extends HTTPRoute {
  name = BrowserlessRoutes.McpDeleteRoute;
  accepts = [contentTypes.any];
  auth = true;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json, contentTypes.text];
  description = dedent(`
  Always returns 405: this MCP endpoint is stateless and holds no session
  to terminate. Use POST /mcp for MCP requests.`);
  method = Methods.delete;
  path = HTTPManagementRoutes.mcp;
  tags = [APITags.management];

  async handler(_req: Request, res: ServerResponse): Promise<void> {
    res.writeHead(405, { 'Content-Type': contentTypes.text });
    res.end('Method Not Allowed: this MCP endpoint is stateless, no session to delete');
  }
}
