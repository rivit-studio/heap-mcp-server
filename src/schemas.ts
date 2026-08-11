/**
 * Zod input schemas for the Heap Analytics MCP server tools.
 *
 * These encode Heap's documented constraints (identity XOR user_id on track,
 * batch-size caps, identity length limits) so invalid calls fail fast with
 * clear messages before any network request.
 */

import { z } from "zod";
import {
  DEFAULT_CONVERSION_WINDOW_HOURS,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_TOP_EVENTS_LIMIT,
  DEFAULT_USERS_LIMIT,
  MAX_BULK_EVENTS,
  MAX_BULK_USERS,
  MAX_DELETION_USERS,
  MAX_EVENT_NAME_LENGTH,
  MAX_FUNNEL_STEPS,
  MAX_IDENTITY_LENGTH,
  MAX_QUERY_LIMIT,
  MAX_TOP_EVENTS_LIMIT,
  MAX_USERS_LIMIT,
  MIN_FUNNEL_STEPS,
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

// ---------------------------------------------------------------------------
// Data vault sources: per-warehouse connection configs
// ---------------------------------------------------------------------------

/** Names for registered data sources: short, filesystem/JSON friendly. */
export const sourceNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    "Source names are 1-64 chars: lowercase letters, digits, '-' or '_', starting with a letter or digit.",
  )
  .describe("Name of a configured data source (e.g. 'prod_sf').");

const secretHint =
  "May be a literal or a ${ENV_VAR} reference resolved when connecting " +
  "(recommended for secrets, so they stay out of the sources file).";

export const snowflakeSourceSchema = z
  .object({
    type: z.literal("snowflake"),
    account: z
      .string()
      .min(1)
      .describe("Snowflake account identifier, e.g. 'xy12345.us-east-1'."),
    username: z.string().min(1).describe("Snowflake username."),
    password: z.string().min(1).describe(`Snowflake password. ${secretHint}`),
    database: z.string().min(1).describe("Database holding the Heap Connect share/schema."),
    schema: z.string().min(1).default("heap").describe("Schema with Heap tables (default 'heap')."),
    warehouse: z.string().min(1).describe("Virtual warehouse to run queries on."),
    role: z.string().min(1).optional().describe("Optional role to assume."),
  })
  .strict();

export const bigquerySourceSchema = z
  .object({
    type: z.literal("bigquery"),
    project: z.string().min(1).describe("GCP project ID containing the Heap dataset."),
    dataset: z.string().min(1).default("heap").describe("BigQuery dataset (default 'heap')."),
    credentials: z
      .string()
      .min(1)
      .optional()
      .describe(`Service-account key JSON as a string. ${secretHint} Omit to use ADC.`),
    credentials_file: z
      .string()
      .min(1)
      .optional()
      .describe("Path to a service-account key file. Alternative to `credentials`."),
    location: z.string().min(1).optional().describe("Dataset location (e.g. 'US'), if not default."),
  })
  .strict();

export const redshiftSourceSchema = z
  .object({
    type: z.literal("redshift"),
    host: z.string().min(1).describe("Cluster endpoint, e.g. 'my-cluster.abc.us-east-1.redshift.amazonaws.com'."),
    port: z.number().int().min(1).max(65535).default(5439).describe("Port (default 5439)."),
    database: z.string().min(1).describe("Database name."),
    schema: z.string().min(1).default("heap").describe("Schema with Heap tables (default 'heap')."),
    user: z.string().min(1).describe("Database user."),
    password: z.string().min(1).describe(`Password. ${secretHint}`),
    ssl: z
      .boolean()
      .default(true)
      .describe("Use TLS (default true; encryption without CA verification, as is standard for Redshift)."),
  })
  .strict();

/** Test-only in-memory driver; accepted only when HEAP_ENABLE_FAKE_DRIVER=1. */
export const fakeSourceSchema = z
  .object({
    type: z.literal("fake"),
    tables: z
      .record(z.string(), z.array(z.record(z.string(), z.unknown())))
      .default({})
      .describe("Canned tables: table name -> array of row objects."),
    log_path: z
      .string()
      .optional()
      .describe("If set, every received SQL statement is appended to this JSONL file."),
  })
  .strict();

export const sourceConfigSchema = z
  .discriminatedUnion("type", [
    snowflakeSourceSchema,
    bigquerySourceSchema,
    redshiftSourceSchema,
    fakeSourceSchema,
  ])
  .describe("Connection config for one Heap Connect destination, discriminated by `type`.");

export type SnowflakeSourceConfig = z.infer<typeof snowflakeSourceSchema>;
export type BigQuerySourceConfig = z.infer<typeof bigquerySourceSchema>;
export type RedshiftSourceConfig = z.infer<typeof redshiftSourceSchema>;
export type FakeSourceConfig = z.infer<typeof fakeSourceSchema>;
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

// ---------------------------------------------------------------------------
// Data vault sources: management tool inputs
// ---------------------------------------------------------------------------

export const listSourcesSchema = z
  .object({
    test: z
      .boolean()
      .default(false)
      .describe("If true, run a live connectivity check against every source."),
    response_format: responseFormatSchema,
  })
  .strict();

export type ListSourcesInput = z.infer<typeof listSourcesSchema>;

const sourceParamSchema = sourceNameSchema
  .optional()
  .describe(
    "Named data source to use. Omit to use the default source (the configured " +
      "default, or the sole configured source).",
  );

export const testSourceSchema = z
  .object({
    source: sourceParamSchema,
    response_format: responseFormatSchema,
  })
  .strict();

export type TestSourceInput = z.infer<typeof testSourceSchema>;

export const addSourceSchema = z
  .object({
    name: sourceNameSchema,
    config: sourceConfigSchema,
    make_default: z
      .boolean()
      .default(false)
      .describe("Set this source as the default for query tools."),
    overwrite: z
      .boolean()
      .default(false)
      .describe("Replace an existing source with the same name."),
    skip_validation: z
      .boolean()
      .default(false)
      .describe("Persist without testing the connection first (not recommended)."),
    response_format: responseFormatSchema,
  })
  .strict();

export type AddSourceInput = z.infer<typeof addSourceSchema>;

export const removeSourceSchema = z
  .object({
    name: sourceNameSchema,
    response_format: responseFormatSchema,
  })
  .strict();

export type RemoveSourceInput = z.infer<typeof removeSourceSchema>;

// ---------------------------------------------------------------------------
// Data vault sources: query tool inputs
// ---------------------------------------------------------------------------

/**
 * A SQL identifier (used where a tool accepts a column/table name override).
 * Restricting the charset keeps interpolation into generated SQL safe.
 */
const sqlIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_$]*$/,
    "Must be a plain SQL identifier (letters, digits, '_', '$'; not starting with a digit).",
  );

const isoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    'Must be an ISO8601 date or timestamp, e.g. "2026-08-01" or "2026-08-01T00:00:00Z".',
  );

export const describeSchemaSchema = z
  .object({
    source: sourceParamSchema,
    table: sqlIdentifierSchema
      .optional()
      .describe("Table to describe. Omit to list all tables in the Heap dataset."),
    response_format: responseFormatSchema,
  })
  .strict();

export type DescribeSchemaInput = z.infer<typeof describeSchemaSchema>;

export const queryPageviewsSchema = z
  .object({
    source: sourceParamSchema,
    start_time: isoTimestampSchema.describe("Window start (inclusive)."),
    end_time: isoTimestampSchema.describe("Window end (inclusive)."),
    url_contains: z
      .string()
      .max(500)
      .optional()
      .describe("Only count pageviews whose page path contains this substring."),
    group_by: z
      .enum(["url", "day", "user"])
      .default("url")
      .describe("Aggregation key: page URL path, calendar day, or user."),
    url_column: sqlIdentifierSchema
      .default("path")
      .describe("Pageviews column holding the URL path (default 'path')."),
    limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(DEFAULT_QUERY_LIMIT),
    response_format: responseFormatSchema,
  })
  .strict();

export type QueryPageviewsInput = z.infer<typeof queryPageviewsSchema>;

export const queryTopEventsSchema = z
  .object({
    source: sourceParamSchema,
    start_time: isoTimestampSchema.describe("Window start (inclusive)."),
    end_time: isoTimestampSchema.describe("Window end (inclusive)."),
    limit: z.number().int().min(1).max(MAX_TOP_EVENTS_LIMIT).default(DEFAULT_TOP_EVENTS_LIMIT),
    exclude_pageviews: z
      .boolean()
      .default(false)
      .describe("Exclude the built-in pageviews event from the ranking."),
    event_column: sqlIdentifierSchema
      .default("event_view_name")
      .describe(
        "all_events column naming each row's source event (default " +
          "'event_view_name'; some older syncs use 'event_table_name').",
      ),
    response_format: responseFormatSchema,
  })
  .strict();

export type QueryTopEventsInput = z.infer<typeof queryTopEventsSchema>;

export const queryFunnelSchema = z
  .object({
    source: sourceParamSchema,
    steps: z
      .array(z.string().min(1).max(MAX_EVENT_NAME_LENGTH))
      .min(MIN_FUNNEL_STEPS, `Provide at least ${MIN_FUNNEL_STEPS} steps`)
      .max(MAX_FUNNEL_STEPS, `A maximum of ${MAX_FUNNEL_STEPS} steps`)
      .describe("Ordered event names (as they appear in the event column) forming the funnel."),
    start_time: isoTimestampSchema.describe("Window start for step 1 (inclusive)."),
    end_time: isoTimestampSchema.describe("Window end for step 1 (inclusive)."),
    conversion_window_hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(DEFAULT_CONVERSION_WINDOW_HOURS)
      .describe("Max hours between consecutive steps (default 168 = 7 days)."),
    event_column: sqlIdentifierSchema
      .default("event_view_name")
      .describe("all_events column naming each row's source event."),
    response_format: responseFormatSchema,
  })
  .strict();

export type QueryFunnelInput = z.infer<typeof queryFunnelSchema>;

export const queryUsersSchema = z
  .object({
    source: sourceParamSchema,
    identity: z.string().max(MAX_IDENTITY_LENGTH).optional().describe("Exact identity to look up."),
    property_key: sqlIdentifierSchema
      .optional()
      .describe("Users-table column (user property) to filter on. Requires property_value."),
    property_value: z.string().max(1024).optional().describe("Value the property must equal."),
    performed_event: z
      .string()
      .max(MAX_EVENT_NAME_LENGTH)
      .optional()
      .describe("Only users who performed this event (all_events event name)."),
    start_time: isoTimestampSchema.optional().describe("With performed_event: window start."),
    end_time: isoTimestampSchema.optional().describe("With performed_event: window end."),
    event_column: sqlIdentifierSchema
      .default("event_view_name")
      .describe("all_events column naming each row's source event."),
    limit: z.number().int().min(1).max(MAX_USERS_LIMIT).default(DEFAULT_USERS_LIMIT),
    response_format: responseFormatSchema,
  })
  .strict()
  .refine((d) => Boolean(d.property_key) === (d.property_value !== undefined), {
    message: "property_key and property_value must be provided together.",
  });

export type QueryUsersInput = z.infer<typeof queryUsersSchema>;

export const executeQuerySchema = z
  .object({
    source: sourceParamSchema,
    sql: z
      .string()
      .min(1)
      .max(10000)
      .describe("A single SELECT (or WITH ... SELECT) statement. Writes/DDL are rejected."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_QUERY_LIMIT)
      .default(DEFAULT_QUERY_LIMIT)
      .describe("Row cap, injected as/clamped to a LIMIT clause."),
    response_format: responseFormatSchema,
  })
  .strict();

export type ExecuteQueryInput = z.infer<typeof executeQuerySchema>;

export const syncStatusSchema = z
  .object({
    source: sourceParamSchema,
    limit: z.number().int().min(1).max(MAX_USERS_LIMIT).default(DEFAULT_USERS_LIMIT),
    response_format: responseFormatSchema,
  })
  .strict();

export type SyncStatusInput = z.infer<typeof syncStatusSchema>;
