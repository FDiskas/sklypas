import { mkdirSync } from "fs";
import { paths } from "../config";
import { fetchOpenDataDocuments, getDownloadUrl } from "../lib/geoportal";

async function fetchMetadata() {
  mkdirSync(paths.dataDir, { recursive: true });

  const docs = await fetchOpenDataDocuments();
  await Bun.write(paths.datasetsFile, JSON.stringify(docs, null, 2));

  const formats = new Set<string>();
  const withDownload: Array<{ name: string; url: string }> = [];

  for (const doc of docs) {
    const url = getDownloadUrl(doc);
    if (!url) {
      continue;
    }

    withDownload.push({ name: doc.name, url });
    const ext = url.toLowerCase().split(".").pop() ?? "unknown";
    formats.add(ext);
  }

  await Bun.write(
    paths.metadataFile,
    JSON.stringify(
      {
        fetchedAt: Date.now(),
        total: docs.length,
        withDownload: withDownload.length,
        extensions: Array.from(formats).sort(),
      },
      null,
      2
    )
  );

  console.log(`Fetched ${docs.length} open datasets.`);
  console.log(`Datasets with download URLs: ${withDownload.length}`);
  console.log(`Detected file extensions: ${Array.from(formats).sort().join(", ")}`);
}

fetchMetadata().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
