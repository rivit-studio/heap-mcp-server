/**
 * Identity tool: heap_identify_user (POST /api/v1/identify).
 * Links an anonymous Heap SDK user_id to a known identity.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HeapClient } from "../services/heapClient.js";
import { IdentifyUserInput, identifyUserSchema } from "../schemas.js";
import { ResponseFormat } from "../types.js";
import { buildResult, runTool } from "./helpers.js";

const IDENTIFY_PATH = "/api/v1/identify";

export function registerIdentityTools(server: McpServer, client: HeapClient): void {
  server.registerTool(
    "heap_identify_user",
    {
      title: "Identify a Heap User",
      description: `Link an anonymous Heap SDK user_id to a known identity (POST /api/v1/identify).

When called, all events on the given user_id are migrated to the user with the given identity, unifying their history across sessions and devices.

Args:
  - app_id (string, optional): Heap environment ID. Omit to use HEAP_APP_ID.
  - user_id (string, required): Numeric Heap SDK user_id (as a string).
  - identity (string, required): Known identity to attach (e.g. email).
  - timestamp (string, optional): ISO8601; defaults to now.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Limits: 1 identity per user_id; up to 10 user_ids per identity per month. Extra mappings are silently dropped by Heap.

Returns: Confirmation of the user_id -> identity mapping.

Example: "Identify SDK user 1847839267195673 as alice@example.com".`,
      inputSchema: identifyUserSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: IdentifyUserInput) =>
      runTool(async () => {
        const appId = client.resolveAppId(params.app_id);
        const body: Record<string, unknown> = {
          app_id: appId,
          user_id: params.user_id,
          identity: params.identity,
        };
        if (params.timestamp) body.timestamp = params.timestamp;
        await client.postIngestion(IDENTIFY_PATH, body);

        const structured = {
          ok: true,
          app_id: appId,
          user_id: params.user_id,
          identity: params.identity,
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Linked user_id ${params.user_id} to identity ` +
              `"${params.identity}" (app_id ${appId}).`;
        return buildResult(text, structured);
      }),
  );
}
