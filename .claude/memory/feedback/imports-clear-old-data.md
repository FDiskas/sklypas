---
name: imports-clear-old-data
description: Re-imports must always wipe old layer rows + spatial-index entries before inserting; never tolerate duplicates
keywords: [import, sync, clearSourceData, duplicates, idempotent, rtree, reimport]
created: 2026-05-31
updated: 2026-05-31
---

**Rule:** Every import path must be idempotent — old rows for the same `(dataset_uuid, source_path)` must be cleared before the new batch is inserted, including any derived data (R-tree spatial indexes, FTS5, `address_index`).

**Why:** Found a latent bug in `clearSourceData` where `DELETE FROM imported_layers` ran *before* the per-layer `SELECT … FROM imported_layers`, causing the cleanup loop to no-op and a re-import to double the data (3.1M → 6.3M building rows). User explicitly stated: "importuojant seni duomenys turetu buti istrinti arba geriau tiesiog atnaujinti visais importo atvejais."

**How to apply:**
- In any cleanup helper: capture the layer-table list *before* deleting `imported_layers` rows.
- Keep `insertIntoLayerTable` paired with `indexGeometryRow` so derived indexes track inserts automatically.
- New geometry-bearing layers: add entry to `SPATIAL_INDEX_BY_TABLE` in [src/lib/db.ts](src/lib/db.ts) — the rest (insert hook, clear hook, query) wires through that map.
- Upsert-by-natural-key is *not* required — per-row natural keys are inconsistent across sources; transactional delete-then-insert is fine for this data volume.

Related: [[single-dataset-reimport]] explains how to trigger a targeted re-import for testing.
