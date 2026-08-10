/**
 * Test-only in-memory driver. Serves canned tables from its config and
 * (optionally) appends every received SQL statement to a JSONL log so tests
 * can assert exactly what SQL reached which source. Only instantiable when
 * HEAP_ENABLE_FAKE_DRIVER=1 (enforced at config-validation time).
 */

import * as fs from "node:fs";

import { FakeSourceConfig } from "../../../schemas.js";
import { createDialect } from "../sqlBuilders.js";
import { ColumnInfo, QueryResult, SourceDriver } from "../types.js";

export function createFakeDriver(name: string, config: FakeSourceConfig): SourceDriver {
  const tables = config.tables ?? {};
  const dialect = createDialect({ type: "generic", prefixParts: [] });

  const logSql = (sql: string): void => {
    if (!config.log_path) return;
    fs.appendFileSync(config.log_path, `${JSON.stringify({ source: name, sql })}\n`);
  };

  /** Return rows of the first canned table whose name appears in the SQL. */
  const matchTable = (sql: string): Record<string, unknown>[] | undefined => {
    for (const [table, rows] of Object.entries(tables)) {
      if (new RegExp(`\\b${table}\\b`).test(sql)) return rows;
    }
    return undefined;
  };

  return {
    name,
    type: "fake",
    capabilities: { sql: true, syncStatus: true },
    dialect,

    async testConnection(): Promise<string> {
      return `Fake driver "${name}" connected (${Object.keys(tables).length} canned table(s)).`;
    },

    async query(sql: string): Promise<QueryResult> {
      logSql(sql);
      const rows = matchTable(sql) ?? [{ ok: 1 }];
      return { rows, totalRows: rows.length };
    },

    async listTables(): Promise<string[]> {
      logSql("LIST TABLES");
      return Object.keys(tables).sort();
    },

    async describeTable(table: string): Promise<ColumnInfo[]> {
      logSql(`DESCRIBE ${table}`);
      const rows = tables[table];
      if (!rows || rows.length === 0) return [];
      return Object.entries(rows[0]).map(([column, value]) => ({
        column,
        type: typeof value,
      }));
    },

    async close(): Promise<void> {
      // Nothing to release.
    },
  };
}
