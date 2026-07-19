import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addLog, getSnapshot, subscribe } from "../store";
import { deleteWaypoint, sendWaypoint } from "../radio";
import { ago, asciiBattery } from "../fmt";

interface Draft {
  id?: number; // definido = edición
  lat: number;
  lon: number;
  name: string;
  desc: string;
  icon: string; // un emoji
  expireH: number; // horas · 0 = no caduca
}

export default function MapView({
  onOpenNode,
}: {
  onOpenNode: (num: number) => void;
}) {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  const loggedRef = useRef(-1);
  const [draft, setDraft] = useState<Draft>();
  const [wpMsg, setWpMsg] = useState("");

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { zoomControl: true }).setView(
      [40.4, -3.7],
      5,
    );
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on("contextmenu", (e: L.LeafletMouseEvent) => {
      setWpMsg("");
      setDraft({
        lat: e.latlng.lat,
        lon: e.latlng.lng,
        name: "",
        desc: "",
        icon: "📍",
        expireH: 0,
      });
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();

    const positioned = [...s.nodes.values()].filter(
      (n) =>
        n.lat !== undefined &&
        n.lon !== undefined &&
        // GPS basura: posiciones pegadas a (0,0)
        (Math.abs(n.lat) > 0.1 || Math.abs(n.lon) > 0.1),
    );

    // El firmware reduce la precisión de la posición → MUCHOS nodos comparten
    // coordenada exacta y se pintarían uno encima de otro. Un marcador por
    // coordenada, con contador y popup listando todos los nodos del punto.
    const byCoord = new Map<string, typeof positioned>();
    for (const n of positioned) {
      const key = `${n.lat},${n.lon}`;
      const arr = byCoord.get(key) ?? [];
      arr.push(n);
      byCoord.set(key, arr);
    }

    const nodeRows = (n: (typeof positioned)[number]) =>
      `<div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0 2px;">` +
      `<span style="font-size:10px;letter-spacing:2px;opacity:.6;">NODO // ${n.shortName}</span>` +
      `<button data-num="${n.num}" style="font-size:10px;padding:0 6px;">[ +INFO ]</button>` +
      `</div>` +
      `<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;">` +
      `<span style="opacity:.6;">ID</span><span>!${n.num.toString(16)}</span>` +
      `<span style="opacity:.6;">SNR</span><span>${n.snr !== undefined ? `${n.snr.toFixed(2)} dB` : "—"}</span>` +
      `<span style="opacity:.6;">BAT</span><span>${asciiBattery(n.batteryLevel)}</span>` +
      `<span style="opacity:.6;">VISTO</span><span>hace ${ago(n.lastHeard)}</span>` +
      `</div>`;

    for (const group of byCoord.values()) {
      const hasMe = group.some((n) => n.num === s.myNodeNum);
      const color = hasMe ? "#00e5ff" : "#39ff5a";
      const lat = group[0].lat as number;
      const lon = group[0].lon as number;
      const label =
        group.length > 1
          ? `${group[0].shortName} +${group.length - 1}`
          : group[0].shortName;
      // Popup en DOM (no string) para poder colgar el onclick de [+INFO]
      const box = document.createElement("div");
      box.innerHTML =
        `<div style="font-size:10px;letter-spacing:2px;opacity:.6;">POS ${lat.toFixed(4)}N ${lon.toFixed(4)}E · ${group.length} NODO${group.length > 1 ? "S" : ""}</div>` +
        group.map(nodeRows).join("");
      for (const btn of box.querySelectorAll<HTMLButtonElement>("button[data-num]")) {
        btn.onclick = () => onOpenNode(Number(btn.dataset.num));
      }
      L.circleMarker([lat, lon], {
        radius: group.length > 1 ? 8 : 6,
        color,
        fillColor: color,
        fillOpacity: 0.85,
        weight: group.length > 1 ? 2 : 1,
      })
        .bindPopup(box, { maxHeight: 260 })
        .bindTooltip(label, { permanent: false, direction: "right" })
        .addTo(layer);
    }

    // Waypoints: chincheta con emoji. Popup en DOM (no HTML) para colgar los
    // botones de editar/borrar directamente.
    for (const w of s.waypoints.values()) {
      const emoji = w.icon ? String.fromCodePoint(w.icon) : "📍";
      const box = document.createElement("div");
      box.innerHTML =
        `<div style="font-size:10px;letter-spacing:2px;opacity:.6;">WAYPOINT · ${w.lat.toFixed(4)}N ${w.lon.toFixed(4)}E</div>` +
        `<div style="font-weight:700;margin:4px 0;">${emoji} ${w.name || "(sin nombre)"}</div>` +
        (w.description ? `<div style="margin-bottom:4px;">${w.description}</div>` : "") +
        `<div style="opacity:.6;font-size:11px;">de ${getSnapshot().nodes.get(w.from)?.shortName ?? w.from.toString(16)}` +
        (w.expire
          ? ` · caduca ${new Date(w.expire * 1000).toLocaleString()}`
          : " · sin caducidad") +
        `</div>`;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;margin-top:8px;";
      const edit = document.createElement("button");
      edit.textContent = "[ EDITAR ]";
      edit.onclick = () => {
        map.closePopup();
        setWpMsg("");
        setDraft({
          id: w.id,
          lat: w.lat,
          lon: w.lon,
          name: w.name,
          desc: w.description,
          icon: emoji,
          expireH: 0,
        });
      };
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "[ BORRAR ]";
      del.onclick = () => {
        map.closePopup();
        deleteWaypoint(w.id).catch((e: unknown) => setWpMsg(`ERROR: ${e}`));
      };
      row.append(edit, del);
      box.append(row);
      L.marker([w.lat, w.lon], {
        icon: L.divIcon({
          className: "",
          html: `<div style="font-size:22px;line-height:22px;text-shadow:0 0 4px #000;">${emoji}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 22],
        }),
      })
        .bindPopup(box)
        .bindTooltip(w.name || "waypoint", { direction: "top" })
        .addTo(layer);
    }

    if (!fittedRef.current && positioned.length > 0) {
      map.fitBounds(
        L.latLngBounds(
          positioned.map((n) => [n.lat as number, n.lon as number]),
        ).pad(0.3),
      );
      fittedRef.current = true;
    }

    // Diagnóstico: qué pinta el mapa (solo cuando cambia el nº)
    if (positioned.length !== loggedRef.current) {
      loggedRef.current = positioned.length;
      addLog(
        `MAPA: ${positioned.length} nodos en ${byCoord.size} puntos (coords compartidas por precisión reducida)`,
      );
    }
  }, [s]);

  const all = [...s.nodes.values()];
  const withFix = all.filter(
    (n) =>
      n.lat !== undefined &&
      n.lon !== undefined &&
      (Math.abs(n.lat) > 0.1 || Math.abs(n.lon) > 0.1),
  ).length;
  const junk = all.filter(
    (n) =>
      n.lat !== undefined &&
      n.lon !== undefined &&
      Math.abs(n.lat) <= 0.1 &&
      Math.abs(n.lon) <= 0.1,
  ).length;

  return (
    <main>
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-title">
          <span>
            PANEL // MAPA TÁCTICO · {s.nodes.size} NODOS · {withFix} CON FIX
            {junk > 0 && ` · ${junk} DESCARTADOS (0,0)`}
            {s.waypoints.size > 0 && ` · ${s.waypoints.size} WAYPOINTS`}
          </span>
          <span>CAPA: OSCURA</span>
        </div>
        <div className="map-wrap">
          <div ref={divRef} style={{ height: "100%" }} />
          <div className="map-hud" style={{ right: 10, top: 8 }}>
            TILES © OSM
          </div>
          <div className="map-hud" style={{ left: 10, bottom: 10 }}>
            {wpMsg || "CLIC DERECHO = NUEVO WAYPOINT"}
          </div>
          {draft && (
            <div
              className="panel"
              style={{
                position: "absolute",
                zIndex: 1000,
                right: 10,
                top: 34,
                width: 260,
                fontSize: 12,
              }}
            >
              <div className="panel-title">
                {draft.id ? "EDITAR WAYPOINT" : "NUEVO WAYPOINT"}
              </div>
              <div
                style={{
                  padding: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <span className="dim">
                  {draft.lat.toFixed(5)}N {draft.lon.toFixed(5)}E
                </span>
                <input
                  placeholder="nombre"
                  maxLength={30}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <input
                  placeholder="descripción"
                  maxLength={100}
                  value={draft.desc}
                  onChange={(e) => setDraft({ ...draft, desc: e.target.value })}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    style={{ width: 50, textAlign: "center" }}
                    value={draft.icon}
                    onChange={(e) =>
                      setDraft({ ...draft, icon: [...e.target.value].pop() ?? "" })
                    }
                  />
                  <input
                    type="number"
                    min={0}
                    style={{ width: 70 }}
                    value={draft.expireH}
                    onChange={(e) =>
                      setDraft({ ...draft, expireH: Number(e.target.value) })
                    }
                  />
                  <span className="dim">h (0 = nunca)</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="primary"
                    onClick={async () => {
                      try {
                        await sendWaypoint({
                          id: draft.id,
                          lat: draft.lat,
                          lon: draft.lon,
                          name: draft.name,
                          description: draft.desc,
                          icon: draft.icon.codePointAt(0) ?? 0,
                          expire: draft.expireH
                            ? Math.floor(Date.now() / 1000) +
                              draft.expireH * 3600
                            : 0,
                          lockedTo: 0,
                        });
                        setWpMsg("WAYPOINT EMITIDO ✓");
                        setDraft(undefined);
                      } catch (e) {
                        setWpMsg(`ERROR: ${e}`);
                      }
                    }}
                  >
                    [ EMITIR ]
                  </button>
                  <button onClick={() => setDraft(undefined)}>[ CANCELAR ]</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
