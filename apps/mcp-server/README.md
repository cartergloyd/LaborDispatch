# @labordispatch/mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes LaborDispatch's
contractor search, intake, dispatch and booking capabilities to external AI agents (Claude Desktop,
Claude Code, or any MCP-compatible client). It speaks MCP over **stdio**; the process is launched by
the client.

## Tools

| Tool | What it does |
| --- | --- |
| `search_contractors` | Active, credentialed providers serving a postal code for a trade (handymen included as fallback). Optional `emergency` filter. Returns provider ids - never phone/email. |
| `get_availability` | Free slots for a provider (default next 7 days, 120-minute slots, max 8). |
| `request_service` | Create a work order and finish intake. Waits for owner approval when the reporter is not the billing party or the job is a large project. Does **not** dispatch. |
| `dispatch_work_order` | Offer a `ready_to_dispatch` work order to the best qualified provider(s). Offers expire after `DISPATCH_OFFER_MINUTES`. |
| `request_booking` | Place a **hold** on a provider slot. The hold expires after `APPOINTMENT_HOLD_MINUTES` unless the provider confirms - it is not a confirmed booking. |
| `get_work_order_status` | Status, offers, appointments and the last 20 events for a work order. No contact details or property access notes. |
| `get_estimates` | Estimates submitted by providers for a work order. |

Every tool returns pretty-printed JSON in a single `text` content block. Domain errors (not found,
conflict, forbidden, invalid transition) come back as `isError: true` with a `code: message` text.

## Running

From the repo root:

```sh
npm install
npm run dev -w @labordispatch/mcp-server   # or: npm run dev:mcp
```

On startup the server connects to the database, applies pending migrations, then attaches to
stdio. All logging goes to **stderr** - stdout is reserved for the MCP channel.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | unset | Postgres connection string. When unset an embedded PGlite database is used. |
| `PGLITE_DIR` | `./.pglite` | Directory for the embedded PGlite database (relative to the process `cwd`). |
| `DISPATCH_OFFER_MINUTES` | `20` | How long a dispatch offer stays open. |
| `APPOINTMENT_HOLD_MINUTES` | `15` | How long a booking hold is reserved before it expires. |

To try it against demo data, seed the same database first: `npm run db:seed` (uses the same
`DATABASE_URL` / `PGLITE_DIR` resolution).

### Claude Desktop

Add an entry to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`). `cwd` must be the repo root so
workspace packages and the `.pglite` directory resolve.

```json
{
  "mcpServers": {
    "labordispatch": {
      "command": "npx",
      "args": ["tsx", "apps/mcp-server/src/server.ts"],
      "cwd": "/absolute/path/to/LaborDispatch",
      "env": {
        "PGLITE_DIR": "/absolute/path/to/LaborDispatch/.pglite",
        "DISPATCH_OFFER_MINUTES": "20",
        "APPOINTMENT_HOLD_MINUTES": "15"
      }
    }
  }
}
```

If your client does not support `cwd`, use `"command": "sh"` with
`"args": ["-c", "cd /absolute/path/to/LaborDispatch && npx tsx apps/mcp-server/src/server.ts"]`.

### Claude Code

```sh
claude mcp add labordispatch -- npx tsx /absolute/path/to/LaborDispatch/apps/mcp-server/src/server.ts
```

## Typical agent flow

1. `search_contractors` with the property's postal code and trade.
2. `request_service` to open the work order (owner approval may be required).
3. `dispatch_work_order` once the work order is `ready_to_dispatch`.
4. Poll `get_work_order_status` until an offer is `accepted`.
5. `get_availability` for the assigned provider, then `request_booking` to place a hold.
6. The provider confirms the hold through their own channel; `get_work_order_status` shows the
   appointment as `confirmed` and the work order as `scheduled`.

## Development

```sh
npx tsc -b apps/mcp-server          # typecheck
npx vitest run apps/mcp-server      # tests (in-memory PGlite, seeded demo data)
```

Tool handlers in `src/tools.ts` are plain `(db, args) => ToolResult` functions so they can be
tested without a transport; `registerTools(server, db)` wires them into an `McpServer`.
