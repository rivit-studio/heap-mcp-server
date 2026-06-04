/**
 * Shared Heap API client.
 *
 * Heap exposes two distinct surfaces:
 *   1. Ingestion endpoints (track, add_user_properties, add_account_properties,
 *      identify) — authenticated only by `app_id` in the JSON body.
 *   2. Privacy/deletion endpoints — gated by an auth token obtained via HTTP
 *      Basic auth (app_id:api_key), then passed as a Bearer token.
 *
 * This client centralizes host resolution, request execution, auth-token
 * caching, and error normalization so individual tools stay thin.
 */

import axios, { AxiosError } from "axios";
import { DataCenter, getHosts, resolveDataCenter } from "../constants.js";

const REQUEST_TIMEOUT_MS = 30000;
/** Refresh the cached deletion auth token slightly before assumed expiry. */
const AUTH_TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes, conservative.

export interface HeapClientConfig {
  /** Default environment (app) ID used when a tool call omits one. */
  defaultAppId?: string;
  /** API key (password) used for the privacy/deletion auth flow. */
  apiKey?: string;
  /** Heap datacenter: "us" or "eu". */
  dataCenter: DataCenter;
}

/**
 * Normalized error thrown by the client. `userMessage` is safe and actionable
 * to surface to an agent; `status` is the HTTP status when available.
 */
export class HeapApiError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly status?: number,
  ) {
    super(userMessage);
    this.name = "HeapApiError";
  }
}

interface CachedToken {
  token: string;
  acquiredAt: number;
}

export class HeapClient {
  private readonly config: HeapClientConfig;
  private cachedToken: CachedToken | null = null;

  constructor(config: HeapClientConfig) {
    this.config = config;
  }

  /** Build a client from environment variables. */
  static fromEnv(): HeapClient {
    return new HeapClient({
      defaultAppId: process.env.HEAP_APP_ID,
      apiKey: process.env.HEAP_API_KEY,
      dataCenter: resolveDataCenter(),
    });
  }

  /**
   * Resolve the effective app_id for a request: an explicit per-call value
   * takes precedence over the configured default. Throws if neither exists.
   */
  resolveAppId(explicit?: string): string {
    const appId = explicit || this.config.defaultAppId;
    if (!appId) {
      throw new HeapApiError(
        "No Heap app_id available. Provide `app_id` in the tool call or set " +
          "the HEAP_APP_ID environment variable. You can find your environment " +
          "ID in Heap under Account > Manage > Projects.",
      );
    }
    return appId;
  }

  // ---------------------------------------------------------------------------
  // Ingestion (no auth beyond app_id in the body)
  // ---------------------------------------------------------------------------

  /**
   * POST a JSON body to an ingestion endpoint path (e.g. "/api/track").
   * Returns the raw response body (often `{}` or "OK").
   */
  async postIngestion(path: string, body: unknown): Promise<unknown> {
    const url = `${getHosts(this.config.dataCenter).ingestion}${path}`;
    try {
      const response = await axios.post(url, body, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
      });
      return response.data;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Privacy / deletion (Basic auth -> cached Bearer token)
  // ---------------------------------------------------------------------------

  /**
   * Acquire (or reuse a cached) Bearer auth token for the privacy endpoints.
   * Requires both an app_id and an api_key to be configured.
   */
  private async getAuthToken(): Promise<string> {
    if (!this.config.apiKey) {
      throw new HeapApiError(
        "User deletion requires an API key. Set the HEAP_API_KEY environment " +
          "variable. Admins can generate one in Heap under Account > Manage > " +
          "Privacy & Security.",
      );
    }
    const appId = this.resolveAppId();

    const now = Date.now();
    if (this.cachedToken && now - this.cachedToken.acquiredAt < AUTH_TOKEN_TTL_MS) {
      return this.cachedToken.token;
    }

    const url = `${getHosts(this.config.dataCenter).deletion}/api/public/v0/auth_token`;
    try {
      const response = await axios.post(url, undefined, {
        timeout: REQUEST_TIMEOUT_MS,
        auth: { username: appId, password: this.config.apiKey },
      });
      const token = (response.data as { access_token?: string })?.access_token;
      if (!token) {
        throw new HeapApiError(
          "Heap did not return an access_token. Verify HEAP_APP_ID matches your " +
            "Main Production environment and that HEAP_API_KEY is valid.",
        );
      }
      this.cachedToken = { token, acquiredAt: now };
      return token;
    } catch (error) {
      // A 401 here almost always means bad app_id/api_key pairing.
      if (error instanceof HeapApiError) throw error;
      const normalized = normalizeError(error);
      if (normalized.status === 401) {
        throw new HeapApiError(
          "Unauthorized when requesting an auth token. The user-deletion API " +
            "must auth with your Main Production environment ID (HEAP_APP_ID) " +
            "and a valid HEAP_API_KEY.",
          401,
        );
      }
      throw normalized;
    }
  }

  /** POST to a privacy endpoint with the Bearer token. */
  async postWithAuth(path: string, body: unknown): Promise<unknown> {
    const token = await this.getAuthToken();
    const url = `${getHosts(this.config.dataCenter).deletion}${path}`;
    try {
      const response = await axios.post(url, body, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      return response.data;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  /** GET from a privacy endpoint with the Bearer token. */
  async getWithAuth(path: string): Promise<unknown> {
    const token = await this.getAuthToken();
    const url = `${getHosts(this.config.dataCenter).deletion}${path}`;
    try {
      const response = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${token}` },
      });
      return response.data;
    } catch (error) {
      throw normalizeError(error);
    }
  }
}

/**
 * Convert an unknown thrown value into a HeapApiError with an actionable,
 * agent-friendly message.
 */
export function normalizeError(error: unknown): HeapApiError {
  if (error instanceof HeapApiError) return error;

  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    if (axiosError.response) {
      const status = axiosError.response.status;
      const bodySnippet = extractErrorBody(axiosError.response.data);
      switch (status) {
        case 400:
          return new HeapApiError(
            `Bad request (400). Heap rejected the payload${bodySnippet}. ` +
              "Check that required fields are present and that you used either " +
              "`identity` or `user_id` (never both) on track/identify calls.",
            400,
          );
        case 401:
          return new HeapApiError(
            `Unauthorized (401)${bodySnippet}. Verify HEAP_APP_ID and HEAP_API_KEY.`,
            401,
          );
        case 404:
          return new HeapApiError(
            `Not found (404)${bodySnippet}. For deletion status, confirm the ` +
              "deletion_request_id exists and belongs to this environment.",
            404,
          );
        case 429:
          return new HeapApiError(
            "Rate limit exceeded (429). Heap limits ingestion to 30 requests " +
              "per 30s per identity per app_id (bulk: 1000 events/min/identity, " +
              "15,000 events/min/app_id). Slow down or batch with the bulk tools.",
            429,
          );
        default:
          return new HeapApiError(
            `Heap API request failed with status ${status}${bodySnippet}.`,
            status,
          );
      }
    }
    if (axiosError.code === "ECONNABORTED") {
      return new HeapApiError("Request to Heap timed out. Please try again.");
    }
    return new HeapApiError(
      `Network error contacting Heap: ${axiosError.message}. If your network ` +
        "restricts outbound traffic, update your network/allowlist settings.",
    );
  }

  return new HeapApiError(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Best-effort extraction of a short error detail from a response body. */
function extractErrorBody(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") {
    const trimmed = data.trim();
    return trimmed ? `: ${trimmed.slice(0, 300)}` : "";
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const message = obj.message ?? obj.error ?? (obj.err as Record<string, unknown> | undefined)?.message;
    if (typeof message === "string") return `: ${message.slice(0, 300)}`;
    try {
      return `: ${JSON.stringify(data).slice(0, 300)}`;
    } catch {
      return "";
    }
  }
  return "";
}
