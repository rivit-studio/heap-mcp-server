/**
 * Snowflake driver. Requires the optional peer dependency "snowflake-sdk".
 * Opens one connection per source; reconnects automatically if the
 * connection has been terminated (Snowflake idles out long-lived sessions).
 */

import { SnowflakeSourceConfig } from "../../../schemas.js";
import { createDialect } from "../sqlBuilders.js";
import { ColumnInfo, QueryResult, SourceDriver } from "../types.js";
import { importOptional, normalizeDriverError, withTimeout } from "./shared.js";

export async function createSnowflakeDriver(
  name: string,
  config: SnowflakeSourceConfig,
): Promise<SourceDriver> {
  const sdk = await importOptional("snowflake-sdk");
  const snowflake = sdk.default ?? sdk;
  // Keep the SDK's console logging out of the MCP stdio channel.
  try {
    snowflake.configure?.({ logLevel: "OFF" });
  } catch {
    // Older SDK versions may not support this log level; non-fatal.
  }

  let connection: any = null;

  const connect = (): Promise<any> =>
    new Promise((resolve, reject) => {
      const conn = snowflake.createConnection({
        account: config.account,
        username: config.username,
        password: config.password,
        database: config.database,
        schema: config.schema,
        warehouse: config.warehouse,
        ...(config.role ? { role: config.role } : {}),
        application: "heap_mcp_server",
      });
      conn.connect((err: unknown) => {
        if (err) reject(normalizeDriverError(err, `Snowflake source "${name}"`));
        else resolve(conn);
      });
    });

  const ensureConnected = async (): Promise<any> => {
    if (connection && connection.isUp?.() !== false) return connection;
    connection = await withTimeout(connect(), 30000, `Snowflake connect for "${name}"`);
    return connection;
  };

  const run = async (sql: string, timeoutMs?: number): Promise<QueryResult> => {
    const conn = await ensureConnected();
    const exec = new Promise<QueryResult>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        complete(err: unknown, _stmt: unknown, rows: Record<string, unknown>[] | undefined) {
          if (err) reject(normalizeDriverError(err, `Snowflake source "${name}"`));
          else resolve({ rows: rows ?? [], totalRows: rows?.length ?? 0 });
        },
      });
    });
    return withTimeout(exec, timeoutMs, `Snowflake query on "${name}"`);
  };

  const dialect = createDialect({
    type: "snowflake",
    prefixParts: [config.database, config.schema],
  });

  return {
    name,
    type: "snowflake",
    capabilities: { sql: true, syncStatus: true },
    dialect,

    async testConnection(): Promise<string> {
      await run("SELECT 1 AS ok", 15000);
      return (
        `Connected to Snowflake account "${config.account}", database ` +
        `"${config.database}", schema "${config.schema}".`
      );
    },

    query: run,

    async listTables(): Promise<string[]> {
      const result = await run(dialect.listTablesSql());
      return result.rows.map((row) => String(row.TABLE_NAME ?? row.table_name ?? ""));
    },

    async describeTable(table: string): Promise<ColumnInfo[]> {
      const result = await run(dialect.describeTableSql(table));
      return result.rows.map((row) => ({
        column: String(row.COLUMN_NAME ?? row.column_name ?? ""),
        type: String(row.DATA_TYPE ?? row.data_type ?? ""),
      }));
    },

    async close(): Promise<void> {
      const conn = connection;
      connection = null;
      if (!conn) return;
      await new Promise<void>((resolve) => {
        conn.destroy(() => resolve());
      });
    },
  };
}
