/**
 * Pure SQL generation for the Heap Connect query tools.
 *
 * No driver dependencies — everything here is unit-testable without any
 * warehouse SDK installed. Dialects cover the syntax differences between
 * BigQuery, Snowflake, and Redshift (identifier quoting, timestamp literals,
 * interval arithmetic, INFORMATION_SCHEMA access).
 *
 * Safety model: identifiers are validated against a strict charset before
 * interpolation; string values are escaped per dialect; timestamps must match
 * the ISO8601 pattern enforced by the input schemas.
 */

import { SqlDialect, WarehouseError } from "./types.js";

export type DialectType = "bigquery" | "snowflake" | "redshift" | "generic";

export interface DialectOptions {
  type: DialectType;
  /**
   * Qualification prefix for Heap tables:
   * bigquery [project, dataset] · snowflake [database, schema] ·
   * redshift [schema] · generic [].
   */
  prefixParts: string[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function assertIdentifier(name: string, what = "identifier"): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new WarehouseError(
      `Invalid ${what} "${name}": only letters, digits, '_' and '$' are allowed.`,
      "SQL",
    );
  }
  return name;
}

function assertIso(iso: string): string {
  if (!ISO_PATTERN.test(iso)) {
    throw new WarehouseError(`Invalid timestamp "${iso}": expected ISO8601.`, "SQL");
  }
  return iso;
}

/** Escape a string literal: quotes doubled; backslashes doubled on dialects
 * where backslash is an escape character (BigQuery, Snowflake). */
function escapeString(value: string, type: DialectType): string {
  if (/[\0\r\n]/.test(value)) {
    throw new WarehouseError("String values must not contain NUL or newline characters.", "SQL");
  }
  let escaped = value.replace(/'/g, "''");
  if (type === "bigquery" || type === "snowflake") {
    escaped = escaped.replace(/\\/g, "\\\\");
  }
  return escaped;
}

export function createDialect(options: DialectOptions): SqlDialect {
  const { type, prefixParts } = options;
  prefixParts.forEach((part) => assertIdentifier(part, "schema qualifier"));
  const prefix = prefixParts.join(".");

  const qualify = (table: string): string => {
    assertIdentifier(table, "table name");
    if (!prefix) return table;
    // BigQuery paths must be backtick-quoted as a whole; the other
    // warehouses case-fold unquoted identifiers, which matches how Heap
    // Connect names its tables.
    return type === "bigquery" ? `\`${prefix}.${table}\`` : `${prefix}.${table}`;
  };

  const timestampLiteral = (iso: string): string => {
    assertIso(iso);
    switch (type) {
      case "bigquery":
        return `TIMESTAMP('${iso}')`;
      case "snowflake":
        return `TO_TIMESTAMP_TZ('${iso}')`;
      case "redshift":
        return `'${iso}'::timestamptz`;
      default:
        return `TIMESTAMP '${iso}'`;
    }
  };

  const addHours = (expr: string, hours: number): string => {
    const h = Math.floor(hours);
    switch (type) {
      case "bigquery":
        return `TIMESTAMP_ADD(${expr}, INTERVAL ${h} HOUR)`;
      case "snowflake":
      case "redshift":
        return `DATEADD(hour, ${h}, ${expr})`;
      default:
        return `ADD_HOURS(${expr}, ${h})`;
    }
  };

  const listTablesSql = (): string => {
    switch (type) {
      case "bigquery":
        return (
          `SELECT table_name FROM \`${prefix}.INFORMATION_SCHEMA.TABLES\` ` +
          "ORDER BY table_name"
        );
      case "snowflake": {
        const [database, schema] = prefixParts;
        return (
          `SELECT table_name FROM ${database}.information_schema.tables ` +
          `WHERE UPPER(table_schema) = UPPER('${escapeString(schema, type)}') ` +
          "ORDER BY table_name"
        );
      }
      case "redshift": {
        const [schema] = prefixParts;
        return (
          "SELECT table_name FROM information_schema.tables " +
          `WHERE table_schema = '${escapeString(schema, type)}' ` +
          "ORDER BY table_name"
        );
      }
      default:
        return "LIST TABLES";
    }
  };

  const describeTableSql = (table: string): string => {
    assertIdentifier(table, "table name");
    switch (type) {
      case "bigquery":
        return (
          `SELECT column_name, data_type FROM \`${prefix}.INFORMATION_SCHEMA.COLUMNS\` ` +
          `WHERE table_name = '${escapeString(table, type)}' ORDER BY ordinal_position`
        );
      case "snowflake": {
        const [database, schema] = prefixParts;
        return (
          `SELECT column_name, data_type FROM ${database}.information_schema.columns ` +
          `WHERE UPPER(table_schema) = UPPER('${escapeString(schema, type)}') ` +
          `AND UPPER(table_name) = UPPER('${escapeString(table, type)}') ` +
          "ORDER BY ordinal_position"
        );
      }
      case "redshift": {
        const [schema] = prefixParts;
        return (
          "SELECT column_name, data_type FROM information_schema.columns " +
          `WHERE table_schema = '${escapeString(schema, type)}' ` +
          `AND table_name = '${escapeString(table, type)}' ORDER BY ordinal_position`
        );
      }
      default:
        return `DESCRIBE ${table}`;
    }
  };

  return {
    ident: (name) => assertIdentifier(name),
    qualify,
    stringLiteral: (value) => `'${escapeString(value, type)}'`,
    timestampLiteral,
    addHours,
    listTablesSql,
    describeTableSql,
  };
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

export interface PageviewsParams {
  startTime: string;
  endTime: string;
  urlContains?: string;
  groupBy: "url" | "day" | "user";
  urlColumn: string;
  limit: number;
}

export function buildPageviewsSql(d: SqlDialect, p: PageviewsParams): string {
  const urlCol = d.ident(p.urlColumn);
  const timeFilter =
    `time >= ${d.timestampLiteral(p.startTime)} AND time <= ${d.timestampLiteral(p.endTime)}`;
  const urlFilter = p.urlContains
    ? ` AND ${urlCol} LIKE ${d.stringLiteral(`%${p.urlContains}%`)}`
    : "";
  const key =
    p.groupBy === "url"
      ? `${urlCol} AS url`
      : p.groupBy === "day"
        ? "CAST(time AS DATE) AS day"
        : "user_id";
  const order = p.groupBy === "day" ? "day" : "pageview_count DESC";
  return (
    `SELECT ${key}, COUNT(*) AS pageview_count, COUNT(DISTINCT user_id) AS unique_users ` +
    `FROM ${d.qualify("pageviews")} WHERE ${timeFilter}${urlFilter} ` +
    `GROUP BY 1 ORDER BY ${order} LIMIT ${Math.floor(p.limit)}`
  );
}

export interface TopEventsParams {
  startTime: string;
  endTime: string;
  excludePageviews: boolean;
  eventColumn: string;
  limit: number;
}

export function buildTopEventsSql(d: SqlDialect, p: TopEventsParams): string {
  const eventCol = d.ident(p.eventColumn);
  const pageviewFilter = p.excludePageviews ? ` AND LOWER(${eventCol}) <> 'pageviews'` : "";
  return (
    `SELECT ${eventCol} AS event_name, COUNT(*) AS event_count, ` +
    "COUNT(DISTINCT user_id) AS unique_users " +
    `FROM ${d.qualify("all_events")} ` +
    `WHERE time >= ${d.timestampLiteral(p.startTime)} AND time <= ${d.timestampLiteral(p.endTime)}` +
    `${pageviewFilter} GROUP BY 1 ORDER BY event_count DESC LIMIT ${Math.floor(p.limit)}`
  );
}

export interface FunnelParams {
  steps: string[];
  startTime: string;
  endTime: string;
  conversionWindowHours: number;
  eventColumn: string;
}

/**
 * One CTE per step: step N keeps users from step N-1 whose first step-N event
 * falls within the conversion window of their step-(N-1) time. The final
 * SELECT returns one row per step with the user count; conversion percentages
 * are computed by the caller.
 */
export function buildFunnelSql(d: SqlDialect, p: FunnelParams): string {
  const eventCol = d.ident(p.eventColumn);
  const allEvents = d.qualify("all_events");
  const ctes: string[] = [];

  p.steps.forEach((step, i) => {
    const n = i + 1;
    if (i === 0) {
      ctes.push(
        `step_1 AS (SELECT user_id, MIN(time) AS time FROM ${allEvents} ` +
          `WHERE ${eventCol} = ${d.stringLiteral(step)} ` +
          `AND time >= ${d.timestampLiteral(p.startTime)} ` +
          `AND time <= ${d.timestampLiteral(p.endTime)} GROUP BY user_id)`,
      );
    } else {
      ctes.push(
        `step_${n} AS (SELECT e.user_id, MIN(e.time) AS time FROM ${allEvents} e ` +
          `JOIN step_${i} s ON e.user_id = s.user_id ` +
          `WHERE e.${eventCol} = ${d.stringLiteral(step)} ` +
          `AND e.time >= s.time AND e.time <= ${d.addHours("s.time", p.conversionWindowHours)} ` +
          "GROUP BY e.user_id)",
      );
    }
  });

  const selects = p.steps.map((step, i) => {
    const n = i + 1;
    return (
      `SELECT ${n} AS step, ${d.stringLiteral(step)} AS event_name, ` +
      `(SELECT COUNT(*) FROM step_${n}) AS users`
    );
  });

  return `WITH ${ctes.join(", ")} ${selects.join(" UNION ALL ")} ORDER BY step`;
}

export interface UsersParams {
  identity?: string;
  propertyKey?: string;
  propertyValue?: string;
  performedEvent?: string;
  startTime?: string;
  endTime?: string;
  eventColumn: string;
  limit: number;
}

export function buildUsersSql(d: SqlDialect, p: UsersParams): string {
  const filters: string[] = [];
  if (p.identity) filters.push(`identity = ${d.stringLiteral(p.identity)}`);
  if (p.propertyKey && p.propertyValue !== undefined) {
    filters.push(`${d.ident(p.propertyKey)} = ${d.stringLiteral(p.propertyValue)}`);
  }
  if (p.performedEvent) {
    const eventCol = d.ident(p.eventColumn);
    const time: string[] = [];
    if (p.startTime) time.push(`time >= ${d.timestampLiteral(p.startTime)}`);
    if (p.endTime) time.push(`time <= ${d.timestampLiteral(p.endTime)}`);
    const timeSql = time.length ? ` AND ${time.join(" AND ")}` : "";
    filters.push(
      `user_id IN (SELECT DISTINCT user_id FROM ${d.qualify("all_events")} ` +
        `WHERE ${eventCol} = ${d.stringLiteral(p.performedEvent)}${timeSql})`,
    );
  }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  return `SELECT * FROM ${d.qualify("users")}${where} LIMIT ${Math.floor(p.limit)}`;
}

export function buildSyncStatusSql(d: SqlDialect, limit: number): string {
  return `SELECT * FROM ${d.qualify("_sync_history")} LIMIT ${Math.floor(limit)}`;
}

// ---------------------------------------------------------------------------
// Raw SQL guardrails
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|MERGE|CALL|COPY|UNLOAD|EXPORT)\b/i;

/**
 * Enforce SELECT-only raw SQL: a single statement starting with SELECT or
 * WITH, containing no write/DDL keywords anywhere (a deliberately blunt
 * check — a SELECT mentioning e.g. the word DELETE in a literal is rejected).
 * Returns the trimmed statement without a trailing semicolon.
 */
export function sanitizeSelectOnly(sql: string): string {
  let trimmed = sql.trim();
  if (trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1).trimEnd();
  if (trimmed.includes(";")) {
    throw new WarehouseError(
      "Only a single SQL statement is allowed (no semicolons).",
      "SQL",
    );
  }
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new WarehouseError(
      "Only SELECT (or WITH ... SELECT) statements are allowed.",
      "SQL",
    );
  }
  const forbidden = trimmed.match(FORBIDDEN_KEYWORDS);
  if (forbidden) {
    throw new WarehouseError(
      `Statement rejected: contains forbidden keyword ${forbidden[1].toUpperCase()}. ` +
        "Only read-only SELECT queries are allowed.",
      "SQL",
    );
  }
  return trimmed;
}

/**
 * Ensure the statement carries a row limit no higher than `limit`: a trailing
 * LIMIT is clamped, otherwise a LIMIT clause is appended.
 */
export function clampAndInjectLimit(sql: string, limit: number): string {
  const capped = Math.floor(limit);
  const match = sql.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (match) {
    const existing = parseInt(match[1], 10);
    if (existing <= capped) return sql;
    return `${sql.slice(0, match.index)}LIMIT ${capped}`;
  }
  return `${sql} LIMIT ${capped}`;
}
