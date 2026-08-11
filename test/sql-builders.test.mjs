// Unit tests for SQL generation and raw-SQL guardrails. Pure functions,
// no drivers or credentials involved.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFunnelSql,
  buildPageviewsSql,
  buildSyncStatusSql,
  buildTopEventsSql,
  buildUsersSql,
  clampAndInjectLimit,
  createDialect,
  sanitizeSelectOnly,
} from "../dist/services/warehouse/sqlBuilders.js";

const bq = createDialect({ type: "bigquery", prefixParts: ["proj", "heap"] });
const sf = createDialect({ type: "snowflake", prefixParts: ["DB", "heap"] });
const rs = createDialect({ type: "redshift", prefixParts: ["heap"] });

test("dialect table qualification", () => {
  assert.equal(bq.qualify("users"), "`proj.heap.users`");
  assert.equal(sf.qualify("users"), "DB.heap.users");
  assert.equal(rs.qualify("users"), "heap.users");
  assert.throws(() => bq.qualify("users; DROP"), /Invalid table name/);
});

test("dialect timestamp literals and interval arithmetic", () => {
  assert.equal(bq.timestampLiteral("2026-08-01"), "TIMESTAMP('2026-08-01')");
  assert.equal(sf.timestampLiteral("2026-08-01T00:00:00Z"), "TO_TIMESTAMP_TZ('2026-08-01T00:00:00Z')");
  assert.equal(rs.timestampLiteral("2026-08-01"), "'2026-08-01'::timestamptz");
  assert.throws(() => bq.timestampLiteral("8/1/2026"), /ISO8601/);
  assert.throws(() => bq.timestampLiteral("2026-08-01'); DROP TABLE x;--"), /ISO8601/);

  assert.equal(bq.addHours("t", 168), "TIMESTAMP_ADD(t, INTERVAL 168 HOUR)");
  assert.equal(sf.addHours("t", 168), "DATEADD(hour, 168, t)");
  assert.equal(rs.addHours("t", 24), "DATEADD(hour, 24, t)");
});

test("string literals are escaped per dialect", () => {
  assert.equal(rs.stringLiteral("o'brien"), "'o''brien'");
  // Backslash doubled where backslash is an escape character.
  assert.equal(bq.stringLiteral("a\\b"), "'a\\\\b'");
  assert.equal(sf.stringLiteral("a\\b"), "'a\\\\b'");
  assert.equal(rs.stringLiteral("a\\b"), "'a\\b'");
  assert.throws(() => rs.stringLiteral("line\nbreak"), /must not contain/);
});

test("pageviews SQL: grouping, url filter, limit", () => {
  const sql = buildPageviewsSql(rs, {
    startTime: "2026-08-01",
    endTime: "2026-08-08",
    urlContains: "pricing",
    groupBy: "url",
    urlColumn: "path",
    limit: 50,
  });
  assert.match(sql, /FROM heap\.pageviews/);
  assert.match(sql, /path LIKE '%pricing%'/);
  assert.match(sql, /time >= '2026-08-01'::timestamptz/);
  assert.match(sql, /GROUP BY 1/);
  assert.match(sql, /ORDER BY pageview_count DESC/);
  assert.match(sql, /LIMIT 50$/);

  const byDay = buildPageviewsSql(bq, {
    startTime: "2026-08-01",
    endTime: "2026-08-08",
    groupBy: "day",
    urlColumn: "path",
    limit: 100,
  });
  assert.match(byDay, /CAST\(time AS DATE\) AS day/);
  assert.match(byDay, /ORDER BY day/);
  assert.match(byDay, /`proj\.heap\.pageviews`/);
});

test("top events SQL: event column, pageview exclusion", () => {
  const sql = buildTopEventsSql(sf, {
    startTime: "2026-08-01",
    endTime: "2026-08-08",
    excludePageviews: true,
    eventColumn: "event_view_name",
    limit: 25,
  });
  assert.match(sql, /FROM DB\.heap\.all_events/);
  assert.match(sql, /event_view_name AS event_name/);
  assert.match(sql, /LOWER\(event_view_name\) <> 'pageviews'/);
  assert.match(sql, /LIMIT 25$/);
});

test("funnel SQL: one CTE per step, conversion window join, ordered union", () => {
  const sql = buildFunnelSql(rs, {
    steps: ["sign_up", "created_project", "invited_teammate"],
    startTime: "2026-07-01",
    endTime: "2026-08-01",
    conversionWindowHours: 72,
    eventColumn: "event_view_name",
  });
  assert.match(sql, /^WITH step_1 AS/);
  assert.match(sql, /step_2 AS \(SELECT e\.user_id/);
  assert.match(sql, /JOIN step_1 s ON e\.user_id = s\.user_id/);
  assert.match(sql, /JOIN step_2 s ON e\.user_id = s\.user_id/);
  assert.match(sql, /DATEADD\(hour, 72, s\.time\)/);
  assert.match(sql, /event_view_name = 'sign_up'/);
  assert.match(sql, /UNION ALL SELECT 3/);
  assert.match(sql, /ORDER BY step$/);
});

test("users SQL: filters compose; event names with quotes are escaped", () => {
  const sql = buildUsersSql(rs, {
    identity: "o'brien@example.com",
    propertyKey: "plan",
    propertyValue: "pro",
    performedEvent: "ran_export",
    startTime: "2026-08-01",
    eventColumn: "event_view_name",
    limit: 10,
  });
  assert.match(sql, /identity = 'o''brien@example\.com'/);
  assert.match(sql, /plan = 'pro'/);
  assert.match(sql, /user_id IN \(SELECT DISTINCT user_id FROM heap\.all_events/);
  assert.match(sql, /event_view_name = 'ran_export'/);
  assert.match(sql, /LIMIT 10$/);

  assert.throws(
    () =>
      buildUsersSql(rs, {
        propertyKey: "plan; DROP TABLE users",
        propertyValue: "x",
        eventColumn: "event_view_name",
        limit: 10,
      }),
    /Invalid identifier/,
  );
});

test("sync status SQL targets _sync_history", () => {
  assert.equal(buildSyncStatusSql(rs, 50), "SELECT * FROM heap._sync_history LIMIT 50");
});

test("sanitizeSelectOnly: accepts SELECT and WITH, strips one trailing semicolon", () => {
  assert.equal(sanitizeSelectOnly("SELECT 1;"), "SELECT 1");
  assert.equal(sanitizeSelectOnly("  with x as (select 1) select * from x  "), "with x as (select 1) select * from x");
});

test("sanitizeSelectOnly: rejects writes, DDL, and multi-statement", () => {
  const bad = [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a=1",
    "DELETE FROM t",
    "DROP TABLE t",
    "CREATE TABLE t (a int)",
    "ALTER TABLE t ADD c int",
    "TRUNCATE t",
    "GRANT SELECT ON t TO x",
    "SELECT 1; DROP TABLE t;",
    "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
    "MERGE INTO t USING s ON 1=1",
    "COPY t FROM 's3://x'",
  ];
  for (const sql of bad) {
    assert.throws(() => sanitizeSelectOnly(sql), Error, `should reject: ${sql}`);
  }
  // Word boundaries: column names containing keywords are fine.
  assert.equal(
    sanitizeSelectOnly("SELECT created_at, updated_at FROM heap.users"),
    "SELECT created_at, updated_at FROM heap.users",
  );
});

test("clampAndInjectLimit: appends, keeps, or clamps a trailing LIMIT", () => {
  assert.equal(clampAndInjectLimit("SELECT 1", 100), "SELECT 1 LIMIT 100");
  assert.equal(clampAndInjectLimit("SELECT 1 LIMIT 5", 100), "SELECT 1 LIMIT 5");
  assert.equal(clampAndInjectLimit("SELECT 1 LIMIT 99999", 100), "SELECT 1 LIMIT 100");
  // A subquery LIMIT is left alone; an outer cap is appended.
  assert.equal(
    clampAndInjectLimit("SELECT * FROM (SELECT 1 LIMIT 9999) q", 100),
    "SELECT * FROM (SELECT 1 LIMIT 9999) q LIMIT 100",
  );
});
