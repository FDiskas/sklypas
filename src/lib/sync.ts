import { mkdirSync, existsSync, rmSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { readdir, stat } from "fs/promises";
import { basename, extname, join, dirname } from "path";
import { $ } from "bun";
import { settings, paths } from "../config";
import { fetchOpenDataDocuments, getDownloadUrl, type GeoportalDocument } from "./geoportal";
import { getSyncState, initDb, openDb, setSyncState, upsertDataset, clearSourceData, indexGeometryRow } from "./db";
import { createProgressReporter, type ProgressReporter, logger, stopProgress } from "./progress";

type SourceCandidate = {
  path: string;
  kind: "gpkg" | "gdb" | "shp" | "geojson" | "gml";
};

type ExtractedFeature = {
  layer: string;
  fid: string | number | null;
  properties: Record<string, unknown>;
  geometry: { type?: string; coordinates?: unknown } | null;
};

type SqlBinding = string | number | bigint | Uint8Array | null;

type DatasetWithImportMeta = GeoportalDocument & {
  _lastImportedAt: number | null;
};

type SyncLockPayload = {
  pid: number;
  startedAt: number;
};

type SourceSignature = {
  size: number;
  mtimeMs: number;
};

type ZipValidationCache = SourceSignature & {
  validatedAt: number;
};

type ExtractionCache = SourceSignature & {
  extractedAt: number;
};

type ProcessWaitResult =
  | { kind: "exit"; code: number }
  | { kind: "timeout" };

class RecoverableSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverableSyncError";
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function logDatasetFailure(dataset: GeoportalDocument, error: unknown): void {
  const message = toErrorMessage(error);
  logger.error(`[dataset:failed] ${dataset.uuid} ${dataset.name} :: ${message}`);
}

async function readLinesFromStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: string) => void
): Promise<void> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        onLine(line);
      }
    }

    buffered += decoder.decode();
    if (buffered.length > 0) {
      onLine(buffered);
    }
  } finally {
    reader.releaseLock();
  }
}

async function streamToText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) {
    return "";
  }

  const chunks: string[] = [];
  await readLinesFromStream(stream, (line) => {
    chunks.push(line);
  });
  return chunks.join("\n");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLockFile(payload: SyncLockPayload): void {
  const fd = openSync(paths.syncLockFile, "wx");
  try {
    writeFileSync(fd, JSON.stringify(payload));
  } finally {
    closeSync(fd);
  }
}

function tryAcquireSyncLock(): (() => void) | null {
  mkdirSync(paths.dataDir, { recursive: true });
  const payload: SyncLockPayload = {
    pid: process.pid,
    startedAt: Date.now(),
  };

  try {
    writeLockFile(payload);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") {
      throw error;
    }

    try {
      const existingText = readFileSync(paths.syncLockFile, "utf8");
      const existing = JSON.parse(existingText) as Partial<SyncLockPayload>;
      if (typeof existing.pid === "number" && isProcessAlive(existing.pid)) {
        return null;
      }
    } catch {
      // If lock cannot be parsed/read, treat it as stale and replace it.
    }

    try {
      unlinkSync(paths.syncLockFile);
    } catch {
      return null;
    }

    writeLockFile(payload);
  }

  return () => {
    try {
      unlinkSync(paths.syncLockFile);
    } catch {
      // Ignore lock cleanup errors.
    }
  };
}

function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableNameForLayer(datasetUuid: string, layerName: string): string {
  const datasetPart = sanitizeName(datasetUuid.replace(/[{}]/g, ""));
  const layerPart = sanitizeName(layerName || "layer");
  return `layer_${datasetPart}_${layerPart}`.slice(0, 63);
}

function inferSqliteType(value: unknown): "INTEGER" | "REAL" | "TEXT" {
  if (typeof value === "boolean") {
    return "INTEGER";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "INTEGER" : "REAL";
  }
  return "TEXT";
}

function toSqlValue(value: unknown): SqlBinding {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  return String(value);
}

function ensureLayerTable(
  db: ReturnType<typeof openDb>,
  tableName: string,
  properties: Record<string, unknown>
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (
      _source_fid TEXT,
      _source_path TEXT NOT NULL,
      _layer_name TEXT NOT NULL,
      _geometry_json TEXT,
      _imported_at INTEGER NOT NULL
    )
  `);

  const existing = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{ name: string }>;
  const existingNames = new Set(existing.map((c) => c.name));

  for (const [key, value] of Object.entries(properties)) {
    if (existingNames.has(key)) {
      continue;
    }

    const colType = inferSqliteType(value);
    db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(key)} ${colType}`);
  }
}

function addImportedLayer(
  db: ReturnType<typeof openDb>,
  datasetUuid: string,
  sourcePath: string,
  layerName: string,
  tableName: string
): void {
  db.prepare(`
    INSERT OR REPLACE INTO imported_layers (dataset_uuid, source_path, layer_name, table_name, imported_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(datasetUuid, sourcePath, layerName, tableName, Date.now());
}

function insertIntoLayerTable(
  db: ReturnType<typeof openDb>,
  tableName: string,
  sourcePath: string,
  layerName: string,
  sourceFid: string,
  properties: Record<string, unknown>,
  geometryJson: string | null,
  importedAt: number
): void {
  const propertyKeys = Object.keys(properties);
  const columns = ["_source_fid", "_source_path", "_layer_name", "_geometry_json", "_imported_at", ...propertyKeys];
  const placeholders = columns.map(() => "?").join(", ");
  const sql = `INSERT INTO ${quoteIdent(tableName)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;

  const values: SqlBinding[] = [
    sourceFid,
    sourcePath,
    layerName,
    geometryJson,
    importedAt,
    ...propertyKeys.map((key) => toSqlValue(properties[key])),
  ];

  const result = db.prepare(sql).run(...values);
  // Keep spatial index (if any) in lockstep with the per-layer table.
  indexGeometryRow(db, tableName, Number(result.lastInsertRowid), geometryJson);
}

function looksLikeAddressField(fieldName: string): boolean {
  return /(addr|adresas|gatv|street|house|nam|city|miest|savival|seniun|vietov|place|location)/i.test(fieldName);
}

function looksLikeLat(fieldName: string): boolean {
  return /(lat|latitude|koord_y|y_coord)/i.test(fieldName);
}

function looksLikeLon(fieldName: string): boolean {
  return /(lon|lng|longitude|koord_x|x_coord)/i.test(fieldName);
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function latLonFromFeature(feature: ExtractedFeature): { lat: number | null; lon: number | null } {
  const props = feature.properties ?? {};
  const keys = Object.keys(props);
  const latKey = keys.find((k) => looksLikeLat(k));
  const lonKey = keys.find((k) => looksLikeLon(k));

  const fromPropsLat = latKey ? toNumberOrNull(props[latKey]) : null;
  const fromPropsLon = lonKey ? toNumberOrNull(props[lonKey]) : null;
  if (fromPropsLat !== null && fromPropsLon !== null) {
    return { lat: fromPropsLat, lon: fromPropsLon };
  }

  if (feature.geometry?.type === "Point" && Array.isArray(feature.geometry.coordinates)) {
    const coords = feature.geometry.coordinates as unknown[];
    const lon = toNumberOrNull(coords[0]);
    const lat = toNumberOrNull(coords[1]);
    return { lat, lon };
  }

  return { lat: null, lon: null };
}

function buildAddressText(props: Record<string, unknown>): string | null {
  const entries = Object.entries(props);
  const preferred = entries.filter(([key, value]) => looksLikeAddressField(key) && typeof value === "string" && value.trim().length > 0);
  const primaryAddress = preferred.filter(([key]) => /(adres|address|street|gatv)/i.test(key));

  if (preferred.length === 0 || primaryAddress.length === 0) {
    return null;
  }

  const parts = preferred
    .slice(0, 8)
    .map(([, value]) => String(value).trim());

  if (parts.length === 0) {
    return null;
  }

  return parts.join(", ");
}

function buildSearchText(props: Record<string, unknown>): string | null {
  const parts = Object.values(props)
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .map((v) => String(v).trim());
  return parts.length > 0 ? parts.join(" ") : null;
}

async function walk(dir: string, out: string[], onFile?: () => void): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, out, onFile);
    } else {
      out.push(fullPath);
      onFile?.();
    }
  }
}

async function findGdbDirs(baseDir: string): Promise<string[]> {
  const found: string[] = [];
  const stack = [baseDir];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase().endsWith(".gdb")) {
          found.push(fullPath);
        } else {
          stack.push(fullPath);
        }
      }
    }
  }

  return found;
}

async function collectSources(baseDir: string): Promise<SourceCandidate[]> {
  const start = Date.now();
  const files: string[] = [];
  const scanProgress = createProgressReporter("auto", { label: "scanned files" });
  logger.info("[scan] Discovering extracted source files");
  let scannedFiles = 0;
  await walk(baseDir, files, () => {
    scannedFiles += 1;
    scanProgress.update(scannedFiles);
  });
  scanProgress.update(scannedFiles);
  scanProgress.checkpoint(`scanned ${scannedFiles} file(s)`);

  const sources: SourceCandidate[] = [];
  for (const filePath of files) {
    const name = basename(filePath);
    if (name.startsWith(".")) {
      continue;
    }

    const ext = extname(filePath).toLowerCase();
    if (ext === ".gpkg") {
      sources.push({ path: filePath, kind: "gpkg" });
    } else if (ext === ".shp") {
      sources.push({ path: filePath, kind: "shp" });
    } else if (ext === ".geojson" || (ext === ".json" && name !== ".source-state.json")) {
      sources.push({ path: filePath, kind: "geojson" });
    } else if (ext === ".gml") {
      sources.push({ path: filePath, kind: "gml" });
    }
  }

  const gdbDirs = await findGdbDirs(baseDir);
  for (const gdbDir of gdbDirs) {
    sources.push({ path: gdbDir, kind: "gdb" });
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[scan] Found ${sources.length} geospatial source(s) in ${elapsed}s`);
  return sources;
}

async function ensureDirs(): Promise<void> {
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.downloadDir, { recursive: true });
  mkdirSync(paths.extractDir, { recursive: true });
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

async function downloadToFile(url: string, targetFile: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed ${response.status} ${response.statusText} for ${url}`);
  }

  if (!response.body) {
    throw new Error(`Download failed: empty response body for ${url}`);
  }

  const totalBytesHeader = response.headers.get("content-length");
  const totalBytes = totalBytesHeader ? Number(totalBytesHeader) : NaN;
  const hasKnownTotal = Number.isFinite(totalBytes) && totalBytes > 0;

  const writer = Bun.file(targetFile).writer();
  const reader = response.body.getReader();
  let downloaded = 0;
  const progress = createProgressReporter("auto", { valueFormatter: formatBytes });
  logger.info("[download] Downloading source archive");

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      await writer.write(value);
      downloaded += value.byteLength;

      if (hasKnownTotal) {
        progress.update(downloaded, totalBytes);
      } else {
        progress.update(downloaded);
      }
    }

    if (hasKnownTotal) {
      progress.complete(`downloaded ${formatBytes(downloaded)} / ${formatBytes(totalBytes)}`);
    } else {
      progress.complete(`downloaded ${formatBytes(downloaded)}`);
    }
  } finally {
    await writer.end();
    reader.releaseLock();
  }
}

async function extractZip(zipPath: string, extractTo: string): Promise<void> {
  mkdirSync(extractTo, { recursive: true });
  const startTime = Date.now();
  const totalEntries = await countZipEntries(zipPath);

  if (totalEntries <= 0) {
    await $`unzip -o ${zipPath} -d ${extractTo}`.quiet();
  } else {
    logger.info("[extracting] ZIP archive");
    const progress = createProgressReporter();
    const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", extractTo], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let extractedEntries = 0;
    const onLine = (line: string): void => {
      if (line.includes("inflating:") || line.includes("extracting:")) {
        extractedEntries += 1;
        progress.update(Math.min(extractedEntries, totalEntries), totalEntries);
      }
    };

    const [exitCode] = await Promise.all([
      proc.exited,
      readLinesFromStream(proc.stdout, onLine),
      readLinesFromStream(proc.stderr, onLine),
    ]);

    if (exitCode !== 0) {
      throw new Error(`ZIP extraction failed with exit code ${exitCode}`);
    }

    const finalCount = Math.max(extractedEntries, totalEntries);
    progress.complete(`extracted ${finalCount}/${totalEntries} entries`);
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[extract] ZIP extraction finished in ${elapsedSec}s`);
}

function signatureMatches(a: SourceSignature, b: SourceSignature): boolean {
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;
}

function getZipValidationCachePath(zipPath: string): string {
  return `${zipPath}.validated.json`;
}

function readZipValidationCache(zipPath: string): ZipValidationCache | null {
  const cachePath = getZipValidationCachePath(zipPath);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<ZipValidationCache>;
    if (typeof data.size !== "number" || typeof data.mtimeMs !== "number") {
      return null;
    }
    return {
      size: data.size,
      mtimeMs: data.mtimeMs,
      validatedAt: typeof data.validatedAt === "number" ? data.validatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeZipValidationCache(zipPath: string, signature: SourceSignature): void {
  const cachePath = getZipValidationCachePath(zipPath);
  const payload: ZipValidationCache = {
    ...signature,
    validatedAt: Date.now(),
  };
  writeFileSync(cachePath, JSON.stringify(payload));
}

function getExtractionCachePath(extractDir: string): string {
  return join(extractDir, ".source-state.json");
}

function readExtractionCache(extractDir: string): ExtractionCache | null {
  const cachePath = getExtractionCachePath(extractDir);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<ExtractionCache>;
    if (typeof data.size !== "number" || typeof data.mtimeMs !== "number") {
      return null;
    }
    return {
      size: data.size,
      mtimeMs: data.mtimeMs,
      extractedAt: typeof data.extractedAt === "number" ? data.extractedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeExtractionCache(extractDir: string, signature: SourceSignature): void {
  const cachePath = getExtractionCachePath(extractDir);
  const payload: ExtractionCache = {
    ...signature,
    extractedAt: Date.now(),
  };
  writeFileSync(cachePath, JSON.stringify(payload));
}

async function getSourceSignature(filePath: string): Promise<SourceSignature> {
  const fileStat = await stat(filePath);
  return {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  };
}

function shouldReuseExtraction(extractDir: string, signature: SourceSignature): boolean {
  if (!existsSync(extractDir)) {
    return false;
  }

  const cache = readExtractionCache(extractDir);
  if (!cache || !signatureMatches(cache, signature)) {
    return false;
  }

  try {
    const entries = readdirSync(extractDir);
    return entries.some((entry) => entry !== ".source-state.json");
  } catch {
    return false;
  }
}

async function countZipEntries(zipPath: string): Promise<number> {
  const output = await $`unzip -Z1 ${zipPath}`.text();
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

async function testZipWithProgress(zipPath: string, totalEntries: number): Promise<void> {
  const progress = createProgressReporter();
  const proc = Bun.spawn(["unzip", "-t", zipPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let testedEntries = 0;
  const onLine = (line: string): void => {
    if (line.includes("testing:")) {
      testedEntries += 1;
      progress.update(Math.min(testedEntries, totalEntries), totalEntries);
    }
  };

  const [exitCode] = await Promise.all([
    proc.exited,
    readLinesFromStream(proc.stdout, onLine),
    readLinesFromStream(proc.stderr, onLine),
  ]);

  if (exitCode !== 0) {
    throw new Error(`ZIP validation failed with exit code ${exitCode}`);
  }

  const finalCount = Math.max(testedEntries, totalEntries);
  progress.complete(`validated ${finalCount}/${totalEntries} entries`);
}

async function isZipArchiveValid(zipPath: string): Promise<boolean> {
  try {
   const signature = await getSourceSignature(zipPath);
   const cached = readZipValidationCache(zipPath);
   if (cached && signatureMatches(cached, signature)) {
    logger.info("[validating] ZIP integrity (cached)");
     return true;
   }

  logger.info("[validating] ZIP integrity");
   const start = Date.now();
   const totalEntries = await countZipEntries(zipPath);
   if (totalEntries <= 0) {
     await $`unzip -tqq ${zipPath}`.quiet();
   } else {
     await testZipWithProgress(zipPath, totalEntries);
   }
   const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  writeZipValidationCache(zipPath, signature);
  logger.info(`[validate] ZIP valid (${elapsed}s)`);
   return true;
  } catch {
  logger.warn("[validate] ZIP corrupted, will re-download");
    return false;
  }
}

function summarizeExtractorFailure(stderrText: string, exitCode: number): string {
  const lines = stderrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const nativeCrash = lines.find((line) => line.toLowerCase().includes("crashed while loading native module"));
  if (nativeCrash) {
    return `Extractor failed (exit code ${exitCode}): native module load failure.`;
  }

  const panic = lines.find((line) => line.toLowerCase().includes("panic"));
  if (panic) {
    return `Extractor failed (exit code ${exitCode}): ${panic}`;
  }

  const tail = lines.slice(-3).join(" | ");
  if (tail.length > 0) {
    return `Extractor failed (exit code ${exitCode}): ${tail}`;
  }

  return `Extractor failed with exit code ${exitCode}`;
}

async function importSource(dataset: GeoportalDocument, sourcePath: string): Promise<void> {
  logger.info(`[import] Reading ${basename(sourcePath)}`);
  
  const ogrinfoProc = Bun.spawn(["ogrinfo", "-json", "-ro", sourcePath], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const ogrinfoText = await new Response(ogrinfoProc.stdout).text();
  const ogrinfoCode = await ogrinfoProc.exited;
  if (ogrinfoCode !== 0) {
    throw new RecoverableSyncError(`Failed to read layers from ${basename(sourcePath)}`);
  }
  
  let info;
  try {
    info = JSON.parse(ogrinfoText);
  } catch {
    throw new RecoverableSyncError(`Failed to parse ogrinfo output for ${basename(sourcePath)}`);
  }
  
  const layers: string[] = [];
  let totalFeatures = 0;
  for (const l of info.layers || []) {
    layers.push(l.name);
    if (typeof l.featureCount === "number" && l.featureCount > 0) {
      totalFeatures += l.featureCount;
    }
  }

  const db = openDb();
  initDb(db);
  
  const progress = createProgressReporter("auto", { label: "ingested features" });
  progress.checkpoint("clearing any previous partial import");
  clearSourceData(db, dataset.uuid, sourcePath);

  const insertAddress = db.prepare(`
    INSERT INTO address_index (
      dataset_uuid, dataset_name, source_table, source_fid, address_text, info_json, search_text, latitude, longitude, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO address_fts(rowid, search_text) VALUES (?, ?)
  `);

  const now = Date.now();
  const clearedLayerTables = new Set<string>();
  let processedCount = 0;
  let skippedCount = 0;

  db.exec("BEGIN TRANSACTION");
  try {
    for (const layerName of layers) {
      const proc = Bun.spawn(
        ["ogr2ogr", "-f", "GeoJSONSeq", "/vsistdout/", sourcePath, layerName],
        { stdout: "pipe", stderr: "ignore" }
      );

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        
        let feature: ExtractedFeature;
        try {
          const geojson = JSON.parse(trimmed);
          if (geojson.type !== "Feature") return;
          feature = {
            layer: layerName,
            fid: geojson.id !== undefined ? geojson.id : (processedCount + 1),
            properties: geojson.properties || {},
            geometry: geojson.geometry || null,
          };
        } catch (parseError) {
          skippedCount += 1;
          return;
        }

        const properties = feature.properties ?? {};
        const sourceFid = feature.fid === null || feature.fid === undefined ? "" : String(feature.fid);
        const tableName = tableNameForLayer(dataset.uuid, layerName);
        const geometryJson = feature.geometry ? JSON.stringify(feature.geometry) : null;

        ensureLayerTable(db, tableName, properties);
        if (!clearedLayerTables.has(tableName)) {
          addImportedLayer(db, dataset.uuid, sourcePath, layerName, tableName);
          clearedLayerTables.add(tableName);
        }

        insertIntoLayerTable(db, tableName, sourcePath, layerName, sourceFid, properties, geometryJson, now);
        processedCount += 1;

        if (totalFeatures > 0) {
          progress.update(processedCount, totalFeatures);
        } else {
          progress.update(processedCount);
        }

        const addressText = buildAddressText(properties);
        if (!addressText) {
          return;
        }

        const latLon = latLonFromFeature(feature);
        const infoJson = JSON.stringify({ ...properties, _geometry: feature.geometry });
        const searchText = buildSearchText(properties);
        insertAddress.run(
          dataset.uuid,
          dataset.name,
          layerName,
          sourceFid,
          addressText,
          infoJson,
          searchText,
          latLon.lat,
          latLon.lon,
          now
        );
        if (searchText) {
          const { id } = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!;
          insertFts.run(id, searchText);
        }
      };

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            processLine(line);
          }
        }
        if (done) {
          if (buffer) {
            processLine(buffer);
          }
          break;
        }
      }
      
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
         throw new RecoverableSyncError(`Extraction failed for layer ${layerName}`);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  if (skippedCount > 0) {
    progress.checkpoint(`ingested ${processedCount} features (skipped ${skippedCount} malformed)`);
  } else {
    progress.checkpoint(`ingested ${processedCount} features`);
  }

  db.close();
}

async function processDataset(dataset: GeoportalDocument): Promise<void> {
  logger.info(`\n[dataset] ${dataset.name}`);
  const downloadUrl = getDownloadUrl(dataset);
  const db = openDb();
  initDb(db);
  upsertDataset(db, dataset, downloadUrl);
  db.close();

  if (!downloadUrl) {
    logger.info("  [skip] no download URL");
    return;
  }

  const slug = sanitizeName(`${dataset.uuid}_${dataset.name}`) || sanitizeName(dataset.uuid);
  const datasetDownloadDir = join(paths.downloadDir, slug);
  const datasetExtractDir = join(paths.extractDir, slug);
  mkdirSync(datasetDownloadDir, { recursive: true });
  mkdirSync(datasetExtractDir, { recursive: true });

  try {
    const ext = extname(new URL(downloadUrl).pathname) || ".bin";
    const filePath = join(datasetDownloadDir, `source${ext.toLowerCase()}`);

    const sourceExists = existsSync(filePath) && (await stat(filePath)).size > 0;
    let shouldDownload = !sourceExists;
    if (sourceExists) {
      logger.info("[download] Reusing cached file");
      if (ext.toLowerCase() === ".zip") {
        const isValid = await isZipArchiveValid(filePath);
        if (!isValid) {
          logger.warn("[download] Cached ZIP invalid, re-downloading");
          rmSync(filePath, { force: true });
          shouldDownload = true;
        }
      }
    }

    if (shouldDownload) {
      await downloadToFile(downloadUrl, filePath);

      if (ext.toLowerCase() === ".zip") {
        const isValid = await isZipArchiveValid(filePath);
        if (!isValid) {
          throw new Error(`Downloaded file is not a valid zip archive: ${filePath}`);
        }
      }
    }

    const sourceSignature = await getSourceSignature(filePath);

    if (ext.toLowerCase() === ".zip") {
      if (shouldReuseExtraction(datasetExtractDir, sourceSignature)) {
        logger.info("[extract] Reusing extracted files (source unchanged)");
      } else {
        rmSync(datasetExtractDir, { recursive: true, force: true });
        mkdirSync(datasetExtractDir, { recursive: true });
        await extractZip(filePath, datasetExtractDir);
        writeExtractionCache(datasetExtractDir, sourceSignature);
      }
    } else {
      logger.info("[extract] Copying non-zip source file");
      rmSync(datasetExtractDir, { recursive: true, force: true });
      mkdirSync(datasetExtractDir, { recursive: true });
      const target = join(datasetExtractDir, basename(filePath));
      const bytes = await Bun.file(filePath).arrayBuffer();
      await Bun.write(target, new Uint8Array(bytes));
      writeExtractionCache(datasetExtractDir, sourceSignature);
    }

    const indexDb = openDb();
    initDb(indexDb);
    indexDb.prepare("DELETE FROM address_index WHERE dataset_uuid = ?").run(dataset.uuid);
    indexDb.close();

    const sources = await collectSources(datasetExtractDir);
    logger.info(`[import] ${sources.length} geospatial source(s) detected`);
    const sourceProgress = createProgressReporter();
    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[i];
      logger.info(`[import] Source ${i + 1}/${sources.length}`);
      await importSource(dataset, source.path);
      
      // Aggressive cleanup: remove the source file and any of its sidecar files (like .gfs, .shx, .dbf)
      const dir = dirname(source.path);
      if (existsSync(source.path) && statSync(source.path).isDirectory()) {
        rmSync(source.path, { recursive: true, force: true });
      } else {
        const base = basename(source.path, extname(source.path));
        const filesInDir = readdirSync(dir);
        for (const file of filesInDir) {
          if (file === basename(source.path) || (file.startsWith(base + ".") && file !== basename(source.path))) {
            rmSync(join(dir, file), { recursive: true, force: true });
          }
        }
      }
      
      sourceProgress.update(i + 1, sources.length);
    }
    sourceProgress.complete(`imported ${sources.length} source(s)`);
  } finally {
    logger.info("[cleanup] Removing extracted files and downloaded archives to save disk space");
    rmSync(datasetDownloadDir, { recursive: true, force: true });
    rmSync(datasetExtractDir, { recursive: true, force: true });
  }
}

function normalizeUuid(uuid: string): string {
  return uuid.replace(/[{}]/g, "").toLowerCase();
}

function selectDatasetsForRun(docs: GeoportalDocument[]): GeoportalDocument[] {
  const db = openDb();
  initDb(db);

  // Apply allowlist when configured.
  const allowlist = settings.priorityDatasetUuids;
  const filteredDocs = allowlist.length > 0
    ? docs.filter((doc) => allowlist.some((id) => normalizeUuid(id) === normalizeUuid(doc.uuid)))
    : docs;

  const importRows = db.prepare(`
    SELECT dataset_uuid, MAX(imported_at) AS last_imported_at
    FROM imported_layers
    GROUP BY dataset_uuid
  `).all() as Array<{ dataset_uuid: string; last_imported_at: number | null }>;

  const lastImportByDataset = new Map<string, number>();
  for (const row of importRows) {
    if (row.last_imported_at !== null && Number.isFinite(row.last_imported_at)) {
      lastImportByDataset.set(row.dataset_uuid, Number(row.last_imported_at));
    }
  }

  const now = Date.now();
  const refreshThreshold = now - settings.syncIntervalDays * 24 * 60 * 60 * 1000;

  const withMeta: DatasetWithImportMeta[] = filteredDocs.map((doc) => ({
    ...doc,
    _lastImportedAt: lastImportByDataset.get(doc.uuid) ?? null,
  }));

  const due = withMeta
    .filter((doc) => doc._lastImportedAt === null || doc._lastImportedAt < refreshThreshold)
    .sort((a, b) => {
      const av = a._lastImportedAt ?? 0;
      const bv = b._lastImportedAt ?? 0;
      if (av !== bv) {
        return av - bv;
      }
      return a.name.localeCompare(b.name);
    });

  db.close();

  if (settings.maxDatasetsPerRun > 0) {
    return due.slice(0, settings.maxDatasetsPerRun);
  }

  return due;
}

export async function runFullSync(): Promise<{ total: number; processed: number }> {
  const releaseLock = tryAcquireSyncLock();
  if (!releaseLock) {
    logger.info("[sync] another sync process is already running. Skipping this run.");
    return { total: 0, processed: 0 };
  }

  logger.info("[sync] Fetching metadata from geoportal");
  try {
    await ensureDirs();

    const metadataFetchProgress = createProgressReporter("auto", { label: "metadata records" });
    const docs = await fetchOpenDataDocuments(settings.requestLimit, ({ pagesFetched, docsFetched }) => {
      metadataFetchProgress.update(docsFetched);
      if (pagesFetched % 10 === 0) {
        metadataFetchProgress.checkpoint(`fetched ${pagesFetched} metadata page(s)`);
      }
    });
    metadataFetchProgress.complete(`metadata fetched for ${docs.length} dataset(s)`);
    await Bun.write(paths.datasetsFile, JSON.stringify(docs, null, 2));
    await Bun.write(paths.metadataFile, JSON.stringify({ total: docs.length, fetchedAt: Date.now() }, null, 2));

    const metadataDb = openDb();
    initDb(metadataDb);
    const metadataPersistProgress = createProgressReporter("auto", { label: "dataset metadata records" });
    for (let i = 0; i < docs.length; i += 1) {
      const doc = docs[i];
      upsertDataset(metadataDb, doc, getDownloadUrl(doc));
      metadataPersistProgress.update(i + 1, docs.length);
    }
    metadataPersistProgress.complete("metadata persisted to local database");
    metadataDb.close();

    const limitedDocs = selectDatasetsForRun(docs);
    logger.info(`[sync] ${limitedDocs.length} dataset(s) queued for this run`);
    if (limitedDocs.length > 0) {
      const preview = limitedDocs.slice(0, 5).map((d) => d.name).join(" | ");
      logger.info(`[sync] next in queue: ${preview}`);
    }
    if (limitedDocs.length === 0) {
      logger.info("No datasets due for import (all are fresh within refresh interval).");
    }

    let processed = 0;
    const datasetProgress = createProgressReporter();
    for (let i = 0; i < limitedDocs.length; i += 1) {
      const doc = limitedDocs[i];
      try {
        logger.info(`[sync] Dataset ${i + 1}/${limitedDocs.length}: ${doc.name}`);
        await processDataset(doc);
        processed += 1;
      } catch (error) {
        logDatasetFailure(doc, error);
      } finally {
        datasetProgress.update(i + 1, limitedDocs.length);
      }
    }
    datasetProgress.complete(`finished ${limitedDocs.length} dataset attempt(s)`);

    const stateDb = openDb();
    setSyncState(stateDb, "last_full_sync", String(Date.now()));
    setSyncState(stateDb, "last_processed_count", String(processed));
    stateDb.close();

    return { total: docs.length, processed };
  } finally {
    stopProgress();
    releaseLock();
  }
}

export function isRefreshNeeded(): boolean {
  const db = openDb();
  initDb(db);
  const value = getSyncState(db, "last_full_sync");
  db.close();

  if (!value) {
    return true;
  }

  const lastSync = Number(value);
  if (!Number.isFinite(lastSync)) {
    return true;
  }

  const ageMs = Date.now() - lastSync;
  const maxAgeMs = settings.syncIntervalDays * 24 * 60 * 60 * 1000;
  return ageMs > maxAgeMs;
}
