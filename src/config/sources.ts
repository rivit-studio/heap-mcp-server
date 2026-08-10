/**
 * Data source configuration: loading, layering, and persistence.
 *
 * Sources live in a JSON file (default ~/.heap-mcp/sources.json, overridable
 * via HEAP_SOURCES_PATH). For backward compatibility with the single-warehouse
 * env design, HEAP_WAREHOUSE plus the HEAP_BQ_/HEAP_SF_/HEAP_RS_ vars
 * synthesize a source named "default" when the file doesn't define that name.
 *
 * Secret values may be `${ENV_VAR}` references; they are resolved when a
 * connection is opened (not at load time), so a missing variable only fails
 * the source that needs it — with a message naming the variable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_SOURCES_DIR, DEFAULT_SOURCES_FILE } from "../constants.js";
import { SourceConfig, sourceConfigSchema, sourceNameSchema } from "../schemas.js";
import { WarehouseError } from "../services/warehouse/types.js";

/** One configured source plus where it came from. */
export interface NamedSourceEntry {
  name: string;
  origin: "file" | "env";
  /** Raw config; ${ENV_VAR} references are NOT yet interpolated. */
  config: SourceConfig;
}

/** A source that failed validation (kept so it can be reported, not used). */
export interface InvalidSourceEntry {
  name: string;
  reason: string;
}

export interface LoadedSourcesConfig {
  /** Resolved sources-file path (may not exist yet). */
  path: string;
  /** default_source from the file, when it names a valid source. */
  defaultSource?: string;
  sources: Map<string, NamedSourceEntry>;
  invalid: InvalidSourceEntry[];
  /**
   * Set when the sources file exists but could not be read/parsed. Sources
   * from the file are unavailable and writes refuse to run (to avoid
   * clobbering a file the user may be able to repair).
   */
  loadError?: string;
}

export function resolveSourcesPath(): string {
  const override = process.env.HEAP_SOURCES_PATH;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), DEFAULT_SOURCES_DIR, DEFAULT_SOURCES_FILE);
}

export function fakeDriverEnabled(): boolean {
  return process.env.HEAP_ENABLE_FAKE_DRIVER === "1";
}

const ENV_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve ${ENV_VAR} references in every string field of a source config.
 * Throws WarehouseError naming the first missing variable.
 */
export function interpolateEnvRefs(config: SourceConfig, sourceName: string): SourceConfig {
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(ENV_REF_PATTERN, (_match, varName: string) => {
        const resolved = process.env[varName];
        if (resolved === undefined) {
          throw new WarehouseError(
            `Source "${sourceName}" references environment variable ${varName}, ` +
              "which is not set. Set it in the environment the MCP server runs " +
              "in (e.g. the `env` block of your MCP client config).",
            "CONFIG",
          );
        }
        return resolved;
      });
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolve(v)]),
      );
    }
    return value;
  };
  return resolve(config) as SourceConfig;
}

/** Validate one raw source config; returns an error string when invalid. */
function validateSourceConfig(raw: unknown): { config?: SourceConfig; error?: string } {
  const parsed = sourceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
    return { error: `${issue?.message ?? "invalid config"}${where}` };
  }
  const config = parsed.data;
  if (config.type === "fake" && !fakeDriverEnabled()) {
    return { error: 'type "fake" is test-only; set HEAP_ENABLE_FAKE_DRIVER=1 to allow it' };
  }
  if (config.type === "bigquery" && config.credentials && config.credentials_file) {
    return { error: "provide at most one of credentials / credentials_file" };
  }
  return { config };
}

/** Build the legacy env-var source ("default") when HEAP_WAREHOUSE is set. */
function envSourceFromLegacyVars(): { raw: Record<string, unknown>; type: string } | undefined {
  const warehouse = (process.env.HEAP_WAREHOUSE || "").toLowerCase();
  if (!warehouse) return undefined;

  const env = process.env;
  const compact = (obj: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ""));

  switch (warehouse) {
    case "bigquery":
      return {
        type: warehouse,
        raw: compact({
          type: "bigquery",
          project: env.HEAP_BQ_PROJECT,
          dataset: env.HEAP_BQ_DATASET,
          credentials: env.HEAP_BQ_CREDENTIALS,
        }),
      };
    case "snowflake":
      return {
        type: warehouse,
        raw: compact({
          type: "snowflake",
          account: env.HEAP_SF_ACCOUNT,
          username: env.HEAP_SF_USERNAME,
          password: env.HEAP_SF_PASSWORD,
          database: env.HEAP_SF_DATABASE,
          schema: env.HEAP_SF_SCHEMA,
          warehouse: env.HEAP_SF_WAREHOUSE,
        }),
      };
    case "redshift":
      return {
        type: warehouse,
        raw: compact({
          type: "redshift",
          host: env.HEAP_RS_HOST,
          port: env.HEAP_RS_PORT ? Number(env.HEAP_RS_PORT) : undefined,
          database: env.HEAP_RS_DATABASE,
          schema: env.HEAP_RS_SCHEMA,
          user: env.HEAP_RS_USER,
          password: env.HEAP_RS_PASSWORD,
        }),
      };
    default:
      console.error(
        `[heap-mcp-server] Warning: unrecognized HEAP_WAREHOUSE="${warehouse}" ` +
          "(expected bigquery|snowflake|redshift); ignoring.",
      );
      return undefined;
  }
}

/** Shape of the sources file on disk. */
interface SourcesFileShape {
  version?: number;
  default_source?: string;
  sources?: Record<string, unknown>;
}

function readSourcesFile(filePath: string): { data?: SourcesFileShape; error?: string } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { data: undefined };
    return { error: `cannot read ${filePath}: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `${filePath} is not valid JSON: ${(error as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${filePath} must contain a JSON object` };
  }
  const shape = parsed as SourcesFileShape;
  if (shape.version !== undefined && shape.version !== 1) {
    return { error: `${filePath} has unsupported version ${shape.version} (expected 1)` };
  }
  return { data: shape };
}

/**
 * Load the layered sources configuration: file first, then the legacy env
 * source under the name "default" unless the file already defines it.
 * Never throws — problems land in `loadError` / `invalid`.
 */
export function loadSourcesConfig(): LoadedSourcesConfig {
  const filePath = resolveSourcesPath();
  const result: LoadedSourcesConfig = {
    path: filePath,
    sources: new Map(),
    invalid: [],
  };

  const { data, error } = readSourcesFile(filePath);
  if (error) {
    result.loadError = error;
    console.error(`[heap-mcp-server] Warning: sources file ignored — ${error}`);
  } else if (data?.sources) {
    for (const [name, raw] of Object.entries(data.sources)) {
      if (!sourceNameSchema.safeParse(name).success) {
        result.invalid.push({ name, reason: "invalid source name" });
        continue;
      }
      const { config, error: reason } = validateSourceConfig(raw);
      if (!config) {
        result.invalid.push({ name, reason: reason ?? "invalid config" });
        continue;
      }
      result.sources.set(name, { name, origin: "file", config });
    }
  }

  const legacy = envSourceFromLegacyVars();
  if (legacy) {
    if (result.sources.has("default")) {
      console.error(
        '[heap-mcp-server] Note: sources file defines "default"; ignoring the ' +
          "HEAP_WAREHOUSE env-var source of the same name.",
      );
    } else {
      const { config, error: reason } = validateSourceConfig(legacy.raw);
      if (config) {
        result.sources.set("default", { name: "default", origin: "env", config });
      } else {
        console.error(
          `[heap-mcp-server] Warning: HEAP_WAREHOUSE=${legacy.type} is set but its ` +
            `env vars are incomplete (${reason}); ignoring the env source.`,
        );
      }
    }
  }

  if (data?.default_source && result.sources.has(data.default_source)) {
    result.defaultSource = data.default_source;
  } else if (data?.default_source) {
    console.error(
      `[heap-mcp-server] Warning: default_source "${data.default_source}" does not ` +
        "match any configured source; ignoring.",
    );
  }

  return result;
}

/** Atomically write the sources file (dir 0700, file 0600, tmp + rename). */
function writeSourcesFile(filePath: string, shape: SourcesFileShape): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(shape, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/** Re-read the file for a read-modify-write; throws if it exists but is broken. */
function readForUpdate(filePath: string): SourcesFileShape {
  const { data, error } = readSourcesFile(filePath);
  if (error) {
    throw new WarehouseError(
      `Refusing to modify the sources file: ${error}. Fix or remove the file, then retry.`,
      "CONFIG",
    );
  }
  return data ?? { version: 1, sources: {} };
}

/** Persist (add or replace) one source. */
export function saveSourceToFile(
  filePath: string,
  name: string,
  config: SourceConfig,
  makeDefault: boolean,
): void {
  const shape = readForUpdate(filePath);
  shape.version = 1;
  shape.sources = { ...(shape.sources ?? {}), [name]: config };
  if (makeDefault) shape.default_source = name;
  writeSourcesFile(filePath, shape);
}

/** Remove one source from the file; clears default_source if it pointed there. */
export function removeSourceFromFile(filePath: string, name: string): void {
  const shape = readForUpdate(filePath);
  if (!shape.sources || !(name in shape.sources)) {
    throw new WarehouseError(
      `Source "${name}" is not defined in ${filePath}.`,
      "NOT_FOUND",
    );
  }
  const { [name]: _removed, ...rest } = shape.sources;
  shape.sources = rest;
  if (shape.default_source === name) delete shape.default_source;
  writeSourcesFile(filePath, shape);
}
