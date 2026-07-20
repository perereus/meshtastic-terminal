import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { parseChannelSetUrl } from "./channelUrl";
import { COOLDOWN_MS, getAlertCfg } from "./alerts";
import { t } from "./i18n";
import { createSerialTransport } from "./transport/serial";
import { waitConfigured } from "./handshake";
import { createTcpTransport } from "./transport/tcp";
import { createBleTransport } from "./transport/ble";
import {
  addLog,
  convoKey,
  getSnapshot,
  markUnread,
  mutate,
  type Message,
  type NodeEntry,
  type Waypoint,
} from "./store";
import {
  deleteNodeDb,
  deleteWaypointDb,
  loadMessages,
  loadNodes,
  loadWaypoints,
  marcarEscucha,
  saveHopChange,
  saveMessage,
  saveNeighbors,
  saveNode,
  saveTelemetry,
  saveTraceroute,
  saveWaypoint,
  updateMessageState,
} from "./db";

export let device: MeshDevice | undefined;

export async function loadHistory(): Promise<void> {
  const msgs = await loadMessages();
  const nodes = await loadNodes();
  const wps = await loadWaypoints();
  mutate((s) => {
    s.messages = msgs;
    s.waypoints = new Map(wps.map((w) => [w.id, w]));
    // DB first; the radio's dump overwrites field by field what it brings
    // (upsertNode keeps the previous value when the patch says undefined).
    s.nodes = new Map(nodes.map((n) => [n.num, n]));
  });
}

// A failed SQLite write must not take down packet reception, but it can't
// vanish either: with no trace it's impossible to tell whether a table is
// empty because the data never arrived or because the write failed.
function dbFail(what: string) {
  return (e: unknown) => addLog(`BD: fallo al guardar ${what}: ${e}`);
}

// System notification. Permission is requested the first time.
export async function notify(title: string, body: string): Promise<void> {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body });
  } catch {
    // no notification support: not critical
  }
}

// Incoming messages: only when the window isn't focused (if you're looking at
// the chat there's no need). Node alerts always notify: they don't depend on
// you looking at the right screen.
async function notifyIncoming(title: string, body: string): Promise<void> {
  if (await getCurrentWindow().isFocused().catch(() => false)) return;
  await notify(title, body);
}

function upsertNode(num: number, patch: Partial<NodeEntry>): void {
  mutate((s) => {
    const prev = s.nodes.get(num) ?? {
      num,
      longName: `!${num.toString(16)}`,
      shortName: num.toString(16).slice(-4),
      lastHeard: 0,
    };
    // ponytail: a patch with undefined must NOT overwrite the default/previous
    // value (e.g. NodeInfo without user left longName=undefined → localeCompare crashes)
    for (const k of Object.keys(patch) as (keyof NodeEntry)[]) {
      if (patch[k] === undefined) delete patch[k];
    }
    const merged = { ...prev, ...patch };
    s.nodes = new Map(s.nodes).set(num, merged);
    // ponytail: one write per event; SQLite handles this rate easily
    saveNode(merged).catch(dbFail("nodo"));
    // Only counts as a sighting once we're configured: during the initial dump
    // the radio re-sends its whole NodeDB and we'd mark 91 nodes as
    // "heard now" on every startup. The packet's lastHeard (epoch s) is used
    // so the hour is the real one and not the connection time.
    if (
      patch.lastHeard !== undefined &&
      s.status === Types.DeviceStatusEnum.DeviceConfigured
    ) {
      marcarEscucha(num, patch.lastHeard * 1000).catch(dbFail("escucha"));
    }

    // Distance change: a node going from direct to 2 hops usually means a
    // repeater down or a moved antenna. Only with the radio already
    // configured, for the same reason as sightings.
    if (
      patch.hopsAway !== undefined &&
      prev.hopsAway !== undefined &&
      patch.hopsAway !== prev.hopsAway &&
      s.status === Types.DeviceStatusEnum.DeviceConfigured
    ) {
      avisarCambioRuta(merged, prev.hopsAway);
    }
  });
}

// One warning per node every 6 h: the distance can oscillate between two
// values for a while and we don't want a notification per bounce.
const rutaAvisada = new Map<number, number>();

function avisarCambioRuta(n: NodeEntry, antes: number): void {
  const ahora = n.hopsAway as number;
  saveHopChange(n.num, ahora, antes).catch(dbFail("cambio de ruta"));
  const quien = n.longName || n.shortName;
  addLog(`RUTA: ${quien} pasa de ${antes} a ${ahora} saltos`);
  if (!n.fav || !getAlertCfg().on) return;
  if (Date.now() - (rutaAvisada.get(n.num) ?? -Infinity) < COOLDOWN_MS) return;
  rutaAvisada.set(n.num, Date.now());
  void notify(
    t("{0} · ruta {1}", quien, ahora > antes ? t("más larga") : t("más corta")),
    t("Ahora a {0} saltos (antes {1})", ahora, antes),
  );
}

function wireEvents(d: MeshDevice): void {
  d.events.onDeviceStatus.subscribe((status) => {
    mutate((s) => {
      s.status = status;
    });
    addLog(`Estado: ${Types.DeviceStatusEnum[status]}`);
  });

  d.events.onMyNodeInfo.subscribe((info) => {
    mutate((s) => {
      s.myNodeNum = info.myNodeNum;
    });
  });

  d.events.onNodeInfoPacket.subscribe((node) => {
    upsertNode(node.num, {
      longName: node.user?.longName ?? undefined,
      shortName: node.user?.shortName ?? undefined,
      // real lastHeard from the firmware. If it's 0 (node never heard directly)
      // we don't fabricate it: undefined → upsert keeps prev/default (ago() shows "—").
      lastHeard: node.lastHeard || undefined,
      snr: node.snr,
      batteryLevel: node.deviceMetrics?.batteryLevel,
      voltage: node.deviceMetrics?.voltage,
      lat: node.position?.latitudeI
        ? node.position.latitudeI / 1e7
        : undefined,
      lon: node.position?.longitudeI
        ? node.position.longitudeI / 1e7
        : undefined,
      hwModel: node.user?.hwModel !== undefined ? String(node.user.hwModel) : undefined,
      hopsAway: node.hopsAway,
      viaMqtt: node.viaMqtt,
      // without user we know nothing about its key: undefined keeps the previous value
      hasKey: node.user ? node.user.publicKey.length > 0 : undefined,
    });
  });

  // During the NodeDB dump (configure) the core re-emits user/position for
  // every node. Those are NOT live sightings: we only stamp "now" when already
  // configured; during the dump we keep the lastHeard set by onNodeInfoPacket.
  const liveTs = () =>
    getSnapshot().status === Types.DeviceStatusEnum.DeviceConfigured
      ? Math.floor(Date.now() / 1000)
      : undefined;

  d.events.onUserPacket.subscribe((u) => {
    upsertNode(u.from, {
      longName: u.data.longName,
      shortName: u.data.shortName,
      lastHeard: liveTs(),
      // public key present ⇒ DMs with this node are encrypted with PKI
      hasKey: (u.data.publicKey?.length ?? 0) > 0,
    });
  });

  d.events.onWaypointPacket.subscribe((p) => {
    const w = p.data;
    // deletion: the firmware re-sends the waypoint with expire in the past
    const expired = w.expire > 0 && w.expire * 1000 < Date.now();
    mutate((s) => {
      const m = new Map(s.waypoints);
      if (expired) m.delete(w.id);
      else
        m.set(w.id, {
          id: w.id,
          lat: (w.latitudeI ?? 0) / 1e7,
          lon: (w.longitudeI ?? 0) / 1e7,
          name: w.name,
          description: w.description,
          icon: w.icon,
          expire: w.expire,
          lockedTo: w.lockedTo,
          from: p.from,
        });
      s.waypoints = m;
      const saved = m.get(w.id);
      if (saved) saveWaypoint(saved).catch(dbFail("waypoint"));
      else deleteWaypointDb(w.id).catch(dbFail("waypoint"));
    });
    const who = getSnapshot().nodes.get(p.from)?.shortName ?? p.from.toString(16);
    addLog(`WAYPOINT ${expired ? "borrado" : "recibido"} de ${who}: ${w.name}`);
  });

  d.events.onRangeTestPacket.subscribe((r) => {
    const n = getSnapshot().nodes.get(r.from);
    const snr = n?.snr !== undefined ? ` · SNR ${n.snr.toFixed(1)} dB` : "";
    const hops = n?.hopsAway !== undefined ? ` · ${n.hopsAway} saltos` : "";
    addLog(
      `RANGE TEST de ${n?.shortName ?? r.from.toString(16)}: "${new TextDecoder().decode(r.data)}"${snr}${hops}`,
    );
  });

  d.events.onPositionPacket.subscribe((p) => {
    // "reply received" signal BEFORE the filter: a position without a fix
    // also answers the position request
    mutate((s) => {
      s.posUpdates = new Map(s.posUpdates).set(p.from, Date.now());
    });
    if (!p.data.latitudeI && !p.data.longitudeI) return;
    upsertNode(p.from, {
      lat: p.data.latitudeI ? p.data.latitudeI / 1e7 : undefined,
      lon: p.data.longitudeI ? p.data.longitudeI / 1e7 : undefined,
      lastHeard: liveTs(),
    });
  });

  d.events.onTelemetryPacket.subscribe((t) => {
    const ts = Date.now();
    const variant = t.data.variant;
    if (!variant.case || !variant.value) return;
    const metrics = variant.value as unknown as Record<string, unknown>;
    for (const [key, val] of Object.entries(metrics)) {
      if (typeof val === "number" && Number.isFinite(val)) {
        saveTelemetry(t.from, key, val, ts).catch(dbFail("telemetría"));
      }
    }
    if (variant.case === "deviceMetrics") {
      const dm = variant.value;
      upsertNode(t.from, {
        batteryLevel: dm.batteryLevel,
        voltage: dm.voltage,
        lastHeard: Math.floor(ts / 1000),
      });
    }
  });

  d.events.onMessagePacket.subscribe((pkt) => {
    // The core echoes our own packet (echoResponse=true) as soon as the radio
    // accepts it. We don't duplicate it: we use it to mark "sent".
    const { myNodeNum } = getSnapshot();
    if (myNodeNum !== undefined && pkt.from === myNodeNum) {
      mutate((s) => {
        let done = false;
        s.messages = s.messages.map((m) => {
          if (
            !done &&
            m.mine &&
            m.state === "queued" &&
            m.text === pkt.data &&
            m.channel === pkt.channel
          ) {
            done = true;
            return { ...m, state: "sent" as const };
          }
          return m;
        });
      });
      // ponytail: "sent" is transient, we don't persist it; delivered/failed we do
      return;
    }
    // ignored node: drop its message (no chat, no unread, no notification)
    if (getSnapshot().nodes.get(pkt.from)?.ignored) return;
    const msg: Message = {
      id: pkt.id,
      convo: "",
      from: pkt.from,
      to: pkt.to,
      channel: pkt.channel,
      text: pkt.data,
      ts: pkt.rxTime.getTime() || Date.now(),
      mine: false,
      state: "delivered",
    };
    msg.convo = convoKey(msg);
    mutate((s) => {
      s.messages = [...s.messages, msg];
    });
    markUnread(msg.convo);
    saveMessage(msg).catch(dbFail("mensaje"));
    const { nodes, channels } = getSnapshot();
    const who = nodes.get(pkt.from)?.longName ?? `!${pkt.from.toString(16)}`;
    const isDm = msg.convo.startsWith("dm:");
    const where = isDm ? "DM" : `#${channels.get(pkt.channel)?.name ?? pkt.channel}`;
    // The channel MUTE (checkbox in CONFIG // CHANNELS) silences only the
    // channel: a DM still notifies even when it arrives on a muted channel.
    const muted =
      !isDm &&
      (channels.get(pkt.channel)?.settings?.moduleSettings?.isMuted ?? false);
    if (!muted) void notifyIncoming(`${who} · ${where}`, pkt.data);
  });

  d.events.onTraceRoutePacket.subscribe((pkt) => {
    const tr = {
      route: pkt.data.route,
      snrTowards: pkt.data.snrTowards,
      routeBack: pkt.data.routeBack,
      snrBack: pkt.data.snrBack,
      ts: Date.now(),
    };
    mutate((s) => {
      s.traceroutes = new Map(s.traceroutes).set(pkt.from, tr);
    });
    saveTraceroute(pkt.from, tr).catch(dbFail("traceroute"));
    addLog(`Traceroute de !${pkt.from.toString(16)}: ${pkt.data.route.length + 1} saltos ida`);
  });

  // NeighborInfo: each node publishes who it hears and with what SNR. It's the
  // only source of links that doesn't depend on running traceroutes by hand.
  d.events.onNeighborInfoPacket.subscribe((pkt) => {
    const src = pkt.data.nodeId || pkt.from;
    const neighbors = pkt.data.neighbors.map(
      (n: { nodeId: number; snr: number }) => ({ num: n.nodeId, snr: n.snr }),
    );
    saveNeighbors(src, neighbors, Date.now()).catch(dbFail("vecinos"));
    addLog(`NeighborInfo de !${src.toString(16)}: ${neighbors.length} vecinos`);
  });

  d.events.onChannelPacket.subscribe((ch) => {
    mutate((s) => {
      s.channels = new Map(s.channels).set(ch.index, {
        index: ch.index,
        name: ch.settings?.name || (ch.index === 0 ? "Principal" : `Canal ${ch.index}`),
        role: ch.role,
        settings: ch.settings, // keep PSK/opts so the URL can be exported
      });
    });
  });

  d.events.onConfigPacket.subscribe((cfg) => {
    if (!cfg.payloadVariant.case) return;
    mutate((s) => {
      s.config = new Map(s.config).set(
        cfg.payloadVariant.case as string,
        cfg.payloadVariant.value,
      );
    });
  });

  d.events.onModuleConfigPacket.subscribe((cfg) => {
    if (!cfg.payloadVariant.case) return;
    mutate((s) => {
      s.moduleConfig = new Map(s.moduleConfig).set(
        cfg.payloadVariant.case as string,
        cfg.payloadVariant.value,
      );
    });
  });
}

// Handshake budget. Generous: over BLE the initial NodeDB dump is slow, and a
// real reconnect measured 26 s with ~90 nodes. It only bites when the link is
// up but silent — an actual drop rejects at once via DeviceDisconnected.
const CONFIG_TIMEOUT_MS = 90_000;
// Ceilings for the two steps that can hang with no error of their own: opening
// the transport (the BLE plugin's connect) and configure() (a stuck BLE write).
const OPEN_TIMEOUT_MS = 40_000;
const WRITE_TIMEOUT_MS = 15_000;

/** connect() must never hang forever: it is the only thing gating the retry
 *  loop, and a caller-side timeout can't cancel it, only race it — leaving a
 *  zombie connect that finishes in the background and fights the next attempt
 *  for the single global BLE link. So every await that can hang is bounded
 *  here instead. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} no respondió en ${ms / 1000}s`)), ms),
    ),
  ]);
}

/** Takes a factory, not a transport, so the previous device is torn down
 *  BEFORE the new link exists: the BLE plugin holds a single global connection
 *  and disconnecting the old one afterwards would kill the new one. */
async function connect(make: () => Promise<Types.Transport>): Promise<void> {
  // The old MeshDevice keeps its heartbeat timer running (only disconnect()
  // clears it) and would write into whatever link is current.
  const prev = device;
  device = undefined;
  if (prev) await prev.disconnect().catch(() => {});

  const transport = await withTimeout(make(), OPEN_TIMEOUT_MS, "la conexión");
  const d = new MeshDevice(transport);
  wireEvents(d);
  device = d;
  try {
    // subscribe before configure(): the reply can arrive first
    const configured = waitConfigured(d, CONFIG_TIMEOUT_MS);
    configured.catch(() => {}); // if configure() throws first, nobody awaits it
    await withTimeout(d.configure(), WRITE_TIMEOUT_MS, "configure");
    await configured;
  } catch (e) {
    device = undefined;
    // leave nothing half-open, or the next attempt finds the plugin still
    // believing it is connected and returns OK without reconnecting
    await d.disconnect().catch(() => {});
    throw e;
  }
  d.setHeartbeatInterval(60_000);
}

export async function connectSerial(path: string): Promise<void> {
  await connect(() => createSerialTransport(path, handleLost));
}

export async function connectTcp(host: string): Promise<void> {
  await connect(() => createTcpTransport(host, handleLost));
}

// The app registers here what to do when the link drops on its own (not a
// manual disconnect): it triggers auto-reconnection.
let onConnectionLost: (() => void) | undefined;
export function setConnectionLostHandler(cb: (() => void) | undefined): void {
  onConnectionLost = cb;
}

function handleLost(): void {
  if (!device) return; // already disconnected manually
  device = undefined;
  mutate((s) => {
    s.status = Types.DeviceStatusEnum.DeviceDisconnected;
  });
  addLog("Enlace perdido");
  // A missing handler used to be an invisible dead end: the log said the link
  // dropped and nothing else ever happened.
  if (!onConnectionLost) {
    addLog("RECONEXION: sin manejador registrado, no se reintenta");
    return;
  }
  onConnectionLost();
}

export async function connectBle(address: string): Promise<void> {
  await connect(() => createBleTransport(address, handleLost));
}

// Imports channels from a Meshtastic URL (https://meshtastic.org/e/#<b64url>).
// Also accepts just the base64 fragment. Returns the number of channels applied.
export async function importChannelSet(url: string): Promise<number> {
  if (!device) throw new Error("Sin conexión");
  const set = parseChannelSetUrl(url);
  for (let i = 0; i < set.settings.length; i++) {
    await device.setChannel(
      create(Protobuf.Channel.ChannelSchema, {
        index: i,
        role:
          i === 0
            ? Protobuf.Channel.Channel_Role.PRIMARY
            : Protobuf.Channel.Channel_Role.SECONDARY,
        settings: set.settings[i],
      }),
    );
  }
  if (set.loraConfig) {
    await device.setConfig(
      create(Protobuf.Config.ConfigSchema, {
        payloadVariant: { case: "lora", value: set.loraConfig },
      }),
    );
  }
  await device.commitEditSettings();
  addLog(`Importados ${set.settings.length} canales desde URL`);
  return set.settings.length;
}

// ── Full config backup/restore ─────────────────────────────────────────────
// Each protobuf message is serialized to binary+base64 inside a JSON:
// robust against new fields and without depending on protobuf's JSON format.
const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64ToBytes = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function exportConfigJson(): string {
  const { config, moduleConfig, channels } = getSnapshot();
  const configs: string[] = [];
  for (const [case_, value] of config) {
    if (case_ === "sessionkey") continue; // ephemeral, not restorable
    configs.push(
      bytesToB64(
        toBinary(
          Protobuf.Config.ConfigSchema,
          create(Protobuf.Config.ConfigSchema, {
            payloadVariant: { case: case_, value } as never,
          }),
        ),
      ),
    );
  }
  const modules: string[] = [];
  for (const [case_, value] of moduleConfig) {
    modules.push(
      bytesToB64(
        toBinary(
          Protobuf.ModuleConfig.ModuleConfigSchema,
          create(Protobuf.ModuleConfig.ModuleConfigSchema, {
            payloadVariant: { case: case_, value } as never,
          }),
        ),
      ),
    );
  }
  const chans: string[] = [];
  for (const ch of channels.values()) {
    chans.push(
      bytesToB64(
        toBinary(
          Protobuf.Channel.ChannelSchema,
          create(Protobuf.Channel.ChannelSchema, {
            index: ch.index,
            role: ch.role,
            settings: ch.settings,
          }),
        ),
      ),
    );
  }
  return JSON.stringify({ v: 1, configs, modules, channels: chans }, null, 2);
}

export async function importConfigJson(json: string): Promise<number> {
  if (!device) throw new Error("Sin conexión");
  const data = JSON.parse(json) as {
    v: number;
    configs: string[];
    modules: string[];
    channels: string[];
  };
  if (data.v !== 1) throw new Error(`versión de backup desconocida: ${data.v}`);
  let n = 0;
  for (const b of data.channels ?? []) {
    await device.setChannel(
      fromBinary(Protobuf.Channel.ChannelSchema, b64ToBytes(b)),
    );
    n++;
  }
  for (const b of data.configs ?? []) {
    await device.setConfig(
      fromBinary(Protobuf.Config.ConfigSchema, b64ToBytes(b)),
    );
    n++;
  }
  for (const b of data.modules ?? []) {
    await device.setModuleConfig(
      fromBinary(Protobuf.ModuleConfig.ModuleConfigSchema, b64ToBytes(b)),
    );
    n++;
  }
  await device.commitEditSettings();
  addLog(`Backup restaurado: ${n} mensajes de config aplicados`);
  return n;
}

// ── Remote admin ────────────────────────────────────────────────────────────
// Sends an AdminMessage to another node (admin channel / PKI depending on firmware).
async function sendAdminTo(
  dest: number,
  payloadVariant: Protobuf.Admin.AdminMessage["payloadVariant"],
): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  await device.sendPacket(
    toBinary(
      Protobuf.Admin.AdminMessageSchema,
      create(Protobuf.Admin.AdminMessageSchema, { payloadVariant }),
    ),
    Protobuf.Portnums.PortNum.ADMIN_APP,
    dest,
  );
}

export async function remoteReboot(dest: number): Promise<void> {
  await sendAdminTo(dest, { case: "rebootSeconds", value: 5 });
  addLog(`Reboot remoto → !${dest.toString(16)}`);
}

export async function remoteShutdown(dest: number): Promise<void> {
  await sendAdminTo(dest, { case: "shutdownSeconds", value: 5 });
  addLog(`Shutdown remoto → !${dest.toString(16)}`);
}

export async function disconnect(): Promise<void> {
  await device?.disconnect().catch(() => {});
  device = undefined;
  mutate((s) => {
    s.status = Types.DeviceStatusEnum.DeviceDisconnected;
  });
}

function routingErrName(code: number | undefined): string {
  return (
    Protobuf.Mesh.Routing_ErrorSchema.values.find(
      (v: { number: number; name: string }) => v.number === code,
    )?.name ?? `ERROR ${code}`
  );
}

export async function runTraceroute(dest: number): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  mutate((s) => {
    const m = new Map(s.traceroutes);
    m.delete(dest);
    s.traceroutes = m;
  });
  // The implicit ack can expire (TIMEOUT) even when the RouteDiscovery arrives
  // later through its own onTraceRoutePacket event. We don't block on the ack:
  // we log it and let the UI wait for the real reply.
  device.traceRoute(dest).catch((e: unknown) => {
    const code = (e as { error?: number } | undefined)?.error;
    addLog(`Traceroute → !${dest.toString(16)}: ack ${routingErrName(code)}`);
  });
}

export function toggleFav(num: number): void {
  const n = getSnapshot().nodes.get(num);
  if (n) upsertNode(num, { fav: !n.fav });
}

export function toggleIgnored(num: number): void {
  const n = getSnapshot().nodes.get(num);
  if (n) upsertNode(num, { ignored: !n.ignored });
}

// Deletes the node from the radio (if connected) and from the local DB/state.
export async function deleteNode(num: number): Promise<void> {
  await device?.removeNodeByNum(num).catch(() => {});
  mutate((s) => {
    const m = new Map(s.nodes);
    m.delete(num);
    s.nodes = m;
  });
  await deleteNodeDb(num).catch(() => {});
  addLog(`Nodo !${num.toString(16)} borrado`);
}

// Requests a position from a node. The reply arrives via onPositionPacket
// (already wired) and updates node+map. As with traceroute, the ack may expire
// even though the reply comes later: we don't block.
export function requestNodePosition(dest: number): void {
  if (!device) throw new Error("Sin conexión");
  device.requestPosition(dest).catch((e: unknown) => {
    const code = (e as { error?: number } | undefined)?.error;
    addLog(`Posición → !${dest.toString(16)}: ack ${routingErrName(code)}`);
  });
}

// Fixed position for nodes without GPS (ours). The firmware broadcasts it to the mesh.
export async function setFixedPosition(lat: number, lon: number): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  await device.setFixedPosition(lat, lon);
}

export async function clearFixedPosition(): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  await device.removeFixedPosition();
}

// Sends a waypoint to the channel. id=0 → new (random id); existing id → edit.
// The echo of our own packet comes back via onWaypointPacket, which stores it.
export async function sendWaypoint(
  w: Omit<Waypoint, "from" | "id"> & { id?: number },
  channel = 0,
): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  await device.sendWaypoint(
    create(Protobuf.Mesh.WaypointSchema, {
      id: w.id || Math.floor(Math.random() * 0x7fffffff) + 1,
      latitudeI: Math.round(w.lat * 1e7),
      longitudeI: Math.round(w.lon * 1e7),
      name: w.name,
      description: w.description,
      icon: w.icon,
      expire: w.expire,
      lockedTo: w.lockedTo,
    }),
    "broadcast",
    channel,
  );
}

// Deleting = re-sending it with expire in the past: that way it leaves every node.
export async function deleteWaypoint(id: number): Promise<void> {
  const w = getSnapshot().waypoints.get(id);
  if (!w) return;
  await sendWaypoint({ ...w, expire: Math.floor(Date.now() / 1000) - 1 });
  mutate((s) => {
    const m = new Map(s.waypoints);
    m.delete(id);
    s.waypoints = m;
  });
  await deleteWaypointDb(id).catch(() => {});
}

// Retries a failed message reusing the same entry (id/ts untouched).
export async function retryMessage(msg: Message): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  const isDm = msg.convo.startsWith("dm:");
  const destination = isDm ? Number(msg.convo.slice(3)) : ("broadcast" as const);
  const setState = (state: Message["state"]) => {
    mutate((s) => {
      s.messages = s.messages.map((m) =>
        m.id === msg.id && m.ts === msg.ts ? { ...m, state } : m,
      );
    });
    updateMessageState(msg.id, state).catch(dbFail("estado de mensaje"));
  };
  setState("queued");
  try {
    await device.sendText(msg.text, destination, true, msg.channel);
    setState("delivered");
  } catch (e) {
    setState("failed");
    throw e;
  }
}

export async function sendText(
  text: string,
  convo: string,
): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  const isDm = convo.startsWith("dm:");
  const destination = isDm ? Number(convo.slice(3)) : "broadcast";
  const channel = isDm ? 0 : Number(convo.slice(3));

  const msg: Message = {
    id: Date.now(), // provisional local id; the final one arrives with the ack
    convo,
    from: 0,
    to: isDm ? (destination as number) : 0xffffffff,
    channel,
    text,
    ts: Date.now(),
    mine: true,
    state: "queued",
  };
  mutate((s) => {
    msg.from = s.myNodeNum ?? 0;
    s.messages = [...s.messages, msg];
  });
  saveMessage(msg).catch(dbFail("mensaje"));

  const setState = (state: Message["state"]) => {
    mutate((s) => {
      s.messages = s.messages.map((m) =>
        m === msg || (m.id === msg.id && m.ts === msg.ts) ? { ...m, state } : m,
      );
    });
    updateMessageState(msg.id, state).catch(dbFail("estado de mensaje"));
  };

  try {
    await device.sendText(text, destination, true, channel);
    setState("delivered");
  } catch (e) {
    setState("failed");
    throw e;
  }
}
