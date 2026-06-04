# Contributing to Heap Analytics MCP Server

Thanks for your interest in contributing! This document explains how to set up the project, the conventions to follow, and how to get a change merged.

## Code of conduct

Be respectful and constructive. Assume good faith. Harassment or abuse of any kind is not tolerated.

## Getting set up

```bash
git clone https://github.com/rivit-studio/heap-mcp-server.git
cd heap-mcp-server
npm install
npm run build
npm test
```

You'll want an MCP client for manual testing. The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the quickest:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

You do **not** need real Heap credentials to develop most features — see [Testing](#testing) for the local mock approach.

## Project layout

```
src/
  index.ts                 # entry point: transports + server wiring
  constants.ts             # datacenter hosts, limits, config resolution
  types.ts                 # shared types
  schemas.ts               # Zod input schemas (all validation rules)
  services/heapClient.ts   # HTTP client, auth-token caching, error normalization
  tools/                   # one file per domain; tools stay thin
test/                      # node:test suites (unit + mock integration)
```

**Design principle:** tools are thin. Anything reusable — HTTP, auth, error handling — lives in `services/`. All input validation lives in `schemas.ts`. Keep it that way.

## Adding or changing a tool

When you add a tool, keep it consistent with the existing ones:

- **Name:** snake_case, prefixed `heap_` (e.g. `heap_track_event`).
- **Schema:** a `.strict()` Zod object in `schemas.ts`, with `.describe()` on every field and refinements for any cross-field rules (e.g. "exactly one of X or Y"). Validate *before* any network call.
- **Description:** include `Args:`, `Returns:`, and at least one `Example:` so agents can use it correctly.
- **Annotations:** set `readOnlyHint`, `destructiveHint`, and `idempotentHint` accurately. Anything that deletes or mutates irreversibly must be `destructiveHint: true`.
- **Responses:** return both human-readable text and `structuredContent` via the shared helpers in `tools/helpers.ts`. Support the `response_format` argument.
- **Errors:** throw `HeapApiError` (or let the client normalize) so messages stay actionable.

Add or update tests for any behavior you change.

## Testing

The suite uses Node's built-in test runner (`node:test`) — no extra test framework.

```bash
npm test            # builds, then runs all suites in test/
```

There are two kinds of tests:

- **Unit** (`test/schemas.test.mjs`) — assert that the Zod schemas accept valid input and reject invalid input (the identity/user_id rule, batch caps, strictness, etc.).
- **Integration** (`test/integration.test.mjs`) — start a local mock HTTP server, run the built server over stdio with `HEAP_BASE_URL` pointed at the mock, call tools through the MCP protocol, and assert the exact requests Heap would have received (endpoints, bodies, and the Basic→Bearer auth flow for deletion).

Because the integration test points `HEAP_BASE_URL` at a local mock, it never touches a real Heap workspace and needs no credentials.

## Coding conventions

- **Strict TypeScript.** No `any`; prefer precise types or `unknown` with narrowing.
- **Async/await** for all I/O.
- `npm run build` must pass with **zero errors** before you open a PR.
- Keep dependencies minimal — this project deliberately avoids heavy frameworks.

## Submitting a change

1. Open an issue describing the bug or proposal (for non-trivial changes).
2. Fork and create a topic branch.
3. Make the change, add/adjust tests, and run `npm test`.
4. Open a PR with a clear description and before/after notes where relevant.

## Reporting security issues

Please do **not** open a public issue for security problems (e.g. anything involving credential handling or the unauthenticated HTTP transport). Contact the maintainers privately and allow time for a fix before disclosure.
