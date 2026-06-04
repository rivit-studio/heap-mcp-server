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
