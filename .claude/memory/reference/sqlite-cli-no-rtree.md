---
name: sqlite-cli-no-rtree
description: System sqlite3 CLI lacks R-tree module — use Bun for any query touching building_rtree / parcels_rtree
keywords: [sqlite, rtree, cli, bun, virtual table, no such module]
created: 2026-05-31
updated: 2026-05-31
---

**Fact:** The macOS system `sqlite3` binary is built without R-tree support. Any query against `building_rtree` or `parcels_rtree` fails with `Error: in prepare, no such module: rtree`. Bun's bundled SQLite (`bun:sqlite`) has it enabled.

**How to apply:** For R-tree counts / inspections, use a one-liner:

```sh
bun -e "import { Database } from 'bun:sqlite'; const db = new Database('data/geoportal.db'); console.log(db.prepare('SELECT COUNT(*) AS c FROM building_rtree').get()); db.close();"
```

Plain layer tables (`layer_..._building`, `address_index`, etc.) work fine in the CLI — only the R-tree virtual tables are off-limits.
