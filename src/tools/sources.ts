/**
 * Data source management tools: list, test, add, remove.
 *
 * heap_list_sources / heap_test_source are always registered — they are the
 * discovery surface the setup_data prompt drives. heap_add_source /
 * heap_remove_source mutate the sources file and are gated behind
 * resolveAllowSourceAdmin (disabled by default on the http transport).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  AddSourceInput,
  ListSourcesInput,
  RemoveSourceInput,
  SourceConfig,
  TestSourceInput,
  addSourceSchema,
  listSourcesSchema,
  removeSourceSchema,
  testSourceSchema,
} from "../schemas.js";
import { buildSyncStatusSql } from "../services/warehouse/sqlBuilders.js";
import { SourceRegistry, instantiateDriver } from "../services/warehouse/registry.js";
import { SourceDriver } from "../services/warehouse/types.js";
import { ResponseFormat } from "../types.js";
import { buildResult, runTool } from "./helpers.js";

export interface SourceToolOptions {
  /** Whether the mutating admin tools are registered. */
  allowAdmin: boolean;
  /** Called after a source is added, so query tools can register live. */
  onSourcesChanged: () => void;
}

/** Fields whose literal values are masked in tool output. */
const SECRET_FIELDS = new Set(["password", "credentials", "token"]);

/** Mask secret literals (env refs like ${VAR} are shown as-is). */
function maskSecrets(config: SourceConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (SECRET_FIELDS.has(key) && typeof value === "string" && !value.startsWith("${")) {
        return [key, "********"];
      }
      return [key, value];
    }),
  );
}

/**
 * Validate a driver end to end: connect, list tables, probe _sync_history.
 * Returns human-readable findings (and never throws once connected).
 */
async function probeDriver(driver: SourceDriver): Promise<{
  detail: string;
  tables: string[];
  warnings: string[];
}> {
  const detail = await driver.testConnection();
  const warnings: string[] = [];
  let tables: string[] = [];
  try {
    tables = await driver.listTables();
    if (tables.length === 0) {
      warnings.push(
        "No tables found in the configured schema/dataset. Heap Connect may not " +
          "have completed its first sync, or the schema name may be wrong.",
      );
    }
  } catch (error) {
    warnings.push(
      `Connected, but listing tables failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (driver.capabilities.sql) {
    try {
      await driver.query(buildSyncStatusSql(driver.dialect, 1), 15000);
    } catch {
      warnings.push(
        "The _sync_history table was not readable. If Heap Connect has never " +
          "synced to this destination yet, that's expected; otherwise check the " +
          "schema configuration.",
      );
    }
  }
  return { detail, tables, warnings };
}

export function registerSourceTools(
  server: McpServer,
  registry: SourceRegistry,
  options: SourceToolOptions,
): void {
  server.registerTool(
    "heap_list_sources",
    {
      title: "List Heap Data Sources",
      description: `List the data vault sources (Heap Connect warehouse connections) configured for this server.

Use this to discover which sources exist, which is the default, and whether warehouse query tools are available. Secrets are never shown.

Args:
  - test (boolean, optional): If true, run a live connectivity check against every source (default false).
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: One row per source: name, type (bigquery/snowflake/redshift), origin (file or env), default flag — plus connectivity results when test=true, and any invalid config entries.

Example: "What Heap data sources are connected?"`,
      inputSchema: listSourcesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListSourcesInput) =>
      runTool(async () => {
        const summaries = registry.list();
        const results = await Promise.all(
          summaries.map(async (summary) => {
            if (!params.test) return { ...summary, status: undefined as string | undefined };
            try {
              const driver = await registry.resolve(summary.name);
              const detail = await driver.testConnection();
              return { ...summary, status: `ok — ${detail}` };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { ...summary, status: `FAILED — ${message}` };
            }
          }),
        );

        const structured = {
          ok: true,
          sources: results.map((r) => ({
            name: r.name,
            type: r.type,
            origin: r.origin,
            is_default: r.isDefault,
            ...(r.status !== undefined ? { status: r.status } : {}),
          })),
          invalid_sources: registry.invalidSources,
          sources_file: registry.filePath,
          ...(registry.loadError ? { load_error: registry.loadError } : {}),
        };

        let text: string;
        if (params.response_format === ResponseFormat.JSON) {
          text = JSON.stringify(structured, null, 2);
        } else if (results.length === 0) {
          text =
            "No data sources are configured. The ingestion tools work without any; " +
            "to unlock warehouse query tools, run the setup_data prompt or " +
            "heap_add_source to connect a Heap Connect destination " +
            `(BigQuery, Snowflake, or Redshift). Sources file: ${registry.filePath}`;
        } else {
          const lines = results.map((r) => {
            const flags = [
              r.isDefault ? "default" : null,
              r.origin === "env" ? "from env vars" : null,
            ]
              .filter(Boolean)
              .join(", ");
            const status = r.status ? ` — ${r.status}` : "";
            return `- **${r.name}** (${r.type}${flags ? `; ${flags}` : ""})${status}`;
          });
          for (const bad of registry.invalidSources) {
            lines.push(`- ~~${bad.name}~~ — invalid config: ${bad.reason}`);
          }
          if (registry.loadError) lines.push(`\nWarning: ${registry.loadError}`);
          text = `Configured data sources:\n${lines.join("\n")}`;
        }
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_test_source",
    {
      title: "Test a Heap Data Source",
      description: `Validate one data source end to end: connect, list tables, and probe the Heap Connect _sync_history table.

Use this after configuring a source (or when queries misbehave) to pinpoint whether the problem is credentials, network, schema naming, or an unfinished first sync.

Args:
  - source (string, optional): Source name. Omit to test the default source.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Connection detail, the tables found (first 25), and warnings (e.g. _sync_history missing, empty schema).

Example: "Test the prod_sf Heap source".`,
      inputSchema: testSourceSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: TestSourceInput) =>
      runTool(async () => {
        const driver = await registry.resolve(params.source);
        const { detail, tables, warnings } = await probeDriver(driver);
        const structured = {
          ok: true,
          source: driver.name,
          type: driver.type,
          detail,
          tables: tables.slice(0, 25),
          table_count: tables.length,
          warnings,
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : [
                `Source "${driver.name}" (${driver.type}): ${detail}`,
                tables.length
                  ? `Tables (${tables.length}): ${tables.slice(0, 25).join(", ")}${
                      tables.length > 25 ? ", …" : ""
                    }`
                  : null,
                ...warnings.map((w) => `Warning: ${w}`),
              ]
                .filter(Boolean)
                .join("\n");
        return buildResult(text, structured);
      }),
  );

  if (!options.allowAdmin) return;

  server.registerTool(
    "heap_add_source",
    {
      title: "Add a Heap Data Source",
      description: `Validate and persist a named data vault source (Heap Connect warehouse connection) to the sources file, unlocking the warehouse query tools.

The connection is tested before anything is written (disable with skip_validation). Secret values may be \${ENV_VAR} references — recommended, so credentials stay in the environment instead of on disk. The file is written with 0600 permissions.

Args:
  - name (string, required): Source name (lowercase letters/digits/'-'/'_', e.g. 'prod_sf').
  - config (object, required): Connection config, discriminated by \`type\`:
      snowflake: { type, account, username, password, database, warehouse, schema?, role? }
      bigquery:  { type, project, dataset?, credentials? | credentials_file? } (omit both for ADC)
      redshift:  { type, host, database, user, password, port?, schema?, ssl? }
  - make_default (boolean, optional): Make this the default source for query tools.
  - overwrite (boolean, optional): Replace an existing source of the same name.
  - skip_validation (boolean, optional): Persist without a connection test (not recommended).
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Confirmation, validation findings (tables discovered, warnings), the persisted JSON entry (secrets masked), and the query tools now available.

Example: "Add my Snowflake warehouse as source prod_sf and make it the default".`,
      inputSchema: addSourceSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: AddSourceInput) =>
      runTool(async () => {
        const hadSources = registry.hasSources();

        let validation: Awaited<ReturnType<typeof probeDriver>> | undefined;
        if (!params.skip_validation) {
          const probeDriverInstance = await instantiateDriver(params.name, params.config);
          try {
            validation = await probeDriver(probeDriverInstance);
          } finally {
            await probeDriverInstance.close().catch(() => {});
          }
        }

        registry.add(params.name, params.config, {
          makeDefault: params.make_default,
          overwrite: params.overwrite,
        });
        options.onSourcesChanged();

        const structured = {
          ok: true,
          source: params.name,
          type: params.config.type,
          is_default: params.make_default || registry.defaultName() === params.name,
          validated: !params.skip_validation,
          ...(validation
            ? { table_count: validation.tables.length, warnings: validation.warnings }
            : {}),
          persisted_to: registry.filePath,
          persisted_entry: maskSecrets(params.config),
          query_tools_available: true,
        };

        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : [
                `Added source "${params.name}" (${params.config.type}) to ${registry.filePath}.`,
                validation
                  ? `Validation: ${validation.detail} Found ${validation.tables.length} table(s).`
                  : "Validation was skipped.",
                ...(validation?.warnings ?? []).map((w) => `Warning: ${w}`),
                hadSources
                  ? `Query tools can target it with source: "${params.name}".`
                  : "Warehouse query tools are now available: heap_describe_schema, " +
                    "heap_query_pageviews, heap_query_top_events, heap_query_funnel, " +
                    "heap_query_users, heap_execute_query, heap_get_sync_status.",
              ].join("\n");
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_remove_source",
    {
      title: "Remove a Heap Data Source",
      description: `Remove a named data source from the sources file. The connection config is deleted from disk; the warehouse itself is untouched.

Sources defined via HEAP_WAREHOUSE env vars can't be removed here — unset the env vars instead.

Args:
  - name (string, required): Source name to remove.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Confirmation and the remaining source names.

Example: "Remove the old_bq Heap source".`,
      inputSchema: removeSourceSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: RemoveSourceInput) =>
      runTool(async () => {
        await registry.remove(params.name);
        const remaining = registry.sourceNames();
        const structured = { ok: true, removed: params.name, remaining_sources: remaining };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Removed source "${params.name}". Remaining sources: ${
                remaining.length ? remaining.join(", ") : "(none)"
              }.`;
        return buildResult(text, structured);
      }),
  );
}
