# Memory Index

## developer/
- [communication-style](developer/communication-style.md) — replies in Lithuanian, terse + imperative, no preamble. keywords: lithuanian, lt, tone, concise

## feedback/
- [imports-clear-old-data](feedback/imports-clear-old-data.md) — every re-import must wipe old layer + R-tree rows before insert; latent dup bug fixed in clearSourceData. keywords: import, sync, idempotent, duplicates, rtree

## project/
- [single-dataset-reimport](project/single-dataset-reimport.md) — force one priority dataset re-import: `UPDATE imported_layers SET imported_at=0` + `MAX_DATASETS_PER_RUN=0 bun run sync`. keywords: reimport, sync, priorityDatasetUuids

## reference/
- [sqlite-cli-no-rtree](reference/sqlite-cli-no-rtree.md) — system sqlite3 CLI has no R-tree module; use `bun -e` for `*_rtree` queries. keywords: sqlite, rtree, cli, bun
