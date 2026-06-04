#!/usr/bin/env node
/**
 * MCP server for Heap Analytics (heap.io).
 *
 * Exposes Heap's server-side API as MCP tools: event tracking, user/account
 * property enrichment, identity resolution, and GDPR user deletion.
 *
 * Configuration (environment variables):
 *   HEAP_APP_ID       Default Heap environment (app) ID. Recommended.
 *   HEAP_API_KEY      Required only for the user-deletion tools.
 *   HEAP_DATA_CENTER  "us" (default) or "eu".
 *   TRANSPORT         "stdio" (default) or "http".
 *   PORT              Port for http transport (default 3000).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { HeapClient } from "./services/heapClient.js";
import { resolveDataCenter } from "./constants.js";
import { registerTrackingTools } from "./tools/tracking.js";
import { registerPropertyTools } from "./tools/properties.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerDeletionTools } from "./tools/deletion.js";

function createServer(): McpServer {
  const client = HeapClient.fromEnv();
  const server = new McpServer({
    name: "heap-mcp-server",
    version: "1.0.0",
  });

  registerTrackingTools(server, client);
  registerPropertyTools(server, client);
  registerIdentityTools(server, client);
  registerDeletionTools(server, client);

  return server;
}

function logStartupConfig(): void {
  const dc = resolveDataCenter();
  const hasAppId = Boolean(process.env.HEAP_APP_ID);
  const hasApiKey = Boolean(process.env.HEAP_API_KEY);
  console.error(
    `[heap-mcp-server] datacenter=${dc} ` +
      `HEAP_APP_ID=${hasAppId ? "set" : "MISSING"} ` +
      `HEAP_API_KEY=${hasApiKey ? "set" : "unset (deletion tools disabled)"}`,
  );
  if (!hasAppId) {
    console.error(
      "[heap-mcp-server] Warning: HEAP_APP_ID is not set. Tools will require " +
        "an explicit app_id argument on every call.",
    );
  }
}

async function runStdio(): Promise<void> {
  logStartupConfig();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[heap-mcp-server] running via stdio");
}

async function runHTTP(): Promise<void> {
  logStartupConfig();
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "heap-mcp-server" });
  });

  // Stateless: a fresh server + transport per request avoids request-ID
  // collisions and scales cleanly.
  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`[heap-mcp-server] running on http://localhost:${port}/mcp`);
  });
}

const transport = (process.env.TRANSPORT || "stdio").toLowerCase();
const main = transport === "http" ? runHTTP : runStdio;
main().catch((error) => {
  console.error("[heap-mcp-server] fatal error:", error);
  process.exit(1);
});
