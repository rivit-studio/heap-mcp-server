/**
 * Shared helpers for building consistent MCP tool responses.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import { HeapApiError, normalizeError } from "../services/heapClient.js";
import { WarehouseError } from "../services/warehouse/types.js";

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
  // Warehouse-layer errors already carry a safe userMessage; surface it
  // without running them through the Heap-API normalizer.
  if (error instanceof WarehouseError) {
    return {
      content: [{ type: "text", text: `Error: ${error.userMessage}` }],
      structuredContent: {
        ok: false,
        ...(error.code !== undefined ? { code: error.code } : {}),
        error: error.userMessage,
      },
      isError: true,
    };
  }
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

/** Render query rows as a GitHub-flavored markdown table. */
export function rowsToMarkdown(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_No rows._";
  const columns = Object.keys(rows[0]);
  const cell = (value: unknown): string => {
    const text =
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  };
  const lines = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((c) => cell(row[c])).join(" | ")} |`),
  ];
  return lines.join("\n");
}
