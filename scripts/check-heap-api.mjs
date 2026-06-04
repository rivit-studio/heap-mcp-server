#!/usr/bin/env node
/**
 * Heap API drift checker.
 *
 * Fetches the Heap developer-docs pages this server depends on, extracts the
 * embedded OpenAPI definition (or normalized text where no OpenAPI block
 * exists), and compares it against committed snapshots in
 * `.heap-api-snapshots/`.
 *
 *   node scripts/check-heap-api.mjs            # compare; exit 1 on drift
 *   node scripts/check-heap-api.mjs --update   # (re)write snapshots
 *
 * On drift, a human-readable report is written to `heap-api-diff.md` and the
 * process exits non-zero so CI / the scheduled workflow can alert.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SNAPSHOT_DIR = join(ROOT, ".heap-api-snapshots");
const REPORT_PATH = join(ROOT, "heap-api-diff.md");

// Reference pages this server's tools rely on. Each maps to one snapshot.
const ENDPOINTS = [
  { name: "track", url: "https://developers.heap.io/reference/track-1.md" },
  { name: "bulk-track", url: "https://developers.heap.io/reference/bulk-track.md" },
  { name: "add-user-properties", url: "https://developers.heap.io/reference/add-user-properties.md" },
  { name: "bulk-add-user-properties", url: "https://developers.heap.io/reference/bulk-add-user-properties.md" },
  { name: "add-account-properties", url: "https://developers.heap.io/reference/add-account-properties.md" },
  { name: "identify", url: "https://developers.heap.io/reference/identify-1.md" },
  { name: "user-deletion", url: "https://developers.heap.io/reference/user-deletion.md" },
  { name: "index", url: "https://developers.heap.io/llms.txt" },
];

const UPDATE = process.argv.includes("--update");

/** Recursively sort object keys so serialization is stable. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortDeep(value[k]);
    return out;
  }
  return value;
}

/** Stable, pretty JSON so line diffs are granular and readable. */
function stableStringify(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

/** Remove a volatile docs banner and trim, for text-only snapshots. */
function normalizeText(text) {
  return text
    .replace(/^>\s*## Documentation Index[\s\S]*?\n\n/m, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

/**
 * Extract the normalized snapshot content for a page: the embedded OpenAPI
 * definition (preferred, structural) or normalized text as a fallback.
 */
function extractSnapshot(text) {
  const marker = "# OpenAPI definition";
  const idx = text.indexOf(marker);
  if (idx !== -1) {
    const after = text.slice(idx);
    const match = after.match(/```json\s*\n([\s\S]*?)\n```/);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        // Drop README-tooling noise that can churn without affecting the API.
        if (parsed && typeof parsed === "object") delete parsed["x-readme"];
        return { kind: "openapi", content: stableStringify(parsed) };
      } catch {
        /* fall through to text */
      }
    }
  }
  return { kind: "text", content: normalizeText(text) };
}

function sha(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Minimal line diff: lines only in old (-) and only in new (+). */
function lineDiff(oldStr, newStr, limit = 40) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed = oldLines.filter((l) => !newSet.has(l));
  const added = newLines.filter((l) => !oldSet.has(l));
  const out = [];
  for (const l of removed.slice(0, limit)) out.push(`- ${l}`);
  if (removed.length > limit) out.push(`  …(${removed.length - limit} more removed)`);
  for (const l of added.slice(0, limit)) out.push(`+ ${l}`);
  if (added.length > limit) out.push(`  …(${added.length - limit} more added)`);
  return out.join("\n");
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "heap-mcp-server-api-watch" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function main() {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const results = [];
  for (const ep of ENDPOINTS) {
    let snapshot;
    try {
      const text = await fetchText(ep.url);
      snapshot = extractSnapshot(text);
    } catch (err) {
      results.push({ name: ep.name, status: "fetch-error", error: String(err) });
      continue;
    }
    const file = join(SNAPSHOT_DIR, `${ep.name}.${snapshot.kind === "openapi" ? "json" : "txt"}`);

    if (UPDATE) {
      writeFileSync(file, snapshot.content + "\n");
      results.push({ name: ep.name, status: "written", kind: snapshot.kind, file });
      continue;
    }

    if (!existsSync(file)) {
      results.push({ name: ep.name, status: "new", kind: snapshot.kind, snapshot });
      continue;
    }
    const previous = readFileSync(file, "utf8").trimEnd();
    if (sha(previous) === sha(snapshot.content)) {
      results.push({ name: ep.name, status: "unchanged" });
    } else {
      results.push({
        name: ep.name,
        status: "changed",
        kind: snapshot.kind,
        diff: lineDiff(previous, snapshot.content),
      });
    }
  }

  if (UPDATE) {
    for (const r of results) console.log(`snapshot ${r.status}: ${r.name} (${r.kind || ""})`);
    console.log(`\nWrote ${results.filter((r) => r.status === "written").length} snapshots to .heap-api-snapshots/`);
    return;
  }

  const drift = results.filter((r) => ["changed", "new", "fetch-error"].includes(r.status));
  for (const r of results) console.log(`${r.status.padEnd(12)} ${r.name}`);

  if (drift.length === 0) {
    console.log("\n✅ No Heap API drift detected.");
    return;
  }

  // Build a report and fail.
  const lines = ["# Heap API drift detected", "", `Detected ${drift.length} change(s) on ${new Date().toISOString()}.`, ""];
  for (const r of drift) {
    lines.push(`## \`${r.name}\` — ${r.status}`, "");
    if (r.status === "fetch-error") {
      lines.push("Could not fetch the reference page:", "", "```", r.error, "```", "");
    } else if (r.status === "new") {
      lines.push("No baseline snapshot existed. Run `npm run check:heap-api -- --update` to create one.", "");
    } else if (r.diff) {
      lines.push("```diff", r.diff || "(content changed)", "```", "");
    }
  }
  lines.push(
    "---",
    "",
    "If these changes are expected, review the affected tools/schemas, then refresh the baseline with:",
    "",
    "```bash",
    "npm run check:heap-api -- --update",
    "git add .heap-api-snapshots && git commit -m \"chore: refresh Heap API snapshots\"",
    "```",
  );
  const report = lines.join("\n");
  writeFileSync(REPORT_PATH, report + "\n");
  console.error(`\n⚠️  Heap API drift detected. Report written to ${REPORT_PATH}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("check-heap-api failed:", err);
  process.exit(2);
});
