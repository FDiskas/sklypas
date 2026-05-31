---
name: single-dataset-reimport
description: How to force a targeted re-import of one priority dataset without touching the others
keywords: [reimport, sync, MAX_DATASETS_PER_RUN, imported_layers, priorityDatasetUuids, testing]
created: 2026-05-31
updated: 2026-05-31
---

**Recipe:** Mark a dataset's `imported_layers` row as overdue, then run sync with no per-run cap.

```sh
sqlite3 data/geoportal.db "UPDATE imported_layers SET imported_at = 0 WHERE dataset_uuid='{UUID-IN-BRACES-UPPERCASE}';"
MAX_DATASETS_PER_RUN=0 bun run sync
```

**Why this works:**
- `selectDatasetsForRun` (in [src/lib/sync.ts](src/lib/sync.ts)) compares each dataset's max `imported_at` from `imported_layers` against `now - syncIntervalDays`. `imported_at = 0` makes the row look ancient → "due".
- The `priorityDatasetUuids` allowlist in [src/config.ts](src/config.ts) already restricts sync to the 4 priority datasets; setting only one row overdue means only that one runs.
- `MAX_DATASETS_PER_RUN=0` means "no cap" (the code path is `if (settings.maxDatasetsPerRun > 0) slice(...)`), not "import zero" — counter-intuitive but correct.

**Gotchas:**
- Buildings ZIP is ~417 MB; full re-import takes ~30–60 min (download + extract + 3.1M parses/inserts).
- Dataset UUIDs in `imported_layers` and `priorityDatasetUuids` are stored with **braces + UPPERCASE**: `{3BBD0FF5-4B37-4A12-BFB6-6A058F594D29}`.
- After the re-import, verify counts match: `building_rtree` row count must equal `layer_..._building` row count (use Bun, not the system `sqlite3` CLI — see [[sqlite-cli-no-rtree]]).
