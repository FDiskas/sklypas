import { join } from "path";

const rootDir = process.cwd();

export const paths = {
  rootDir,
  dataDir: join(rootDir, "data"),
  dbFile: join(rootDir, "data", "geoportal.db"),
  syncLockFile: join(rootDir, "data", "sync.lock"),
  metadataFile: join(rootDir, "data", "metadata.json"),
  datasetsFile: join(rootDir, "data", "datasets.json"),
  cacheDir: join(rootDir, "data", "cache"),
  downloadDir: join(rootDir, "data", "cache", "downloads"),
  extractDir: join(rootDir, "data", "cache", "extracted"),
};

export const settings = {
  geoportalFindUrl: "https://www.geoportal.lt/metadata-catalog/rest/find/group/read",
  geoportalBaseUrl: "https://www.geoportal.lt",
  requestLimit: 200,
  syncIntervalDays: 30,
  serverPort: Number(Bun.env.PORT ?? 3000),
  maxDatasetsPerRun: Number(Bun.env.MAX_DATASETS_PER_RUN ?? 0),

  // Only these datasets will be downloaded and imported.
  // UUIDs are matched case-insensitively, with or without braces.
  // Set to an empty array to import everything.
  priorityDatasetUuids: [
    "F5AF6623-4B67-4C69-8E44-6BCA70D1B91C", // Kadastrinių žemės sklypų GDB (parcel search)
    "90D0F369-2B71-408C-896A-16DC2473E3F0", // Adresų registro GDB (address search)
    "465D3411-EDDC-47E7-ABA8-32ED7B23822B", // Annex I. Adresai INSPIRE (address search)
    "3BBD0FF5-4B37-4A12-BFB6-6A058F594D29", // Annex III. Pastatai INSPIRE (buildings + polygons)
  ],
};
