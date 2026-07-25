/**
 * Supabase → GitHub JSON sync
 *
 * Flow:
 *   0. Odd/even-hour routine toggle (insert on odd hours, delete cron markers on even)
 *   1. Resolve credentials & table list (service-role OpenAPI discovery or SUPABASE_TABLES)
 *   2. Page-fetch each table via PostgREST (Range headers), with retries
 *   3. Sanitize secret-like fields/values
 *   4. Write stable JSON under data/, prune stale files, write _manifest.json
 *
 * Designed for GitHub Actions (no npm deps; Node 20+).
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// ─── Config ─────────────────────────────────────────────────────────────────

const config = {
  supabaseUrl: requireEnv("SUPABASE_URL").replace(/\/+$/, ""),
  anonKey: process.env.SUPABASE_ANON_KEY || "",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  configuredTables: parseList(process.env.SUPABASE_TABLES),
  /** Max concurrent table fetches (avoid hammering PostgREST). */
  concurrency: clampInt(process.env.SYNC_CONCURRENCY, 4, 1, 16),
  pageSize: clampInt(process.env.SYNC_PAGE_SIZE, 1000, 100, 1000),
  maxRetries: clampInt(process.env.SYNC_MAX_RETRIES, 3, 0, 8),
  retryBaseMs: 500,
  outputRoot: path.resolve("data"),
  manifestName: "_manifest.json",
  redacted: "[REDACTED SECRET]",
  /** Odd-hour insert / even-hour delete for routine table. Set ROUTINE_TOGGLE=0 to disable. */
  routineToggle: !["0", "false", "off", "no"].includes(
    String(process.env.ROUTINE_TOGGLE ?? "1").toLowerCase(),
  ),
  routineTable: process.env.ROUTINE_TABLE || "routine",
  /** IANA timezone used for odd/even hour (default Taipei). */
  routineTz: process.env.ROUTINE_TZ || "Asia/Taipei",
  /** Unique marker in `note` so only cron-managed rows are deleted. */
  routineMarkerNote: process.env.ROUTINE_MARKER_NOTE || "GH_CRON_ROUTINE",
  routineMarkerName: process.env.ROUTINE_MARKER_NAME || "[cron] odd-hour",
};

const apiKey = config.serviceRoleKey || config.anonKey;
if (!apiKey) {
  throw new Error(
    "Missing API key. Add SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY in GitHub Secrets.",
  );
}

const baseHeaders = {
  apikey: apiKey,
  Authorization: `Bearer ${apiKey}`,
};

const secretFieldPattern =
  /(api[-_ ]?key|secret|token|password|passwd|authorization|bearer)/i;
const secretValuePatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-kimi-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g,
];

// ─── Env helpers ─────────────────────────────────────────────────────────────

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseList(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with exponential backoff on 429 / 5xx / network errors.
 */
async function fetchWithRetry(url, init = {}, label = "request") {
  let lastError;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok) return response;

      const retriable = response.status === 429 || response.status >= 500;
      const body = await response.text();
      lastError = new Error(
        `${label} failed: ${response.status} ${body.slice(0, 500)}`,
      );

      if (!retriable || attempt === config.maxRetries) throw lastError;

      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : config.retryBaseMs * 2 ** attempt;
      console.warn(
        `  retry ${attempt + 1}/${config.maxRetries} after ${delay}ms — ${label}`,
      );
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === config.maxRetries) throw lastError;
      const delay = config.retryBaseMs * 2 ** attempt;
      console.warn(
        `  retry ${attempt + 1}/${config.maxRetries} after ${delay}ms — ${label}: ${error.message}`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

async function fetchJson(url, init = {}, label = "request") {
  const response = await fetchWithRetry(url, init, label);
  return response.json();
}

// ─── Table discovery ─────────────────────────────────────────────────────────

async function discoverTablesWithServiceRole() {
  const spec = await fetchJson(
    `${config.supabaseUrl}/rest/v1/`,
    {
      headers: {
        ...baseHeaders,
        Accept: "application/openapi+json",
      },
    },
    "OpenAPI discovery",
  );

  const tables = new Set();

  for (const route of Object.keys(spec.paths ?? {})) {
    const tableName = route.replace(/^\//, "");
    // Skip path params and RPC endpoints
    if (!tableName || tableName.includes("{") || tableName.startsWith("rpc/")) {
      continue;
    }
    tables.add(tableName);
  }

  return [...tables].sort((a, b) => a.localeCompare(b));
}

async function discoverTables() {
  if (config.serviceRoleKey) {
    return {
      tables: await discoverTablesWithServiceRole(),
      mode: "service_role_auto_discovery",
    };
  }

  if (config.configuredTables.length > 0) {
    return {
      tables: config.configuredTables,
      mode: "configured_table_list",
    };
  }

  throw new Error(
    "Exporting all tables requires SUPABASE_SERVICE_ROLE_KEY. " +
      "If you only want specific tables, set SUPABASE_TABLES (comma-separated).",
  );
}

// ─── Row fetch (PostgREST Range pagination) ──────────────────────────────────

async function fetchTableRows(tableName) {
  const rows = [];
  let from = 0;

  while (true) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}`);
    url.searchParams.set("select", "*");

    const response = await fetchWithRetry(
      url,
      {
        headers: {
          ...baseHeaders,
          Range: `${from}-${from + config.pageSize - 1}`,
          Prefer: "count=exact",
        },
      },
      `table "${tableName}" range ${from}`,
    );

    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) break;

    rows.push(...page);
    if (page.length < config.pageSize) break;
    from += page.length;
  }

  return rows;
}

// ─── Sanitization ────────────────────────────────────────────────────────────

function sanitizeString(value, keyName = "") {
  if (secretFieldPattern.test(keyName) && value.trim().length > 0) {
    return config.redacted;
  }

  let sanitized = value;
  for (const pattern of secretValuePatterns) {
    sanitized = sanitized.replace(pattern, config.redacted);
  }
  return sanitized;
}

function sanitizeValue(value, keyName = "") {
  if (typeof value === "string") return sanitizeString(value, keyName);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeValue(v, k)]),
    );
  }
  return value;
}

// ─── Stable ordering (cleaner git diffs) ─────────────────────────────────────

function stableSortRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const sample = rows.find((r) => r && typeof r === "object") ?? null;
  if (!sample) return rows;

  // Prefer common primary-key style columns
  const sortKey = ["id", "uuid", "created_at"].find((k) => k in sample);
  if (!sortKey) return rows;

  return [...rows].sort((a, b) => {
    const av = a?.[sortKey];
    const bv = b?.[sortKey];
    if (av === bv) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av).localeCompare(String(bv), undefined, { numeric: true });
  });
}

// ─── File I/O ────────────────────────────────────────────────────────────────

function safeFileName(tableName) {
  return `${tableName.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeIfChanged(filePath, content) {
  try {
    const existing = await readFile(filePath, "utf8");
    if (existing === content) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(filePath, content);
  return true;
}

async function walkFiles(dir) {
  const found = new Set();

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const file of await walkFiles(absolutePath)) found.add(file);
      } else {
        found.add(absolutePath);
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return found;
    throw error;
  }

  return found;
}

async function pruneDeletedFiles(expectedRelative) {
  const existing = await walkFiles(config.outputRoot);
  let removed = 0;

  for (const existingFile of existing) {
    const relative = path.relative(config.outputRoot, existingFile).replace(/\\/g, "/");
    if (!expectedRelative.has(relative)) {
      await unlink(existingFile);
      removed += 1;
      console.log(`  pruned stale file: ${relative}`);
    }
  }

  return removed;
}

// ─── Concurrency pool ────────────────────────────────────────────────────────

/**
 * Run async work over items with a fixed concurrency limit.
 * Preserves input order in results.
 */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

// ─── Routine odd/even hour toggle ────────────────────────────────────────────

/**
 * Local hour in `timeZone` (0–23). Falls back to UTC if the zone is invalid.
 */
function getHourInTimeZone(date, timeZone) {
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(date);
    return Number.parseInt(hourStr, 10);
  } catch {
    return date.getUTCHours();
  }
}

function formatLocalStamp(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Odd hour (1,3,5…): insert one marker row into `routine`.
 * Even hour (0,2,4…): delete all rows whose `note` starts with the cron marker.
 *
 * Marker rows are identified by note prefix so real user data is never removed.
 * Requires insert/delete rights (service_role recommended).
 */
async function toggleRoutineByHour() {
  if (!config.routineToggle) {
    console.log("Routine toggle: disabled (ROUTINE_TOGGLE=0)");
    return { enabled: false };
  }

  const now = new Date();
  const hour = getHourInTimeZone(now, config.routineTz);
  const isOddHour = hour % 2 === 1;
  const localStamp = formatLocalStamp(now, config.routineTz);
  const table = config.routineTable;
  const marker = config.routineMarkerNote;

  console.log(
    `Routine toggle: ${config.routineTz} hour=${hour} → ${isOddHour ? "ODD insert" : "EVEN delete"}`,
  );

  if (isOddHour) {
    // Keep note ≤ 100 chars (schema limit). Prefix stays stable for even-hour delete.
    const note = `${marker} ${localStamp}`.slice(0, 100);
    const body = {
      name: config.routineMarkerName.slice(0, 100),
      note,
      lastdate1: null,
      lastdate2: null,
      lastdate3: null,
      link: null,
      photo: null,
    };

    const response = await fetchWithRetry(
      `${config.supabaseUrl}/rest/v1/${encodeURIComponent(table)}`,
      {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(body),
      },
      `insert ${table} (odd hour)`,
    );

    const created = await response.json();
    const row = Array.isArray(created) ? created[0] : created;
    console.log(
      `  inserted ${table} id=${row?.id ?? "?"} name=${JSON.stringify(body.name)} note=${JSON.stringify(note)}`,
    );

    return {
      enabled: true,
      action: "insert",
      timezone: config.routineTz,
      hour,
      table,
      id: row?.id ?? null,
      name: body.name,
      note,
    };
  }

  // Even hour: remove only cron-managed rows (note starts with marker)
  const deleteUrl = new URL(
    `${config.supabaseUrl}/rest/v1/${encodeURIComponent(table)}`,
  );
  deleteUrl.searchParams.set("note", `like.${marker}*`);

  const response = await fetchWithRetry(
    deleteUrl,
    {
      method: "DELETE",
      headers: {
        ...baseHeaders,
        Prefer: "return=representation",
      },
    },
    `delete ${table} cron markers (even hour)`,
  );

  const deleted = await response.json();
  const deletedRows = Array.isArray(deleted) ? deleted : [];
  const ids = deletedRows.map((r) => r.id).filter((id) => id != null);

  console.log(
    `  deleted ${deletedRows.length} cron marker row(s) from ${table}` +
      (ids.length ? ` ids=[${ids.join(",")}]` : ""),
  );

  return {
    enabled: true,
    action: "delete",
    timezone: config.routineTz,
    hour,
    table,
    deleted_count: deletedRows.length,
    deleted_ids: ids,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const started = Date.now();
  await mkdir(config.outputRoot, { recursive: true });

  // Phase 0: mutate routine before export so data/*.json reflects the toggle
  let routineToggleResult;
  try {
    routineToggleResult = await toggleRoutineByHour();
  } catch (error) {
    console.error(`Routine toggle failed: ${error.message}`);
    routineToggleResult = {
      enabled: config.routineToggle,
      action: "error",
      error: error.message,
    };
    // Fail the job: write/delete is intentional side effect, not best-effort
    process.exitCode = 1;
  }

  const { tables, mode } = await discoverTables();
  console.log(
    `Discovery: ${tables.length} table(s) via ${mode} (concurrency=${config.concurrency})`,
  );

  const expectedFiles = new Set([config.manifestName]);
  let filesChanged = 0;
  let totalRows = 0;
  const failures = [];

  const tableResults = await mapPool(tables, config.concurrency, async (tableName) => {
    try {
      const rows = await fetchTableRows(tableName);
      const sorted = stableSortRows(rows);
      const sanitized = sanitizeValue(sorted);
      const fileName = safeFileName(tableName);
      const content = toJson(sanitized);
      const filePath = path.join(config.outputRoot, fileName);
      const changed = await writeIfChanged(filePath, content);

      console.log(
        `  ${changed ? "updated" : "unchanged"} ${tableName} (${rows.length} rows) → ${fileName}`,
      );

      return {
        ok: true,
        table: tableName,
        row_count: rows.length,
        file: fileName,
        changed,
      };
    } catch (error) {
      console.error(`  FAILED ${tableName}: ${error.message}`);
      return {
        ok: false,
        table: tableName,
        error: error.message,
      };
    }
  });

  const manifestTables = [];

  for (const result of tableResults) {
    if (!result.ok) {
      failures.push(result);
      continue;
    }
    expectedFiles.add(result.file);
    totalRows += result.row_count;
    if (result.changed) filesChanged += 1;
    manifestTables.push({
      table: result.table,
      row_count: result.row_count,
      file: result.file,
    });
  }

  // Keep manifest table list sorted for stable diffs
  manifestTables.sort((a, b) => a.table.localeCompare(b.table));

  const pruned = await pruneDeletedFiles(expectedFiles);

  const manifest = {
    synced_at: new Date().toISOString(),
    table_count: manifestTables.length,
    total_rows: totalRows,
    discovery_mode: mode,
    concurrency: config.concurrency,
    routine_toggle: routineToggleResult,
    tables: manifestTables,
  };

  if (failures.length > 0) {
    manifest.failures = failures.map((f) => ({
      table: f.table,
      error: f.error,
    }));
  }

  const manifestPath = path.join(config.outputRoot, config.manifestName);
  const manifestChanged = await writeIfChanged(manifestPath, toJson(manifest));
  if (manifestChanged) filesChanged += 1;

  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsedSec}s — ${manifestTables.length} table(s), ${totalRows} rows, ` +
      `${filesChanged} file(s) changed, ${pruned} pruned` +
      (failures.length ? `, ${failures.length} failed` : ""),
  );

  // Fail the job if any table failed (partial data still written for successful ones)
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
