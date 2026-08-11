/**
 * BigQuery driver. Requires the optional peer dependency
 * "@google-cloud/bigquery". Auth: inline service-account JSON, a key file,
 * or Application Default Credentials when neither is configured.
 */

import { BigQuerySourceConfig } from "../../../schemas.js";
import { createDialect } from "../sqlBuilders.js";
import { ColumnInfo, QueryResult, SourceDriver, WarehouseError } from "../types.js";
import { importOptional, normalizeDriverError, withTimeout } from "./shared.js";

export async function createBigQueryDriver(
  name: string,
  config: BigQuerySourceConfig,
): Promise<SourceDriver> {
  const mod = await importOptional("@google-cloud/bigquery");
  const BigQuery = mod.BigQuery ?? mod.default?.BigQuery;

  const options: Record<string, unknown> = { projectId: config.project };
  if (config.credentials) {
    try {
      options.credentials = JSON.parse(config.credentials);
    } catch {
      throw new WarehouseError(
        `Source "${name}": \`credentials\` is not valid service-account JSON.`,
        "CONFIG",
      );
    }
  }
  if (config.credentials_file) options.keyFilename = config.credentials_file;
  if (config.location) options.location = config.location;

  const client = new BigQuery(options);
  const dialect = createDialect({
    type: "bigquery",
    prefixParts: [config.project, config.dataset],
  });

  const run = async (sql: string, timeoutMs?: number): Promise<QueryResult> => {
    try {
      const queryPromise: Promise<[Record<string, unknown>[]]> = client.query({
        query: sql,
        ...(config.location ? { location: config.location } : {}),
      });
      const [rows] = await withTimeout(queryPromise, timeoutMs, `BigQuery query on "${name}"`);
      const plain = rows.map((row) => ({ ...row }));
      return { rows: plain, totalRows: plain.length };
    } catch (error) {
      throw normalizeDriverError(error, `BigQuery source "${name}"`);
    }
  };

  return {
    name,
    type: "bigquery",
    capabilities: { sql: true, syncStatus: true },
    dialect,

    async testConnection(): Promise<string> {
      await run("SELECT 1 AS ok", 15000);
      return `Connected to BigQuery project "${config.project}", dataset "${config.dataset}".`;
    },

    query: run,

    async listTables(): Promise<string[]> {
      const result = await run(dialect.listTablesSql());
      return result.rows.map((row) => String(row.table_name ?? row.TABLE_NAME ?? ""));
    },

    async describeTable(table: string): Promise<ColumnInfo[]> {
      const result = await run(dialect.describeTableSql(table));
      return result.rows.map((row) => ({
        column: String(row.column_name ?? row.COLUMN_NAME ?? ""),
        type: String(row.data_type ?? row.DATA_TYPE ?? ""),
      }));
    },

    async close(): Promise<void> {
      // The BigQuery client is HTTP-based; nothing persistent to release.
    },
  };
}
