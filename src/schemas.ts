/**
 * Zod input schemas for the Heap Analytics MCP server tools.
 *
 * These encode Heap's documented constraints (identity XOR user_id on track,
 * batch-size caps, identity length limits) so invalid calls fail fast with
 * clear messages before any network request.
 */

import { z } from "zod";
import {
  MAX_BULK_EVENTS,
  MAX_BULK_USERS,
  MAX_DELETION_USERS,
  MAX_EVENT_NAME_LENGTH,
  MAX_IDENTITY_LENGTH,
} from "./constants.js";
import { ResponseFormat } from "./types.js";

/** A property value: string, number, boolean, or an array of those. */
const propertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

/** A property bag attached to events, users, or accounts. */
export const propertiesSchema = z
  .record(z.string().max(512, "Property keys must be < 512 characters"), propertyValueSchema)
  .describe(
    "Key-value properties. Keys < 512 chars; values are string/number/boolean " +
      "or arrays thereof (arrays are joined with '||' on ingestion, max 1024 chars).",
  );

const appIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Heap environment (app) ID. Optional if HEAP_APP_ID is configured; an " +
      "explicit value overrides the default.",
  );

const identitySchema = z
  .string()
  .min(1)
  .max(MAX_IDENTITY_LENGTH, `identity must be <= ${MAX_IDENTITY_LENGTH} characters`)
  .describe("A user identity (e.g. email or user key). Case-sensitive.");

const userIdSchema = z
  .string()
  .min(1)
  .regex(/^\d+$/, "user_id must be the string form of a number from the Heap SDK")
  .describe("The numeric user_id from the Heap SDK, as a string.");

const responseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' (human-readable) or 'json' (machine-readable).");

const timestampSchema = z
  .string()
  .describe('ISO8601 timestamp, e.g. "2024-03-10T22:21:56+00:00". Defaults to now.')
  .optional();

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

const singleEventCore = {
  event: z
    .string()
    .min(1)
    .max(MAX_EVENT_NAME_LENGTH, `event name must be <= ${MAX_EVENT_NAME_LENGTH} characters`)
    .describe("Event name. Prefer broad names + properties (e.g. 'Error' with {type})."),
  identity: identitySchema.optional(),
  user_id: userIdSchema.optional(),
  session_id: z.string().optional().describe("Optional session identifier."),
  timestamp: timestampSchema,
  idempotency_key: z
    .string()
    .optional()
    .describe("Unique key to de-duplicate events; repeat calls won't double-count."),
  properties: propertiesSchema.optional(),
};

/** Enforces Heap's rule: exactly one of identity / user_id. */
const identityXorUserId = (data: { identity?: string; user_id?: string }) =>
  Boolean(data.identity) !== Boolean(data.user_id);
const identityXorMessage =
  "Provide exactly one of `identity` or `user_id` (not both, not neither).";

export const trackEventSchema = z
  .object({
    app_id: appIdSchema,
    ...singleEventCore,
    response_format: responseFormatSchema,
  })
  .strict()
  .refine(identityXorUserId, { message: identityXorMessage });

export type TrackEventInput = z.infer<typeof trackEventSchema>;

const bulkEventSchema = z
  .object(singleEventCore)
  .strict()
  .refine(identityXorUserId, { message: identityXorMessage });

export const bulkTrackEventsSchema = z
  .object({
    app_id: appIdSchema,
    events: z
      .array(bulkEventSchema)
      .min(1, "Provide at least one event")
      .max(MAX_BULK_EVENTS, `A maximum of ${MAX_BULK_EVENTS} events per request`)
      .describe("Array of events, each with exactly one of identity/user_id."),
    response_format: responseFormatSchema,
  })
  .strict();

export type BulkTrackEventsInput = z.infer<typeof bulkTrackEventsSchema>;

// ---------------------------------------------------------------------------
// User properties
// ---------------------------------------------------------------------------

export const addUserPropertiesSchema = z
  .object({
    app_id: appIdSchema,
    identity: identitySchema,
    properties: propertiesSchema.describe(
      "User properties to set/overwrite. To write the built-in Email property, " +
        "use a lowercase 'email' key.",
    ),
    response_format: responseFormatSchema,
  })
  .strict();

export type AddUserPropertiesInput = z.infer<typeof addUserPropertiesSchema>;

export const bulkAddUserPropertiesSchema = z
  .object({
    app_id: appIdSchema,
    users: z
      .array(
        z
          .object({
            identity: identitySchema,
            properties: propertiesSchema,
          })
          .strict(),
      )
      .min(1, "Provide at least one user")
      .max(MAX_BULK_USERS, `A maximum of ${MAX_BULK_USERS} users per request`)
      .describe("Array of { identity, properties } objects."),
    response_format: responseFormatSchema,
  })
  .strict();

export type BulkAddUserPropertiesInput = z.infer<typeof bulkAddUserPropertiesSchema>;

// ---------------------------------------------------------------------------
// Account properties (single or bulk via one tool)
// ---------------------------------------------------------------------------

export const addAccountPropertiesSchema = z
  .object({
    app_id: appIdSchema,
    account_id: z
      .string()
      .min(1)
      .optional()
      .describe("Account ID for a single-account update. Use with `properties`."),
    properties: propertiesSchema
      .optional()
      .describe("Properties for the single-account update (paired with `account_id`)."),
    accounts: z
      .array(
        z
          .object({
            account_id: z.string().min(1),
            properties: propertiesSchema,
          })
          .strict(),
      )
      .min(1)
      .optional()
      .describe("For bulk updates: array of { account_id, properties } objects."),
    response_format: responseFormatSchema,
  })
  .strict()
  .refine(
    (d) =>
      // Either single (account_id + properties) OR bulk (accounts), not both/neither.
      (Boolean(d.account_id) && Boolean(d.properties) && !d.accounts) ||
      (Boolean(d.accounts) && !d.account_id && !d.properties),
    {
      message:
        "Provide either `account_id` + `properties` (single account) OR " +
        "`accounts` (bulk), but not a mix.",
    },
  );

export type AddAccountPropertiesInput = z.infer<typeof addAccountPropertiesSchema>;

// ---------------------------------------------------------------------------
// Identify
// ---------------------------------------------------------------------------

export const identifyUserSchema = z
  .object({
    app_id: appIdSchema,
    user_id: userIdSchema,
    identity: identitySchema,
    timestamp: timestampSchema,
    response_format: responseFormatSchema,
  })
  .strict();

export type IdentifyUserInput = z.infer<typeof identifyUserSchema>;

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

export const deleteUsersSchema = z
  .object({
    users: z
      .array(
        z
          .object({
            user_id: z.string().min(1).optional(),
            identity: z.string().min(1).optional(),
          })
          .strict()
          .refine((u) => Boolean(u.user_id) !== Boolean(u.identity), {
            message: "Each user needs exactly one of `user_id` or `identity`.",
          }),
      )
      .min(1, "Provide at least one user to delete")
      .max(MAX_DELETION_USERS, `A maximum of ${MAX_DELETION_USERS} users per request`)
      .describe("Users to delete, each identified by user_id or identity."),
    response_format: responseFormatSchema,
  })
  .strict();

export type DeleteUsersInput = z.infer<typeof deleteUsersSchema>;

export const deletionStatusSchema = z
  .object({
    deletion_request_id: z
      .string()
      .min(1)
      .describe("The deletion_request_id returned by heap_delete_users."),
    response_format: responseFormatSchema,
  })
  .strict();

export type DeletionStatusInput = z.infer<typeof deletionStatusSchema>;
