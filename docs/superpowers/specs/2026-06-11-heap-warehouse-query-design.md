# Heap Warehouse Query Tools — Design Spec

**Date:** 2026-06-11  
**Status:** Approved

## Summary

Add read/query capability to heap-mcp-server by connecting to the user's Heap Connect data warehouse (BigQuery, Snowflake, or Redshift). Exposes 6 new MCP tools for page view analysis, event counts, funnel conversion, user lookup, schema discovery, and raw SQL passthrough.

Heap has no public analytics query API. All read access goes through Heap Connect, which syncs autocaptured + custom event data into a user-managed warehouse.

---

## Architecture

Three new layers added alongside existing ingestion tools. No existing files restructured.

```
src/
  services/
    heapClient.ts          (existing — unchanged)
    warehouseClient.ts     (NEW — WarehouseClient interface + fromEnv factory)
    bigquery.ts            (NEW — BigQuery driver)
    snowflake.ts           (NEW — Snowflake driver)
    redshift.ts            (NEW — Redshift via pg)
  tools/
    tracking.ts            (existing — unchanged)
    properties.ts          (existing — unchanged)
    identity.ts            (existing — unchanged)
    deletion.ts            (existing — unchanged)
    query.ts               (NEW — 6 query tools)
  schemas.ts               (extend with query input schemas)
  constants.ts             (extend with warehouse env vars + limits)
  index.ts                 (register query tools when HEAP_WAREHOUSE is set)
```

**`WarehouseClient` interface:**
```typescript
interface QueryResult {
  rows: Record<string, unknown>[];
  totalRows: number;
}

interface WarehouseClient {
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  listTables(): Promise<string[]>;
  describeTable(tableName: string): Promise<{ column: string; type: string }[]>;
}
```

`WarehouseClient.fromEnv()` reads `HEAP_WAREHOUSE` and returns the matching driver. Missing or unrecognized value throws `WarehouseConfigError` with a clear setup message.

---

## Configuration

All new env vars are optional for backward compatibility. Query tools are only registered when `HEAP_WAREHOUSE` is set. Existing ingestion tools are unaffected.

```bash
# Required to enable query tools
HEAP_WAREHOUSE=bigquery|snowflake|redshift

# BigQuery
HEAP_BQ_PROJECT=my-gcp-project
HEAP_BQ_DATASET=heap                   # default: "heap"
HEAP_BQ_CREDENTIALS='{...}'            # JSON service account key; omit for ADC

# Snowflake
HEAP_SF_ACCOUNT=xy12345.us-east-1
HEAP_SF_USERNAME=heap_user
HEAP_SF_PASSWORD=secret
HEAP_SF_DATABASE=HEAP_DB
HEAP_SF_SCHEMA=heap                    # default: "heap"
HEAP_SF_WAREHOUSE=COMPUTE_WH

# Redshift
HEAP_RS_HOST=my-cluster.us-east-1.redshift.amazonaws.com
HEAP_RS_PORT=5439                      # default: 5439
HEAP_RS_DATABASE=analytics
HEAP_RS_SCHEMA=heap                    # default: "heap"
HEAP_RS_USER=heap_user
HEAP_RS_PASSWORD=secret
```

---

## Heap Connect Schema

Standard tables synced by Heap Connect (all warehouses):

| Table | Contents |
|-------|----------|
| `users` | One row per user; identity + all user properties |
| `sessions` | One row per session; device, landing page, referrer |
| `pageviews` | One row per pageview; URL, time, user |
| `all_events` | Union of all labeled/custom events + pageviews |
| `user_migrations` | User merge/migration history |
| `_sync_history` | Heap Connect sync metadata |

Individual event tables are named after the event (e.g. `clicked_button`). Schema is dynamic — new events and properties appear as new columns automatically.

Key columns shared across event tables: `user_id`, `session_id`, `time`, `browser`, `device_type`, `country`, `ip`.

---

## New MCP Tools

### `heap_describe_schema`
- **Purpose:** Discover available tables and column definitions in the Heap Connect dataset.
- **Params:** `table?` (omit = list all tables), `response_format`
- **Returns:** Table list or `{column, type}[]` for a specific table.
- **SQL:** `INFORMATION_SCHEMA.COLUMNS` — supported by all three warehouses.

### `heap_query_pageviews`
- **Purpose:** Page view analysis by URL, time range, or user.
- **Params:** `start_time` (ISO8601), `end_time` (ISO8601), `url_contains?`, `group_by: 'url'|'day'|'user'` (default `'url'`), `limit?` (default 100, max 1000), `response_format`
- **Returns:** `{url|day|user_id, pageview_count, unique_users}`
- **SQL:** Aggregation on `pageviews` table filtered by `time` column.

### `heap_query_top_events`
- **Purpose:** Rank events by frequency over a time window.
- **Params:** `start_time`, `end_time`, `limit?` (default 25, max 100), `exclude_pageviews?` (default false), `response_format`
- **Returns:** `{event_name, count, unique_users}` sorted by count descending.
- **SQL:** `GROUP BY event` on `all_events`, optionally filtering out pageview type.

### `heap_query_funnel`
- **Purpose:** Multi-step conversion funnel — what % of users completed each step.
- **Params:** `steps: string[]` (2–8 event names in order), `start_time`, `end_time`, `conversion_window_hours?` (default 168 = 7 days), `response_format`
- **Returns:** `{step, event_name, users_entered, users_converted, conversion_rate_pct}` per step.
- **SQL:** Series of CTEs — one per step — joining on `user_id` with a time-window constraint between steps.

### `heap_query_users`
- **Purpose:** Find and inspect users by identity, property, or event performed.
- **Params:** `identity?`, `property_key?`, `property_value?`, `performed_event?`, `start_time?`, `end_time?`, `limit?` (default 50, max 500), `response_format`
- **Returns:** User rows (identity + properties).
- **SQL:** Filter on `users` table; optional join to `all_events` when `performed_event` specified.

### `heap_execute_query`
- **Purpose:** Raw SQL passthrough for ad-hoc analysis. Escape hatch when pre-built tools are insufficient.
- **Params:** `sql`, `limit?` (default 100, max 1000), `response_format`
- **Returns:** Raw result rows.
- **Guardrails:**
  - Only `SELECT` statements allowed — rejects `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE`
  - `LIMIT` injected/clamped automatically
  - 60-second query timeout
  - Result truncated at 25,000 characters

---

## Error Handling

- `WarehouseError` class mirrors `HeapApiError` — `userMessage` (safe to surface) + optional `code`.
- Raw SQL errors and stack traces are never exposed to agents — may leak schema details.
- Explicit handling for: missing `HEAP_WAREHOUSE`, auth failure, query timeout (60s), table not found, SQL syntax error, result size overflow.
- Query tools fail gracefully with actionable messages if warehouse is not configured; ingestion tools are unaffected.

---

## Testing

Follows existing `node --test` pattern, no test framework dependency.

**Unit tests (always run):**
- SQL generation: each pre-built tool called with params → assert generated SQL contains expected clauses (correct table, WHERE conditions, GROUP BY, LIMIT).
- `heap_execute_query` guardrails: non-SELECT rejected, LIMIT injected when absent, oversized LIMIT clamped to max.
- `WarehouseClient.fromEnv()`: throws `WarehouseConfigError` when `HEAP_WAREHOUSE` is missing or invalid.

**Integration tests (skipped without credentials):**
- Warehouse driver connects, `listTables()` returns results, `query()` runs a simple SELECT.
- Skipped via env var check — same pattern as existing deletion tests that require `HEAP_API_KEY`.

---

## Out of Scope

- Query result pagination / cursor (LIMIT + agent retry is sufficient)
- Result caching
- DDL or write operations via warehouse
- Streaming query results
- Warehouse schema auto-detection (schema names are configurable via env vars)
