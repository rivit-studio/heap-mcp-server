/**
 * Shared helpers for building consistent MCP tool responses.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import { HeapApiError, normalizeError } from "../services/heapClient.js";

/** The shape every tool handler returns. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // The MCP SDK's CallToolResult carries an open index signature; mirror it
  // so our handlers are structurally assignable to the SDK's expected type.
  [key: string]: unknown;
}

/** Build a successful tool result with both text and structured payloads. */
export function buildResult(
  text: string,
  structured: Record<string, unknown>,
): ToolResult {
  let body = text;
  if (body.length > CHARACTER_LIMIT) {
    body =
      body.slice(0, CHARACTER_LIMIT) +
      `\n\n[Output truncated at ${CHARACTER_LIMIT} characters.]`;
  }
  return {
    content: [{ type: "text", text: body }],
    structuredContent: structured,
  };
}

/** Build an error tool result from any thrown value. */
export function buildErrorResult(error: unknown): ToolResult {
  const normalized: HeapApiError =
    error instanceof HeapApiError ? error : normalizeError(error);
  return {
    content: [{ type: "text", text: `Error: ${normalized.userMessage}` }],
    structuredContent: {
      ok: false,
      ...(normalized.status !== undefined ? { status: normalized.status } : {}),
      error: normalized.userMessage,
    },
    isError: true,
  };
}

/**
 * Wrap a tool handler body so any thrown error becomes a clean error result.
 */
export async function runTool(
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return buildErrorResult(error);
  }
}
