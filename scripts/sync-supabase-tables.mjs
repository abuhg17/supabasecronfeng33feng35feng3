import { mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const requiredEnv = ["SUPABASE_URL", "SUPABASE_ANON_KEY"];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, "");
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const outputRoot = path.resolve("data");
const manifestPath = path.resolve("data", "_manifest.json");
const pageSize = 1000;

const baseHeaders = {
  apikey: supabaseAnonKey,
  Authorization: `Bearer ${supabaseAnonKey}`,
};

function safeFileName(tableName) {
  return `${tableName.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request failed: ${response.status} ${errorText}`);
  }
  return response.json();
}

async function discoverTables() {
  const spec = await fetchJson(`${supabaseUrl}/rest/v1/`, {
    headers: {
      ...baseHeaders,
      Accept: "application/openapi+json",
    },
  });

  const tables = new Set();

  for (const route of Object.keys(spec.paths ?? {})) {
    const tableName = route.replace(/^\//, "");
    if (!tableName || tableName.includes("{") || tableName.startsWith("rpc/")) {
      continue;
    }
    tables.add(tableName);
  }

  return [...tables].sort((a, b) => a.localeCompare(b));
}

async function fetchTableRows(tableName) {
  const rows = [];
  let from = 0;

  while (true) {
    const url = new URL(`${supabaseUrl}/rest/v1/${tableName}`);
    url.searchParams.set("select", "*");

    const response = await fetch(url, {
      headers: {
        ...baseHeaders,
        Range: `${from}-${from + pageSize - 1}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch table "${tableName}": ${response.status} ${errorText}`);
    }

    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    rows.push(...page);
    if (page.length < pageSize) {
      break;
    }

    from += page.length;
  }

  return rows;
}

async function walkFiles(dir) {
  const found = new Set();

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await walkFiles(absolutePath);
        for (const file of nested) {
          found.add(file);
        }
      } else {
        found.add(absolutePath);
      }
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return found;
    }
    throw error;
  }

  return found;
}

async function ensureOutputRoot() {
  await mkdir(outputRoot, { recursive: true });
}

async function pruneDeletedFiles(expectedFiles) {
  const existingFiles = await walkFiles(outputRoot);

  for (const existingFile of existingFiles) {
    const relativePath = path.relative(outputRoot, existingFile).replace(/\\/g, "/");
    if (!expectedFiles.has(relativePath)) {
      await unlink(existingFile);
    }
  }
}

async function main() {
  await ensureOutputRoot();

  const tables = await discoverTables();
  const manifest = {
    synced_at: new Date().toISOString(),
    table_count: tables.length,
    tables: [],
  };

  const expectedFiles = new Set(["_manifest.json"]);

  for (const tableName of tables) {
    const rows = await fetchTableRows(tableName);
    const fileName = safeFileName(tableName);
    expectedFiles.add(fileName);

    await writeFile(
      path.join(outputRoot, fileName),
      `${JSON.stringify(rows, null, 2)}\n`,
    );

    manifest.tables.push({
      table: tableName,
      row_count: rows.length,
      file: fileName,
    });
  }

  await pruneDeletedFiles(expectedFiles);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Synced ${tables.length} table(s) to JSON files.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
