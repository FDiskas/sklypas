import { mkdirSync } from "fs";
import { Database } from "bun:sqlite";
import { paths } from "../config";
import type { GeoportalDocument } from "./geoportal";
import { logger } from "./progress";

export type SearchResult = {
  id: number;
  dataset_uuid: string;
  dataset_name: string;
  source_table: string;
  source_fid: string;
  address_text: string;
  info_json: string;
  latitude: number | null;
  longitude: number | null;
};

export type ParcelSearchResult = {
  dataset_uuid: string;
  dataset_name: string;
  source_table: string;
  source_fid: string;
  cadastre_number: string | null;
  unique_number: string | null;
  geometry_json: string | null;
};

type LayerInfo = {
  dataset_uuid: string;
  dataset_name: string;
  table_name: string;
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function findFirstMatchingColumn(columns: string[], exact: string[], regex: RegExp): string | null {
  const lowerMap = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const name of exact) {
    const found = lowerMap.get(name.toLowerCase());
    if (found) {
      return found;
    }
  }

  const byRegex = columns.find((c) => regex.test(c));
  return byRegex ?? null;
}

function toSearchComparableExpr(column: string): string {
  const ident = quoteIdent(column);
  return `LOWER(REPLACE(REPLACE(REPLACE(COALESCE(CAST(${ident} AS TEXT), ''), ' ', ''), '/', ''), '-', ''))`;
}

export function openDb(): Database {
  mkdirSync(paths.dataDir, { recursive: true });
  const db = new Database(paths.dbFile, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

export function initDb(db: Database): void {
  // Drop legacy raw_features table — data is fully captured in per-layer tables.
  db.exec("DROP TABLE IF EXISTS raw_features;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS datasets (
      uuid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      author TEXT,
      description TEXT,
      frequency TEXT,
      download_url TEXT,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS imported_layers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_uuid TEXT NOT NULL,
      source_path TEXT NOT NULL,
      layer_name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      UNIQUE(dataset_uuid, source_path, layer_name)
    );

    CREATE TABLE IF NOT EXISTS address_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_uuid TEXT NOT NULL,
      dataset_name TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_fid TEXT NOT NULL,
      address_text TEXT NOT NULL,
      info_json TEXT NOT NULL,
      search_text TEXT,
      latitude REAL,
      longitude REAL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_address_text ON address_index(address_text);
    CREATE INDEX IF NOT EXISTS idx_dataset_name ON address_index(dataset_name);
    CREATE INDEX IF NOT EXISTS idx_address_dataset_uuid ON address_index(dataset_uuid);
  `);

  // Add search_text column if missing (one-time schema evolution).
  try {
    db.exec("ALTER TABLE address_index ADD COLUMN search_text TEXT");
  } catch {
    // Column already exists — ignore.
  }

  // FTS5 full-text index over search_text; rowid mirrors address_index.id.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS address_fts USING fts5(
      search_text,
      tokenize='unicode61'
    )
  `);

  // One-time migration: populate search_text, fix projected coords → WGS84, build FTS5.
  const migrated = getSyncState(db, "db_migration_v2");
  if (!migrated) {
    logger.info("[db] running one-time migration v2: search_text + WGS84 coords + FTS5...");

    // Flatten all non-geometry JSON values into a single searchable string.
    db.exec(`
      UPDATE address_index
      SET search_text = (
        SELECT GROUP_CONCAT(
          CASE WHEN key != '_geometry' AND value IS NOT NULL AND CAST(value AS TEXT) != ''
          THEN CAST(value AS TEXT) ELSE NULL END, ' '
        )
        FROM json_each(address_index.info_json)
      )
      WHERE search_text IS NULL
    `);

    // Replace LKS94 projected coords with WGS84 E_KOORD/N_KOORD where available.
    db.exec(`
      UPDATE address_index
      SET
        latitude  = CAST(json_extract(info_json, '$.N_KOORD') AS REAL),
        longitude = CAST(json_extract(info_json, '$.E_KOORD') AS REAL)
      WHERE
        json_extract(info_json, '$.N_KOORD') IS NOT NULL
        AND json_extract(info_json, '$.E_KOORD') IS NOT NULL
        AND (latitude IS NULL OR latitude > 90 OR latitude < -90)
    `);

    // Rebuild FTS5 from address_index.
    db.exec("DELETE FROM address_fts");
    db.exec(`
      INSERT INTO address_fts(rowid, search_text)
      SELECT id, search_text FROM address_index WHERE search_text IS NOT NULL
    `);

    setSyncState(db, "db_migration_v2", "1");
    logger.info("[db] migration v2 complete");
  }

  // Backfill search_text for rows that are still NULL (imported after v2 ran but before the
  // insert-time fix) and sync any missing address_fts entries.
  const backfilled = getSyncState(db, "db_migration_v3");
  if (!backfilled) {
    logger.info("[db] running one-time migration v3: backfill search_text + FTS5 for existing rows...");

    db.exec(`
      UPDATE address_index
      SET search_text = (
        SELECT GROUP_CONCAT(
          CASE WHEN key != '_geometry' AND value IS NOT NULL AND CAST(value AS TEXT) != ''
          THEN CAST(value AS TEXT) ELSE NULL END, ' '
        )
        FROM json_each(address_index.info_json)
      )
      WHERE search_text IS NULL
    `);

    // Insert FTS5 rows for any address_index entries not yet in address_fts.
    db.exec(`
      INSERT INTO address_fts(rowid, search_text)
      SELECT ai.id, ai.search_text
      FROM address_index ai
      WHERE ai.search_text IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM address_fts WHERE rowid = ai.id)
    `);

    setSyncState(db, "db_migration_v3", "1");
    logger.info("[db] migration v3 complete");
  }
}

/**
 * Delete all address_index rows (and matching FTS5 entries) for a dataset.
 * Must be called inside an open db connection before re-importing.
 */
export function clearDatasetAddresses(db: Database, datasetUuid: string): void {
  const rows = db.prepare("SELECT id FROM address_index WHERE dataset_uuid = ?").all(datasetUuid) as { id: number }[];
  if (rows.length > 0) {
    const deleteFts = db.prepare("DELETE FROM address_fts WHERE rowid = ?");
    db.transaction(() => {
      for (const { id } of rows) deleteFts.run(id);
    })();
  }
  db.prepare("DELETE FROM address_index WHERE dataset_uuid = ?").run(datasetUuid);
}

/**
 * Clear all data for a specific source file (dataset + source_path combination).
 * Ensures idempotent re-runs: if import fails halfway, re-running doesn't duplicate data.
 */
export function clearSourceData(db: Database, datasetUuid: string, sourcePath: string): void {
  // Delete from address_index
  const addressRows = db.prepare("SELECT id FROM address_index WHERE dataset_uuid = ? AND source_table IN (SELECT table_name FROM imported_layers WHERE dataset_uuid = ? AND source_path = ?)").all(datasetUuid, datasetUuid, sourcePath) as { id: number }[];
  if (addressRows.length > 0) {
    const deleteFts = db.prepare("DELETE FROM address_fts WHERE rowid = ?");
    db.transaction(() => {
      for (const { id } of addressRows) deleteFts.run(id);
    })();
  }
  db.prepare("DELETE FROM address_index WHERE dataset_uuid = ? AND source_table IN (SELECT table_name FROM imported_layers WHERE dataset_uuid = ? AND source_path = ?)").run(datasetUuid, datasetUuid, sourcePath);

  // Delete from imported_layers
  db.prepare("DELETE FROM imported_layers WHERE dataset_uuid = ? AND source_path = ?").run(datasetUuid, sourcePath);

  // Delete from all per-layer tables
  const layers = db.prepare("SELECT DISTINCT table_name FROM imported_layers WHERE dataset_uuid = ?").all(datasetUuid) as { table_name: string }[];
  for (const { table_name } of layers) {
    const quoted = `"${table_name.replace(/"/g, '""')}"`;
    try {
      db.prepare(`DELETE FROM ${quoted} WHERE _source_path = ?`).run(sourcePath);
    } catch {
      // Table might not exist yet, that's ok
    }
  }
}

export function upsertDataset(db: Database, doc: GeoportalDocument, downloadUrl: string | null): void {
  const stmt = db.prepare(`
    INSERT INTO datasets (uuid, name, author, description, frequency, download_url, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uuid) DO UPDATE SET
      name = excluded.name,
      author = excluded.author,
      description = excluded.description,
      frequency = excluded.frequency,
      download_url = excluded.download_url,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    doc.uuid,
    doc.name,
    doc.author ?? null,
    doc.description ?? null,
    doc.frequency ?? null,
    downloadUrl,
    JSON.stringify(doc),
    Date.now()
  );
}

export function setSyncState(db: Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO sync_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

export function getSyncState(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function searchAddresses(db: Database, query: string, limit = 20): SearchResult[] {
  const safeLimit = Math.min(Math.max(limit, 1), 100);

  const tokens = query
    .trim()
    .split(/[\s,./]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) {
    return [];
  }

  // Build FTS5 query: each token as a quoted phrase (implicit AND).
  const ftsQuery = tokens.map((t) => `"${t.replace(/["\*\^]/g, "")}"`).join(" ");

  try {
    return db.prepare(`
      SELECT ai.id, ai.dataset_uuid, ai.dataset_name, ai.source_table, ai.source_fid,
             ai.address_text, ai.info_json, ai.latitude, ai.longitude
      FROM address_fts
      JOIN address_index ai ON ai.id = address_fts.rowid
      WHERE address_fts MATCH ?
      ORDER BY LENGTH(ai.address_text) ASC
      LIMIT ?
    `).all(ftsQuery, safeLimit) as SearchResult[];
  } catch {
    // Fall back to multi-token LIKE if FTS5 is unavailable or the query is malformed.
    const conditions = tokens.map(() => "address_text LIKE ?").join(" AND ");
    const bindings: unknown[] = tokens.map((t) => `%${t}%`);
    bindings.push(safeLimit);
    return db.prepare(`
      SELECT id, dataset_uuid, dataset_name, source_table, source_fid, address_text, info_json, latitude, longitude
      FROM address_index WHERE ${conditions}
      ORDER BY LENGTH(address_text) ASC LIMIT ?
    `).all(...bindings) as SearchResult[];
  }
}

export function getAddressById(db: Database, id: number): SearchResult | null {
  const stmt = db.prepare(`
    SELECT id, dataset_uuid, dataset_name, source_table, source_fid, address_text, info_json, latitude, longitude
    FROM address_index
    WHERE id = ?
  `);
  return (stmt.get(id) as SearchResult | null) ?? null;
}

export function searchParcelsByCadastre(db: Database, query: string, limit = 20): ParcelSearchResult[] {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const compact = query.toLowerCase().replace(/[\s/-]+/g, "").trim();
  if (compact.length < 3) {
    return [];
  }

  const layerRows = db.prepare(`
    SELECT DISTINCT il.dataset_uuid, d.name AS dataset_name, il.table_name
    FROM imported_layers il
    JOIN datasets d ON d.uuid = il.dataset_uuid
  `).all() as LayerInfo[];

  const results: ParcelSearchResult[] = [];
  const perTableLimit = Math.min(safeLimit, 25);
  const likeValue = `%${compact}%`;

  for (const layer of layerRows) {
    if (results.length >= safeLimit) {
      break;
    }

    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(layer.table_name)})`).all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    const cadastreColumn = findFirstMatchingColumn(
      columnNames,
      ["kadastro_nr", "kadastrinis_nr", "kad_nr", "parcel_nr", "parcel_no"],
      /(kad|cadas|parcel|sklyp).*(nr|no|num)/i
    );
    const uniqueColumn = findFirstMatchingColumn(
      columnNames,
      ["unikalus_nr", "unikalusnumeris", "unique_nr", "unique_no"],
      /(unik|unique).*(nr|no|num)?/i
    );

    if (!cadastreColumn && !uniqueColumn) {
      continue;
    }

    const whereClauses: string[] = [];
    if (cadastreColumn) {
      whereClauses.push(`${toSearchComparableExpr(cadastreColumn)} LIKE ?`);
    }
    if (uniqueColumn) {
      whereClauses.push(`${toSearchComparableExpr(uniqueColumn)} LIKE ?`);
    }
    if (whereClauses.length === 0) {
      continue;
    }

    const cadastreExpr = cadastreColumn ? `CAST(${quoteIdent(cadastreColumn)} AS TEXT)` : "NULL";
    const uniqueExpr = uniqueColumn ? `CAST(${quoteIdent(uniqueColumn)} AS TEXT)` : "NULL";
    const sql = `
      SELECT
        ? AS dataset_uuid,
        ? AS dataset_name,
        ? AS source_table,
        CAST(_source_fid AS TEXT) AS source_fid,
        ${cadastreExpr} AS cadastre_number,
        ${uniqueExpr} AS unique_number,
        _geometry_json AS geometry_json
      FROM ${quoteIdent(layer.table_name)}
      WHERE ${whereClauses.join(" OR ")}
      LIMIT ?
    `;

    const bindings: unknown[] = [layer.dataset_uuid, layer.dataset_name, layer.table_name];
    if (cadastreColumn) {
      bindings.push(likeValue);
    }
    if (uniqueColumn) {
      bindings.push(likeValue);
    }
    bindings.push(perTableLimit);

    const rows = db.prepare(sql).all(...bindings) as ParcelSearchResult[];
    results.push(...rows);
  }

  return results.slice(0, safeLimit);
}
