import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getSnapshot,
  subscribe,
  type NodeEntry,
  type Traceroute,
} from "../store";
import {
  deleteNode,
  remoteReboot,
  remoteShutdown,
  requestNodePosition,
  runTraceroute,
  toggleFav,
  toggleIgnored,
} from "../radio";
import { ago, asciiBattery, hwName, snrClass } from "../fmt";
import { loadTraceroutes } from "../db";

type SortKey = "visto" | "nombre" | "corto" | "saltos" | "snr" | "bateria" | "pos";

// dirección por defecto la primera vez que se pulsa cada columna
const DEFAULT_DIR: Record<SortKey, 1 | -1> = {
  visto: -1,
  nombre: 1,
  corto: 1,
  saltos: 1,
  snr: -1,
  bateria: -1,
  pos: 1,
};

function distKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  // ponytail: equirectangular, sobra para ordenar dentro de una malla
  return Math.sqrt(x * x + y * y) * 6371;
}

// undefined siempre al final
function cmpOpt(a: number | undefined, b: number | undefined, dir: 1 | -1) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return (a - b) * dir;
}

function sortNodes(nodes: NodeEntry[], key: SortKey, dir: 1 | -1, me?: NodeEntry) {
  const base = sortNodesBy(nodes, key, dir, me);
  // favoritos siempre arriba, respetando el orden elegido dentro de cada grupo
  return base.sort((a, b) => Number(!!b.fav) - Number(!!a.fav));
}

function sortNodesBy(nodes: NodeEntry[], key: SortKey, dir: 1 | -1, me?: NodeEntry) {
  const s = [...nodes];
  switch (key) {
    case "nombre":
      return s.sort((a, b) => (a.longName ?? "").localeCompare(b.longName ?? "") * dir);
    case "corto":
      return s.sort((a, b) => (a.shortName ?? "").localeCompare(b.shortName ?? "") * dir);
    case "saltos":
      return s.sort((a, b) => cmpOpt(a.hopsAway, b.hopsAway, dir));
    case "snr":
      return s.sort((a, b) => cmpOpt(a.snr, b.snr, dir));
    case "bateria":
      return s.sort((a, b) => cmpOpt(a.batteryLevel, b.batteryLevel, dir));
    case "pos": {
      const d = (n: NodeEntry) =>
        n.lat !== undefined && n.lon !== undefined && me?.lat !== undefined && me?.lon !== undefined
          ? distKm(me.lat, me.lon, n.lat, n.lon)
          : undefined;
      return s.sort(
        (a, b) =>
          cmpOpt(d(a), d(b), dir) ||
          Number(b.lat !== undefined) - Number(a.lat !== undefined) ||
          b.lastHeard - a.lastHeard,
      );
    }
    default:
      return s.sort((a, b) => (a.lastHeard - b.lastHeard) * dir);
  }
}

function Th(props: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
}) {
  const active = props.sort.key === props.k;
  return (
    <th
      onClick={() => props.onSort(props.k)}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
    >
      {props.label}{" "}
      <span style={{ fontSize: 9, letterSpacing: 0 }}>
        <span style={{ opacity: active && props.sort.dir === 1 ? 1 : 0.3 }}>▲</span>
        <span style={{ opacity: active && props.sort.dir === -1 ? 1 : 0.3 }}>▼</span>
      </span>
    </th>
  );
}

function RouteLine(props: {
  label: string;
  hops: number[]; // nodos intermedios
  snrs: number[]; // dB ×4, un valor por segmento (nodo receptor)
  from: string;
  to: string;
  short: (num: number) => string;
}) {
  // secuencia completa de nodos y flechas con la SNR de cada segmento
  const nodes = [props.from, ...props.hops.map(props.short), props.to];
  const arrow = (snr: number | undefined) =>
    snr !== undefined ? ` ─(${(snr / 4).toFixed(1)} dB)→ ` : " → ";
  return (
    <div style={{ fontSize: 11, lineHeight: 1.6 }}>
      <span className="dim">{props.label}: </span>
      {nodes.map((name, i) => (i === 0 ? name : arrow(props.snrs[i - 1]) + name)).join("")}
    </div>
  );
}

function Detail(props: {
  node: NodeEntry;
  isMe: boolean;
  trace?: Traceroute;
  posTs?: number; // ts del último PositionPacket recibido de este nodo
  short: (num: number) => string;
  onOpenDm: (num: number) => void;
  onClose: () => void;
}) {
  const { node: n } = props;
  const [tracing, setTracing] = useState(false);
  const [traceErr, setTraceErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // "" | "waiting" | "ok" | "timeout" | mensaje de error
  const [posState, setPosState] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  // "" | "reboot" | "shutdown" — confirmación de acción admin remota
  const [adminArm, setAdminArm] = useState("");
  const [adminMsg, setAdminMsg] = useState("");
  const posTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const posBase = useRef<number | undefined>(undefined);
  const [history, setHistory] = useState<Traceroute[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTraceroutes(n.num).then((h) => {
      if (!cancelled) setHistory(h);
    });
    return () => {
      cancelled = true;
    };
  }, [n.num, props.trace]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(posTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (props.trace) {
      setTracing(false);
      clearTimeout(timer.current);
    }
  }, [props.trace]);
  useEffect(() => {
    if (posState === "waiting" && props.posTs !== posBase.current) {
      setPosState("ok");
      clearTimeout(posTimer.current);
    }
  }, [props.posTs, posState]);
  useEffect(() => {
    setTracing(false);
    setTraceErr("");
    setPosState("");
    setConfirmDel(false);
    setAdminArm("");
    setAdminMsg("");
    setShowHistory(false);
    clearTimeout(timer.current);
    clearTimeout(posTimer.current);
  }, [n.num]);

  const onAdmin = (kind: "reboot" | "shutdown") => {
    if (adminArm !== kind) {
      setAdminArm(kind);
      setAdminMsg("");
      setTimeout(() => setAdminArm((c) => (c === kind ? "" : c)), 3000);
      return;
    }
    setAdminArm("");
    const fn = kind === "reboot" ? remoteReboot : remoteShutdown;
    fn(n.num)
      .then(() => setAdminMsg(`${kind === "reboot" ? "Reboot" : "Shutdown"} enviado ✓ (requiere permiso admin en el nodo remoto)`))
      .catch((e) => setAdminMsg(`ERROR: ${e}`));
  };

  const onAskPos = () => {
    clearTimeout(posTimer.current);
    posBase.current = props.posTs;
    try {
      requestNodePosition(n.num);
    } catch (e) {
      setPosState(String(e));
      return;
    }
    setPosState("waiting");
    posTimer.current = setTimeout(() => {
      setPosState((cur) => (cur === "waiting" ? "timeout" : cur));
    }, 60_000);
  };

  const onTrace = async () => {
    setTraceErr("");
    setTracing(true);
    clearTimeout(timer.current);
    // la respuesta llega por evento; esperamos hasta 60 s pase lo que pase con el ack
    timer.current = setTimeout(() => {
      setTracing(false);
      setTraceErr("SIN RESPUESTA (60 s)");
    }, 60_000);
    try {
      await runTraceroute(n.num);
    } catch (e) {
      setTracing(false);
      setTraceErr(e instanceof Error ? e.message : "ERROR");
      clearTimeout(timer.current);
    }
  };

  const rows: [string, React.ReactNode][] = [
    ["ID", `!${n.num.toString(16)}`],
    ["HARDWARE", hwName(n.hwModel)],
    [
      "SNR",
      <span className={snrClass(n.snr)}>
        {n.snr !== undefined ? `${n.snr.toFixed(2)} dB` : "—"}
      </span>,
    ],
    ["BATERÍA", asciiBattery(n.batteryLevel)],
    ["VOLTAJE", n.voltage !== undefined ? `${n.voltage.toFixed(2)} V` : "—"],
    ["SALTOS", n.hopsAway !== undefined ? String(n.hopsAway) : "—"],
    ["VÍA MQTT", n.viaMqtt ? "SÍ" : "NO"],
    ["CIFRADO DM", n.hasKey ? "PKI 🔒" : "sólo PSK del canal"],
    [
      "POSICIÓN",
      n.lat !== undefined && n.lon !== undefined
        ? `${n.lat.toFixed(4)}N ${n.lon.toFixed(4)}E`
        : "SIN GPS FIX",
    ],
    ["VISTO HACE", ago(n.lastHeard)],
  ];
  return (
    <div className="panel hot" style={{ width: 300, flexShrink: 0 }}>
      <div className="panel-title">
        <span>DETALLE // NODO {n.shortName}</span>
        <button
          onClick={props.onClose}
          style={{ width: 22, height: 22, padding: 0, fontSize: 12, lineHeight: 1 }}
        >
          ✕
        </button>
      </div>
      <div
        style={{
          padding: "12px 12px 4px",
          fontSize: 16,
          fontWeight: 700,
          textShadow: "0 0 8px var(--glow)",
        }}
      >
        {n.longName}
        {props.isMe && " · (YO)"}
      </div>
      <div className="dim" style={{ padding: "2px 12px 12px", fontSize: 11 }}>
        ÚLTIMO PAQUETE HACE {ago(n.lastHeard)}
      </div>
      <div className="kv" style={{ borderTop: "1px solid var(--border)" }}>
        {rows.map(([k, v]) => (
          <span key={k} style={{ display: "contents" }}>
            <span className="k">{k}</span>
            <span>{v}</span>
          </span>
        ))}
      </div>
      {(props.trace || tracing || traceErr || history.length > 0) && (
        <div
          style={{
            padding: "10px 12px",
            borderTop: "1px solid var(--border)",
            wordBreak: "break-word",
          }}
        >
          <div className="dim" style={{ fontSize: 10, letterSpacing: 2, marginBottom: 4 }}>
            TRACEROUTE
          </div>
          {tracing && <span className="warn" style={{ fontSize: 11 }}>EN CURSO_</span>}
          {traceErr && <span className="err" style={{ fontSize: 11 }}>{traceErr}</span>}
          {props.trace && (
            <>
              <RouteLine
                label="IDA"
                hops={props.trace.route}
                snrs={props.trace.snrTowards}
                from="YO"
                to={n.shortName}
                short={props.short}
              />
              <RouteLine
                label="VUELTA"
                hops={props.trace.routeBack}
                snrs={props.trace.snrBack}
                from={n.shortName}
                to="YO"
                short={props.short}
              />
            </>
          )}
          {history.length > 0 && (
            <>
              <button
                style={{ fontSize: 10, padding: "2px 6px", marginTop: 8 }}
                onClick={() => setShowHistory((v) => !v)}
              >
                {showHistory ? "▼" : "▶"} HISTORIAL ({history.length})
              </button>
              {showHistory && (
                <div style={{ maxHeight: 160, overflowY: "auto", marginTop: 6 }}>
                  {history.map((h) => (
                    <div key={h.ts} style={{ marginBottom: 6 }}>
                      <div className="dim" style={{ fontSize: 10 }}>
                        {new Date(h.ts).toLocaleString()} · {h.route.length + 1} saltos
                      </div>
                      <RouteLine
                        label="IDA"
                        hops={h.route}
                        snrs={h.snrTowards}
                        from="YO"
                        to={n.shortName}
                        short={props.short}
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {posState && (
        <div
          style={{
            padding: "10px 12px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div className="dim" style={{ fontSize: 10, letterSpacing: 2, marginBottom: 4 }}>
            PETICIÓN DE POSICIÓN
          </div>
          {posState === "waiting" && (
            <span className="warn" style={{ fontSize: 11 }}>EN CURSO_</span>
          )}
          {posState === "ok" && (
            <span style={{ fontSize: 11 }}>
              RECIBIDA ✓{" "}
              {n.lat !== undefined && n.lon !== undefined
                ? `${n.lat.toFixed(4)}N ${n.lon.toFixed(4)}E`
                : "(SIN GPS FIX)"}
            </span>
          )}
          {posState === "timeout" && (
            <span className="err" style={{ fontSize: 11 }}>SIN RESPUESTA (60 s)</span>
          )}
          {!["waiting", "ok", "timeout"].includes(posState) && (
            <span className="err" style={{ fontSize: 11 }}>{posState}</span>
          )}
        </div>
      )}
      <div style={{ flex: 1 }} />
      {!props.isMe && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 8,
          }}
        >
          <button
            style={{ flex: 1, padding: "6px 0" }}
            className={n.fav ? "primary" : ""}
            title={n.fav ? "Quitar de favoritos" : "Marcar favorito (arriba en la lista)"}
            onClick={() => toggleFav(n.num)}
          >
            {n.fav ? "★ FAV" : "☆ FAV"}
          </button>
          <button
            style={{ flex: 1, padding: "6px 0" }}
            title={n.ignored ? "Dejar de ignorar" : "Ignorar: descartar sus mensajes"}
            onClick={() => toggleIgnored(n.num)}
          >
            {n.ignored ? "🚫 IGNORADO" : "IGNORAR"}
          </button>
          <button
            className="danger"
            style={{ flex: 1, padding: "6px 0" }}
            title="Borrar de la radio y de la BD local"
            onClick={() => {
              if (confirmDel) {
                deleteNode(n.num).catch(() => {});
                props.onClose();
              } else {
                setConfirmDel(true);
                setTimeout(() => setConfirmDel(false), 3000);
              }
            }}
          >
            {confirmDel ? "¿SEGURO?" : "BORRAR"}
          </button>
        </div>
      )}
      {!props.isMe && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ flex: 1, padding: "6px 0" }}
              title="Reboot remoto vía canal admin"
              onClick={() => onAdmin("reboot")}
            >
              {adminArm === "reboot" ? "¿SEGURO?" : "REBOOT REMOTO"}
            </button>
            <button
              className="danger"
              style={{ flex: 1, padding: "6px 0" }}
              title="Apagado remoto vía canal admin"
              onClick={() => onAdmin("shutdown")}
            >
              {adminArm === "shutdown" ? "¿SEGURO?" : "APAGAR REMOTO"}
            </button>
          </div>
          {adminMsg && (
            <span
              className={adminMsg.startsWith("ERROR") ? "err" : "dim"}
              style={{ fontSize: 10 }}
            >
              {adminMsg}
            </span>
          )}
        </div>
      )}
      {!props.isMe && (
        <div
          style={{
            padding: 12,
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 8,
          }}
        >
          <button
            className="primary"
            style={{ flex: 1, padding: "8px 0" }}
            onClick={() => props.onOpenDm(n.num)}
          >
            [ DM ]
          </button>
          <button
            style={{ flex: 1, padding: "8px 0", minWidth: 0 }}
            title="Traceroute: trazar ruta de saltos hasta el nodo"
            disabled={tracing}
            onClick={onTrace}
          >
            [ TRACE ]
          </button>
          <button
            style={{ flex: 1, padding: "8px 0", minWidth: 0 }}
            title="Pedir posición GPS al nodo"
            disabled={posState === "waiting"}
            onClick={onAskPos}
          >
            [ POS ]
          </button>
        </div>
      )}
    </div>
  );
}

export default function Nodes({
  onOpenDm,
  initialSelected,
}: {
  onOpenDm: (num: number) => void;
  initialSelected?: number;
}) {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const [selected, setSelected] = useState<number | undefined>(initialSelected);

  // Al llegar desde el mapa con nodo preseleccionado, llevar su fila a la vista
  useEffect(() => {
    document.querySelector("tbody tr.sel")?.scrollIntoView({ block: "center" });
  }, []);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "visto",
    dir: -1,
  });
  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: (prev.dir * -1) as 1 | -1 } : { key, dir: DEFAULT_DIR[key] },
    );
  const [filter, setFilter] = useState("");
  const me = s.myNodeNum !== undefined ? s.nodes.get(s.myNodeNum) : undefined;
  const q = filter.trim().toLowerCase().replace(/^!/, "");
  const all = [...s.nodes.values()];
  const matching = q
    ? all.filter(
        (n) =>
          n.longName?.toLowerCase().includes(q) ||
          n.shortName?.toLowerCase().includes(q) ||
          n.num.toString(16).includes(q),
      )
    : all;
  const nodes = sortNodes(matching, sort.key, sort.dir, me);
  const selectedNode =
    selected !== undefined ? s.nodes.get(selected) : undefined;
  const short = (num: number) =>
    s.nodes.get(num)?.shortName ?? `!${num.toString(16)}`;

  return (
    <main>
      <div className="panel" style={{ flex: 1, minWidth: 0 }}>
        <div className="panel-title">
          <span>
            PANEL // NODOS · {nodes.length}
            {q ? ` DE ${all.length}` : ""} DETECTADOS
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filtrar nombre / id_"
            style={{ width: 180, fontSize: 11 }}
          />
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          <table className="grid">
            <thead>
              <tr>
                <Th label="NODO" k="nombre" sort={sort} onSort={onSort} />
                <Th label="CORTO" k="corto" sort={sort} onSort={onSort} />
                <Th label="SNR" k="snr" sort={sort} onSort={onSort} />
                <Th label="BATERÍA" k="bateria" sort={sort} onSort={onSort} />
                <Th label="SALTOS" k="saltos" sort={sort} onSort={onSort} />
                <Th label="POSICIÓN" k="pos" sort={sort} onSort={onSort} />
                <Th label="VISTO HACE" k="visto" sort={sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr
                  key={n.num}
                  className={selected === n.num ? "sel" : ""}
                  onClick={() =>
                    setSelected(selected === n.num ? undefined : n.num)
                  }
                >
                  <td style={n.ignored ? { opacity: 0.4 } : undefined}>
                    {n.fav && <span className="warn">★ </span>}
                    !{n.num.toString(16)} · {n.longName}
                    {n.num === s.myNodeNum && " (YO)"}
                    {n.viaMqtt && " ☁"}
                    {n.hasKey && " 🔒"}
                    {n.ignored && " 🚫"}
                  </td>
                  <td style={{ fontWeight: 700 }}>{n.shortName}</td>
                  <td className={snrClass(n.snr)}>
                    {n.snr !== undefined ? `${n.snr.toFixed(2)} dB` : "—"}
                  </td>
                  <td
                    className={
                      n.batteryLevel !== undefined && n.batteryLevel <= 20
                        ? "err"
                        : n.batteryLevel !== undefined && n.batteryLevel <= 40
                          ? "warn"
                          : ""
                    }
                  >
                    {asciiBattery(n.batteryLevel)}
                  </td>
                  <td>{n.hopsAway ?? "—"}</td>
                  <td>
                    {n.lat !== undefined && n.lon !== undefined
                      ? `${n.lat.toFixed(4)}N ${n.lon.toFixed(4)}E`
                      : "SIN GPS FIX"}
                  </td>
                  <td>{ago(n.lastHeard)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {nodes.length === 0 && (
            <p className="dim" style={{ padding: 12 }}>
              {q ? `SIN COINCIDENCIAS PARA "${filter}"_` : "NO NODES DETECTED — AWAITING SIGNAL_"}
            </p>
          )}
        </div>
        <div className="panel-foot">
          <span>{all.length} NODOS EN BD</span>
          <span style={{ flex: 1 }} />
          <span>
            SNR: <span className="ok">≥5 dB OK</span> ·{" "}
            <span className="warn">0–5 dB REG</span> ·{" "}
            <span className="err">&lt;0 dB MAL</span>
          </span>
        </div>
      </div>

      {selectedNode && (
        <Detail
          node={selectedNode}
          isMe={selectedNode.num === s.myNodeNum}
          trace={s.traceroutes.get(selectedNode.num)}
          posTs={s.posUpdates.get(selectedNode.num)}
          short={short}
          onOpenDm={onOpenDm}
          onClose={() => setSelected(undefined)}
        />
      )}
    </main>
  );
}
