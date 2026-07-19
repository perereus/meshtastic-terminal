import { Component, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Types } from "@meshtastic/core";
import { listSerialPorts } from "./transport/serial";
import { scanBleDevices, type BleDeviceInfo } from "./transport/ble";
import {
  connectBle,
  connectSerial,
  connectTcp,
  disconnect,
  loadHistory,
  setConnectionLostHandler,
} from "./radio";
import { getSnapshot, subscribe } from "./store";
import Chat from "./screens/Chat";
import Nodes from "./screens/Nodes";
import MapView from "./screens/MapView";
import Config from "./screens/Config";
import Telemetry from "./screens/Telemetry";
import { hwName, regionName } from "./fmt";
import { saveText, stamp } from "./export";
import "./App.css";

const TABS = ["CHAT", "NODOS", "MAPA", "CONFIG", "TELEMETRÍA", "DEBUG"] as const;
type Tab = (typeof TABS)[number];

// ponytail: un error boundary de una sola pantalla no debe tumbar toda la app.
// key={tab} lo remonta al cambiar de pestaña, limpiando el estado de error.
class ScreenBoundary extends Component<
  { children: ReactNode },
  { err?: Error }
> {
  state: { err?: Error } = {};
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (this.state.err) {
      return (
        <main>
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-title">
              <span>ERROR EN PANTALLA</span>
            </div>
            <pre className="err" style={{ padding: 16, whiteSpace: "pre-wrap" }}>
              {String(this.state.err?.stack ?? this.state.err)}
            </pre>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

const appWindow = getCurrentWindow();

function Titlebar() {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar-label" data-tauri-drag-region>
        ◊ MESHTASTIC ·· MESH·NET TERMINAL
      </span>
      <div className="titlebar-btns">
        <button className="tb-btn" onClick={() => appWindow.minimize()} title="Minimizar">
          ─
        </button>
        <button
          className="tb-btn"
          onClick={() => appWindow.toggleMaximize()}
          title="Maximizar"
        >
          ▢
        </button>
        <button className="tb-btn tb-close" onClick={() => appWindow.close()} title="Cerrar">
          ✕
        </button>
      </div>
    </div>
  );
}

// Última conexión recordada (localStorage). Para BLE guardamos también el
// nombre para poder mostrarlo en el desplegable antes de escanear.
type Mode = "serie" | "tcp" | "ble";
interface LastConn {
  mode: Mode;
  id: string;
  name?: string;
}
const LAST_KEY = "meshLastConn";
function loadLast(): LastConn | undefined {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? (JSON.parse(raw) as LastConn) : undefined;
  } catch {
    return undefined;
  }
}
function saveLast(v: LastConn): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(v));
  } catch {
    /* localStorage no disponible: no pasa nada */
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function App() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const [tab, setTab] = useState<Tab>("CHAT");
  const [chatConvo, setChatConvo] = useState("ch:0");
  // nodo a preseleccionar al saltar MAPA → NODOS con [+INFO]
  const [nodeFocus, setNodeFocus] = useState<number | undefined>();
  const [mode, setMode] = useState<Mode>("serie");
  const [ports, setPorts] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [host, setHost] = useState("");
  const [bleDevices, setBleDevices] = useState<BleDeviceInfo[]>([]);
  const [bleSel, setBleSel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [connectedAt, setConnectedAt] = useState<number | undefined>();
  const canceledRef = useRef(false);
  // Auto-reconexión: wantRef = el usuario quiere estar conectado (false tras
  // DESCONECTAR/CANCELAR). lastRef = con qué reconectar. Backoff exponencial.
  const wantRef = useRef(false);
  const lastRef = useRef<{ mode: Mode; id: string } | undefined>(undefined);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const reconnectBusyRef = useRef(false);

  const connected =
    s.status !== undefined &&
    s.status >= Types.DeviceStatusEnum.DeviceConnected;
  const configuring = s.status === Types.DeviceStatusEnum.DeviceConfiguring;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const scanBle = () => {
    setScanning(true);
    setError("");
    scanBleDevices()
      .then((d) => {
        setBleDevices(d);
        setBleSel((cur) => cur || d[0]?.address || "");
        setError(
          d.length === 0
            ? "BLE: 0 dispositivos. Bluetooth ON? nodo anunciando? (quítalo de Config Bluetooth de Windows y reinícialo)"
            : `BLE: ${d.length} dispositivos (${d.filter((x) => x.svc).length} Meshtastic)`,
        );
      })
      .catch((e) => setError(String(e)))
      .finally(() => setScanning(false));
  };

  const refreshPorts = () =>
    listSerialPorts()
      .then((p) => {
        setPorts(p);
        setSelected((cur) => cur || p[0] || "");
      })
      .catch((e) => setError(String(e)));

  useEffect(() => {
    refreshPorts();
    loadHistory().catch((e) => setError(`BD: ${e}`));

    // Prefijar la última conexión usada
    const last = loadLast();
    if (last) {
      setMode(last.mode);
      if (last.mode === "serie") setSelected(last.id);
      else if (last.mode === "tcp") setHost(last.id);
      else {
        setBleSel(last.id);
        if (last.name) setBleDevices([{ address: last.id, name: last.name, svc: true }]);
      }
    }

    // Cuando el enlace se cae solo, arrancar la auto-reconexión
    setConnectionLostHandler(() => {
      if (wantRef.current) void tryReconnect();
    });
    return () => setConnectionLostHandler(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doConnect = (m: Mode, id: string) =>
    m === "serie"
      ? connectSerial(id)
      : m === "tcp"
        ? connectTcp(id)
        : connectBle(id);

  const clearReconnect = () => {
    if (reconnectTimerRef.current !== undefined) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    attemptRef.current = 0;
  };

  const onConnect = async () => {
    const id = mode === "serie" ? selected : mode === "tcp" ? host.trim() : bleSel;
    setError("");
    setConnecting(true);
    canceledRef.current = false;
    try {
      await doConnect(mode, id);
      if (canceledRef.current) return;
      setConnectedAt(Date.now());
      wantRef.current = true;
      lastRef.current = { mode, id };
      const name = mode === "ble" ? bleDevices.find((d) => d.address === id)?.name : undefined;
      saveLast({ mode, id, name });
    } catch (e) {
      if (!canceledRef.current) setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  // Reintenta la última conexión con backoff exponencial (2s→15s tope) mientras
  // el usuario siga queriendo estar conectado. Solo BLE avisa de caídas hoy.
  const tryReconnect = async () => {
    if (!wantRef.current || !lastRef.current) return;
    if (reconnectBusyRef.current) return; // ya hay un intento en marcha
    reconnectBusyRef.current = true;
    const { mode: m, id } = lastRef.current;
    setConnecting(true);
    setError(`Reconectando… (intento ${attemptRef.current + 1})`);
    try {
      await doConnect(m, id);
      if (!wantRef.current) return; // el usuario canceló mientras reconectaba
      setConnectedAt(Date.now());
      setError("");
      attemptRef.current = 0;
    } catch {
      if (!wantRef.current) return;
      attemptRef.current++;
      const delay = Math.min(15000, 2000 * 2 ** (attemptRef.current - 1));
      setError(`Reconexión fallida, reintento en ${delay / 1000}s`);
      reconnectTimerRef.current = setTimeout(tryReconnect, delay) as unknown as number;
    } finally {
      reconnectBusyRef.current = false;
      setConnecting(false);
    }
  };

  const stopAndForget = async () => {
    wantRef.current = false;
    clearReconnect();
    setConnectedAt(undefined);
    await disconnect();
  };

  // Aborta un intento de conexión colgado (p.ej. configure() sin respuesta del
  // nodo). disconnect() cierra el transporte y hace que el connect en curso
  // rechace; canceledRef evita que ese rechazo pise el mensaje de cancelado.
  const onCancel = async () => {
    canceledRef.current = true;
    setConnecting(false);
    setError("Conexión cancelada");
    await stopAndForget();
  };

  const d = new Date(now);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const ledClass = connected ? "on" : connecting || configuring ? "connecting" : "";
  const connText = connected
    ? s.status === Types.DeviceStatusEnum.DeviceConfigured
      ? "DEVICE CONFIGURED"
      : "LINK UP"
    : connecting || configuring
      ? "ESTABLISHING LINK…"
      : "NO LINK";

  let totalUnread = 0;
  for (const n of s.unread.values()) totalUnread += n;

  const me = s.myNodeNum !== undefined ? s.nodes.get(s.myNodeNum) : undefined;
  const lora = s.config.get("lora") as
    | { region?: number }
    | undefined;
  const ch0 = s.channels.get(0);

  return (
    <div className="app">
      <Titlebar />
      <header>
        <div className="logo">
          <strong>MESHTASTIC</strong>
          <span>MESH·NET TERMINAL</span>
        </div>
        <nav>
          {TABS.map((t) => (
            <button
              key={t}
              className={`tab ${t === tab ? "active" : ""}`}
              onClick={() => {
                setNodeFocus(undefined);
                setTab(t);
              }}
            >
              [{t}]
              {t === "CHAT" && totalUnread > 0 && (
                <span className="unread-badge">{totalUnread}</span>
              )}
            </button>
          ))}
        </nav>
        <span style={{ flex: 1 }} />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as "serie" | "tcp" | "ble")}
          disabled={connected || connecting}
        >
          <option value="serie">SERIE</option>
          <option value="tcp">TCP</option>
          <option value="ble">BLE</option>
        </select>
        {mode === "serie" ? (
          <>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={connected || connecting}
            >
              {ports.length === 0 && <option value="">SIN PUERTOS</option>}
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button onClick={refreshPorts} disabled={connected} title="Refrescar">
              ⟳
            </button>
          </>
        ) : mode === "tcp" ? (
          <input
            placeholder="IP DEL NODO : 4403"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            disabled={connected || connecting}
            style={{ width: 190 }}
          />
        ) : (
          <>
            <select
              value={bleSel}
              onChange={(e) => setBleSel(e.target.value)}
              disabled={connected || connecting}
              style={{ minWidth: 150 }}
            >
              {bleDevices.length === 0 && (
                <option value="">{scanning ? "BUSCANDO…" : "SIN NODOS"}</option>
              )}
              {bleDevices.map((d) => (
                <option key={d.address} value={d.address}>
                  {d.svc ? "● " : ""}
                  {d.name}
                </option>
              ))}
            </select>
            <button
              onClick={scanBle}
              disabled={connected || connecting || scanning}
              title="Escanear BLE"
            >
              {scanning ? "⟳" : "ESCANEAR"}
            </button>
          </>
        )}
        {connected ? (
          <button className="primary" onClick={stopAndForget}>
            DESCONECTAR
          </button>
        ) : connecting ? (
          <button className="primary" onClick={onCancel}>
            CANCELAR
          </button>
        ) : (
          <button
            className="primary"
            onClick={onConnect}
            disabled={
              mode === "serie"
                ? !selected
                : mode === "tcp"
                  ? !host.trim()
                  : !bleSel
            }
          >
            CONECTAR
          </button>
        )}
        <div className="conn-pill">
          <span className={`led ${ledClass}`} />
          <span
            className={
              connected ? "" : connecting || configuring ? "txt-connecting" : "txt-off"
            }
          >
            {connText}
          </span>
        </div>
        <div className="clock">
          <span className="time">{clock}</span>
          <span className="uptime">
            UPLINK {connectedAt && connected ? hms(now - connectedAt) : "--:--:--"}
          </span>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <ScreenBoundary key={tab}>
      {tab === "CHAT" && <Chat convo={chatConvo} setConvo={setChatConvo} />}
      {tab === "NODOS" && (
        <Nodes
          initialSelected={nodeFocus}
          onOpenDm={(num) => {
            setChatConvo(`dm:${num}`);
            setTab("CHAT");
          }}
        />
      )}
      {tab === "MAPA" && (
        <MapView
          onOpenNode={(num) => {
            setNodeFocus(num);
            setTab("NODOS");
          }}
        />
      )}
      {tab === "CONFIG" && <Config />}
      {tab === "TELEMETRÍA" && <Telemetry />}
      {tab === "DEBUG" && (
        <main>
          <div className="panel" style={{ flex: 1, background: "#050905" }}>
            <div className="panel-title">
              <span>PANEL // DEBUG · SERIAL 115200 8N1</span>
              <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  style={{ fontSize: 10, padding: "0 6px" }}
                  title="Exportar el log a un archivo de texto"
                  disabled={s.log.length === 0}
                  onClick={() =>
                    saveText(`meshtastic-log-${stamp()}.txt`, s.log.join("\n"))
                      .then((p) => p && setError(`EXPORTADO → ${p}`))
                      .catch((e) => setError(`FALLO EXPORT: ${e}`))
                  }
                >
                  ⭳ EXPORTAR
                </button>
                {s.log.length} LÍNEAS
              </span>
            </div>
            <pre className="debuglog">
              {s.log.join("\n")}
              {"\n"}
              <span className="cursor">█</span>
            </pre>
          </div>
        </main>
      )}
      </ScreenBoundary>

      <footer>
        {me?.hwModel !== undefined && <span>HW {hwName(me.hwModel)}</span>}
        {lora?.region !== undefined && <span>REGIÓN {regionName(lora.region)}</span>}
        {ch0 && <span>CANAL 0 #{ch0.name}</span>}
        <span>{s.nodes.size} NODOS</span>
        <span style={{ flex: 1 }} />
        <span>{s.log[s.log.length - 1] ?? "—"}</span>
      </footer>
    </div>
  );
}

export default App;
