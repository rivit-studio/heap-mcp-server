/**
 * SourceRegistry: the in-memory view of all configured data sources.
 *
 * Holds the layered config (file + legacy env), lazily instantiates and
 * caches drivers, resolves the default source, and mediates add/remove
 * (delegating persistence to src/config/sources.ts).
 *
 * Driver SDKs load via dynamic import inside each driver module, so the
 * server starts (and ingestion-only setups run) without any warehouse SDK
 * installed.
 */

import {
  LoadedSourcesConfig,
  NamedSourceEntry,
  fakeDriverEnabled,
  interpolateEnvRefs,
  loadSourcesConfig,
  removeSourceFromFile,
  saveSourceToFile,
} from "../../config/sources.js";
import { SourceConfig } from "../../schemas.js";
import { SourceCapabilities, SourceDriver, SourceType, WarehouseError } from "./types.js";

export interface SourceSummary {
  name: string;
  type: SourceType;
  origin: "file" | "env";
  isDefault: boolean;
  capabilities: SourceCapabilities;
}

/** Capabilities are static per type today (all current drivers speak SQL). */
function capabilitiesFor(_type: SourceType): SourceCapabilities {
  return { sql: true, syncStatus: true };
}

type DriverFactory = (name: string, config: SourceConfig) => Promise<SourceDriver>;

const DRIVER_FACTORIES: Record<SourceType, DriverFactory> = {
  bigquery: async (name, config) => {
    const mod = await import("./drivers/bigquery.js");
    return mod.createBigQueryDriver(name, config as Extract<SourceConfig, { type: "bigquery" }>);
  },
  snowflake: async (name, config) => {
    const mod = await import("./drivers/snowflake.js");
    return mod.createSnowflakeDriver(name, config as Extract<SourceConfig, { type: "snowflake" }>);
  },
  redshift: async (name, config) => {
    const mod = await import("./drivers/redshift.js");
    return mod.createRedshiftDriver(name, config as Extract<SourceConfig, { type: "redshift" }>);
  },
  fake: async (name, config) => {
    const mod = await import("./drivers/fake.js");
    return mod.createFakeDriver(name, config as Extract<SourceConfig, { type: "fake" }>);
  },
};

/**
 * Instantiate a driver for a raw (uninterpolated) config. Exported so
 * heap_add_source can validate a connection before anything is persisted.
 */
export async function instantiateDriver(name: string, config: SourceConfig): Promise<SourceDriver> {
  const resolved = interpolateEnvRefs(config, name);
  return DRIVER_FACTORIES[resolved.type](name, resolved);
}

export class SourceRegistry {
  private readonly config: LoadedSourcesConfig;
  private readonly driverCache = new Map<string, Promise<SourceDriver>>();

  constructor(config: LoadedSourcesConfig) {
    this.config = config;
  }

  static fromEnv(): SourceRegistry {
    return new SourceRegistry(loadSourcesConfig());
  }

  get filePath(): string {
    return this.config.path;
  }

  get loadError(): string | undefined {
    return this.config.loadError;
  }

  get invalidSources(): ReadonlyArray<{ name: string; reason: string }> {
    return this.config.invalid;
  }

  hasSources(): boolean {
    return this.config.sources.size > 0;
  }

  sourceNames(): string[] {
    return [...this.config.sources.keys()];
  }

  list(): SourceSummary[] {
    const defaultName = this.defaultName();
    return [...this.config.sources.values()].map((entry) => ({
      name: entry.name,
      type: entry.config.type,
      origin: entry.origin,
      isDefault: entry.name === defaultName,
      capabilities: capabilitiesFor(entry.config.type),
    }));
  }

  getEntry(name: string): NamedSourceEntry | undefined {
    return this.config.sources.get(name);
  }

  /** The effective default source name, if one can be determined. */
  defaultName(): string | undefined {
    if (this.config.defaultSource) return this.config.defaultSource;
    if (this.config.sources.size === 1) return this.config.sources.keys().next().value;
    if (this.config.sources.has("default")) return "default";
    return undefined;
  }

  /** Resolve a source name: explicit param > default. Throws with guidance. */
  resolveName(explicit?: string): string {
    if (explicit) {
      if (!this.config.sources.has(explicit)) {
        throw new WarehouseError(
          `Unknown data source "${explicit}". Configured sources: ` +
            `${this.describeConfigured()}.`,
          "NOT_FOUND",
        );
      }
      return explicit;
    }
    const fallback = this.defaultName();
    if (!fallback) {
      throw new WarehouseError(
        this.hasSources()
          ? "Multiple data sources are configured and none is the default. Pass " +
            `\`source\` explicitly. Configured sources: ${this.describeConfigured()}.`
          : "No data sources are configured. Run the setup_data prompt (or " +
            "heap_add_source) to connect a Heap Connect warehouse " +
            "(BigQuery, Snowflake, or Redshift).",
        this.hasSources() ? "CONFIG" : "NOT_FOUND",
      );
    }
    return fallback;
  }

  private describeConfigured(): string {
    const names = this.sourceNames();
    return names.length ? names.map((n) => `"${n}"`).join(", ") : "(none)";
  }

  /** Get (or lazily create) the live driver for a source. */
  async resolve(explicit?: string): Promise<SourceDriver> {
    const name = this.resolveName(explicit);
    let cached = this.driverCache.get(name);
    if (!cached) {
      const entry = this.config.sources.get(name)!;
      cached = instantiateDriver(entry.name, entry.config);
      this.driverCache.set(name, cached);
      // Drop failed instantiations so a fixed env var / restored network is
      // picked up on the next call instead of caching the failure forever.
      cached.catch(() => this.driverCache.delete(name));
    }
    return cached;
  }

  /** Persist a source to the file and add it to the live registry. */
  add(name: string, config: SourceConfig, opts: { makeDefault: boolean; overwrite: boolean }): void {
    if (this.config.loadError) {
      throw new WarehouseError(
        `Refusing to modify the sources file: ${this.config.loadError}.`,
        "CONFIG",
      );
    }
    if (config.type === "fake" && !fakeDriverEnabled()) {
      throw new WarehouseError(
        'Source type "fake" is test-only; set HEAP_ENABLE_FAKE_DRIVER=1 to allow it.',
        "CONFIG",
      );
    }
    const existing = this.config.sources.get(name);
    if (existing && !opts.overwrite) {
      throw new WarehouseError(
        existing.origin === "file"
          ? `Source "${name}" already exists. Pass overwrite: true to replace it.`
          : `Source "${name}" is defined by HEAP_WAREHOUSE env vars. Adding it to the ` +
            "sources file will shadow the env config; pass overwrite: true to proceed.",
        "CONFIG",
      );
    }
    saveSourceToFile(this.config.path, name, config, opts.makeDefault);
    this.config.sources.set(name, { name, origin: "file", config });
    if (opts.makeDefault) this.config.defaultSource = name;
    this.evict(name);
  }

  /** Remove a file-defined source from disk and the live registry. */
  async remove(name: string): Promise<void> {
    const entry = this.config.sources.get(name);
    if (!entry) {
      throw new WarehouseError(
        `Unknown data source "${name}". Configured sources: ${this.describeConfigured()}.`,
        "NOT_FOUND",
      );
    }
    if (entry.origin === "env") {
      throw new WarehouseError(
        `Source "${name}" comes from HEAP_WAREHOUSE environment variables, not the ` +
          "sources file. Unset those env vars (or shadow it by adding a file source " +
          "of the same name) instead.",
        "CONFIG",
      );
    }
    removeSourceFromFile(this.config.path, name);
    this.config.sources.delete(name);
    if (this.config.defaultSource === name) this.config.defaultSource = undefined;
    await this.evict(name);
  }

  private async evict(name: string): Promise<void> {
    const cached = this.driverCache.get(name);
    this.driverCache.delete(name);
    if (cached) {
      try {
        await (await cached).close();
      } catch {
        // Instantiation failed or close failed — nothing to release.
      }
    }
  }

  async closeAll(): Promise<void> {
    const names = [...this.driverCache.keys()];
    await Promise.all(names.map((name) => this.evict(name)));
  }
}
