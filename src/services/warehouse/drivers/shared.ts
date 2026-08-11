/**
 * Shared helpers for warehouse drivers: optional-dependency loading, query
 * timeouts, and error normalization.
 */

import { QUERY_TIMEOUT_MS } from "../../../constants.js";
import { WarehouseError } from "../types.js";

/**
 * Import an optional peer dependency. The warehouse SDKs are declared as
 * optional peerDependencies so ingestion-only installs stay light; this
 * turns a missing module into an actionable install instruction.
 */
export async function importOptional(pkg: string): Promise<any> {
  try {
    return await import(pkg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ERR_MODULE_NOT_FOUND" ||
      /Cannot find (module|package)/i.test(message)
    ) {
      throw new WarehouseError(
        `The "${pkg}" package is required for this source type but is not ` +
          `installed. Install it next to heap-mcp-server (npm install ${pkg}), ` +
          `or when using npx: npx -y -p heap-mcp-server -p ${pkg} heap-mcp-server`,
        "DRIVER_MISSING",
      );
    }
    throw new WarehouseError(`Failed to load "${pkg}": ${message.slice(0, 300)}`, "CONFIG");
  }
}

/** Race a promise against the query timeout. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  what: string,
): Promise<T> {
  const ms = timeoutMs ?? QUERY_TIMEOUT_MS;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new WarehouseError(
          `${what} timed out after ${Math.round(ms / 1000)}s. Narrow the time ` +
            "range or add filters, then retry.",
          "TIMEOUT",
        ),
      );
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

/**
 * Normalize a driver error: keep a short, stack-free message and classify
 * auth failures so tools can respond with targeted guidance.
 */
export function normalizeDriverError(error: unknown, context: string): WarehouseError {
  if (error instanceof WarehouseError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/\s+/g, " ").slice(0, 300);
  if (/auth|credential|password|permission|access denied|401|403/i.test(message)) {
    return new WarehouseError(
      `${context}: authentication/authorization failed — ${message}. ` +
        "Check the source's credentials and grants.",
      "AUTH",
    );
  }
  if (/not found|does not exist|unknown (table|database|schema)/i.test(message)) {
    return new WarehouseError(`${context}: ${message}`, "NOT_FOUND");
  }
  return new WarehouseError(`${context}: ${message}`, "SQL");
}
