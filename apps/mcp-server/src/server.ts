/**
 * LaborDispatch MCP server (stdio transport).
 *
 * Exposes contractor search, availability, intake, dispatch, booking holds and status to external
 * AI agents over the Model Context Protocol. Start with `npm run dev -w @labordispatch/mcp-server`.
 *
 * stdout is the MCP channel - everything we log goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDb, runMigrations } from "@labordispatch/db";
import { registerTools, TOOL_NAMES } from "./tools.js";

const log = (...args: unknown[]) => console.error("[labordispatch-mcp]", ...args);

const handle = await createDb();
await runMigrations(handle);
log(`database ready (${handle.driver})`);

const server = new McpServer({ name: "labordispatch", version: "0.1.0" });
registerTools(server, handle.db);

let closing = false;
async function shutdown(reason: string) {
  if (closing) return;
  closing = true;
  log(`shutting down (${reason})`);
  await server.close().catch(() => undefined);
  await handle.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const transport = new StdioServerTransport();
transport.onclose = () => void shutdown("transport closed");
await server.connect(transport);
log(`listening on stdio; tools: ${TOOL_NAMES.join(", ")}`);
