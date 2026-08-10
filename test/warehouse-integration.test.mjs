// Integration tests for the data vault source framework: run the built
// server over stdio with fake sources (HEAP_ENABLE_FAKE_DRIVER=1) and assert
// tool registration, source routing, guardrails, runtime add with
// tools/list_changed, admin gating, and the setup_data prompt.
// No credentials or network required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, "..", "dist", "index.js");

// StdioMcpClient with notification capture (superset of the client in
// integration.test.mjs, which is kept untouched).
class StdioMcpClient {
  constructor(env) {
    this.proc = spawn("node", [SERVER_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buf = "";
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        } else if (msg.method && msg.id === undefined) {
          this.notifications.push(msg);
        }
      }
    });
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize() {
    await this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools() {
    const res = await this._request("tools/list", {});
    return res.result.tools.map((t) => t.name);
  }

  async call(name, args) {
    const res = await this._request("tools/call", { name, arguments: args });
    return res.result;
  }

  async getPrompt(name, args) {
    const res = await this._request("prompts/get", { name, arguments: args ?? {} });
    return res.result;
  }

  close() {
    this.proc.kill();
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "heap-warehouse-test-"));
}

function writeSourcesFile(dir, shape) {
  const filePath = path.join(dir, "sources.json");
  fs.writeFileSync(filePath, JSON.stringify(shape));
  return filePath;
}

const QUERY_TOOLS = [
  "heap_describe_schema",
  "heap_query_pageviews",
  "heap_query_top_events",
  "heap_query_funnel",
  "heap_query_users",
  "heap_execute_query",
  "heap_get_sync_status",
];

test("zero sources: ingestion + source tools only; query tools absent", async (t) => {
  const dir = makeTmpDir();
  const client = new StdioMcpClient({
    HEAP_APP_ID: "app-1",
    HEAP_SOURCES_PATH: path.join(dir, "missing.json"),
  });
  t.after(() => {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.initialize();

  const tools = await client.listTools();
  assert.ok(tools.includes("heap_track_event"), "ingestion tools present");
  assert.ok(tools.includes("heap_list_sources"));
  assert.ok(tools.includes("heap_test_source"));
  assert.ok(tools.includes("heap_add_source"), "admin tools on stdio by default");
  for (const name of QUERY_TOOLS) {
    assert.ok(!tools.includes(name), `${name} absent with no sources`);
  }

  const res = await client.call("heap_list_sources", {});
  assert.match(res.content[0].text, /No data sources are configured/);

  // Query tools require a configured source; test_source says so clearly.
  const testRes = await client.call("heap_test_source", {});
  assert.equal(testRes.isError, true);
  assert.match(testRes.content[0].text, /No data sources are configured/);
});

test("fake sources: routing, default resolution, guardrails, funnel math", async (t) => {
  const dir = makeTmpDir();
  const logA = path.join(dir, "a.jsonl");
  const logB = path.join(dir, "b.jsonl");
  const sourcesPath = writeSourcesFile(dir, {
    version: 1,
    default_source: "alpha",
    sources: {
      alpha: {
        type: "fake",
        log_path: logA,
        tables: {
          all_events: [
            { step: 1, event_name: "sign_up", users: 100 },
            { step: 2, event_name: "purchase", users: 25 },
          ],
          _sync_history: [{ table_name: "users", synced_at: "2026-08-09" }],
        },
      },
      beta: {
        type: "fake",
        log_path: logB,
        tables: { users: [{ user_id: 7, identity: "x@y.z" }] },
      },
    },
  });
  const client = new StdioMcpClient({
    HEAP_APP_ID: "app-1",
    HEAP_SOURCES_PATH: sourcesPath,
    HEAP_ENABLE_FAKE_DRIVER: "1",
  });
  t.after(() => {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.initialize();

  const tools = await client.listTools();
  for (const name of QUERY_TOOLS) {
    assert.ok(tools.includes(name), `${name} registered`);
  }

  // list_sources shows both with the default flagged.
  const list = await client.call("heap_list_sources", {});
  assert.equal(list.structuredContent.sources.length, 2);
  const alpha = list.structuredContent.sources.find((s) => s.name === "alpha");
  assert.equal(alpha.is_default, true);

  // Default routing goes to alpha; explicit source routes to beta.
  await client.call("heap_query_top_events", {
    start_time: "2026-08-01",
    end_time: "2026-08-08",
  });
  const users = await client.call("heap_query_users", { source: "beta", identity: "x@y.z" });
  assert.equal(users.structuredContent.rows[0].identity, "x@y.z");

  const sqlA = fs.readFileSync(logA, "utf8");
  const sqlB = fs.readFileSync(logB, "utf8");
  assert.match(sqlA, /all_events/, "top-events SQL reached alpha");
  assert.match(sqlB, /identity = 'x@y\.z'/, "users SQL reached beta");
  assert.doesNotMatch(sqlA, /identity = 'x@y\.z'/, "users SQL did not leak to alpha");

  // Unknown source error names the configured sources.
  const unknown = await client.call("heap_query_users", { source: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /"alpha", "beta"/);

  // Funnel conversion math is computed from per-step counts.
  const funnel = await client.call("heap_query_funnel", {
    steps: ["sign_up", "purchase"],
    start_time: "2026-08-01",
    end_time: "2026-08-08",
  });
  const rows = funnel.structuredContent.rows;
  assert.equal(rows[0].users, 100);
  assert.equal(rows[1].users, 25);
  assert.equal(rows[1].conversion_from_previous_pct, 25);
  assert.equal(rows[1].conversion_from_start_pct, 25);

  // Raw SQL guardrails surface as clean tool errors.
  const rejected = await client.call("heap_execute_query", { sql: "DROP TABLE users" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Only SELECT/);

  const multi = await client.call("heap_execute_query", { sql: "SELECT 1; SELECT 2" });
  assert.equal(multi.isError, true);
  assert.match(multi.content[0].text, /single SQL statement/);

  // Sync status reads _sync_history.
  const sync = await client.call("heap_get_sync_status", {});
  assert.equal(sync.structuredContent.rows[0].table_name, "users");

  // test_source runs the probe.
  const probe = await client.call("heap_test_source", { source: "alpha" });
  assert.equal(probe.structuredContent.ok, true);
  assert.equal(probe.structuredContent.table_count, 2);
});

test("heap_add_source persists, emits tools/list_changed, and lights up query tools", async (t) => {
  const dir = makeTmpDir();
  const sourcesPath = path.join(dir, "sources.json");
  const client = new StdioMcpClient({
    HEAP_APP_ID: "app-1",
    HEAP_SOURCES_PATH: sourcesPath,
    HEAP_ENABLE_FAKE_DRIVER: "1",
  });
  t.after(() => {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.initialize();

  let tools = await client.listTools();
  assert.ok(!tools.includes("heap_execute_query"), "no query tools before add");

  const added = await client.call("heap_add_source", {
    name: "runtime_src",
    config: { type: "fake", tables: { all_events: [{ event_name: "e", n: 1 }] } },
    make_default: true,
  });
  assert.equal(added.structuredContent.ok, true, added.content?.[0]?.text);
  assert.equal(added.structuredContent.validated, true);
  assert.match(added.content[0].text, /query tools are now available/i);

  // The file was written with the source and default.
  const shape = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  assert.equal(shape.default_source, "runtime_src");
  assert.equal(shape.sources.runtime_src.type, "fake");

  // Query tools are live in the SAME session, and a list_changed arrived.
  tools = await client.listTools();
  for (const name of QUERY_TOOLS) {
    assert.ok(tools.includes(name), `${name} appeared after add`);
  }
  assert.ok(
    client.notifications.some((n) => n.method === "notifications/tools/list_changed"),
    "tools/list_changed notification was sent",
  );

  const result = await client.call("heap_query_top_events", {
    start_time: "2026-08-01",
    end_time: "2026-08-08",
  });
  assert.equal(result.structuredContent.rows[0].event_name, "e");

  // Duplicate names are rejected without overwrite; secrets never echo back.
  const dup = await client.call("heap_add_source", {
    name: "runtime_src",
    config: { type: "fake", tables: {} },
  });
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /already exists/);

  const masked = await client.call("heap_add_source", {
    name: "sf_masked",
    config: {
      type: "snowflake",
      account: "a",
      username: "u",
      password: "hunter2",
      database: "d",
      warehouse: "w",
    },
    skip_validation: true,
  });
  assert.equal(masked.structuredContent.persisted_entry.password, "********");
  assert.ok(!JSON.stringify(masked.content).includes("hunter2"), "literal secret not echoed");

  // remove_source deletes from the file.
  const removed = await client.call("heap_remove_source", { name: "sf_masked" });
  assert.equal(removed.structuredContent.ok, true);
  const after = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  assert.ok(!("sf_masked" in after.sources));
});

test("admin tools honor HEAP_ALLOW_SOURCE_ADMIN=false", async (t) => {
  const dir = makeTmpDir();
  const client = new StdioMcpClient({
    HEAP_APP_ID: "app-1",
    HEAP_SOURCES_PATH: path.join(dir, "sources.json"),
    HEAP_ALLOW_SOURCE_ADMIN: "false",
  });
  t.after(() => {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.initialize();

  const tools = await client.listTools();
  assert.ok(!tools.includes("heap_add_source"));
  assert.ok(!tools.includes("heap_remove_source"));
  assert.ok(tools.includes("heap_list_sources"), "read-only source tools stay");
});

test("setup_data prompt reflects live state", async (t) => {
  const dir = makeTmpDir();
  const sourcesPath = writeSourcesFile(dir, {
    version: 1,
    sources: { myfake: { type: "fake", tables: {} } },
  });
  const client = new StdioMcpClient({
    HEAP_APP_ID: "app-1",
    HEAP_SOURCES_PATH: sourcesPath,
    HEAP_ENABLE_FAKE_DRIVER: "1",
  });
  t.after(() => {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.initialize();

  const prompt = await client.getPrompt("setup_data", { source_type: "snowflake" });
  const text = prompt.messages[0].content.text;
  assert.match(text, /HEAP_APP_ID is set/);
  assert.match(text, /"myfake" \(fake, default\)/);
  assert.match(text, /heap_add_source/);
  assert.match(text, /snowflake/i);
  assert.match(text, /\$\{ENV_VAR\}/);
});
