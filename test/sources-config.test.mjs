// Unit tests for the sources config module: file parsing, env-var
// interpolation, legacy HEAP_WAREHOUSE migration, layering, and atomic
// persistence. Pure filesystem + env manipulation; no network, no drivers.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  interpolateEnvRefs,
  loadSourcesConfig,
  removeSourceFromFile,
  resolveSourcesPath,
  saveSourceToFile,
} from "../dist/config/sources.js";
import { SourceRegistry } from "../dist/services/warehouse/registry.js";

const MANAGED_VARS = [
  "HEAP_SOURCES_PATH",
  "HEAP_ENABLE_FAKE_DRIVER",
  "HEAP_WAREHOUSE",
  "HEAP_BQ_PROJECT",
  "HEAP_BQ_DATASET",
  "HEAP_BQ_CREDENTIALS",
  "HEAP_SF_ACCOUNT",
  "HEAP_SF_USERNAME",
  "HEAP_SF_PASSWORD",
  "HEAP_SF_DATABASE",
  "HEAP_SF_SCHEMA",
  "HEAP_SF_WAREHOUSE",
  "HEAP_RS_HOST",
  "HEAP_RS_PORT",
  "HEAP_RS_DATABASE",
  "HEAP_RS_SCHEMA",
  "HEAP_RS_USER",
  "HEAP_RS_PASSWORD",
  "TEST_INTERP_VALUE",
];

let tmpDir;
const saved = {};

beforeEach(() => {
  for (const key of MANAGED_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "heap-sources-test-"));
});

afterEach(() => {
  for (const key of MANAGED_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSources(shape) {
  const filePath = path.join(tmpDir, "sources.json");
  fs.writeFileSync(filePath, JSON.stringify(shape));
  process.env.HEAP_SOURCES_PATH = filePath;
  return filePath;
}

test("resolveSourcesPath honors HEAP_SOURCES_PATH and defaults under the home dir", () => {
  process.env.HEAP_SOURCES_PATH = path.join(tmpDir, "custom.json");
  assert.equal(resolveSourcesPath(), path.join(tmpDir, "custom.json"));
  delete process.env.HEAP_SOURCES_PATH;
  assert.ok(resolveSourcesPath().endsWith(path.join(".heap-mcp", "sources.json")));
});

test("loads valid sources of every type and applies schema defaults", () => {
  writeSources({
    version: 1,
    default_source: "sf",
    sources: {
      sf: {
        type: "snowflake",
        account: "xy1",
        username: "u",
        password: "p",
        database: "DB",
        warehouse: "WH",
      },
      bq: { type: "bigquery", project: "proj" },
      rs: { type: "redshift", host: "h", database: "d", user: "u", password: "p" },
    },
  });
  const cfg = loadSourcesConfig();
  assert.equal(cfg.loadError, undefined);
  assert.equal(cfg.defaultSource, "sf");
  assert.deepEqual([...cfg.sources.keys()].sort(), ["bq", "rs", "sf"]);
  assert.equal(cfg.sources.get("sf").config.schema, "heap");
  assert.equal(cfg.sources.get("bq").config.dataset, "heap");
  assert.equal(cfg.sources.get("rs").config.port, 5439);
  assert.equal(cfg.sources.get("rs").config.ssl, true);
  assert.equal(cfg.invalid.length, 0);
});

test("invalid sources are reported, not fatal; valid siblings still load", () => {
  writeSources({
    version: 1,
    sources: {
      good: { type: "bigquery", project: "p" },
      bad: { type: "snowflake", account: "only" },
      "Bad Name!": { type: "bigquery", project: "p" },
      unknown_type: { type: "databricks", host: "h" },
    },
  });
  const cfg = loadSourcesConfig();
  assert.deepEqual([...cfg.sources.keys()], ["good"]);
  assert.equal(cfg.invalid.length, 3);
});

test("malformed JSON sets loadError and registry refuses writes", () => {
  const filePath = path.join(tmpDir, "sources.json");
  fs.writeFileSync(filePath, "{not json");
  process.env.HEAP_SOURCES_PATH = filePath;
  const cfg = loadSourcesConfig();
  assert.match(cfg.loadError, /not valid JSON/);
  assert.equal(cfg.sources.size, 0);

  const registry = new SourceRegistry(cfg);
  assert.throws(
    () => registry.add("x", { type: "bigquery", project: "p", dataset: "heap" }, { makeDefault: false, overwrite: false }),
    /Refusing to modify/,
  );
});

test("fake type is rejected without HEAP_ENABLE_FAKE_DRIVER=1", () => {
  writeSources({ version: 1, sources: { f: { type: "fake" } } });
  let cfg = loadSourcesConfig();
  assert.equal(cfg.sources.size, 0);
  assert.match(cfg.invalid[0].reason, /HEAP_ENABLE_FAKE_DRIVER/);

  process.env.HEAP_ENABLE_FAKE_DRIVER = "1";
  cfg = loadSourcesConfig();
  assert.equal(cfg.sources.size, 1);
});

test("unsupported file version sets loadError", () => {
  writeSources({ version: 2, sources: {} });
  const cfg = loadSourcesConfig();
  assert.match(cfg.loadError, /unsupported version/);
});

test("${ENV_VAR} interpolation resolves at use time and names missing vars", () => {
  process.env.TEST_INTERP_VALUE = "s3cret";
  const config = {
    type: "snowflake",
    account: "a",
    username: "u",
    password: "${TEST_INTERP_VALUE}",
    database: "d",
    schema: "heap",
    warehouse: "w",
  };
  const resolved = interpolateEnvRefs(config, "sf");
  assert.equal(resolved.password, "s3cret");
  // Original untouched.
  assert.equal(config.password, "${TEST_INTERP_VALUE}");

  delete process.env.TEST_INTERP_VALUE;
  assert.throws(
    () => interpolateEnvRefs(config, "sf"),
    (err) => err.name === "WarehouseError" && /TEST_INTERP_VALUE/.test(err.userMessage),
  );
});

test("legacy env vars migrate to a source named 'default' for all three types", () => {
  process.env.HEAP_SOURCES_PATH = path.join(tmpDir, "none.json");

  process.env.HEAP_WAREHOUSE = "bigquery";
  process.env.HEAP_BQ_PROJECT = "proj";
  let cfg = loadSourcesConfig();
  let entry = cfg.sources.get("default");
  assert.equal(entry.origin, "env");
  assert.equal(entry.config.type, "bigquery");
  assert.equal(entry.config.dataset, "heap");
  delete process.env.HEAP_BQ_PROJECT;

  process.env.HEAP_WAREHOUSE = "snowflake";
  Object.assign(process.env, {
    HEAP_SF_ACCOUNT: "xy",
    HEAP_SF_USERNAME: "u",
    HEAP_SF_PASSWORD: "p",
    HEAP_SF_DATABASE: "db",
    HEAP_SF_WAREHOUSE: "wh",
  });
  cfg = loadSourcesConfig();
  entry = cfg.sources.get("default");
  assert.equal(entry.config.type, "snowflake");
  assert.equal(entry.config.schema, "heap");

  process.env.HEAP_WAREHOUSE = "redshift";
  Object.assign(process.env, {
    HEAP_RS_HOST: "h",
    HEAP_RS_PORT: "5440",
    HEAP_RS_DATABASE: "d",
    HEAP_RS_USER: "u",
    HEAP_RS_PASSWORD: "p",
  });
  cfg = loadSourcesConfig();
  entry = cfg.sources.get("default");
  assert.equal(entry.config.type, "redshift");
  assert.equal(entry.config.port, 5440);
});

test("incomplete legacy env vars are skipped non-fatally", () => {
  process.env.HEAP_SOURCES_PATH = path.join(tmpDir, "none.json");
  process.env.HEAP_WAREHOUSE = "snowflake"; // no HEAP_SF_* vars
  const cfg = loadSourcesConfig();
  assert.equal(cfg.sources.size, 0);
});

test("a file-defined 'default' shadows the env-derived source", () => {
  process.env.HEAP_WAREHOUSE = "bigquery";
  process.env.HEAP_BQ_PROJECT = "env-proj";
  writeSources({
    version: 1,
    sources: { default: { type: "bigquery", project: "file-proj" } },
  });
  const cfg = loadSourcesConfig();
  const entry = cfg.sources.get("default");
  assert.equal(entry.origin, "file");
  assert.equal(entry.config.project, "file-proj");
});

test("save/remove round-trip is atomic-ish and preserves siblings", () => {
  const filePath = path.join(tmpDir, "sources.json");
  saveSourceToFile(filePath, "a", { type: "bigquery", project: "p1", dataset: "heap" }, true);
  saveSourceToFile(filePath, "b", { type: "bigquery", project: "p2", dataset: "heap" }, false);

  let shape = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(shape.version, 1);
  assert.equal(shape.default_source, "a");
  assert.deepEqual(Object.keys(shape.sources).sort(), ["a", "b"]);

  if (process.platform !== "win32") {
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600, "sources file is written 0600");
  }

  removeSourceFromFile(filePath, "a");
  shape = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(Object.keys(shape.sources), ["b"]);
  assert.equal(shape.default_source, undefined, "default cleared when its source is removed");

  assert.throws(() => removeSourceFromFile(filePath, "missing"), /not defined/);
});

test("registry default resolution: explicit > default_source > sole source; errors list names", async () => {
  process.env.HEAP_ENABLE_FAKE_DRIVER = "1";
  writeSources({
    version: 1,
    sources: { only: { type: "fake", tables: {} } },
  });
  let registry = new SourceRegistry(loadSourcesConfig());
  assert.equal(registry.resolveName(), "only", "sole source is the implicit default");

  writeSources({
    version: 1,
    sources: { a: { type: "fake", tables: {} }, b: { type: "fake", tables: {} } },
  });
  registry = new SourceRegistry(loadSourcesConfig());
  assert.throws(() => registry.resolveName(), /none is the default/);
  assert.throws(() => registry.resolveName("nope"), /Unknown data source "nope".*"a", "b"/s);
  assert.equal(registry.resolveName("b"), "b");

  writeSources({
    version: 1,
    default_source: "b",
    sources: { a: { type: "fake", tables: {} }, b: { type: "fake", tables: {} } },
  });
  registry = new SourceRegistry(loadSourcesConfig());
  assert.equal(registry.resolveName(), "b");
  const driver = await registry.resolve();
  assert.equal(driver.name, "b");
});
