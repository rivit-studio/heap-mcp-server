/**
 * Core types for the data vault (Heap Connect warehouse) layer.
 *
 * Heap has no public analytics query API; read access goes through Heap
 * Connect, which syncs event data into a customer-managed warehouse. Users
 * register one or more named "sources" (warehouse connections) and query
 * tools route to them. Each supported warehouse type implements SourceDriver.
 */

/**
 * Warehouse types with a driver in this release. Heap Connect also supports
 * Databricks and S3 destinations; adding one is a new driver module plus a
 * config-schema branch — see docs/superpowers/specs. "fake" is a test-only
 * in-memory driver, accepted only when HEAP_ENABLE_FAKE_DRIVER=1.
 */
export type SourceType = "bigquery" | "snowflake" | "redshift" | "fake";

/** Result of a warehouse query. */
export interface QueryResult {
  rows: Record<string, unknown>[];
  totalRows: number;
}

/** One column of a warehouse table. */
export interface ColumnInfo {
  column: string;
  type: string;
}

/**
 * What a source can do. SQL warehouses support everything; future metadata
 * -only sources (e.g. an S3 file dump) would set sql to false so tools can
 * fail with an honest message instead of a confusing driver error.
 */
export interface SourceCapabilities {
  sql: boolean;
  syncStatus: boolean;
}

/**
 * Dialect helpers for generating SQL that runs on a specific warehouse.
 * Implementations live in sqlBuilders.ts (pure, driver-free).
 */
export interface SqlDialect {
  /** Validate and render a single identifier (table/column name). */
  ident(name: string): string;
  /** Fully qualify a Heap Connect table name for a FROM clause. */
  qualify(table: string): string;
  /** Render a string value as a safely-escaped SQL string literal. */
  stringLiteral(value: string): string;
  /** Render an ISO8601 timestamp as a timestamp expression. */
  timestampLiteral(iso: string): string;
  /** Expression adding `hours` hours to a timestamp expression. */
  addHours(expr: string, hours: number): string;
  /** SQL listing table names in the configured schema/dataset. */
  listTablesSql(): string;
  /** SQL listing {column, type} rows for one table. */
  describeTableSql(table: string): string;
}

export type WarehouseErrorCode =
  | "CONFIG"
  | "AUTH"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "SQL"
  | "UNSUPPORTED"
  | "DRIVER_MISSING";

/**
 * Normalized error for the warehouse layer, mirroring HeapApiError:
 * `userMessage` is safe and actionable to surface to an agent. Raw driver
 * errors and stack traces are never exposed directly.
 */
export class WarehouseError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly code?: WarehouseErrorCode,
  ) {
    super(userMessage);
    this.name = "WarehouseError";
  }
}

/** A live connection to one configured data source. */
export interface SourceDriver {
  readonly name: string;
  readonly type: SourceType;
  readonly capabilities: SourceCapabilities;
  readonly dialect: SqlDialect;

  /** Cheap end-to-end connectivity check. Resolves to a detail message. */
  testConnection(): Promise<string>;
  /** Run a SQL statement, resolving to rows. Rejects with WarehouseError. */
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  /** List table names in the Heap Connect schema/dataset. */
  listTables(): Promise<string[]>;
  /** Describe the columns of one table. */
  describeTable(table: string): Promise<ColumnInfo[]>;
  /**
   * Optional non-SQL sync-status implementation (for future metadata-only
   * sources). SQL sources omit this; tools fall back to querying
   * _sync_history via `query()`.
   */
  getSyncStatus?(): Promise<QueryResult>;
  /** Release the underlying connection. Safe to call twice. */
  close(): Promise<void>;
}
