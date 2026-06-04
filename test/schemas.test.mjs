// Unit tests for the Zod input schemas.
// Run via `npm test` (which builds first, then runs node --test).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  trackEventSchema,
  bulkTrackEventsSchema,
  addUserPropertiesSchema,
  bulkAddUserPropertiesSchema,
  addAccountPropertiesSchema,
  identifyUserSchema,
  deleteUsersSchema,
  deletionStatusSchema,
} from "../dist/schemas.js";

const ok = (schema, input, msg) =>
  assert.equal(schema.safeParse(input).success, true, msg);
const bad = (schema, input, msg) =>
  assert.equal(schema.safeParse(input).success, false, msg);

test("track: requires exactly one of identity / user_id", () => {
  ok(trackEventSchema, { event: "X", identity: "a@b.com" }, "identity only");
  ok(trackEventSchema, { event: "X", user_id: "123" }, "user_id only");
  bad(trackEventSchema, { event: "X", identity: "a@b.com", user_id: "123" }, "both rejected");
  bad(trackEventSchema, { event: "X" }, "neither rejected");
});

test("track: user_id must be a numeric string", () => {
  ok(trackEventSchema, { event: "X", user_id: "1847839267195673" });
  bad(trackEventSchema, { event: "X", user_id: "abc" });
});

test("track: rejects unknown fields (strict)", () => {
  bad(trackEventSchema, { event: "X", identity: "a@b.com", surprise: 1 });
});

test("track: accepts scalar and array property values", () => {
  ok(trackEventSchema, {
    event: "X",
    identity: "a@b.com",
    properties: { n: 1, s: "v", b: true, arr: ["a", "b", 3] },
  });
});

test("track: enforces identity length limit (255)", () => {
  bad(trackEventSchema, { event: "X", identity: "a".repeat(256) });
});

test("bulk track: 1..1000 events, each with identity XOR user_id", () => {
  ok(bulkTrackEventsSchema, { events: [{ event: "X", identity: "a@b.com" }] });
  bad(bulkTrackEventsSchema, { events: [] }, "empty rejected");
  bad(
    bulkTrackEventsSchema,
    { events: Array.from({ length: 1001 }, () => ({ event: "X", identity: "a@b.com" })) },
    "over 1000 rejected",
  );
  bad(bulkTrackEventsSchema, { events: [{ event: "X" }] }, "missing identity/user_id rejected");
});

test("add user properties: identity + properties required", () => {
  ok(addUserPropertiesSchema, { identity: "a@b.com", properties: { plan: "pro" } });
  bad(addUserPropertiesSchema, { properties: { plan: "pro" } }, "missing identity");
});

test("bulk add user properties: 1..1000 users", () => {
  ok(bulkAddUserPropertiesSchema, {
    users: [{ identity: "a@b.com", properties: { x: 1 } }],
  });
  bad(bulkAddUserPropertiesSchema, { users: [] });
});

test("account properties: single XOR bulk, not both/neither", () => {
  ok(addAccountPropertiesSchema, { account_id: "Acme", properties: { tier: "ent" } }, "single");
  ok(
    addAccountPropertiesSchema,
    { accounts: [{ account_id: "Acme", properties: { tier: "ent" } }] },
    "bulk",
  );
  bad(
    addAccountPropertiesSchema,
    {
      account_id: "Acme",
      properties: {},
      accounts: [{ account_id: "x", properties: {} }],
    },
    "mixed rejected",
  );
  bad(addAccountPropertiesSchema, { app_id: "1" }, "neither rejected");
});

test("identify: requires both user_id and identity", () => {
  ok(identifyUserSchema, { user_id: "123", identity: "a@b.com" });
  bad(identifyUserSchema, { user_id: "123" });
  bad(identifyUserSchema, { identity: "a@b.com" });
});

test("delete users: each user has exactly one of user_id / identity", () => {
  ok(deleteUsersSchema, { users: [{ identity: "a@b.com" }] });
  ok(deleteUsersSchema, { users: [{ user_id: "5" }] });
  bad(deleteUsersSchema, { users: [{ user_id: "5", identity: "a@b.com" }] }, "both rejected");
  bad(deleteUsersSchema, { users: [{}] }, "neither rejected");
  bad(deleteUsersSchema, { users: [] }, "empty rejected");
});

test("delete users: caps at 10000", () => {
  bad(deleteUsersSchema, {
    users: Array.from({ length: 10001 }, (_, i) => ({ user_id: String(i) })),
  });
});

test("deletion status: requires deletion_request_id", () => {
  ok(deletionStatusSchema, { deletion_request_id: "abc" });
  bad(deletionStatusSchema, {});
});
