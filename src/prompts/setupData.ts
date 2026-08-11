/**
 * The `setup_data` MCP prompt — surfaced by MCP clients as a slash command
 * (in Claude Code: /mcp__<server-key>__setup_data).
 *
 * Walks the user through connecting one or more Heap Connect warehouse
 * destinations as named data sources, validating each connection and
 * lighting up the query tools in the same session. The handler embeds a
 * live snapshot of server state so the agent doesn't spend a turn
 * rediscovering it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SourceRegistry } from "../services/warehouse/registry.js";

export interface SetupPromptOptions {
  /** Whether heap_add_source / heap_remove_source are registered. */
  adminEnabled: boolean;
}

const FIELD_TABLES = `
### Connection fields by warehouse type

**snowflake** — { type: "snowflake", account, username, password*, database, warehouse, schema? ("heap"), role? }
  - account: e.g. "xy12345.us-east-1" (from the Snowflake URL)
  - warehouse: the virtual warehouse to run queries on

**bigquery** — { type: "bigquery", project, dataset? ("heap"), credentials*? | credentials_file? , location? }
  - Omit credentials AND credentials_file to use Application Default Credentials
  - credentials: full service-account key JSON as a string

**redshift** — { type: "redshift", host, database, user, password*, port? (5439), schema? ("heap"), ssl? (true) }

Fields marked * are secrets. Recommend a \${ENV_VAR} reference (e.g. "\${HEAP_SF_PASSWORD}") —
the user sets the variable in the \`env\` block of their MCP client config and the server
resolves it at connect time, so the secret never lands in the sources file. Literal values
are accepted but stored on disk (file permissions 0600) — warn the user before doing that.
`;

export function registerSetupDataPrompt(
  server: McpServer,
  registry: SourceRegistry,
  options: SetupPromptOptions,
): void {
  server.registerPrompt(
    "setup_data",
    {
      title: "Set Up Heap Data Sources",
      description:
        "Connect your Heap Connect data warehouse (BigQuery, Snowflake, or " +
        "Redshift) as a data source to unlock warehouse query tools — or " +
        "review/extend the sources already configured.",
      argsSchema: {
        source_type: z
          .string()
          .optional()
          .describe("Warehouse type to set up: bigquery, snowflake, or redshift."),
      },
    },
    ({ source_type }) => {
      const sources = registry.list();
      const sourceLines = sources.length
        ? sources
            .map(
              (s) =>
                `  - "${s.name}" (${s.type}${s.isDefault ? ", default" : ""}${
                  s.origin === "env" ? ", from env vars" : ""
                })`,
            )
            .join("\n")
        : "  (none configured)";
      const appIdSet = Boolean(process.env.HEAP_APP_ID);

      const stateSnapshot = `
## Current server state (live snapshot)

- Ingestion configured: HEAP_APP_ID is ${appIdSet ? "set" : "NOT set"}
- Sources file: ${registry.filePath}${registry.loadError ? ` (LOAD ERROR: ${registry.loadError})` : ""}
- Configured data sources:
${sourceLines}
- Source admin tools (heap_add_source/heap_remove_source): ${
        options.adminEnabled ? "enabled" : "DISABLED (http transport or HEAP_ALLOW_SOURCE_ADMIN=false)"
      }
${source_type ? `- The user wants to set up a ${source_type} source.` : ""}`;

      const instructions = `You are helping the user set up data sources for the Heap MCP server.

Background: this server's ingestion tools (track events, set properties, identify,
deletion) already work with just HEAP_APP_ID — no data source needed. Heap has no
public analytics QUERY API; read access comes from Heap Connect, which syncs Heap
data into the user's own warehouse. Connecting that warehouse here as a "data
source" supercharges the server with query tools: heap_describe_schema,
heap_query_pageviews, heap_query_top_events, heap_query_funnel, heap_query_users,
heap_execute_query, and heap_get_sync_status. Heap Connect can sync to multiple
destinations simultaneously; each becomes a named source (query tools take an
optional \`source\` argument, and one source can be the default).
${stateSnapshot}

## Walk the user through this flow

1. **Assess.** Call heap_list_sources. Summarize the state above for the user in a
   sentence or two: whether ingestion works, and which sources (if any) exist.

2. **Choose the path.** Ask which Heap Connect destination they use:
   **Snowflake, Redshift (AWS), or BigQuery (Google Cloud)**. If they use Databricks
   or S3: those Heap Connect destinations aren't supported by this server yet (the
   driver registry is built for them to be added later) — offer to proceed with a
   supported warehouse if they also have one, or stop gracefully. If they don't use
   Heap Connect at all, explain the server is fully usable for ingestion as-is and
   that Heap Connect (a Heap add-on) is how query access works; stop there.

3. **Collect the connection config** for their type using the field tables below.
   Steer secrets toward \${ENV_VAR} references. Ask for a short source name
   (lowercase, e.g. "prod_sf") and whether it should be the default.
${FIELD_TABLES}
4. **Preflight.** If the source admin tools are DISABLED (see snapshot), do not try
   to call them. Instead: output (a) the exact JSON entry to add under "sources" in
   the sources file at the path shown above, wrapped in the file's full shape
   {"version": 1, "default_source": ..., "sources": {...}}, and (b) any env vars
   they must add to their MCP client config's \`env\` block, then tell them to
   restart the server and stop here.

5. **Validate and persist.** Call heap_add_source with the collected name/config
   (it tests the connection before writing anything).
   - On a DRIVER_MISSING error: relay the exact install command from the error
     message, wait for the user to install it, then retry.
   - On an auth/config error: show the message, re-collect only the bad field, retry.
   - On warnings about _sync_history or zero tables: explain Heap Connect may not
     have finished its first sync; the source is saved and will work once data lands.

6. **Report the supercharge.** Tell the user which query tools are now live, that
   this persists across restarts via the sources file, and — if several sources
   exist — that tools take source: "<name>". Suggest a first query, e.g. "show my
   top events this week" (heap_query_top_events). Offer to add another destination
   or set a different default.`;

      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: instructions },
          },
        ],
      };
    },
  );
}
