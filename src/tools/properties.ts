/**
 * Property enrichment tools:
 *   - heap_add_user_properties        (POST /api/add_user_properties)
 *   - heap_bulk_add_user_properties   (POST /api/add_user_properties, users[])
 *   - heap_add_account_properties     (POST /api/add_account_properties)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HeapClient } from "../services/heapClient.js";
import {
  AddAccountPropertiesInput,
  AddUserPropertiesInput,
  BulkAddUserPropertiesInput,
  addAccountPropertiesSchema,
  addUserPropertiesSchema,
  bulkAddUserPropertiesSchema,
} from "../schemas.js";
import { ResponseFormat } from "../types.js";
import { buildResult, runTool } from "./helpers.js";

const USER_PROPS_PATH = "/api/add_user_properties";
const ACCOUNT_PROPS_PATH = "/api/add_account_properties";

export function registerPropertyTools(server: McpServer, client: HeapClient): void {
  server.registerTool(
    "heap_add_user_properties",
    {
      title: "Add Heap User Properties",
      description: `Attach custom properties to a single identified user (POST /api/add_user_properties).

Properties are stateless: only the most recent value is kept, and existing keys are overwritten. If the identity doesn't exist yet, Heap creates the user.

Args:
  - app_id (string, optional): Heap environment ID. Omit to use HEAP_APP_ID.
  - identity (string, required): The user's identity (email/key).
  - properties (object, required): Properties to set. Use lowercase 'email' to write the built-in Email property.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Returns: Confirmation with the identity and the property keys set.

Example: "Set plan=enterprise and seats=40 for org-admin@acme.com".`,
      inputSchema: addUserPropertiesSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AddUserPropertiesInput) =>
      runTool(async () => {
        const appId = client.resolveAppId(params.app_id);
        await client.postIngestion(USER_PROPS_PATH, {
          app_id: appId,
          identity: params.identity,
          properties: params.properties,
        });

        const keys = Object.keys(params.properties);
        const structured = {
          ok: true,
          app_id: appId,
          identity: params.identity,
          properties_set: keys,
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Set ${keys.length} propert${keys.length === 1 ? "y" : "ies"} ` +
              `(${keys.join(", ")}) on ${params.identity} (app_id ${appId}).`;
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_bulk_add_user_properties",
    {
      title: "Bulk Add Heap User Properties",
      description: `Attach custom properties to up to 1000 users in one request (POST /api/add_user_properties with a users array).

Args:
  - app_id (string, optional): Heap environment ID. Omit to use HEAP_APP_ID.
  - users (array, required, 1-1000): Each item: { identity, properties }.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Use lowercase 'email' keys to write the built-in Email property.

Returns: Count of users updated and the app_id used.

Example: "Set the Plan property on 200 users from a CSV export".`,
      inputSchema: bulkAddUserPropertiesSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: BulkAddUserPropertiesInput) =>
      runTool(async () => {
        const appId = client.resolveAppId(params.app_id);
        await client.postIngestion(USER_PROPS_PATH, {
          app_id: appId,
          users: params.users,
        });

        const structured = {
          ok: true,
          app_id: appId,
          users_updated: params.users.length,
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Updated properties for ${params.users.length} user(s) (app_id ${appId}).`;
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_add_account_properties",
    {
      title: "Add Heap Account Properties",
      description: `Attach custom properties to one account or many accounts (POST /api/add_account_properties).

Requires Account ID to be configured in Heap (or the Salesforce integration). Useful for account-health analysis (e.g. payment tier, owner, name). Existing keys are overwritten.

Args:
  - app_id (string, optional): Heap environment ID. Omit to use HEAP_APP_ID.
  - account_id (string): For a SINGLE account update; pair with 'properties'.
  - properties (object): Properties for the single-account update.
  - accounts (array): For BULK updates; each item: { account_id, properties }.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Provide EITHER account_id + properties OR accounts (not a mix).

Returns: The account(s) updated and the app_id used.

Example: "Set tier=Enterprise and mrr=12000 for account 'Acme Corp'".`,
      inputSchema: addAccountPropertiesSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AddAccountPropertiesInput) =>
      runTool(async () => {
        const appId = client.resolveAppId(params.app_id);

        const body: Record<string, unknown> = { app_id: appId };
        let summary: string;
        let count: number;
        if (params.accounts) {
          body.accounts = params.accounts;
          count = params.accounts.length;
          summary = `Updated properties for ${count} account(s)`;
        } else {
          body.account_id = params.account_id;
          body.properties = params.properties;
          count = 1;
          summary = `Updated properties for account "${params.account_id}"`;
        }
        await client.postIngestion(ACCOUNT_PROPS_PATH, body);

        const structured = {
          ok: true,
          app_id: appId,
          accounts_updated: count,
          ...(params.account_id ? { account_id: params.account_id } : {}),
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `${summary} (app_id ${appId}).`;
        return buildResult(text, structured);
      }),
  );
}
