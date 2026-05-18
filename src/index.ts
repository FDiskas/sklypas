import { readFileSync } from "fs";
import { join } from "path";
import { settings } from "./config";
import { getAddressById, initDb, openDb, searchAddresses, searchParcelsByCadastre } from "./lib/db";
import { isRefreshNeeded, runFullSync } from "./lib/sync";

const publicDir = join(process.cwd(), "src", "public");
const indexHtml = readFileSync(join(publicDir, "index.html"), "utf8");
const appJs = readFileSync(join(publicDir, "app.js"), "utf8");
const stylesCss = readFileSync(join(publicDir, "styles.css"), "utf8");

let syncInProgress = false;

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.replace(/\s+/g, " ").trim() || "Unknown error";
    if (message.length <= 600) {
      return message;
    }
    return `${message.slice(0, 600)}... [truncated ${message.length - 600} chars]`;
  }

  const text = String(error).replace(/\s+/g, " ").trim();
  if (text.length <= 600) {
    return text;
  }
  return `${text.slice(0, 600)}... [truncated ${text.length - 600} chars]`;
}

async function maybeRefreshInBackground(): Promise<void> {
  if (syncInProgress) {
    return;
  }

  if (!isRefreshNeeded()) {
    return;
  }

  syncInProgress = true;
  console.log("Starting background refresh. This may take a long time.");

  runFullSync()
    .then((result) => {
      console.log(`Background refresh finished. Processed ${result.processed}/${result.total} datasets.`);
    })
    .catch((error) => {
      console.error(`Background refresh failed: ${summarizeError(error)}`);
    })
    .finally(() => {
      syncInProgress = false;
    });
}

async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
  const endpoint = new URL("https://nominatim.openstreetmap.org/search");
  endpoint.searchParams.set("q", address);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("limit", "1");

  const res = await fetch(endpoint, {
    headers: {
      "User-Agent": "geoportal-sqlite-downloader/1.0",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    return null;
  }

  const payload = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (payload.length === 0) {
    return null;
  }

  const first = payload[0];
  return { lat: Number(first.lat), lon: Number(first.lon) };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function getDb() {
  const db = openDb();
  initDb(db);
  return db;
}

setInterval(() => {
  void maybeRefreshInBackground();
}, 6 * 60 * 60 * 1000);

void maybeRefreshInBackground();

Bun.serve({
  port: settings.serverPort,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/app.js") {
      return new Response(appJs, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
    }

    if (url.pathname === "/styles.css") {
      return new Response(stylesCss, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    }

    if (url.pathname === "/api/health") {
      const db = getDb();
      const lastSync = db.prepare("SELECT value, updated_at FROM sync_state WHERE key = 'last_full_sync'").get() as
        | { value: string; updated_at: number }
        | undefined;
      db.close();

      return json({
        ok: true,
        syncInProgress,
        lastSync: lastSync ? Number(lastSync.value) : null,
      });
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      if (syncInProgress) {
        return json({ ok: false, message: "Sync already running" }, 409);
      }

      syncInProgress = true;
      runFullSync()
        .then((result) => {
          console.log(`Manual sync finished: ${result.processed}/${result.total}`);
        })
        .catch((error) => {
          console.error(`Manual sync failed: ${summarizeError(error)}`);
        })
        .finally(() => {
          syncInProgress = false;
        });

      return json({ ok: true, message: "Sync started" }, 202);
    }

    if (url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length < 2) {
        return json({ ok: true, items: [] });
      }

      const db = getDb();
      const items = searchAddresses(db, query, Number(url.searchParams.get("limit") || "20"));
      db.close();

      return json({ ok: true, items });
    }

    if (url.pathname === "/api/parcel-search") {
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length < 2) {
        return json({ ok: true, items: [] });
      }

      const db = getDb();
      const items = searchParcelsByCadastre(db, query, Number(url.searchParams.get("limit") || "20"));
      db.close();

      return json({ ok: true, items });
    }

    if (url.pathname.startsWith("/api/address/")) {
      const id = Number(url.pathname.split("/").pop());
      if (!Number.isFinite(id)) {
        return json({ ok: false, message: "Invalid id" }, 400);
      }

      const db = getDb();
      const row = getAddressById(db, id);
      db.close();

      if (!row) {
        return json({ ok: false, message: "Not found" }, 404);
      }

      let lat = row.latitude;
      let lon = row.longitude;

      if ((!lat || !lon) && row.address_text) {
        const geocoded = await geocodeAddress(row.address_text);
        if (geocoded) {
          lat = geocoded.lat;
          lon = geocoded.lon;
        }
      }

      return json({
        ok: true,
        item: {
          ...row,
          latitude: lat,
          longitude: lon,
          info: JSON.parse(row.info_json),
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Server started: http://localhost:${settings.serverPort}`);
