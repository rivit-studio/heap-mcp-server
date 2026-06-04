// Integration tests: run the built server over stdio against a local mock
// Heap server (via HEAP_BASE_URL) and assert the exact requests Heap receives.
// No real Heap credentials or network access required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, "..", "dist", "index.js");

// --- Minimal MCP-over-stdio JSON-RPC client -------------------------------
class StdioMcpClient {
  constructor(env) {
    this.proc = spawn("node", [SERVER_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.nextId = 1;
    this.pending = new Map();
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

  async call(name, args) {
    const res = await this._request("tools/call", { name, arguments: args });
    return res.result;
  }

  close() {
    this.proc.kill();
  }
}

// --- Mock Heap server ------------------------------------------------------
function startMockHeap() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        auth: req.headers["authorization"] || null,
        body: body ? JSON.parse(body) : null,
      });
      if (req.url === "/api/public/v0/auth_token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "TEST_TOKEN_XYZ" }));
      } else if (req.url === "/api/public/v0/user_deletion") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            deletion_request_id: "req-789",
            status: "pending",
            deletion_request_location: "http://mock/req-789",
          }),
        );
      } else if (req.url.startsWith("/api/public/v0/deletion_status/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deletion_request_id: "req-789", status: "complete" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    });
  });
  return { server, received };
}

test("ingestion + deletion flows hit the right endpoints with the right payloads", async (t) => {
  const { server, received } = startMockHeap();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const client = new StdioMcpClient({
    HEAP_APP_ID: "env-app-1",
    HEAP_API_KEY: "secret-key",
    HEAP_BASE_URL: base,
    TRANSPORT: "stdio",
  });

  t.after(() => {
    client.close();
    server.close();
  });

  await client.initialize();

  // 1) track with the env-default app_id and an array property
  const trackRes = await client.call("heap_track_event", {
    event: "Purchase",
    identity: "alice@example.com",
    properties: { amount: 42, tags: ["a", "b"] },
  });
  assert.equal(trackRes.structuredContent.ok, true);

  const track = received.find((r) => r.url === "/api/track");
  assert.ok(track, "track request was made");
  assert.equal(track.method, "POST");
  assert.equal(track.body.app_id, "env-app-1");
  assert.equal(track.body.event, "Purchase");
  assert.equal(track.body.identity, "alice@example.com");
  assert.deepEqual(track.body.properties.tags, ["a", "b"]);

  // 2) explicit app_id overrides the env default
  await client.call("heap_track_event", {
    app_id: "override-9",
    event: "Override Check",
    user_id: "555",
  });
  const overridden = received.find((r) => r.body && r.body.event === "Override Check");
  assert.equal(overridden.body.app_id, "override-9");
  assert.equal(overridden.body.user_id, "555");

  // 3) account properties (single)
  await client.call("heap_add_account_properties", {
    account_id: "Acme",
    properties: { tier: "ent" },
  });
  const acct = received.find((r) => r.url === "/api/add_account_properties");
  assert.equal(acct.body.account_id, "Acme");
  assert.equal(acct.body.properties.tier, "ent");

  // 4) identify
  await client.call("heap_identify_user", {
    user_id: "123456",
    identity: "bob@example.com",
  });
  const ident = received.find((r) => r.url === "/api/v1/identify");
  assert.equal(ident.body.user_id, "123456");
  assert.equal(ident.body.identity, "bob@example.com");

  // 5) delete users -> Basic auth token, then Bearer deletion
  const delRes = await client.call("heap_delete_users", {
    users: [{ identity: "gone@example.com" }],
  });
  assert.equal(delRes.structuredContent.deletion_request_id, "req-789");

  const tokenReq = received.find((r) => r.url === "/api/public/v0/auth_token");
  assert.ok(tokenReq, "auth token requested");
  assert.ok(tokenReq.auth.startsWith("Basic "), "uses Basic auth");
  const decoded = Buffer.from(tokenReq.auth.slice("Basic ".length), "base64").toString();
  assert.equal(decoded, "env-app-1:secret-key", "Basic auth = app_id:api_key");

  const delReq = received.find((r) => r.url === "/api/public/v0/user_deletion");
  assert.equal(delReq.auth, "Bearer TEST_TOKEN_XYZ", "deletion uses Bearer token");
  assert.equal(delReq.body.users[0].identity, "gone@example.com");

  // 6) deletion status (GET, Bearer) and token reuse (no second auth_token call)
  const statusRes = await client.call("heap_get_deletion_status", {
    deletion_request_id: "req-789",
  });
  assert.equal(statusRes.structuredContent.status, "complete");

  const statusReq = received.find((r) => r.url.startsWith("/api/public/v0/deletion_status/"));
  assert.equal(statusReq.method, "GET");
  assert.equal(statusReq.auth, "Bearer TEST_TOKEN_XYZ");

  const tokenCalls = received.filter((r) => r.url === "/api/public/v0/auth_token");
  assert.equal(tokenCalls.length, 1, "auth token is cached and reused across deletion calls");
});

test("deletion tools fail clearly when no API key is configured", async (t) => {
  const client = new StdioMcpClient({
    HEAP_APP_ID: "env-app-1",
    TRANSPORT: "stdio",
    // no HEAP_API_KEY
  });
  t.after(() => client.close());

  await client.initialize();
  const res = await client.call("heap_get_deletion_status", {
    deletion_request_id: "abc",
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /API key/i);
});
