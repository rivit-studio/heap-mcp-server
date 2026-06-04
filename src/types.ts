/**
 * Shared TypeScript types for the Heap Analytics MCP server.
 */

/** Response output format selectable per tool call. */
export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** A single property bag: string/number/boolean or arrays thereof. */
export type HeapPropertyValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>;

export type HeapProperties = Record<string, HeapPropertyValue>;

/** One event in a (bulk) track request. */
export interface HeapEvent {
  event: string;
  identity?: string;
  user_id?: string;
  session_id?: string;
  timestamp?: string;
  idempotency_key?: string;
  properties?: HeapProperties;
}

/** One user in a bulk add-user-properties request. */
export interface HeapUserPropertyEntry {
  identity: string;
  properties: HeapProperties;
}

/** One account in an add-account-properties request. */
export interface HeapAccountEntry {
  account_id: string;
  properties: HeapProperties;
}

/** Successful user-deletion submission response. */
export interface HeapDeletionResponse {
  deletion_request_id: string;
  deletion_request_location?: string;
  status: string;
}

/** Deletion-status lookup response. */
export interface HeapDeletionStatusResponse {
  deletion_request_id: string;
  status: string;
}
