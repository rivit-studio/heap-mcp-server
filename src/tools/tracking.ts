/**
 * Event tracking tools: heap_track_event and heap_bulk_track_events.
 * Both POST to /api/track.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HeapClient } from "../services/heapClient.js";
import {
  BulkTrackEventsInput,
  TrackEventInput,
  bulkTrackEventsSchema,
  trackEventSchema,
} from "../schemas.js";
import { ResponseFormat, HeapEvent } from "../types.js";
import { buildResult, runTool } from "./helpers.js";

const TRACK_PATH = "/api/track";

/** Strip response_format/app_id and keep only Heap event fields. */
function toHeapEvent(input: {
  event: string;
  identity?: string;
  user_id?: string;
  session_id?: string;
  timestamp?: string;
  idempotency_key?: string;
  properties?: HeapEvent["properties"];
}): HeapEvent {
  const event: HeapEvent = { event: input.event };
  if (input.identity) event.identity = input.identity;
  if (input.user_id) event.user_id = input.user_id;
  if (input.session_id) event.session_id = input.session_id;
  if (input.timestamp) event.timestamp = input.timestamp;
  if (input.idempotency_key) event.idempotency_key = input.idempotency_key;
  if (input.properties) event.properties = input.properties;
  return event;
}

export function registerTrackingTools(server: McpServer, client: HeapClient): void {
  server.registerTool(
    "heap_track_event",
    {
      title: "Track a Heap Event",
      description: `Send a single custom server-side event to Heap (POST /api/track).

Use this for events your backend knows about that Heap can't autocapture from the browser, such as completed purchases, emails sent, or background jobs.

Args:
  - app_id (string, optional): Heap environment ID. Omit to use HEAP_APP_ID.
  - event (string, required): Event name (<=1024 chars). Prefer broad names + properties.
  - identity (string): User identity (email/key). REQUIRED unless user_id is given.
  - user_id (string): Numeric Heap SDK user_id (as a string). Use instead of identity.
  - session_id (string, optional): Session identifier.
  - timestamp (string, optional): ISO8601; defaults to now.
  - idempotency_key (string, optional): De-duplicates repeated sends.
  - properties (object, optional): Key-value metadata.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Note: Provide EXACTLY ONE of identity or user_id.

Returns: Confirmation including the event name and the identity/user_id used.

Example: "Log a 'Subscription Upgraded' event for alice@example.com with plan=pro".`,
      inputSchema: trackEventSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: TrackEventInput) =>
      runTool(async () => {
        const appId = client.resolveAppId(params.app_id);
        const event = toHeapEvent(params);
        const body = { app_id: appId, ...event };
        await client.postIngestion(TRACK_PATH, body);

        const who = event.identity ?? `user_id ${event.user_id}`;
        const structured = {
          ok: true,
          app_id: appId,
          event: event.event,
          identity: event.identity,
          user_id: event.user_id,
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Tracked event "${event.event}" for ${who} (app_id ${appId}).`;
        return buildResult(text, structured);
      }),
  );

  server.registerTool(
    "heap_bulk_track_events",
    {
      title: "Bulk Track Heap Events",
      description: `Send up to 1000 custom events to Heap in one request (POST /api/track with an events array).

Use this when backfilling or logging many events at once. Each event independently requires exactly one of identity or user_id.

Args:
  - app_id (string, optional): Heap environment ID. Omit to use HEAP_APP_ID.
  - events (array, required, 1-1000): Each item: { event, identity|user_id, session_id?, timestamp?, idempotency_key?, properties? }.
  - response_format ('markdown' | 'json'): Output format (default markdown).

Rate limits: 1000 events/min/identity and 15,000 events/min/app_id.

Returns: Count of events submitted and the app_id used.

Example: "Track 50 'Invoice Paid' events, one per customer identity".`,
      inputSchema: bulkTrackEventsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: BulkTrackEventsInput) =>
      runTool(async () => {
        const appId = client.resolveAppId(params.app_id);
        const events = params.events.map(toHeapEvent);
        await client.postIngestion(TRACK_PATH, { app_id: appId, events });

        const structured = {
          ok: true,
          app_id: appId,
          submitted: events.length,
        };
        const text =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : `Submitted ${events.length} event(s) to Heap (app_id ${appId}).`;
        return buildResult(text, structured);
      }),
  );
}
