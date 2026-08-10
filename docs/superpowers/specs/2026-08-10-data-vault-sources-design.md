# Data Vault Sources — Multi-Warehouse Framework + `setup_data` Design Spec

**Date:** 2026-08-10
**Status:** Implemented
**Supersedes:** [2026-06-11-heap-warehouse-query-design.md](2026-06-11-heap-warehouse-query-design.md) (config model and driver architecture; the 6 query tools, SQL guardrails, table reference, and error-class design carry over)

## Summary

Generalizes the single-`HEAP_WAREHOUSE` design into a **multi-source framework**: users register any number of named Heap Connect destinations ("data vault sources"), query tools route to them via an optional `source` argument, and a guided **`setup_data` MCP prompt** (surfaced by clients as a slash command) walks users through connecting a warehouse — validating the connection and registering query tools in the same session via `tools/list_changed`.

Heap Connect supports Snowflake, Redshift, BigQuery, S3, and Databricks, and one Heap environment can sync to **multiple destinations simultaneously** — hence a named registry rather than a single slot. v1 ships the three SQL warehouses; Databricks/S3 are future drivers behind the same interface.

## Architecture

```
src/
  config/sources.ts              file load/save, ${ENV_VAR} interpolation,
                                 legacy env migration, atomic 0600 writes
  services/warehouse/
    types.ts                     SourceDriver, SqlDialect, WarehouseError, capabilities
    registry.ts                  SourceRegistry: name→driver, lazy dynamic import,
                                 default resolution, add/remove
    sqlBuilders.ts               pure dialect-aware SQL + raw-SQL guardrails
    drivers/{bigquery,snowflake,redshift}.ts   real drivers (optional peer deps)
    drivers/fake.ts              test-only driver (HEAP_ENABLE_FAKE_DRIVER=1)
    drivers/shared.ts            importOptional, withTimeout, error normalization
  tools/sources.ts               heap_list/test/add/remove_source
  tools/query.ts                 7 query tools
  prompts/setupData.ts           the setup_data prompt
```

## Key decisions

1. **Config = file + env layering.** Named sources in `~/.heap-mcp/sources.json` (`HEAP_SOURCES_PATH` overrides). Legacy `HEAP_WAREHOUSE` + per-driver env vars still load, as a source named `default`; a file-defined `default` wins. Secrets may be `${ENV_VAR}` references resolved at connect time — a missing var fails only the source that needs it, naming the variable.
2. **Drivers are optional peer dependencies** (`peerDependenciesMeta.optional`), loaded via dynamic `import()` on first use. Ingestion-only installs stay light; a missing SDK yields a `DRIVER_MISSING` error carrying the exact install command.
3. **Runtime setup.** `heap_add_source` validates (connect → listTables → `_sync_history` probe) before persisting, then registers the query tools live (SDK emits `notifications/tools/list_changed`). Admin tools are disabled by default under `TRANSPORT=http`; the stateless HTTP mode re-reads the file per request instead.
4. **Default resolution** mirrors `resolveAppId`: explicit `source` param → file `default_source` → sole configured source → error listing configured names.
5. **Schema drift hedge.** Heap Connect's schema is dynamic; the event-name column (`event_view_name`) and pageview path column (`path`) are overridable per call.
6. **Capabilities flags** (`sql`, `syncStatus`) exist on every driver so future non-SQL sources (S3 manifests) can register honestly; `getSyncStatus` is an optional driver method with a SQL fallback.

## Tool surface (new)

| Tool | Registered |
|---|---|
| `heap_list_sources`, `heap_test_source` | always |
| `heap_add_source`, `heap_remove_source` | `resolveAllowSourceAdmin` (stdio default on, http default off) |
| `heap_describe_schema`, `heap_query_pageviews`, `heap_query_top_events`, `heap_query_funnel`, `heap_query_users`, `heap_execute_query`, `heap_get_sync_status` | ≥1 configured source (startup or live via add) |

`heap_execute_query` guardrails: single statement, SELECT/WITH only, write/DDL keyword blocklist, LIMIT injected/clamped (max 1000), 60 s timeout, 25 k-char output truncation. Errors surface `WarehouseError.userMessage` only — no stack traces or raw driver dumps.

## setup_data prompt flow

Assess (`heap_list_sources`) → choose destination (Snowflake/Redshift/BigQuery; Databricks/S3 = not yet) → collect config (secrets steered to `${ENV_VAR}` refs) → preflight (admin tools absent ⇒ emit file/env config and stop) → validate + persist (`heap_add_source`, with retry guidance for `DRIVER_MISSING`/auth) → report newly available tools and suggest a first query. The prompt handler embeds a live state snapshot (source names, admin availability, `HEAP_APP_ID` presence) so agents skip a discovery turn. A thin repo-level `.claude/commands/setup-data.md` points at the prompt.

## Testing

- `sources-config.test.mjs` — parsing, interpolation, migration, layering, atomic persistence, 0600 mode.
- `sql-builders.test.mjs` — per-dialect SQL for every builder; guardrail rejections; LIMIT clamping.
- `warehouse-integration.test.mjs` — built server over stdio with fake sources: registration matrix, per-source routing (JSONL SQL logs), runtime add + `tools/list_changed`, secret masking, admin gating, prompt state.
- `warehouse-live.test.mjs` — real drivers, skipped without `HEAP_TEST_{BQ,SF,RS}_*` credentials.

## Out of scope (unchanged from the prior spec)

Pagination/cursors, result caching, DDL/writes, streaming — plus, for v1: Databricks and S3 drivers (the registry and capability flags are ready for them), and DuckDB-over-Avro querying of S3 dumps.
