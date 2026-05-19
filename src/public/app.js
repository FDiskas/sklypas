const searchInput = document.getElementById("search");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const detailsEl = document.getElementById("details");
const detailsTitleEl = document.getElementById("detailsTitle");
const detailsMetaEl = document.getElementById("detailsMeta");
const detailsJsonEl = document.getElementById("detailsJson");

const map = L.map("map").setView([55.1694, 23.8813], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

let marker = null;
let parcelLayer = null;
let searchTimer = null;
let buildingLayers = [];

const lks94Def = "+proj=tmerc +lat_0=0 +lon_0=24 +k=0.9998 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs";
if (window.proj4) {
  window.proj4.defs("EPSG:3346", lks94Def);
}

function clearMapObjects() {
  if (marker) {
    map.removeLayer(marker);
    marker = null;
  }

  if (parcelLayer) {
    map.removeLayer(parcelLayer);
    parcelLayer = null;
  }

  // Clear building layers
  buildingLayers.forEach(layer => {
    map.removeLayer(layer);
  });
  buildingLayers = [];
}

function looksLikeWgs84Pair(coords) {
  if (!Array.isArray(coords) || coords.length < 2) {
    return false;
  }

  const x = Number(coords[0]);
  const y = Number(coords[1]);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90;
}

function convertCoordsToWgs84(coords) {
  if (!Array.isArray(coords)) {
    return coords;
  }

  if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    if (looksLikeWgs84Pair(coords) || !window.proj4) {
      return coords;
    }

    return window.proj4("EPSG:3346", "EPSG:4326", coords);
  }

  return coords.map((part) => convertCoordsToWgs84(part));
}

function normalizeGeometryToWgs84(geometry) {
  if (!geometry || !geometry.type || geometry.coordinates === undefined) {
    return null;
  }

  return {
    type: geometry.type,
    coordinates: convertCoordsToWgs84(geometry.coordinates),
  };
}

function setStatus(text) {
  statusEl.textContent = text;
}

function renderResults(items) {
  resultsEl.innerHTML = "";

  if (!items || items.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No matches";
    empty.style.opacity = "0.65";
    resultsEl.appendChild(empty);
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");
    const isParcel = item.kind === "parcel";
    if (isParcel) {
      const numberText = item.cadastre_number || item.unique_number || "Sklypas";
      li.innerHTML = `<strong>${numberText}</strong><br/><small>${item.dataset_name}</small><span class="result-tag">Sklypas</span>`;
    } else {
      li.innerHTML = `<strong>${item.address_text}</strong><br/><small>${item.dataset_name}</small><span class="result-tag">Adresas</span>`;
    }

    li.addEventListener("click", () => {
      if (isParcel) {
        loadParcel(item);
      } else {
        void loadAddress(item.id);
      }
    });
    resultsEl.appendChild(li);
  }
}

// Helper to render building polygons
function renderBuilding(geometry, gmlId, description, dwellings, color) {
  if (!geometry || !geometry.coordinates) {
    return null;
  }

  try {
    if (geometry.type === "Polygon") {
      const rings = geometry.coordinates;
      if (rings.length > 0 && rings[0].length > 0) {
        const latLngs = rings[0].map(coord => L.latLng(coord[1], coord[0]));
        const layer = L.polygon(latLngs, {
          color: color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.25,
        }).addTo(map);
        layer.bindPopup(`Building: ${description || gmlId}<br/>Dwellings: ${dwellings || "?"}`);
        return layer;
      }
    } else if (geometry.type === "MultiPolygon") {
      const polygons = geometry.coordinates;
      let layers = [];
      for (const rings of polygons) {
        if (rings.length > 0 && rings[0].length > 0) {
          const latLngs = rings[0].map(coord => L.latLng(coord[1], coord[0]));
          const layer = L.polygon(latLngs, {
            color: color,
            weight: 2,
            fillColor: color,
            fillOpacity: 0.25,
          }).addTo(map);
          layer.bindPopup(`Building: ${description || gmlId}<br/>Dwellings: ${dwellings || "?"}`);
          layers.push(layer);
        }
      }
      return layers.length > 0 ? layers : null;
    }
  } catch (e) {
    console.error("[DEBUG] Error rendering building:", e);
  }
  return null;
}

async function loadAddress(id) {
  setStatus("Loading address details...");
  const res = await fetch(`/api/address/${id}`);
  const payload = await res.json();

  if (!payload.ok) {
    setStatus("Address not found");
    return;
  }

  const item = payload.item;
  clearMapObjects();
  detailsEl.classList.remove("hidden");
  detailsTitleEl.textContent = item.address_text;
  const kadNr = item.parcel?.kadastro_nr;
  const metaParts = [`${item.dataset_name} | ${item.source_table}#${item.source_fid}`];
  if (kadNr) metaParts.push(`Kadastro nr.: ${kadNr}`);
  detailsMetaEl.textContent = metaParts.join(" — ");
  detailsJsonEl.textContent = JSON.stringify(item.info, null, 2);

  const geometry = item.info && item.info._geometry;
  if (geometry) {
    if (geometry.type === "Point") {
      let parcelBounds = null;
      if (item.parcel && item.parcel.geometry_json) {
        try {
          const parcelGeom = JSON.parse(item.parcel.geometry_json);
          const normalizedParcel = normalizeGeometryToWgs84(parcelGeom);
          if (normalizedParcel) {
            parcelLayer = L.geoJSON(normalizedParcel, {
              style: { color: "#1d4e6b", weight: 2, fillColor: "#3a7ca5", fillOpacity: 0.18 },
            }).addTo(map);
            parcelLayer.bindPopup(`Sklypas: ${item.parcel.kadastro_nr || item.parcel.unikalus_nr || ""}`);
            const b = parcelLayer.getBounds();
            if (b.isValid()) parcelBounds = b;
          }
        } catch (e) {
          console.error("Error rendering parcel:", e);
        }
      }

      if (item.buildings && Array.isArray(item.buildings)) {
        for (const building of item.buildings) {
          if (!building.geometry_json) continue;
          try {
            const buildingGeom = JSON.parse(building.geometry_json);
            const normalizedBuilding = normalizeGeometryToWgs84(buildingGeom);
            if (normalizedBuilding) {
              const layers = renderBuilding(normalizedBuilding, building.gml_id, building.description, building.numberOfDwellings, "#5cb85c");
              if (layers) {
                if (Array.isArray(layers)) buildingLayers.push(...layers);
                else buildingLayers.push(layers);
              }
            }
          } catch (e) {
            console.error("Error rendering building:", e);
          }
        }
      }

      marker = L.marker([item.latitude, item.longitude]).addTo(map);
      marker.bindPopup(item.address_text).openPopup();

      if (parcelBounds) {
        map.fitBounds(parcelBounds.pad(0.2));
      } else {
        map.setView([item.latitude, item.longitude], 18);
      }

      const buildingCount = item.buildings?.length || 0;
      const parcelNote = item.parcel ? ", su sklypu" : "";
      setStatus(`Address loaded${buildingCount > 0 ? ` with ${buildingCount} buildings` : ""}${parcelNote}`);
      return;
    }

    // For Polygon geometries (parcels)
    const normalized = normalizeGeometryToWgs84(geometry);
    if (normalized) {
      console.log("[DEBUG] Rendering Polygon geometry");
      parcelLayer = L.geoJSON(normalized, {
        style: {
          color: "#1d4e6b",
          weight: 2,
          fillColor: "#3a7ca5",
          fillOpacity: 0.18,
        },
      }).addTo(map);

      const bounds = parcelLayer.getBounds();

      if (item.buildings && Array.isArray(item.buildings) && item.buildings.length > 0) {
        console.log("[DEBUG] Found", item.buildings.length, "buildings for Polygon");
        for (const building of item.buildings) {
          if (building.geometry_json) {
            try {
              const buildingGeom = JSON.parse(building.geometry_json);
              const normalizedBuilding = normalizeGeometryToWgs84(buildingGeom);
              if (normalizedBuilding) {
                let centerLat = 0, centerLon = 0, pointCount = 0;
                const collectPoints = (coords) => {
                  if (Array.isArray(coords[0])) {
                    if (typeof coords[0][0] === "number") {
                      centerLon += coords[0];
                      centerLat += coords[1];
                      pointCount++;
                    } else {
                      coords.forEach(collectPoints);
                    }
                  }
                };
                collectPoints(normalizedBuilding.coordinates);
                const buildingCenter = pointCount > 0 
                  ? L.latLng(centerLat / pointCount, centerLon / pointCount)
                  : L.latLng(
                      normalizedBuilding.coordinates?.[0]?.[0]?.[1] || 0,
                      normalizedBuilding.coordinates?.[0]?.[0]?.[0] || 0
                    );
                
                const isOutsideParcel = bounds.isValid() && !bounds.contains(buildingCenter);
                const color = isOutsideParcel ? "#d9534f" : "#5cb85c";
                console.log("[DEBUG] Building outside:", isOutsideParcel, "color:", color);
                
                const layers = renderBuilding(normalizedBuilding, building.gml_id, building.description, building.numberOfDwellings, color);
                if (layers) {
                  if (Array.isArray(layers)) {
                    buildingLayers.push(...layers);
                  } else {
                    buildingLayers.push(layers);
                  }
                }
              }
            } catch (e) {
              console.error("[DEBUG] Error rendering building:", e);
            }
          }
        }
      }

      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.2));
        const buildingCount = item.buildings?.length || 0;
        setStatus(`Address loaded${buildingCount > 0 ? ` with ${buildingCount} buildings` : ""}`);
        return;
      }
    }
  }

  if (item.latitude && item.longitude) {
    marker = L.marker([item.latitude, item.longitude]).addTo(map);
    marker.bindPopup(item.address_text).openPopup();
    map.setView([item.latitude, item.longitude], map.getMaxZoom());
    setStatus("Address loaded");
  } else {
    setStatus("Address loaded, but no coordinates were available");
  }
}

function loadParcel(item) {
  setStatus("Loading parcel geometry...");
  clearMapObjects();

  const title = item.cadastre_number || item.unique_number || `Sklypas ${item.source_fid}`;
  detailsEl.classList.remove("hidden");
  detailsTitleEl.textContent = title;
  detailsMetaEl.textContent = `${item.dataset_name} | ${item.source_table}#${item.source_fid}`;
  detailsJsonEl.textContent = JSON.stringify(
    {
      cadastre_number: item.cadastre_number,
      unique_number: item.unique_number,
    },
    null,
    2
  );

  if (!item.geometry_json) {
    setStatus("Sklypas rastas, bet geometrija nepasiekiama");
    return;
  }

  let geometry;
  try {
    geometry = JSON.parse(item.geometry_json);
  } catch {
    setStatus("Sklypas rastas, bet geometrijos nepavyko perskaityti");
    return;
  }

  const normalized = normalizeGeometryToWgs84(geometry);
  if (!normalized) {
    setStatus("Sklypas rastas, bet geometrija netinkama");
    return;
  }

  parcelLayer = L.geoJSON(normalized, {
    style: {
      color: "#216869",
      weight: 2,
      fillColor: "#49a078",
      fillOpacity: 0.18,
    },
  }).addTo(map);

  const bounds = parcelLayer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.2));
    setStatus("Sklypo forma parodyta žemėlapyje");
  } else {
    setStatus("Sklypas rastas, bet nepavyko apskaičiuoti ribų");
  }
}

async function searchAddresses(query) {
  if (!query || query.trim().length < 2) {
    renderResults([]);
    return;
  }

  setStatus("Searching...");
  const [addressRes, parcelRes] = await Promise.all([
    fetch(`/api/search?q=${encodeURIComponent(query)}`),
    fetch(`/api/parcel-search?q=${encodeURIComponent(query)}`),
  ]);

  const addressPayload = await addressRes.json();
  const parcelPayload = await parcelRes.json();

  const addressItems = (addressPayload.items || []).map((item) => ({ ...item, kind: "address" }));
  const parcelItems = (parcelPayload.items || []).map((item) => ({ ...item, kind: "parcel" }));
  const allItems = [...parcelItems, ...addressItems];

  renderResults(allItems);
  setStatus(`Found ${allItems.length} items`);
}

searchInput.addEventListener("input", (event) => {
  const value = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void searchAddresses(value);
  }, 250);
});

setStatus("Ready");
