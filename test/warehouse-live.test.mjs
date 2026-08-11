// Live warehouse driver tests — skipped unless credentials are provided via
// environment variables (same pattern as the deletion tests requiring
// HEAP_API_KEY). Each block connects, lists tables, and runs a trivial
// SELECT through the real driver + SDK.
//
// Enable per driver:
//   BigQuery:  HEAP_TEST_BQ_PROJECT (+ HEAP_TEST_BQ_DATASET, ADC or
//              HEAP_TEST_BQ_CREDENTIALS)
//   Snowflake: HEAP_TEST_SF_ACCOUNT, HEAP_TEST_SF_USERNAME,
//              HEAP_TEST_SF_PASSWORD, HEAP_TEST_SF_DATABASE,
//              HEAP_TEST_SF_WAREHOUSE (+ HEAP_TEST_SF_SCHEMA)
//   Redshift:  HEAP_TEST_RS_HOST, HEAP_TEST_RS_DATABASE, HEAP_TEST_RS_USER,
//              HEAP_TEST_RS_PASSWORD (+ HEAP_TEST_RS_SCHEMA)
import { test } from "node:test";
import assert from "node:assert/strict";

import { instantiateDriver } from "../dist/services/warehouse/registry.js";

async function exercise(driver) {
  try {
    const detail = await driver.testConnection();
    assert.ok(detail.length > 0);
    const tables = await driver.listTables();
    assert.ok(Array.isArray(tables));
    const result = await driver.query("SELECT 1 AS ok");
    assert.equal(result.rows.length, 1);
  } finally {
    await driver.close();
  }
}

test("bigquery driver (live)", { skip: !process.env.HEAP_TEST_BQ_PROJECT }, async () => {
  const driver = await instantiateDriver("live_bq", {
    type: "bigquery",
    project: process.env.HEAP_TEST_BQ_PROJECT,
    dataset: process.env.HEAP_TEST_BQ_DATASET || "heap",
    ...(process.env.HEAP_TEST_BQ_CREDENTIALS
      ? { credentials: process.env.HEAP_TEST_BQ_CREDENTIALS }
      : {}),
  });
  await exercise(driver);
});

test("snowflake driver (live)", { skip: !process.env.HEAP_TEST_SF_ACCOUNT }, async () => {
  const driver = await instantiateDriver("live_sf", {
    type: "snowflake",
    account: process.env.HEAP_TEST_SF_ACCOUNT,
    username: process.env.HEAP_TEST_SF_USERNAME,
    password: process.env.HEAP_TEST_SF_PASSWORD,
    database: process.env.HEAP_TEST_SF_DATABASE,
    schema: process.env.HEAP_TEST_SF_SCHEMA || "heap",
    warehouse: process.env.HEAP_TEST_SF_WAREHOUSE,
  });
  await exercise(driver);
});

test("redshift driver (live)", { skip: !process.env.HEAP_TEST_RS_HOST }, async () => {
  const driver = await instantiateDriver("live_rs", {
    type: "redshift",
    host: process.env.HEAP_TEST_RS_HOST,
    port: Number(process.env.HEAP_TEST_RS_PORT || 5439),
    database: process.env.HEAP_TEST_RS_DATABASE,
    schema: process.env.HEAP_TEST_RS_SCHEMA || "heap",
    user: process.env.HEAP_TEST_RS_USER,
    password: process.env.HEAP_TEST_RS_PASSWORD,
    ssl: true,
  });
  await exercise(driver);
});
