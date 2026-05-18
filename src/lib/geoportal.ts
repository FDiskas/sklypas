import { settings } from "../config";

export type GeoportalAction = {
  tag: string;
  url?: string;
};

export type GeoportalDocument = {
  uuid: string;
  name: string;
  author?: string | null;
  description?: string | null;
  frequency?: string | null;
  openData?: boolean;
  date_modified?: number;
  date_modified_human?: string;
  actions?: GeoportalAction[];
  [key: string]: unknown;
};

type GroupResponse = {
  success: boolean;
  total: number;
  records: Array<{
    name: string;
    documents?: GeoportalDocument[];
  }>;
};

export type GeoportalFetchProgress = {
  pagesFetched: number;
  docsFetched: number;
  total: number | null;
};

function getPayload(start: number, limit: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set("criterias", JSON.stringify({ open_data: ["true"] }));
  params.set("lang", "lt");
  params.set("page", String(Math.floor(start / limit) + 1));
  params.set("start", String(start));
  params.set("limit", String(limit));
  return params;
}

export async function fetchOpenDataDocuments(
  limit = settings.requestLimit,
  onProgress?: (progress: GeoportalFetchProgress) => void
): Promise<GeoportalDocument[]> {
  const allDocs: GeoportalDocument[] = [];
  let start = 0;
  let pagesFetched = 0;

  while (true) {
    const url = `${settings.geoportalFindUrl}?_dc=${Date.now()}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: getPayload(start, limit),
    });

    if (!response.ok) {
      throw new Error(`Geoportal request failed: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as GroupResponse;
    const docs = json.records.flatMap((group) => group.documents ?? []);
    allDocs.push(...docs);
    pagesFetched += 1;
    const total = Number.isFinite(json.total) && json.total > 0 ? json.total : null;
    onProgress?.({ pagesFetched, docsFetched: allDocs.length, total });

    if (docs.length < limit) {
      break;
    }

    start += limit;
  }

  const byUuid = new Map<string, GeoportalDocument>();
  for (const doc of allDocs) {
    byUuid.set(doc.uuid, doc);
  }

  onProgress?.({ pagesFetched, docsFetched: byUuid.size, total: byUuid.size });

  return Array.from(byUuid.values());
}

export function getDownloadUrl(doc: GeoportalDocument): string | null {
  const actions = doc.actions ?? [];
  const preferred = actions.find((action) => action.tag === "download" || action.tag === "open");
  if (!preferred?.url) {
    return null;
  }

  if (preferred.url.startsWith("http://") || preferred.url.startsWith("https://")) {
    return preferred.url;
  }

  return `${settings.geoportalBaseUrl}${preferred.url}`;
}
