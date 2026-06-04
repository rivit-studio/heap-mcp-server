# Security Policy

## Supported versions

This project is pre-1.0 and maintained on a best-effort basis. Security fixes are applied to the latest release on the default branch. Please run a recent version before reporting issues.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's [private vulnerability reporting](https://github.com/rivit-studio/heap-mcp-server/security/advisories/new) (Security tab → "Report a vulnerability"). If that is unavailable, contact the maintainers listed in the repository.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected version / commit.
- Any suggested remediation.

Please allow a reasonable time for a fix before public disclosure. We'll acknowledge your report, keep you updated, and credit you if you'd like.

## Scope and things to keep in mind

This server is a thin wrapper around the Heap server-side API. Areas most relevant to security:

- **Credentials.** `HEAP_APP_ID` and `HEAP_API_KEY` are read from environment variables and are never written to logs (the server logs only whether they are set). Do not commit them; use `.env` (git-ignored) or your platform's secret store.
- **Irreversible deletion.** `heap_delete_users` permanently deletes user data. It is annotated `destructive` so MCP clients can gate it behind confirmation. The `HEAP_API_KEY` that unlocks it should be scoped tightly.
- **Unauthenticated HTTP transport.** When run with `TRANSPORT=http`, the `/mcp` endpoint has no built-in authentication. Do not expose it directly to untrusted networks — put it behind your own authentication/authorization (reverse proxy, gateway, network policy).
- **PII in transit.** Identities and properties may contain personal data. Use TLS-terminating infrastructure and handle hosting accordingly.

## Out of scope

- Vulnerabilities in Heap's own API or infrastructure — report those to [Heap](https://heap.io).
- Issues that require a misconfigured deployment explicitly warned against in this document or the README (e.g. exposing the unauthenticated HTTP transport to the public internet).
