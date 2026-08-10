#!/usr/bin/env node
/**
 * MCP server for Heap Analytics (heap.io).
 *
 * Exposes Heap's server-side API as MCP tools: event tracking, user/account
 * property enrichment, identity resolution, and GDPR user deletion — plus
 * optional warehouse query tools over the user's Heap Connect data sources
 * (BigQuery, Snowflake, Redshift), configured via the setup_data prompt.
 *
 * Configuration (environment variables):
 *   HEAP_APP_ID       Default Heap environment (app) ID. Recommended.
 *   HEAP_API_KEY      Required only for the user-deletion tools.
 *   HEAP_DATA_CENTER  "us" (default) or "eu".
 *   TRANSPORT         "stdio" (default) or "http".
 *   PORT              Port for http transport (default 3000).
 *   HEAP_SOURCES_PATH Sources file (default ~/.heap-mcp/sources.json).
 *   HEAP_ALLOW_SOURCE_ADMIN  Force-enable/disable heap_add_source &
 *                     heap_remove_source (default: enabled on stdio only).
 *   HEAP_WAREHOUSE (plus HEAP_BQ_/HEAP_SF_/HEAP_RS_ vars)  Legacy
 *                     single-source config, loaded as a source named "default".
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { HeapClient } from "./services/heapClient.js";
import { resolveAllowSourceAdmin, resolveDataCenter } from "./constants.js";
import { SourceRegistry } from "./services/warehouse/registry.js";
import { registerTrackingTools } from "./tools/tracking.js";
import { registerPropertyTools } from "./tools/properties.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerDeletionTools } from "./tools/deletion.js";
import { registerSourceTools } from "./tools/sources.js";
import { registerQueryTools } from "./tools/query.js";
import { registerSetupDataPrompt } from "./prompts/setupData.js";

const transport = (process.env.TRANSPORT || "stdio").toLowerCase();

function createServer(): McpServer {
  const client = HeapClient.fromEnv();
  const registry = SourceRegistry.fromEnv();
  const allowAdmin = resolveAllowSourceAdmin(transport);

  const server = new McpServer({
    name: "heap-mcp-server",
    version: "1.1.0",
  });

  registerTrackingTools(server, client);
  registerPropertyTools(server, client);
  registerIdentityTools(server, client);
  registerDeletionTools(server, client);

  // Query tools appear once at least one data source exists — either at
  // startup, or live when heap_add_source persists the first one (the SDK
  // emits notifications/tools/list_changed for post-connect registration).
  let queryToolsRegistered = false;
  const ensureQueryTools = (): void => {
    if (queryToolsRegistered || !registry.hasSources()) return;
    registerQueryTools(server, registry);
    queryToolsRegistered = true;
  };
  ensureQueryTools();

  registerSourceTools(server, registry, {
    allowAdmin,
    onSourcesChanged: ensureQueryTools,
  });
  registerSetupDataPrompt(server, registry, { adminEnabled: allowAdmin });

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
  // Names only — never config values or secrets.
  const registry = SourceRegistry.fromEnv();
  const names = registry.sourceNames();
  console.error(
    `[heap-mcp-server] data sources: ${names.length ? names.join(", ") : "none"} ` +
      `(file: ${registry.filePath}; run the setup_data prompt to add one)`,
  );
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
  // collisions and scales cleanly. Each request re-reads the sources file,
  // so config changes apply without a restart.
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

const main = transport === "http" ? runHTTP : runStdio;
main().catch((error) => {
  console.error("[heap-mcp-server] fatal error:", error);
  process.exit(1);
});
