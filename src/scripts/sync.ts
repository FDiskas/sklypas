import { runFullSync } from "../lib/sync";

const result = await runFullSync();
console.log(`Sync done. Processed ${result.processed}/${result.total} datasets.`);
