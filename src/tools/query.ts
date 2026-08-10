/**
 * Warehouse query tools over the configured data vault sources.
 *
 * Heap has no public analytics query API; these tools read the Heap Connect
 * dataset the user syncs into their own warehouse. All tools accept an
 * optional `source` (default: the configured/sole source), generate dialect
 * -correct SQL via sqlBuilders, and surface the executed SQL in structured
 * output for transparency.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { QUERY_TIMEOUT_MS } from "../constants.js";
import {
  DescribeSchemaInput,
  ExecuteQueryInput,
  QueryFunnelInput,
  QueryPageviewsInput,
  QueryTopEventsInput,
  QueryUsersInput,
  SyncStatusInput,
  describeSchemaSchema,
  executeQuerySchema,
  queryFunnelSchema,
  queryPageviewsSchema,
  queryTopEventsSchema,
  queryUsersSchema,
  syncStatusSchema,
} from "../schemas.js";
import {
  buildFunnelSql,
  buildPageviewsSql,
  buildSyncStatusSql,
  buildTopEventsSql,
  buildUsersSql,
  clampAndInjectLimit,
  sanitizeSelectOnly,
} from "../services/warehouse/sqlBuilders.js";
import { SourceRegistry } from "../services/warehouse/registry.js";
import { QueryResult } from "../services/warehouse/types.js";
import { ResponseFormat } from "../types.js";
import { buildResult, rowsToMarkdown, runTool } from "./helpers.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function formatRows(
  format: ResponseFormat,
  heading: string,
  result: QueryResult,
  structured: Record<string, unknown>,
): { text: string; structured: Record<string, unknown> } {
  const text =
    format === ResponseFormat.JSON
      ? JSON.stringify(structured, null, 2)
      : `${heading}\n\n${rowsToMarkdown(result.rows)}`;
  return { text, structured };
}

export function registerQueryTools(server: McpServer, registry: SourceRegistry): void {
  server.registerTool(
    "heap_describe_schema",
    {
      title: "Describe Heap Connect Schema",
      description: `Discover the tables (or one table's columns) in the Heap Connect dataset of a configured data source.

Heap Connect syncs users, sessions, pageviews, all_events, one table per defined event, user_migrations, and _sync_history. The schema is dynamic — new events/properties appear automatically — so use this before writing queries.

Args:
  - source (string, optional): Source name. Omit to use the default source.
  - table (string, optional): Table to describe. Omit to list all tables.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Table names, or {column, type} rows for the given table.

Example: "What tables does my Heap warehouse have?" / "Describe the users table".`,
      inputSchema: describeSchemaSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: DescribeSchemaInput) =>
      runTool(async () => {
        const driver = await registry.resolve(params.source);
        if (params.table) {
          const columns = await driver.describeTable(params.table);
          const structured = {
            ok: true,
            source: driver.name,
            table: params.table,
            columns,
          };
          const rows = columns.map((c) => ({ column: c.column, type: c.type }));
          const { text } = formatRows(
            params.response_format,
            `Columns of ${params.table} (source "${driver.name}"):`,
            { rows, totalRows: rows.length },
            structured,
          );
          return buildResult(text, structured);
        }
        const tables = await driver.listTables();
        const structured = { ok: true, source: driver.name, tables };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Tables in source "${driver.name}" (${tables.length}):\n` +
              tables.map((t) => `- ${t}`).join("\n");
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_query_pageviews",
    {
      title: "Query Heap Pageviews",
      description: `Aggregate pageviews from the Heap Connect pageviews table by URL path, day, or user over a time range.

Args:
  - source (string, optional): Source name. Omit to use the default source.
  - start_time / end_time (string, required): ISO8601 window (inclusive).
  - url_contains (string, optional): Only pages whose path contains this substring.
  - group_by ('url' | 'day' | 'user'): Aggregation key (default 'url').
  - url_column (string, optional): Pageviews column holding the path (default 'path').
  - limit (number, optional): Max rows (default 100, max 1000).
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Rows of {url|day|user_id, pageview_count, unique_users}.

Example: "Top pages by views last week" / "Daily pageview trend for /pricing in July".`,
      inputSchema: queryPageviewsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: QueryPageviewsInput) =>
      runTool(async () => {
        const driver = await registry.resolve(params.source);
        const sql = buildPageviewsSql(driver.dialect, {
          startTime: params.start_time,
          endTime: params.end_time,
          urlContains: params.url_contains,
          groupBy: params.group_by,
          urlColumn: params.url_column,
          limit: params.limit,
        });
        const result = await driver.query(sql, QUERY_TIMEOUT_MS);
        const structured = {
          ok: true,
          source: driver.name,
          group_by: params.group_by,
          rows: result.rows,
          total_rows: result.totalRows,
          sql,
        };
        const { text } = formatRows(
          params.response_format,
          `Pageviews by ${params.group_by} (${params.start_time} → ${params.end_time}, source "${driver.name}"):`,
          result,
          structured,
        );
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_query_top_events",
    {
      title: "Query Top Heap Events",
      description: `Rank events by frequency (and unique users) over a time window, from the Heap Connect all_events table.

Args:
  - source (string, optional): Source name. Omit to use the default source.
  - start_time / end_time (string, required): ISO8601 window (inclusive).
  - limit (number, optional): Max events returned (default 25, max 100).
  - exclude_pageviews (boolean, optional): Drop the built-in pageviews event (default false).
  - event_column (string, optional): all_events column naming each row's event (default 'event_view_name').
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Rows of {event_name, event_count, unique_users}, most frequent first.

Example: "What were my top events this week?"`,
      inputSchema: queryTopEventsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: QueryTopEventsInput) =>
      runTool(async () => {
        const driver = await registry.resolve(params.source);
        const sql = buildTopEventsSql(driver.dialect, {
          startTime: params.start_time,
          endTime: params.end_time,
          excludePageviews: params.exclude_pageviews,
          eventColumn: params.event_column,
          limit: params.limit,
        });
        const result = await driver.query(sql, QUERY_TIMEOUT_MS);
        const structured = {
          ok: true,
          source: driver.name,
          rows: result.rows,
          total_rows: result.totalRows,
          sql,
        };
        const { text } = formatRows(
          params.response_format,
          `Top events ${params.start_time} → ${params.end_time} (source "${driver.name}"):`,
          result,
          structured,
        );
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_query_funnel",
    {
      title: "Query a Heap Conversion Funnel",
      description: `Compute a multi-step conversion funnel over the Heap Connect all_events table: how many users completed each step, in order, within a conversion window.

Step N counts users from step N-1 whose first step-N event happened within conversion_window_hours of their step-(N-1) event.

Args:
  - source (string, optional): Source name. Omit to use the default source.
  - steps (string[], required, 2-8): Ordered event names as they appear in the event column.
  - start_time / end_time (string, required): ISO8601 window for step 1 (inclusive).
  - conversion_window_hours (number, optional): Max hours between consecutive steps (default 168 = 7 days).
  - event_column (string, optional): all_events column naming each row's event (default 'event_view_name').
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: One row per step: {step, event_name, users, conversion_from_previous_pct, conversion_from_start_pct}.

Example: "Funnel from sign_up to created_project to invited_teammate this month".`,
      inputSchema: queryFunnelSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: QueryFunnelInput) =>
      runTool(async () => {
        const driver = await registry.resolve(params.source);
        const sql = buildFunnelSql(driver.dialect, {
          steps: params.steps,
          startTime: params.start_time,
          endTime: params.end_time,
          conversionWindowHours: params.conversion_window_hours,
          eventColumn: params.event_column,
        });
        const result = await driver.query(sql, QUERY_TIMEOUT_MS);

        // Compute conversion percentages from the per-step user counts.
        const byStep = [...result.rows].sort(
          (a, b) => Number(a.step ?? 0) - Number(b.step ?? 0),
        );
        const counts = byStep.map((row) => Number(row.users ?? 0));
        const enriched = byStep.map((row, i) => ({
          step: Number(row.step ?? i + 1),
          event_name: String(row.event_name ?? params.steps[i] ?? ""),
          users: counts[i],
          conversion_from_previous_pct:
            i === 0 ? 100 : counts[i - 1] > 0 ? Math.round((counts[i] / counts[i - 1]) * 1000) / 10 : 0,
          conversion_from_start_pct:
            counts[0] > 0 ? Math.round((counts[i] / counts[0]) * 1000) / 10 : 0,
        }));

        const structured = {
          ok: true,
          source: driver.name,
          conversion_window_hours: params.conversion_window_hours,
          rows: enriched,
          sql,
        };
        const { text } = formatRows(
          params.response_format,
          `Funnel ${params.steps.join(" → ")} (source "${driver.name}"):`,
          { rows: enriched, totalRows: enriched.length },
          structured,
        );
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_query_users",
    {
      title: "Query Heap Users",
      description: `Find users in the Heap Connect users table by identity, user property, and/or an event they performed.

Args:
  - source (string, optional): Source name. Omit to use the default source.
  - identity (string, optional): Exact identity to look up.
  - property_key / property_value (strings, optional, together): users-table column and the value it must equal.
  - performed_event (string, optional): Only users who performed this event.
  - start_time / end_time (string, optional): Restrict performed_event to a window.
  - event_column (string, optional): all_events column naming each row's event (default 'event_view_name').
  - limit (number, optional): Max rows (default 50, max 500).
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Full user rows (identity plus all synced user properties).

Example: "Find the user alice@example.com" / "Users on the pro plan who ran an export this month".`,
      inputSchema: queryUsersSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: QueryUsersInput) =>
      runTool(async () => {
        const driver = await registry.resolve(params.source);
        const sql = buildUsersSql(driver.dialect, {
          identity: params.identity,
          propertyKey: params.property_key,
          propertyValue: params.property_value,
          performedEvent: params.performed_event,
          startTime: params.start_time,
          endTime: params.end_time,
          eventColumn: params.event_column,
          limit: params.limit,
        });
        const result = await driver.query(sql, QUERY_TIMEOUT_MS);
        const structured = {
          ok: true,
          source: driver.name,
          rows: result.rows,
          total_rows: result.totalRows,
          sql,
        };
        const { text } = formatRows(
          params.response_format,
          `Users (source "${driver.name}", ${result.totalRows} row(s)):`,
          result,
          structured,
        );
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_execute_query",
    {
      title: "Execute SQL on a Heap Data Source",
      description: `Run an ad-hoc read-only SQL query against a configured data source — the escape hatch when the pre-built query tools aren't enough.

Guardrails: single statement, SELECT/WITH only, write & DDL keywords rejected, a LIMIT is injected or clamped, ${Math.round(
        QUERY_TIMEOUT_MS / 1000,
      )}s timeout, output truncated at 25,000 characters.

Args:
  - source (string, optional): Source name. Omit to use the default source.
  - sql (string, required): A single SELECT (or WITH ... SELECT) statement. Qualify tables with your Heap schema (use heap_describe_schema to explore).
  - limit (number, optional): Row cap (default 100, max 1000).
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Result rows plus the exact SQL executed.

Example: "Run: SELECT browser, COUNT(*) FROM heap.sessions GROUP BY 1 ORDER BY 2 DESC".`,
      inputSchema: executeQuerySchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: ExecuteQueryInput) =>
      runTool(async () => {
        const driver = await registry.resolve(params.source);
        const sql = clampAndInjectLimit(sanitizeSelectOnly(params.sql), params.limit);
        const result = await driver.query(sql, QUERY_TIMEOUT_MS);
        const structured = {
          ok: true,
          source: driver.name,
          rows: result.rows,
          total_rows: result.totalRows,
          sql,
        };
        const { text } = formatRows(
          params.response_format,
          `Query result (source "${driver.name}", ${result.totalRows} row(s)):`,
          result,
          structured,
        );
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_get_sync_status",
    {
      title: "Get Heap Connect Sync Status",
      description: `Read the Heap Connect _sync_history table of a data source to see when Heap last synced data into the warehouse.

Use this to confirm data freshness before drawing conclusions from query results, or to verify a newly connected destination has completed its first sync.

Args:
  - source (string, optional): Source name. Omit to use the default source.
  - limit (number, optional): Max rows (default 50, max 500).
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Raw _sync_history rows (schema varies by warehouse; typically one row per sync attempt).

Example: "When did Heap last sync to the warehouse?"`,
      inputSchema: syncStatusSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: SyncStatusInput) =>
      runTool(async () => {
        const driver = await registry.resolve(params.source);
        const result = driver.getSyncStatus
          ? await driver.getSyncStatus()
          : await driver.query(buildSyncStatusSql(driver.dialect, params.limit), QUERY_TIMEOUT_MS);
        const structured = {
          ok: true,
          source: driver.name,
          rows: result.rows,
          total_rows: result.totalRows,
        };
        const { text } = formatRows(
          params.response_format,
          `Heap Connect sync history (source "${driver.name}"):`,
          result,
          structured,
        );
        return buildResult(text, structured);
      }),
  );
}
