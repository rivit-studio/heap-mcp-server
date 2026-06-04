/**
 * Privacy / GDPR deletion tools (auth-gated):
 *   - heap_delete_users        (POST /api/public/v0/user_deletion)
 *   - heap_get_deletion_status (GET  /api/public/v0/deletion_status/:id)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HeapClient } from "../services/heapClient.js";
import {
  DeleteUsersInput,
  DeletionStatusInput,
  deleteUsersSchema,
  deletionStatusSchema,
} from "../schemas.js";
import {
  HeapDeletionResponse,
  HeapDeletionStatusResponse,
  ResponseFormat,
} from "../types.js";
import { buildResult, runTool } from "./helpers.js";

const DELETION_PATH = "/api/public/v0/user_deletion";
const STATUS_PATH = "/api/public/v0/deletion_status";

export function registerDeletionTools(server: McpServer, client: HeapClient): void {
  server.registerTool(
    "heap_delete_users",
    {
      title: "Delete Heap Users (GDPR)",
      description: `Permanently submit users for deletion from your Heap workspace (POST /api/public/v0/user_deletion).

This is a DESTRUCTIVE, irreversible operation. Heap searches all environments in the account, deletes matching users' records and data, and returns a deletion_request_id you can poll with heap_get_deletion_status.

Requires HEAP_API_KEY (and HEAP_APP_ID must be your Main Production environment ID).

Args:
  - users (array, required, 1-10000): Each item identified by exactly one of user_id or identity.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: { deletion_request_id, status, deletion_request_location }.

Example: "Delete the Heap user with identity former-customer@example.com".`,
      inputSchema: deleteUsersSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DeleteUsersInput) =>
      runTool(async () => {
        const data = (await client.postWithAuth(DELETION_PATH, {
          users: params.users,
        })) as HeapDeletionResponse;

        const structured = {
          ok: true,
          submitted: params.users.length,
          deletion_request_id: data.deletion_request_id,
          status: data.status,
          deletion_request_location: data.deletion_request_location,
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Submitted ${params.users.length} user(s) for deletion.\n` +
              `Request ID: ${data.deletion_request_id}\nStatus: ${data.status}\n` +
              `Poll with heap_get_deletion_status using that request ID.`;
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_get_deletion_status",
    {
      title: "Get Heap Deletion Status",
      description: `Check the status of a previously submitted user-deletion request (GET /api/public/v0/deletion_status/:id).

Requires HEAP_API_KEY.

Args:
  - deletion_request_id (string, required): ID returned by heap_delete_users.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: { deletion_request_id, status } where status is 'pending' or 'complete'.

Example: "Check whether deletion request c93fae81-... has completed".`,
      inputSchema: deletionStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: DeletionStatusInput) =>
      runTool(async () => {
        const data = (await client.getWithAuth(
          `${STATUS_PATH}/${encodeURIComponent(params.deletion_request_id)}`,
        )) as HeapDeletionStatusResponse;

        const structured = {
          ok: true,
          deletion_request_id: data.deletion_request_id ?? params.deletion_request_id,
          status: data.status,
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Deletion request ${structured.deletion_request_id}: ${structured.status}.`;
        return buildResult(text, structured);
      }),
  );
}
