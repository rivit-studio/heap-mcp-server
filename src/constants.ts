/**
 * Shared constants for the Heap Analytics MCP server.
 */

/** Maximum size (in characters) for any single tool text response. */
export const CHARACTER_LIMIT = 25000;

/** Heap's per-request batch limits, per the server-side API docs. */
export const MAX_BULK_EVENTS = 1000;
export const MAX_BULK_USERS = 1000;
export const MAX_DELETION_USERS = 10000;

/** Heap field length constraints, per the server-side API docs. */
export const MAX_IDENTITY_LENGTH = 255;
export const MAX_EVENT_NAME_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Data vault (Heap Connect warehouse) sources
// ---------------------------------------------------------------------------

/** Hard timeout for a single warehouse query. */
export const QUERY_TIMEOUT_MS = 60_000;

/** Default / maximum row limits for warehouse query tools. */
export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;
export const DEFAULT_USERS_LIMIT = 50;
export const MAX_USERS_LIMIT = 500;
export const DEFAULT_TOP_EVENTS_LIMIT = 25;
export const MAX_TOP_EVENTS_LIMIT = 100;

/** Funnel step bounds. */
export const MIN_FUNNEL_STEPS = 2;
export const MAX_FUNNEL_STEPS = 8;
/** Default funnel conversion window: 7 days. */
export const DEFAULT_CONVERSION_WINDOW_HOURS = 168;

/** Where named data sources live unless HEAP_SOURCES_PATH overrides it. */
export const DEFAULT_SOURCES_DIR = ".heap-mcp";
export const DEFAULT_SOURCES_FILE = "sources.json";

/**
 * Whether the source-admin tools (heap_add_source / heap_remove_source) are
 * registered. Explicit HEAP_ALLOW_SOURCE_ADMIN=true/false wins; otherwise
 * they are enabled for stdio and DISABLED for the unauthenticated http
 * transport, where a network caller must not be able to write files on the
 * host or trigger arbitrary outbound connections.
 */
export function resolveAllowSourceAdmin(transport: string): boolean {
  const raw = (process.env.HEAP_ALLOW_SOURCE_ADMIN || "").toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return transport !== "http";
}

/**
 * Heap operates separate ingestion hosts per datacenter. The ingestion host
 * (track / add_*_properties / identify) differs from heapanalytics.com for EU,
 * while the privacy/deletion API lives on heapanalytics.com for both regions.
 */
export type DataCenter = "us" | "eu";

interface DataCenterHosts {
  /** Host for ingestion + identify endpoints. */
  ingestion: string;
  /** Host for the privacy/user-deletion endpoints (auth-gated). */
  deletion: string;
}

const DATA_CENTER_HOSTS: Record<DataCenter, DataCenterHosts> = {
  us: {
    ingestion: "https://heapanalytics.com",
    deletion: "https://heapanalytics.com",
  },
  eu: {
    // Per Heap docs, EU ingestion + identify route through c.eu.heap-api.com.
    ingestion: "https://c.eu.heap-api.com",
    // The deletion API instructions state they apply to both US and EU
    // datacenters via heapanalytics.com.
    deletion: "https://heapanalytics.com",
  },
};

export function getHosts(dataCenter: DataCenter): DataCenterHosts {
  // An explicit override (e.g. a proxy or gateway in front of Heap) applies to
  // both ingestion and deletion hosts. Heap documents proxying its endpoints.
  const override = process.env.HEAP_BASE_URL;
  if (override) {
    const trimmed = override.replace(/\/+$/, "");
    return { ingestion: trimmed, deletion: trimmed };
  }
  return DATA_CENTER_HOSTS[dataCenter];
}

/** Resolve the configured datacenter from the environment (defaults to US). */
export function resolveDataCenter(): DataCenter {
  const raw = (process.env.HEAP_DATA_CENTER || "us").toLowerCase();
  return raw === "eu" ? "eu" : "us";
}
