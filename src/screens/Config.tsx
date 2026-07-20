import { useEffect, useState, useSyncExternalStore } from "react";
import { create } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import { getSnapshot, subscribe } from "../store";
import {
  clearFixedPosition,
  device,
  exportConfigJson,
  importChannelSet,
  importConfigJson,
  setFixedPosition,
} from "../radio";
import {
  dbStats,
  getAutoPurgeDays,
  purgeOlderThan,
  setAutoPurgeDays,
} from "../db";
import { mutate } from "../store";
import { parseChannelSetUrl } from "../channelUrl";
import { buildChannelSetUrl } from "../channelUrl";
import { getLang, getLangPref, setLang, t, type Lang } from "../i18n";
import { getTheme, setTheme, THEMES, type Theme } from "../theme";
import { getHourPref, is12h, setHourPref, type HourPref } from "../fmt";
import { getAlertCfg, setAlertCfg, type AlertCfg } from "../alerts";

type LoRa = Protobuf.Config.Config_LoRaConfig;
type Dev = Protobuf.Config.Config_DeviceConfig;
type Pos = Protobuf.Config.Config_PositionConfig;
type Disp = Protobuf.Config.Config_DisplayConfig;
type Pwr = Protobuf.Config.Config_PowerConfig;
type Mqtt = Protobuf.ModuleConfig.ModuleConfig_MQTTConfig;
type Neigh = Protobuf.ModuleConfig.ModuleConfig_NeighborInfoConfig;
type RangeT = Protobuf.ModuleConfig.ModuleConfig_RangeTestConfig;

// Position precision per channel, same steps as the official app.
// Precision bits → approximate radius of the broadcast area.
const PRECISION_OPTS: [number, string][] = [
  [0, t("SIN POSICIÓN")],
  [10, "±23 km"],
  [11, "±12 km"],
  [12, "±5,8 km"],
  [13, "±2,9 km"],
  [14, "±1,5 km"],
  [15, "±700 m"],
  [16, "±350 m"],
  [17, "±175 m"],
  [18, "±90 m"],
  [19, "±45 m"],
  [32, t("EXACTA")],
];

const THEME_LABELS: Record<Theme, string> = {
  verde: "VERDE FÓSFORO",
  ambar: "ÁMBAR",
  cian: "CIAN",
  hueso: "HUESO",
  violeta: "VIOLETA",
};

function enumOptions(schema: {
  values: readonly { name: string; number: number }[];
}) {
  return schema.values.map((v) => ({ label: v.name, value: v.number }));
}

function Section(props: {
  title: string;
  children: React.ReactNode;
  onSave?: () => Promise<void>;
}) {
  const [msg, setMsg] = useState("");
  const [cls, setCls] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="panel">
      <div className="panel-title">{props.title}</div>
      {props.children}
      {props.onSave && (
        <div className="panel-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setMsg(t("GUARDANDO…"));
              setCls("warn");
              setBusy(true);
              try {
                // the radio's ack can get lost: don't hang the UI forever
                await Promise.race([
                  props.onSave?.(),
                  new Promise((_, rej) =>
                    setTimeout(
                      () => rej(new Error(t("sin respuesta de la radio (20 s)"))),
                      20_000,
                    ),
                  ),
                ]);
                setMsg(t("Guardado ✓"));
                setCls("");
              } catch (e) {
                setMsg(`ERROR: ${e instanceof Error ? e.message : e}`);
                setCls("err");
              } finally {
                setBusy(false);
              }
            }}
          >
            [ EXECUTE ]
          </button>
          <span className={cls} style={{ fontSize: 12 }}>
            {msg}
          </span>
        </div>
      )}
    </div>
  );
}

export default function Config() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const me = s.myNodeNum !== undefined ? s.nodes.get(s.myNodeNum) : undefined;
  const lora = s.config.get("lora") as LoRa | undefined;
  const devCfg = s.config.get("device") as Dev | undefined;
  const posCfg = s.config.get("position") as Pos | undefined;
  const dispCfg = s.config.get("display") as Disp | undefined;
  const pwrCfg = s.config.get("power") as Pwr | undefined;
  const mqtt = s.moduleConfig.get("mqtt") as Mqtt | undefined;
  const neigh = s.moduleConfig.get("neighborInfo") as Neigh | undefined;
  const rangeT = s.moduleConfig.get("rangeTest") as RangeT | undefined;

  const [longName, setLongName] = useState("");
  const [shortName, setShortName] = useState("");
  const [region, setRegion] = useState(0);
  const [preset, setPreset] = useState(0);
  const [hopLimit, setHopLimit] = useState(3);
  const [txEnabled, setTxEnabled] = useState(true);
  const [chNames, setChNames] = useState<Record<number, string>>({});
  const [chPsks, setChPsks] = useState<Record<number, string>>({}); // base64
  // remaining per-channel options (role, MQTT, pos precision, mute) — only touched ones
  const [chExtra, setChExtra] = useState<
    Record<
      number,
      {
        role?: number;
        uplink?: boolean;
        downlink?: boolean;
        precision?: number;
        muted?: boolean;
      }
    >
  >({});
  const [theme, setThemeSel] = useState<Theme>(getTheme);
  const [horaFmt, setHoraFmt] = useState<HourPref>(getHourPref);
  const [alerts, setAlerts] = useState<AlertCfg>(getAlertCfg);
  const saveAlerts = (patch: Partial<AlertCfg>) => {
    const next = { ...alerts, ...patch };
    setAlerts(next);
    setAlertCfg(next);
  };
  const [chMsg, setChMsg] = useState("");
  const [chCls, setChCls] = useState("");
  const [maint, setMaint] = useState("");
  // range test
  const [rtOn, setRtOn] = useState(false);
  const [rtSender, setRtSender] = useState(0);
  const [rtSave, setRtSave] = useState(false);
  // database
  const [stats, setStats] = useState<{
    messages: number;
    telemetry: number;
    nodes: number;
  }>();
  const [purgeDays, setPurgeDays] = useState(30);
  const [purgeArm, setPurgeArm] = useState(false);
  const [autoPurge, setAutoPurge] = useState(getAutoPurgeDays);
  const [purgeMsg, setPurgeMsg] = useState("");
  // device/position/display/power
  const [devRole, setDevRole] = useState(0);
  const [posBcast, setPosBcast] = useState(0);
  const [posSmart, setPosSmart] = useState(true);
  const [dispSecs, setDispSecs] = useState(0);
  const [pwrSave, setPwrSave] = useState(false);
  // backup / import
  const [bkMsg, setBkMsg] = useState("");
  const [bkCls, setBkCls] = useState("");
  const [importPending, setImportPending] = useState("");

  // modules
  const [mqEnabled, setMqEnabled] = useState(false);
  const [mqAddress, setMqAddress] = useState("");
  const [mqUser, setMqUser] = useState("");
  const [mqPass, setMqPass] = useState("");
  const [mqEnc, setMqEnc] = useState(true);
  const [mqRoot, setMqRoot] = useState("");
  const [nbOn, setNbOn] = useState(false);
  const [nbInt, setNbInt] = useState(0);
  const [nbLora, setNbLora] = useState(false);

  const [posLat, setPosLat] = useState("");
  const [posLon, setPosLon] = useState("");
  const [posMsg, setPosMsg] = useState("");
  const [posCls, setPosCls] = useState("");
  const [chUrl, setChUrl] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [importCls, setImportCls] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (me) {
      setLongName(me.longName);
      setShortName(me.shortName);
    }
  }, [me?.num]);

  useEffect(() => {
    if (lora) {
      setRegion(lora.region);
      setPreset(lora.modemPreset);
      setHopLimit(lora.hopLimit);
      setTxEnabled(lora.txEnabled);
    }
  }, [lora]);

  useEffect(() => {
    if (devCfg) setDevRole(devCfg.role);
  }, [devCfg]);
  useEffect(() => {
    if (posCfg) {
      setPosBcast(posCfg.positionBroadcastSecs);
      setPosSmart(posCfg.positionBroadcastSmartEnabled);
    }
  }, [posCfg]);
  useEffect(() => {
    if (dispCfg) setDispSecs(dispCfg.screenOnSecs);
  }, [dispCfg]);
  useEffect(() => {
    if (pwrCfg) setPwrSave(pwrCfg.isPowerSaving);
  }, [pwrCfg]);

  useEffect(() => {
    if (mqtt) {
      setMqEnabled(mqtt.enabled);
      setMqAddress(mqtt.address);
      setMqUser(mqtt.username);
      setMqPass(mqtt.password);
      setMqEnc(mqtt.encryptionEnabled);
      setMqRoot(mqtt.root);
    }
  }, [mqtt]);

  useEffect(() => {
    if (neigh) {
      setNbOn(neigh.enabled);
      setNbInt(neigh.updateInterval);
      setNbLora(neigh.transmitOverLora);
    }
  }, [neigh]);

  useEffect(() => {
    if (rangeT) {
      setRtOn(rangeT.enabled);
      setRtSender(rangeT.sender);
      setRtSave(rangeT.save);
    }
  }, [rangeT]);

  useEffect(() => {
    dbStats().then(setStats).catch(() => {});
  }, []);

  if (!device) {
    return (
      <main>
        <p className="dim" style={{ padding: 16 }}>
          {t("NO LINK — conecta un dispositivo para ver su configuración_")}
        </p>
      </main>
    );
  }

  const onPurge = async () => {
    if (!purgeArm) {
      setPurgeArm(true);
      setPurgeMsg(t("pulsa otra vez para confirmar"));
      setTimeout(() => setPurgeArm(false), 3000);
      return;
    }
    setPurgeArm(false);
    const days = Math.max(1, purgeDays);
    try {
      const n = await purgeOlderThan(days);
      const cut = Date.now() - days * 86_400_000;
      mutate((st) => {
        st.messages = st.messages.filter((m) => m.ts >= cut);
      });
      setPurgeMsg(t("{0} filas borradas", n));
      setStats(await dbStats());
    } catch (e) {
      setPurgeMsg(`ERROR: ${e instanceof Error ? e.message : e}`);
    }
  };

  const saveOwner = async () => {
    await device?.setOwner(
      create(Protobuf.Mesh.UserSchema, { longName, shortName }),
    );
    await device?.commitEditSettings();
  };

  const saveLora = async () => {
    if (!lora) throw new Error(t("config LoRa aún no recibida"));
    await device?.setConfig(
      create(Protobuf.Config.ConfigSchema, {
        payloadVariant: {
          case: "lora",
          value: {
            ...lora,
            region,
            modemPreset: preset,
            hopLimit,
            txEnabled,
            usePreset: true,
          },
        },
      }),
    );
    await device?.commitEditSettings();
  };

  // PSK in standard base64 (like the official apps). Empty = no encryption.
  const pskToB64 = (b?: Uint8Array) =>
    b && b.length ? btoa(String.fromCharCode(...b)) : "";
  const pskFromB64 = (str: string): Uint8Array => {
    const b64 = str.trim();
    if (!b64) return new Uint8Array(0);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (![1, 16, 32].includes(bytes.length)) {
      throw new Error(t("PSK de {0} bytes; debe ser 1, 16 o 32", bytes.length));
    }
    return bytes;
  };

  // saves device+position+display+power in one go (the spread keeps the
  // fields not exposed here)
  const saveDevice = async () => {
    const cfgs: Protobuf.Config.Config["payloadVariant"][] = [
      { case: "device", value: { ...devCfg, role: devRole } as Dev },
      {
        case: "position",
        value: {
          ...posCfg,
          positionBroadcastSecs: posBcast,
          positionBroadcastSmartEnabled: posSmart,
        } as Pos,
      },
      { case: "display", value: { ...dispCfg, screenOnSecs: dispSecs } as Disp },
      { case: "power", value: { ...pwrCfg, isPowerSaving: pwrSave } as Pwr },
    ];
    for (const payloadVariant of cfgs) {
      await device?.setConfig(
        create(Protobuf.Config.ConfigSchema, { payloadVariant }),
      );
    }
    await device?.commitEditSettings();
  };

  const onBackup = () => {
    try {
      const json = exportConfigJson();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = `meshtastic-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setBkMsg(t("Backup descargado ✓"));
      setBkCls("");
    } catch (e) {
      setBkMsg(`ERROR: ${e}`);
      setBkCls("err");
    }
  };

  const onRestore = async (file: File) => {
    setBkMsg("");
    try {
      const n = await importConfigJson(await file.text());
      setBkMsg(t("{0} mensajes de config aplicados ✓ (el nodo puede reiniciar)", n));
      setBkCls("");
    } catch (e) {
      setBkMsg(`ERROR: ${e}`);
      setBkCls("err");
    }
  };

  // keeps the fields not exposed in the UI (spread of the current message)
  const saveModule = async (
    payloadVariant: Protobuf.ModuleConfig.ModuleConfig["payloadVariant"],
  ) => {
    await device?.setModuleConfig(
      create(Protobuf.ModuleConfig.ModuleConfigSchema, { payloadVariant }),
    );
    await device?.commitEditSettings();
  };

  const saveMqtt = () =>
    saveModule({
      case: "mqtt",
      value: create(Protobuf.ModuleConfig.ModuleConfig_MQTTConfigSchema, {
        ...mqtt,
        enabled: mqEnabled,
        address: mqAddress,
        username: mqUser,
        password: mqPass,
        encryptionEnabled: mqEnc,
        root: mqRoot,
      }),
    });

  // The firmware requires 14400 s (4 h) minimum: below that it rejects the
  // change and returns the previous config, which looks like "it won't save".
  const NEIGH_MIN = 14_400;

  const saveNeigh = () =>
    saveModule({
      case: "neighborInfo",
      value: create(Protobuf.ModuleConfig.ModuleConfig_NeighborInfoConfigSchema, {
        ...neigh,
        enabled: nbOn,
        updateInterval: nbOn ? Math.max(NEIGH_MIN, nbInt) : nbInt,
        transmitOverLora: nbLora,
      }),
    });

  const saveRangeTest = () =>
    saveModule({
      case: "rangeTest",
      value: create(Protobuf.ModuleConfig.ModuleConfig_RangeTestConfigSchema, {
        ...rangeT,
        enabled: rtOn,
        sender: rtSender,
        save: rtSave,
      }),
    });

  const saveChannel = async (index: number) => {
    const ch = s.channels.get(index);
    if (!ch) return;
    setChMsg("");
    try {
      const psk =
        chPsks[index] !== undefined
          ? pskFromB64(chPsks[index])
          : (ch.settings?.psk ?? new Uint8Array(0));
      const ex = chExtra[index] ?? {};
      await device?.setChannel(
        create(Protobuf.Channel.ChannelSchema, {
          index,
          role: ex.role ?? ch.role,
          // keep the settings not exposed here (spread of the current message)
          settings: {
            ...ch.settings,
            name: chNames[index] ?? ch.name,
            psk,
            uplinkEnabled: ex.uplink ?? ch.settings?.uplinkEnabled ?? false,
            downlinkEnabled: ex.downlink ?? ch.settings?.downlinkEnabled ?? false,
            moduleSettings: {
              ...ch.settings?.moduleSettings,
              positionPrecision:
                ex.precision ??
                ch.settings?.moduleSettings?.positionPrecision ??
                0,
              isMuted:
                ex.muted ?? ch.settings?.moduleSettings?.isMuted ?? false,
            },
          },
        }),
      );
      await device?.commitEditSettings();
      setChMsg(t("Canal {0} guardado ✓", index));
      setChCls("");
    } catch (e) {
      setChMsg(`ERROR: ${e}`);
      setChCls("err");
    }
  };

  const genPsk = (index: number) => {
    const bytes = crypto.getRandomValues(new Uint8Array(32)); // AES-256
    setChPsks({ ...chPsks, [index]: btoa(String.fromCharCode(...bytes)) });
  };

  const onExport = async () => {
    setCopied(false);
    try {
      const settings = [...s.channels.values()]
        .filter((c) => c.role !== 0 && c.settings)
        .sort((a, b) => a.index - b.index)
        .map((c) => c.settings!);
      const url = buildChannelSetUrl(settings, lora ?? undefined);
      setExportUrl(url);
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
      } catch {
        // clipboard may be blocked; the user can copy from the field
      }
    } catch (e) {
      setExportUrl(`ERROR: ${e}`);
    }
  };

  const channels = [...s.channels.values()].sort((a, b) => a.index - b.index);

  return (
    <main style={{ overflowY: "auto", alignItems: "start" }}>
      <div className="cfg-grid">
        <div className="cfg-col">
        <Section title={t("CONFIG // APLICACIÓN")}>
          <div className="form-grid">
            <label>{t("IDIOMA")}</label>
            <select
              value={getLangPref()}
              style={{ width: 140 }}
              onChange={(e) => setLang(e.target.value as Lang | "auto")}
            >
              <option value="auto">
                {t("AUTOMÁTICO")} · {getLang().toUpperCase()}
              </option>
              <option value="es">ESPAÑOL</option>
              <option value="en">ENGLISH</option>
            </select>
            <label>{t("HORA")}</label>
            <select
              value={horaFmt}
              style={{ width: 140 }}
              onChange={(e) => {
                const v = e.target.value as HourPref;
                setHourPref(v);
                setHoraFmt(v);
              }}
            >
              <option value="auto">
                {t("AUTOMÁTICO")} · {is12h() ? "12 H" : "24 H"}
              </option>
              <option value="24">24 H · 15:04</option>
              <option value="12">12 H · 3:04 PM</option>
            </select>
            <label>{t("COLOR")}</label>
            <select
              value={theme}
              style={{ width: 140 }}
              onChange={(e) => {
                const v = e.target.value as Theme;
                setTheme(v);
                setThemeSel(v);
              }}
            >
              {(Object.keys(THEMES) as Theme[]).map((name) => (
                <option key={name} value={name}>
                  {t(THEME_LABELS[name])}
                </option>
              ))}
            </select>

            <label
              title={t("Avisos del sistema sobre los nodos marcados favoritos")}
            >
              {t("ALERTAS FAVORITOS")}
            </label>
            <input
              type="checkbox"
              checked={alerts.on}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => saveAlerts({ on: e.target.checked })}
            />
            <label>{t("AVISAR BATERÍA <")}</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min={1}
                max={100}
                disabled={!alerts.on}
                value={alerts.battery}
                style={{ width: 80 }}
                onChange={(e) => saveAlerts({ battery: Number(e.target.value) })}
              />
              <span className="dim">%</span>
            </div>
            <label>{t("AVISAR SIN SEÑAL")}</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min={1}
                disabled={!alerts.on}
                value={alerts.silentH}
                style={{ width: 80 }}
                onChange={(e) => saveAlerts({ silentH: Number(e.target.value) })}
              />
              <span className="dim">{t("h")}</span>
            </div>
            <label
              title={t(
                "Avisa antes de que la batería esté baja, según el ritmo de descarga. 0 = no avisar",
              )}
            >
              {t("AVISAR AUTONOMÍA <")}
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min={0}
                disabled={!alerts.on}
                value={alerts.autonomiaH}
                style={{ width: 80 }}
                onChange={(e) =>
                  saveAlerts({ autonomiaH: Number(e.target.value) })
                }
              />
              <span className="dim">{t("h")}</span>
            </div>
          </div>
          <p className="dim" style={{ padding: "0 14px 12px", fontSize: 11 }}>
            {t(
              "Solo avisa de los nodos marcados con ★ en NODOS, y como mucho una vez cada 6 h por nodo y motivo.",
            )}
          </p>
        </Section>

        <Section title={t("CONFIG // USUARIO")} onSave={saveOwner}>
          <div className="form-grid">
            <label>{t("NOMBRE LARGO")}</label>
            <input
              value={longName}
              maxLength={39}
              onChange={(e) => setLongName(e.target.value)}
            />
            <label>{t("NOMBRE CORTO")}</label>
            <input
              value={shortName}
              maxLength={4}
              style={{ width: 90 }}
              onChange={(e) => setShortName(e.target.value)}
            />
            <label>{t("ID NODO")}</label>
            <span className="dim">
              {s.myNodeNum !== undefined
                ? `!${s.myNodeNum.toString(16)} · ${t("SOLO LECTURA")}`
                : "—"}
            </span>
          </div>
        </Section>

        <Section title="CONFIG // LORA" onSave={saveLora}>
          <div className="form-grid">
            <label>{t("REGIÓN")}</label>
            <select
              value={region}
              onChange={(e) => setRegion(Number(e.target.value))}
            >
              {enumOptions(
                Protobuf.Config.Config_LoRaConfig_RegionCodeSchema,
              ).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label>MODEM PRESET</label>
            <select
              value={preset}
              onChange={(e) => setPreset(Number(e.target.value))}
            >
              {enumOptions(
                Protobuf.Config.Config_LoRaConfig_ModemPresetSchema,
              ).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label>HOP LIMIT</label>
            <input
              type="number"
              min={1}
              max={7}
              value={hopLimit}
              style={{ width: 70 }}
              onChange={(e) => setHopLimit(Number(e.target.value))}
            />
            <label>{t("TX ACTIVADO")}</label>
            <input
              type="checkbox"
              checked={txEnabled}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setTxEnabled(e.target.checked)}
            />
          </div>
        </Section>

        <Section title={t("CONFIG // DISPOSITIVO")} onSave={saveDevice}>
          <div className="form-grid">
            <label>{t("ROL")}</label>
            <select
              value={devRole}
              onChange={(e) => setDevRole(Number(e.target.value))}
            >
              {enumOptions(Protobuf.Config.Config_DeviceConfig_RoleSchema).map(
                (o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ),
              )}
            </select>
            <label>{t("BROADCAST POSICIÓN (s)")}</label>
            <input
              type="number"
              min={0}
              value={posBcast}
              style={{ width: 100 }}
              onChange={(e) => setPosBcast(Number(e.target.value))}
            />
            <label>SMART POSITION</label>
            <input
              type="checkbox"
              checked={posSmart}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setPosSmart(e.target.checked)}
            />
            <label>{t("PANTALLA ON (s)")}</label>
            <input
              type="number"
              min={0}
              value={dispSecs}
              style={{ width: 100 }}
              onChange={(e) => setDispSecs(Number(e.target.value))}
            />
            <label>{t("AHORRO ENERGÍA")}</label>
            <input
              type="checkbox"
              checked={pwrSave}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setPwrSave(e.target.checked)}
            />
          </div>
        </Section>

        </div>
        <div className="cfg-col">
        <Section title={t("CONFIG // POSICIÓN FIJA")}>
          <div
            style={{
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              fontSize: 12,
            }}
          >
            <span className="dim">
              {t("Para nodos sin GPS: el firmware difunde esta posición al mesh.")}
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label>LAT</label>
              <input
                placeholder={me?.lat !== undefined ? String(me.lat) : "39.5696"}
                value={posLat}
                style={{ width: 120 }}
                onChange={(e) => setPosLat(e.target.value)}
              />
              <label>LON</label>
              <input
                placeholder={me?.lon !== undefined ? String(me.lon) : "2.6502"}
                value={posLon}
                style={{ width: 120 }}
                onChange={(e) => setPosLon(e.target.value)}
              />
              <button
                className="primary"
                disabled={!posLat.trim() || !posLon.trim()}
                onClick={async () => {
                  setPosMsg("");
                  const lat = Number(posLat.replace(",", "."));
                  const lon = Number(posLon.replace(",", "."));
                  if (
                    !Number.isFinite(lat) ||
                    !Number.isFinite(lon) ||
                    Math.abs(lat) > 90 ||
                    Math.abs(lon) > 180
                  ) {
                    setPosMsg(t("ERROR: coordenadas inválidas"));
                    setPosCls("err");
                    return;
                  }
                  try {
                    await setFixedPosition(lat, lon);
                    setPosMsg(t("Posición fija enviada ✓"));
                    setPosCls("");
                  } catch (e) {
                    setPosMsg(`ERROR: ${e}`);
                    setPosCls("err");
                  }
                }}
              >
                {t("FIJAR")}
              </button>
              <button
                onClick={async () => {
                  setPosMsg("");
                  try {
                    await clearFixedPosition();
                    setPosMsg(t("Posición fija eliminada ✓"));
                    setPosCls("");
                  } catch (e) {
                    setPosMsg(`ERROR: ${e}`);
                    setPosCls("err");
                  }
                }}
              >
                {t("QUITAR")}
              </button>
            </div>
            {posMsg && (
              <span className={posCls} style={{ fontSize: 11 }}>
                {posMsg}
              </span>
            )}
          </div>
        </Section>

        <Section title={t("CONFIG // CANALES")}>
          <div
            style={{
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                borderBottom: "1px solid var(--border)",
                paddingBottom: 10,
                marginBottom: 2,
              }}
            >
              <input
                placeholder={t("PEGA URL meshtastic.org/e/#…")}
                value={chUrl}
                style={{ flex: 1 }}
                onChange={(e) => {
                  setChUrl(e.target.value);
                  setImportPending(""); // URL changed → invalidates the confirmation
                }}
              />
              <button
                className="primary"
                disabled={!chUrl.trim()}
                onClick={async () => {
                  setImportMsg("");
                  // 1st click: show what the URL brings; 2nd click: apply
                  if (!importPending) {
                    try {
                      const set = parseChannelSetUrl(chUrl);
                      const names = set.settings
                        .map(
                          (c: Protobuf.Channel.ChannelSettings, i: number) =>
                            c.name || (i === 0 ? t("Principal") : t("Canal {0}", i)),
                        )
                        .join(", ");
                      setImportPending(chUrl);
                      setImportMsg(
                        t("Sobrescribirá {0} canales ({1})", set.settings.length, names) +
                          (set.loraConfig ? t(" + config LoRa") : "") +
                          t(". Pulsa CONFIRMAR."),
                      );
                      setImportCls("warn");
                    } catch (e) {
                      setImportMsg(`ERROR: ${e}`);
                      setImportCls("err");
                    }
                    return;
                  }
                  try {
                    const n = await importChannelSet(importPending);
                    setImportMsg(t("{0} canales importados ✓", n));
                    setImportCls("");
                    setChUrl("");
                  } catch (e) {
                    setImportMsg(`ERROR: ${e}`);
                    setImportCls("err");
                  } finally {
                    setImportPending("");
                  }
                }}
              >
                {importPending ? t("CONFIRMAR") : t("IMPORTAR")}
              </button>
            </div>
            {importMsg && (
              <span className={importCls || "warn"} style={{ fontSize: 11 }}>
                {importMsg}
              </span>
            )}
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                borderBottom: "1px solid var(--border)",
                paddingBottom: 10,
                marginBottom: 2,
              }}
            >
              <button
                className="primary"
                disabled={s.channels.size === 0}
                onClick={onExport}
              >
                {t("EXPORTAR URL")}
              </button>
              {exportUrl && (
                <>
                  <input
                    readOnly
                    value={exportUrl}
                    style={{ flex: 1 }}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(exportUrl).then(
                        () => setCopied(true),
                        () => {},
                      );
                    }}
                  >
                    {copied ? t("COPIADO ✓") : t("COPIAR")}
                  </button>
                </>
              )}
            </div>
            {channels.length === 0 && (
              <span className="dim">{t("— aún no se han recibido canales —")}</span>
            )}
            {chMsg && (
              <span className={chCls || "warn"} style={{ fontSize: 11 }}>
                {chMsg}
              </span>
            )}
            {channels.map((ch) => {
              // DISABLED → first line only; the rest of the options don't apply
              const roleNow = chExtra[ch.index]?.role ?? ch.role;
              return (
              <div
                key={ch.index}
                className={ch.role === 0 ? "dim" : ""}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  border: "1px solid var(--border)",
                  padding: "6px 10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontWeight: 700 }}>{ch.index}</span>
                  <input
                    value={chNames[ch.index] ?? ch.name}
                    style={{ flex: 1, border: "none", background: "transparent" }}
                    onChange={(e) =>
                      setChNames({ ...chNames, [ch.index]: e.target.value })
                    }
                  />
                  <select
                    value={chExtra[ch.index]?.role ?? ch.role}
                    style={{ width: "auto" }}
                    onChange={(e) =>
                      setChExtra({
                        ...chExtra,
                        [ch.index]: {
                          ...chExtra[ch.index],
                          role: Number(e.target.value),
                        },
                      })
                    }
                  >
                    {Protobuf.Channel.Channel_RoleSchema.values.map((v: { number: number; name: string }) => (
                      <option key={v.number} value={v.number}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => saveChannel(ch.index)}>{t("GUARDAR")}</button>
                </div>
                {roleNow !== 0 && (
                <>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="dim" style={{ fontSize: 10, letterSpacing: 1 }}>
                    PSK
                  </span>
                  <input
                    placeholder={t("— sin cifrado —")}
                    value={chPsks[ch.index] ?? pskToB64(ch.settings?.psk)}
                    style={{ flex: 1, fontFamily: "inherit", fontSize: 11 }}
                    onChange={(e) =>
                      setChPsks({ ...chPsks, [ch.index]: e.target.value })
                    }
                  />
                  <button
                    title={t("Generar clave AES-256 aleatoria")}
                    onClick={() => genPsk(ch.index)}
                  >
                    GEN
                  </button>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    fontSize: 11,
                    flexWrap: "wrap",
                  }}
                >
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                    title={t("Los gateways MQTT suben los mensajes de este canal a internet")}
                  >
                    <input
                      type="checkbox"
                      checked={
                        chExtra[ch.index]?.uplink ??
                        ch.settings?.uplinkEnabled ??
                        false
                      }
                      onChange={(e) =>
                        setChExtra({
                          ...chExtra,
                          [ch.index]: {
                            ...chExtra[ch.index],
                            uplink: e.target.checked,
                          },
                        })
                      }
                    />
                    UPLINK
                  </label>
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                    title={t("Los mensajes vistos en internet se reenvían a la malla")}
                  >
                    <input
                      type="checkbox"
                      checked={
                        chExtra[ch.index]?.downlink ??
                        ch.settings?.downlinkEnabled ??
                        false
                      }
                      onChange={(e) =>
                        setChExtra({
                          ...chExtra,
                          [ch.index]: {
                            ...chExtra[ch.index],
                            downlink: e.target.checked,
                          },
                        })
                      }
                    />
                    DOWNLINK
                  </label>
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                    title={t("Silenciar: la app no notifica los mensajes de este canal")}
                  >
                    <input
                      type="checkbox"
                      checked={
                        chExtra[ch.index]?.muted ??
                        ch.settings?.moduleSettings?.isMuted ??
                        false
                      }
                      onChange={(e) =>
                        setChExtra({
                          ...chExtra,
                          [ch.index]: {
                            ...chExtra[ch.index],
                            muted: e.target.checked,
                          },
                        })
                      }
                    />
                    MUTE
                  </label>
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                    title={t("Precisión de la posición difundida por este canal")}
                  >
                    <span className="dim" style={{ letterSpacing: 1 }}>POS</span>
                    <select
                      style={{ width: "auto", fontSize: 11 }}
                      value={
                        chExtra[ch.index]?.precision ??
                        ch.settings?.moduleSettings?.positionPrecision ??
                        0
                      }
                      onChange={(e) =>
                        setChExtra({
                          ...chExtra,
                          [ch.index]: {
                            ...chExtra[ch.index],
                            precision: Number(e.target.value),
                          },
                        })
                      }
                    >
                      {PRECISION_OPTS.map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                </>
                )}
              </div>
              );
            })}
          </div>
        </Section>

        <Section title="MÓDULO // MQTT" onSave={saveMqtt}>
          <div className="form-grid">
            <label>{t("ACTIVADO")}</label>
            <input
              type="checkbox"
              checked={mqEnabled}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setMqEnabled(e.target.checked)}
            />
            <label>{t("SERVIDOR")}</label>
            <input
              placeholder="mqtt.meshtastic.org"
              value={mqAddress}
              onChange={(e) => setMqAddress(e.target.value)}
            />
            <label>{t("USUARIO")}</label>
            <input value={mqUser} onChange={(e) => setMqUser(e.target.value)} />
            <label>{t("CONTRASEÑA")}</label>
            <input
              type="password"
              value={mqPass}
              onChange={(e) => setMqPass(e.target.value)}
            />
            <label>{t("CIFRADO")}</label>
            <input
              type="checkbox"
              checked={mqEnc}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setMqEnc(e.target.checked)}
            />
            <label>ROOT TOPIC</label>
            <input
              placeholder="msh/EU_868"
              value={mqRoot}
              onChange={(e) => setMqRoot(e.target.value)}
            />
          </div>
        </Section>

        </div>
        <div className="cfg-col">
        <Section title="MÓDULO // NEIGHBOR INFO" onSave={saveNeigh}>
          <div className="form-grid">
            <label>{t("ACTIVADO")}</label>
            <input
              type="checkbox"
              checked={nbOn}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setNbOn(e.target.checked)}
            />
            <label>{t("INTERVALO (s)")}</label>
            <input
              type="number"
              min={NEIGH_MIN}
              step={3600}
              value={nbInt}
              style={{ width: 100 }}
              onChange={(e) => setNbInt(Number(e.target.value))}
            />
            <label
              title={t(
                "Sin esto los vecinos solo van por MQTT/USB, no por radio: la malla no los ve",
              )}
            >
              {t("EMITIR POR LORA")}
            </label>
            <input
              type="checkbox"
              checked={nbLora}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setNbLora(e.target.checked)}
            />
          </div>
          <p className="dim" style={{ padding: "0 14px 12px", fontSize: 11 }}>
            {nbOn && nbInt < NEIGH_MIN && (
              <span className="warn">
                {t(
                  "El firmware exige 14400 s (4 h) como mínimo; por debajo rechaza el cambio. Al guardar se subirá a 14400.",
                )}
                <br />
              </span>
            )}
            {t(
              "EMITIR POR LORA no funciona en un canal con nombre y clave por defecto: usa un canal propio si quieres ver vecinos en la pestaña MALLA.",
            )}
          </p>
        </Section>

        <Section title="MÓDULO // RANGE TEST" onSave={saveRangeTest}>
          <div className="form-grid">
            <label>{t("ACTIVADO")}</label>
            <input
              type="checkbox"
              checked={rtOn}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setRtOn(e.target.checked)}
            />
            <label>{t("EMITIR CADA (s)")}</label>
            <input
              type="number"
              min={0}
              value={rtSender}
              style={{ width: 100 }}
              onChange={(e) => setRtSender(Number(e.target.value))}
            />
            <label>{t("GUARDAR EN SD")}</label>
            <input
              type="checkbox"
              checked={rtSave}
              style={{ justifySelf: "start", width: "auto" }}
              onChange={(e) => setRtSave(e.target.checked)}
            />
          </div>
          <p className="dim" style={{ padding: "0 14px 12px", fontSize: 11 }}>
            {t(
              "0 en EMITIR = sólo recibe. Emitir satura el canal: úsalo en pruebas cortas y vuelve a 0. Los paquetes recibidos salen en el LOG.",
            )}
          </p>
        </Section>

        <Section title={t("CONFIG // BACKUP")}>
          <div
            style={{
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              fontSize: 12,
            }}
          >
            <span className="dim">
              {t("Config completa del nodo (radio, módulos y canales con PSK) a JSON.")}
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="primary" onClick={onBackup}>
                {t("GUARDAR BACKUP")}
              </button>
              <label
                className="btn"
                style={{
                  border: "1px solid var(--border)",
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                {t("RESTAURAR…")}
                <input
                  type="file"
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onRestore(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {bkMsg && (
              <span className={bkCls} style={{ fontSize: 11 }}>
                {bkMsg}
              </span>
            )}
          </div>
        </Section>

        <Section title={t("CONFIG // BASE DE DATOS")}>
          <div
            style={{
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              fontSize: 12,
            }}
          >
            <span className="dim">
              {stats
                ? t(
                    "{0} mensajes · {1} muestras de telemetría · {2} nodos",
                    stats.messages,
                    stats.telemetry,
                    stats.nodes,
                  )
                : t("leyendo…")}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span>{t("borrar lo anterior a")}</span>
              <input
                type="number"
                min={1}
                value={purgeDays}
                style={{ width: 80 }}
                onChange={(e) => {
                  setPurgeDays(Number(e.target.value));
                  setPurgeArm(false);
                }}
              />
              <span>{t("días")}</span>
              <button
                className="danger"
                style={{ width: 180 }}
                onClick={onPurge}
              >
                {purgeArm ? t("[ ¿SEGURO? ]") : t("[ PURGAR ]")}
              </button>
            </div>
            <span className="dim">
              {t("afecta a mensajes y telemetría · los nodos no se tocan")}
            </span>
            {purgeMsg && <span className="warn">{purgeMsg}</span>}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                borderTop: "1px solid var(--border)",
                paddingTop: 10,
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={autoPurge > 0}
                  onChange={(e) => {
                    const v = e.target.checked ? purgeDays : 0;
                    setAutoPurge(v);
                    setAutoPurgeDays(v);
                  }}
                />
                {t("PURGAR AL ARRANCAR")}
              </label>
              <input
                type="number"
                min={1}
                disabled={autoPurge === 0}
                value={autoPurge || purgeDays}
                style={{ width: 80 }}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setAutoPurge(v);
                  setAutoPurgeDays(v);
                }}
              />
              <span>{t("días")}</span>
            </div>
          </div>
        </Section>

        <Section title={t("CONFIG // MANTENIMIENTO")}>
          <div
            style={{
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              fontSize: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                className="primary"
                style={{ width: 180 }}
                onClick={() => {
                  device?.reboot(5);
                  setMaint(t("REBOOT enviado · ~8 s offline"));
                }}
              >
                [ REBOOT ]
              </button>
              <span className="dim">{t("reinicia el dispositivo · ~8 s offline")}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                className="danger"
                style={{ width: 180 }}
                onClick={() => {
                  device?.shutdown(5);
                  setMaint(t("SHUTDOWN enviado"));
                }}
              >
                [ SHUTDOWN ]
              </button>
              <span className="dim">{t("apaga el nodo · requiere encendido manual")}</span>
            </div>
            {maint && <span className="warn">{maint}</span>}
          </div>
        </Section>
        </div>
      </div>
    </main>
  );
}
