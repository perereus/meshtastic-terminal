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
  notify,
  setConnectionLostHandler,
} from "./radio";
import { evalAlerts, evalAutonomia, getAlertCfg } from "./alerts";
import { preverBateria } from "./battery";
import { addLog, getSnapshot, subscribe } from "./store";
import { getAutoPurgeDays, loadTelemetry, purgeOlderThan } from "./db";
import Chat from "./screens/Chat";
import Nodes from "./screens/Nodes";
import MapView from "./screens/MapView";
import Mesh from "./screens/Mesh";
import Config from "./screens/Config";
import Telemetry from "./screens/Telemetry";
import { hora, hwName, regionName, useHourTick } from "./fmt";
import { saveText, stamp } from "./export";
import { t } from "./i18n";
import "./App.css";

const TABS = [
  "CHAT",
  "NODOS",
  "MAPA",
  "MALLA",
  "CONFIG",
  "TELEMETRÍA",
  "DEBUG",
] as const;
type Tab = (typeof TABS)[number];

// ponytail: an error boundary for a single screen must not take down the app.
// key={tab} remounts it when switching tabs, clearing the error state.
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
              <span>{t("ERROR EN PANTALLA")}</span>
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
        <button
          className="tb-btn"
          onClick={() => appWindow.minimize()}
          title={t("Minimizar")}
        >
          ─
        </button>
        <button
          className="tb-btn"
          onClick={() => appWindow.toggleMaximize()}
          title={t("Maximizar")}
        >
          ▢
        </button>
        <button
          className="tb-btn tb-close"
          onClick={() => appWindow.close()}
          title={t("Cerrar")}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// Last connection remembered (localStorage). For BLE we also store the name
// so it can be shown in the dropdown before scanning.
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
    /* localStorage unavailable: no big deal */
  }
}

// Grace period before the first reconnect: the node is still booting.
const RECONNECT_WAIT_MS = 6000;
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function App() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  // at the root: a clock format change repaints every screen
  useHourTick();
  const [tab, setTab] = useState<Tab>("CHAT");
  const [chatConvo, setChatConvo] = useState("ch:0");
  // node to preselect when jumping MAP → NODES with [+INFO]
  const [nodeFocus, setNodeFocus] = useState<number | undefined>();
  // counter: each bump asks the chat to focus its search box
  const [focusSearch, setFocusSearch] = useState(0);
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
  // Auto-reconnect: wantRef = the user wants to be connected (false after
  // DISCONNECT/CANCEL). lastRef = what to reconnect to. Exponential backoff.
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

  // Ctrl+1…7 switches tabs · Ctrl+F searches the chat
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length) {
        e.preventDefault();
        setNodeFocus(undefined);
        setTab(TABS[n - 1]);
      } else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        setTab("CHAT");
        setFocusSearch((v) => v + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Favorite node alerts (low battery / no signal). Once a minute is plenty:
  // these are conditions measured in hours, and evalAlerts has its own cooldown.
  useEffect(() => {
    const fired = new Map<string, number>();
    const check = () => {
      const st = getSnapshot();
      for (const a of evalAlerts(
        st.nodes.values(),
        getAlertCfg(),
        fired,
        Date.now(),
        st.myNodeNum,
      )) {
        if (a.kind === "bateria") {
          void notify(
            t("{0} · batería {1}%", a.name, a.value),
            t("Por debajo del umbral ({0}%)", a.threshold),
          );
        } else {
          void notify(
            t("{0} · sin señal", a.name),
            t("{0} h sin dar señal", a.value),
          );
        }
      }
    };
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, []);

  // Runtime: kept apart because it needs to read each favorite's battery
  // history from SQLite. Every 5 min is plenty — the slope moves slowly.
  useEffect(() => {
    const fired = new Map<string, number>();
    const check = async () => {
      const cfg = getAlertCfg();
      if (!cfg.on || !cfg.autonomiaH) return;
      const st = getSnapshot();
      for (const n of st.nodes.values()) {
        if (!n.fav || n.num === st.myNodeNum) continue;
        try {
          const rows = await loadTelemetry(
            n.num,
            "batteryLevel",
            Date.now() - 6 * 3_600_000,
          );
          const a = evalAutonomia(
            { num: n.num, nombre: n.longName || n.shortName, fav: n.fav },
            preverBateria(rows),
            cfg,
            fired,
          );
          if (a) {
            void notify(
              t("{0} · autonomía ~{1} h", a.name, a.value),
              t("Al ritmo actual se agota por debajo de {0} h", a.threshold),
            );
          }
        } catch {
          // no data for that node: there is no forecast to give
        }
      }
    };
    const id = setInterval(check, 300_000);
    return () => clearInterval(id);
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
            ? t(
                "BLE: 0 dispositivos. Bluetooth ON? nodo anunciando? (quítalo de Config Bluetooth de Windows y reinícialo)",
              )
            : t(
                "BLE: {0} dispositivos ({1} Meshtastic)",
                d.length,
                d.filter((x) => x.svc).length,
              ),
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
    // Purge before loading: the history that reaches memory is already
    // trimmed and needs no second filter. If it fails, we load anyway.
    const days = getAutoPurgeDays();
    (days > 0
      ? purgeOlderThan(days)
          .then((n) => {
            if (n > 0) addLog(t("Purga automática: {0} filas borradas", n));
          })
          .catch(() => {})
      : Promise.resolve()
    ).then(() => loadHistory().catch((e) => setError(`BD: ${e}`)));

    // Prefill the last connection used
    const last = loadLast();
    if (last) {
      // Also seed the reconnect target: these refs reset on every remount
      // (HMR in dev, or a reload), and without this an already-open link
      // would drop with nothing left saying what to reconnect to.
      lastRef.current = { mode: last.mode, id: last.id };
      setMode(last.mode);
      if (last.mode === "serie") setSelected(last.id);
      else if (last.mode === "tcp") setHost(last.id);
      else {
        setBleSel(last.id);
        if (last.name) setBleDevices([{ address: last.id, name: last.name, svc: true }]);
      }
    }

    // When the link drops on its own, start auto-reconnecting
    setConnectionLostHandler(() => {
      // No wantRef check here: handleLost() only fires on an unexpected drop
      // (a manual disconnect clears `device` first and never gets this far),
      // so reaching this point already means we want to be back. Checking a
      // ref that resets on remount is what left the drop silently unhandled.
      if (!lastRef.current) {
        addLog("RECONEXION: no hay conexión previa que reintentar");
        return;
      }
      wantRef.current = true;
      // A node that just dropped is either rebooting (that's what applying a
      // config does) or out of range. Either way it takes 10-20 s to answer
      // again, so retrying immediately only burns the first attempt.
      setError(t("Enlace perdido · reconectando en {0}s", RECONNECT_WAIT_MS / 1000));
      addLog(`RECONEXION: programada en ${RECONNECT_WAIT_MS / 1000}s`);
      scheduleReconnect(RECONNECT_WAIT_MS);
    });
    return () => setConnectionLostHandler(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doConnect = (m: Mode, id: string) =>
    m === "serie" ? connectSerial(id) : m === "tcp" ? connectTcp(id) : connectBle(id);

  const clearReconnect = () => {
    if (reconnectTimerRef.current !== undefined) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    attemptRef.current = 0;
  };

  // The link-lost handler and the backoff both schedule retries: going through
  // here keeps a single live timer instead of one silently replacing the other.
  const scheduleReconnect = (ms: number) => {
    if (reconnectTimerRef.current !== undefined) {
      clearTimeout(reconnectTimerRef.current);
    }
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = undefined;
      void tryReconnect();
    }, ms) as unknown as number;
  };

  const onConnect = async () => {
    const id = mode === "serie" ? selected : mode === "tcp" ? host.trim() : bleSel;
    setError("");
    setConnecting(true);
    canceledRef.current = false;
    wantRef.current = true;
    lastRef.current = { mode, id };
    try {
      await doConnect(mode, id);
      if (canceledRef.current) return;
      setConnectedAt(Date.now());
      const name = mode === "ble" ? bleDevices.find((d) => d.address === id)?.name : undefined;
      saveLast({ mode, id, name });
    } catch (e) {
      wantRef.current = false; // manual connect failed: don't retry behind their back
      if (!canceledRef.current) setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  // Retries the last connection with exponential backoff (2s→15s cap) while
  // the user still wants to be connected. Only BLE reports drops today.
  const tryReconnect = async () => {
    if (!wantRef.current || !lastRef.current) {
      addLog("RECONEXION: cancelada (desconexión manual)");
      return;
    }
    if (reconnectBusyRef.current) {
      addLog("RECONEXION: ya hay un intento en curso");
      return;
    }
    reconnectBusyRef.current = true;
    const { mode: m, id } = lastRef.current;
    setConnecting(true);
    setError(t("Reconectando… (intento {0})", attemptRef.current + 1));
    addLog(`RECONEXION: intento ${attemptRef.current + 1} por ${m}`);
    try {
      // connect() bounds its own steps, so no timeout wrapper here: racing it
      // can't cancel the real connect and would spawn overlapping attempts
      // that fight over the single BLE link.
      await doConnect(m, id);
      if (!wantRef.current) return; // the user cancelled while reconnecting
      setConnectedAt(Date.now());
      setError("");
      attemptRef.current = 0;
      addLog("RECONEXION: conectado");
    } catch (e) {
      if (!wantRef.current) return;
      // Swallowing this was why a failed reconnect left no trace anywhere:
      // the header string is the next thing to overwrite itself.
      addLog(`RECONEXION: intento ${attemptRef.current + 1} fallido: ${e}`);
      attemptRef.current++;
      const delay = Math.min(15000, 2000 * 2 ** (attemptRef.current - 1));
      setError(t("Reconexión fallida, reintento en {0}s", delay / 1000));
      scheduleReconnect(delay);
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

  // Aborts a hung connection attempt (e.g. configure() with no reply from the
  // node). disconnect() closes the transport and makes the pending connect
  // reject; canceledRef keeps that rejection from overwriting the cancel message.
  const onCancel = async () => {
    canceledRef.current = true;
    setConnecting(false);
    setError(t("Conexión cancelada"));
    await stopAndForget();
  };

  const clock = hora(now);

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
          {TABS.map((tb, i) => (
            <button
              key={tb}
              className={`tab ${tb === tab ? "active" : ""}`}
              title={`Ctrl+${i + 1}`}
              onClick={() => {
                setNodeFocus(undefined);
                setTab(tb);
              }}
            >
              [{t(tb)}]
              {tb === "CHAT" && totalUnread > 0 && (
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
          <option value="serie">{t("SERIE")}</option>
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
              {ports.length === 0 && <option value="">{t("SIN PUERTOS")}</option>}
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button onClick={refreshPorts} disabled={connected} title={t("Refrescar")}>
              ⟳
            </button>
          </>
        ) : mode === "tcp" ? (
          <input
            placeholder={t("IP DEL NODO : 4403")}
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
                <option value="">{scanning ? t("BUSCANDO…") : t("SIN NODOS")}</option>
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
              title={t("Escanear BLE")}
            >
              {scanning ? "⟳" : t("ESCANEAR")}
            </button>
          </>
        )}
        {connected ? (
          <button className="primary" onClick={stopAndForget}>
            {t("DESCONECTAR")}
          </button>
        ) : connecting ? (
          <button className="primary" onClick={onCancel}>
            {t("CANCELAR")}
          </button>
        ) : (
          <button
            className="primary"
            onClick={onConnect}
            disabled={
              mode === "serie" ? !selected : mode === "tcp" ? !host.trim() : !bleSel
            }
          >
            {t("CONECTAR")}
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
      {tab === "CHAT" && (
        <Chat
          convo={chatConvo}
          setConvo={setChatConvo}
          focusSearch={focusSearch}
        />
      )}
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
      {tab === "MALLA" && <Mesh />}
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
                  title={t("Exportar el log a un archivo de texto")}
                  disabled={s.log.length === 0}
                  onClick={() =>
                    saveText(`meshtastic-log-${stamp()}.txt`, s.log.join("\n"))
                      .then((p) => p && setError(t("EXPORTADO → {0}", p)))
                      .catch((e) => setError(t("FALLO EXPORT: {0}", String(e))))
                  }
                >
                  {t("⭳ EXPORTAR")}
                </button>
                {t("{0} LÍNEAS", s.log.length)}
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
        {lora?.region !== undefined && (
          <span>{t("REGIÓN")} {regionName(lora.region)}</span>
        )}
        {ch0 && <span>{t("CANAL")} 0 #{ch0.name}</span>}
        <span>{t("{0} NODOS", s.nodes.size)}</span>
        <span style={{ flex: 1 }} />
        <span>{s.log[s.log.length - 1] ?? "—"}</span>
      </footer>
    </div>
  );
}

export default App;
