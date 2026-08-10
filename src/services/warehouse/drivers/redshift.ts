/**
 * Redshift driver, via the optional peer dependency "pg" (Redshift speaks
 * the Postgres wire protocol). TLS is on by default without CA verification
 * (`ssl: { rejectUnauthorized: false }`), the standard posture for Redshift
 * cluster endpoints; set `ssl: false` in the source config to disable TLS.
 */

import { QUERY_TIMEOUT_MS } from "../../../constants.js";
import { RedshiftSourceConfig } from "../../../schemas.js";
import { createDialect } from "../sqlBuilders.js";
import { ColumnInfo, QueryResult, SourceDriver } from "../types.js";
import { importOptional, normalizeDriverError, withTimeout } from "./shared.js";

export async function createRedshiftDriver(
  name: string,
  config: RedshiftSourceConfig,
): Promise<SourceDriver> {
  const pgMod = await importOptional("pg");
  const Client = pgMod.Client ?? pgMod.default?.Client;

  let client: any = null;

  const ensureConnected = async (): Promise<any> => {
    if (client) return client;
    const fresh = new Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      statement_timeout: QUERY_TIMEOUT_MS,
      connectionTimeoutMillis: 15000,
      application_name: "heap-mcp-server",
    });
    // A dropped connection must not linger as "connected".
    fresh.on("error", () => {
      if (client === fresh) client = null;
    });
    fresh.on("end", () => {
      if (client === fresh) client = null;
    });
    try {
      await withTimeout(fresh.connect(), 20000, `Redshift connect for "${name}"`);
    } catch (error) {
      throw normalizeDriverError(error, `Redshift source "${name}"`);
    }
    client = fresh;
    return client;
  };

  const run = async (sql: string, timeoutMs?: number): Promise<QueryResult> => {
    const conn = await ensureConnected();
    try {
      const queryPromise: Promise<{ rows?: Record<string, unknown>[] }> = conn.query(sql);
      const result = await withTimeout(queryPromise, timeoutMs, `Redshift query on "${name}"`);
      const rows = result.rows ?? [];
      return { rows, totalRows: rows.length };
    } catch (error) {
      throw normalizeDriverError(error, `Redshift source "${name}"`);
    }
  };

  const dialect = createDialect({ type: "redshift", prefixParts: [config.schema] });

  return {
    name,
    type: "redshift",
    capabilities: { sql: true, syncStatus: true },
    dialect,

    async testConnection(): Promise<string> {
      await run("SELECT 1 AS ok", 15000);
      return (
        `Connected to Redshift at "${config.host}", database "${config.database}", ` +
        `schema "${config.schema}".`
      );
    },

    query: run,

    async listTables(): Promise<string[]> {
      const result = await run(dialect.listTablesSql());
      return result.rows.map((row) => String(row.table_name ?? ""));
    },

    async describeTable(table: string): Promise<ColumnInfo[]> {
      const result = await run(dialect.describeTableSql(table));
      return result.rows.map((row) => ({
        column: String(row.column_name ?? ""),
        type: String(row.data_type ?? ""),
      }));
    },

    async close(): Promise<void> {
      const conn = client;
      client = null;
      if (!conn) return;
      try {
        await conn.end();
      } catch {
        // Already disconnected.
      }
    },
  };
}
