import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { getSnapshot, subscribe } from "../store";
import { listMetrics, listTelemetryNodes, loadTelemetry } from "../db";
import { t } from "../i18n";

// pseudo-métrica: ChUtil + AirUtilTx en la misma gráfica
const CHANNEL = "__canal";

const METRIC_LABELS: Record<string, string> = {
  [CHANNEL]: t("CANAL OCUPADO (%)"),
  batteryLevel: t("NIVEL BATERÍA (%)"),
  voltage: t("TENSIÓN BATERÍA (V)"),
  channelUtilization: t("UTIL. CANAL (%)"),
  airUtilTx: t("AIRE TX (%)"),
  temperature: t("TEMPERATURA (°C)"),
  relativeHumidity: t("HUMEDAD (%)"),
  barometricPressure: t("PRESIÓN (hPa)"),
};

const RANGES: [string, number][] = [
  ["6 H", 0.25],
  ["24 H", 1],
  ["7 D", 7],
  ["30 D", 30],
];

export default function Telemetry() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const [node, setNode] = useState<number | undefined>();
  const [metrics, setMetrics] = useState<string[]>([]);
  const [metric, setMetric] = useState("");
  const [days, setDays] = useState(1);
  const [stats, setStats] = useState<{
    min: number;
    max: number;
    avg: number;
    n: number;
  } | null>(null);
  const plotDiv = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [withData, setWithData] = useState<Set<number>>(new Set());
  // ponytail: refresco periódico en vez de por s.version — la malla muta
  // decenas de veces/s y reconstruir la gráfica en cada mutación cuelga el webview
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    listTelemetryNodes().then((ns) => setWithData(new Set(ns)));
  }, [tick]);

  const nodes = [...s.nodes.values()]
    .filter((n) => withData.has(n.num))
    .sort((a, b) => (a.longName ?? "").localeCompare(b.longName ?? ""));
  const effectiveNode =
    node !== undefined && withData.has(node) ? node : nodes[0]?.num;

  useEffect(() => {
    if (effectiveNode === undefined) return;
    listMetrics(effectiveNode).then((raw) => {
      const m = raw.includes("channelUtilization") && raw.includes("airUtilTx")
        ? [CHANNEL, ...raw]
        : raw;
      setMetrics(m);
      setMetric((cur) => (m.includes(cur) ? cur : (m[0] ?? "")));
    });
  }, [effectiveNode, tick]);

  useEffect(() => {
    if (effectiveNode === undefined || !metric || !plotDiv.current) return;
    const since = Date.now() - days * 86_400_000;
    let cancelled = false;
    const dual = metric === CHANNEL;
    const load = dual
      ? Promise.all([
          loadTelemetry(effectiveNode, "channelUtilization", since),
          loadTelemetry(effectiveNode, "airUtilTx", since),
        ])
      : loadTelemetry(effectiveNode, metric, since).then((r) => [r]);
    load.then(([rows, rows2]) => {
      if (cancelled || !plotDiv.current) return;
      plotRef.current?.destroy();
      plotRef.current = null;
      if (rows.length > 0) {
        // ponytail: bucle en vez de Math.min(...vals) — el spread revienta
        // con arrays grandes (RangeError: Maximum call stack size exceeded)
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        for (const r of rows) {
          if (r.value < min) min = r.value;
          if (r.value > max) max = r.value;
          sum += r.value;
        }
        setStats({ min, max, avg: sum / rows.length, n: rows.length });
      } else {
        setStats(null);
        return;
      }
      // ambas métricas llegan en el mismo paquete ⇒ mismo ts, join directo
      const byTs = new Map((rows2 ?? []).map((r) => [r.ts, r.value]));
      const data: uPlot.AlignedData = [
        rows.map((r) => r.ts / 1000),
        rows.map((r) => r.value),
        ...(dual ? [rows.map((r) => byTs.get(r.ts) ?? null)] : []),
      ];
      plotRef.current = new uPlot(
        {
          width: Math.max(100, plotDiv.current.clientWidth - 28),
          height: Math.max(220, plotDiv.current.clientHeight - 28),
          series: [
            {},
            {
              label: dual ? t("UTIL. CANAL (%)") : (METRIC_LABELS[metric] ?? metric),
              stroke: "#39ff5a",
              width: 2,
              points: { show: false },
            },
            ...(dual
              ? [
                  {
                    label: t("AIRE TX (%)"),
                    stroke: "#00e5ff",
                    width: 2,
                    points: { show: false },
                  },
                ]
              : []),
          ],
          axes: [
            {
              stroke: "#39ff5a88",
              grid: { stroke: "#39ff5a22", dash: [2, 6] },
              ticks: { stroke: "#39ff5a44" },
              font: "11px JetBrains Mono",
            },
            {
              stroke: "#39ff5a88",
              grid: { stroke: "#39ff5a22", dash: [2, 6] },
              ticks: { stroke: "#39ff5a44" },
              font: "11px JetBrains Mono",
            },
          ],
          legend: { show: dual },
        },
        data,
        plotDiv.current,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [effectiveNode, metric, days, tick]);

  useEffect(() => () => plotRef.current?.destroy(), []);

  const nodeLabel =
    effectiveNode !== undefined
      ? (s.nodes.get(effectiveNode)?.shortName ?? effectiveNode)
      : "—";
  const fmt = (v: number) =>
    Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);

  return (
    <main style={{ flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
        <span className="dim" style={{ fontSize: 10, letterSpacing: 2 }}>
          {t("TELEMETRÍA //")}
        </span>
        <select
          value={effectiveNode ?? ""}
          onChange={(e) => setNode(Number(e.target.value))}
        >
          {nodes.length === 0 && (
            <option value="">{t("SIN DATOS DE TELEMETRÍA")}</option>
          )}
          {nodes.map((n) => (
            <option key={n.num} value={n.num}>
              {n.shortName} · !{n.num.toString(16)}
            </option>
          ))}
        </select>
        <select value={metric} onChange={(e) => setMetric(e.target.value)}>
          {metrics.length === 0 && <option value="">{t("SIN MÉTRICAS")}</option>}
          {metrics.map((m) => (
            <option key={m} value={m}>
              {METRIC_LABELS[m] ?? m.toUpperCase()}
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 4 }}>
          {RANGES.map(([label, d]) => (
            <button
              key={label}
              className={days === d ? "tab active" : "tab"}
              onClick={() => setDays(d)}
            >
              {label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span className="dim" style={{ fontSize: 11 }}>
          {stats ? t("{0} MUESTRAS", stats.n) : t("SIN DATOS")}
        </span>
      </div>

      <div style={{ flex: 1, display: "flex", gap: 12, minHeight: 0 }}>
        <div className="panel" style={{ flex: 1 }}>
          <div className="panel-title">
            {t("GRÁFICA")} // {nodeLabel} · {METRIC_LABELS[metric] ?? (metric || "—")}
          </div>
          <div
            style={{ flex: 1, padding: 14, overflow: "hidden", position: "relative" }}
          >
            {!stats && (
              <p className="dim" style={{ position: "absolute" }}>
                {t("NO DATA — la telemetría se acumula mientras la app está conectada_")}
              </p>
            )}
            {/* ponytail: div dedicado a uPlot, SIN hijos de React — si React
                y uPlot comparten contenedor, removeChild casca y tumba la app */}
            <div ref={plotDiv} style={{ width: "100%", height: "100%" }} />
          </div>
        </div>

        <div
          style={{
            width: 200,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            flexShrink: 0,
          }}
        >
          {(
            [
              ["MIN", stats?.min],
              ["MAX", stats?.max],
              ["AVG", stats?.avg],
            ] as [string, number | undefined][]
          ).map(([label, v]) => (
            <div key={label} className="panel stat-tile">
              <div className="label">{label}</div>
              <div className="value">{v !== undefined ? fmt(v) : "—"}</div>
            </div>
          ))}
          <div
            style={{
              flex: 1,
              border: "1px dashed var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 12,
              textAlign: "center",
            }}
          >
            <span className="dim" style={{ fontSize: 10, letterSpacing: 1 }}>
              {t("MUESTREO PASIVO —")}
              <br />
              {t("SE GUARDA TODO LO")}
              <br />
              {t("QUE EMITE LA MALLA")}
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}
