import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { parseChannelSetUrl } from "./channelUrl";
import { createSerialTransport } from "./transport/serial";
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
    // BD primero; el volcado de la radio pisará campo a campo lo que traiga
    // (upsertNode conserva lo previo si el patch viene undefined).
    s.nodes = new Map(nodes.map((n) => [n.num, n]));
  });
}

// Un fallo al escribir en SQLite no debe tumbar la recepción de paquetes, pero
// tampoco puede desaparecer: sin rastro es imposible saber si una tabla está
// vacía porque no llegó el dato o porque el guardado falló.
function dbFail(what: string) {
  return (e: unknown) => addLog(`BD: fallo al guardar ${what}: ${e}`);
}

// Notificación del sistema. Permiso se pide la primera vez.
export async function notify(title: string, body: string): Promise<void> {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body });
  } catch {
    // sin soporte de notificaciones: no es crítico
  }
}

// Mensajes entrantes: solo si la ventana no tiene el foco (si estás mirando el
// chat no hace falta). Las alertas de nodo sí avisan siempre: no dependen de
// que estés mirando la pantalla correcta.
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
    // ponytail: un patch con undefined NO debe pisar el default/valor previo
    // (p.ej. NodeInfo sin user dejaba longName=undefined → localeCompare casca)
    for (const k of Object.keys(patch) as (keyof NodeEntry)[]) {
      if (patch[k] === undefined) delete patch[k];
    }
    const merged = { ...prev, ...patch };
    s.nodes = new Map(s.nodes).set(num, merged);
    // ponytail: write por evento; SQLite lo aguanta de sobra a este ritmo
    saveNode(merged).catch(dbFail("nodo"));
  });
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
      // lastHeard real del firmware. Si es 0 (nodo nunca oído directo) no lo
      // fabricamos: undefined → upsert conserva prev/default (ago() muestra "—").
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
      // sin user no sabemos nada de su clave: undefined conserva lo anterior
      hasKey: node.user ? node.user.publicKey.length > 0 : undefined,
    });
  });

  // Durante el volcado de la NodeDB (configure) el core re-emite user/position
  // por cada nodo. NO son escuchas en vivo: solo sellamos "ahora" si ya estamos
  // configurados; en el volcado dejamos el lastHeard que puso onNodeInfoPacket.
  const liveTs = () =>
    getSnapshot().status === Types.DeviceStatusEnum.DeviceConfigured
      ? Math.floor(Date.now() / 1000)
      : undefined;

  d.events.onUserPacket.subscribe((u) => {
    upsertNode(u.from, {
      longName: u.data.longName,
      shortName: u.data.shortName,
      lastHeard: liveTs(),
      // clave pública presente ⇒ los DM con este nodo van cifrados con PKI
      hasKey: (u.data.publicKey?.length ?? 0) > 0,
    });
  });

  d.events.onWaypointPacket.subscribe((p) => {
    const w = p.data;
    // borrado: el firmware reenvía el waypoint con expire en el pasado
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
    // señal de "respuesta recibida" ANTES del filtro: una posición sin fix
    // también responde al PEDIR POS
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
    // El core hace echo de nuestro propio paquete (echoResponse=true) en cuanto
    // la radio lo acepta. No lo duplicamos: lo usamos para marcar "sent".
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
      // ponytail: "sent" es transitorio, no lo persistimos; delivered/failed sí
      return;
    }
    // nodo ignorado: descartar su mensaje (ni chat, ni no-leídos, ni notificación)
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
    // MUTE del canal (casilla en CONFIG // CANALES) silencia solo el canal:
    // un DM sigue avisando aunque llegue por un canal silenciado.
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

  // NeighborInfo: cada nodo publica a quién oye y con qué SNR. Es la única
  // fuente de enlaces que no depende de lanzar traceroutes a mano.
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
        settings: ch.settings, // guardamos PSK/opts para poder exportar la URL
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

async function connect(transport: Types.Transport): Promise<void> {
  device = new MeshDevice(transport);
  wireEvents(device);
  await device.configure();
  device.setHeartbeatInterval(60_000);
}

export async function connectSerial(path: string): Promise<void> {
  await connect(await createSerialTransport(path, handleLost));
}

export async function connectTcp(host: string): Promise<void> {
  await connect(await createTcpTransport(host, handleLost));
}

// La app registra aquí qué hacer cuando el enlace se cae solo (no un
// disconnect manual): dispara la auto-reconexión.
let onConnectionLost: (() => void) | undefined;
export function setConnectionLostHandler(cb: (() => void) | undefined): void {
  onConnectionLost = cb;
}

function handleLost(): void {
  if (!device) return; // ya desconectado manualmente
  device = undefined;
  mutate((s) => {
    s.status = Types.DeviceStatusEnum.DeviceDisconnected;
  });
  addLog("Enlace perdido");
  onConnectionLost?.();
}

export async function connectBle(address: string): Promise<void> {
  await connect(await createBleTransport(address, handleLost));
}

// Importa canales desde una URL de Meshtastic (https://meshtastic.org/e/#<b64url>).
// Acepta también solo el fragmento base64. Devuelve nº de canales aplicados.
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

// ── Backup/restore de config completa ──────────────────────────────────────
// Serializamos cada mensaje protobuf a binario+base64 dentro de un JSON:
// robusto ante campos nuevos y sin depender del formato JSON de protobuf.
const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64ToBytes = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function exportConfigJson(): string {
  const { config, moduleConfig, channels } = getSnapshot();
  const configs: string[] = [];
  for (const [case_, value] of config) {
    if (case_ === "sessionkey") continue; // efímera, no restaurable
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

// ── Admin remoto ────────────────────────────────────────────────────────────
// Envía un AdminMessage a otro nodo (canal admin / PKI según firmware).
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
  // El ack implícito puede expirar (TIMEOUT) aunque la RouteDiscovery llegue
  // luego por su propio evento onTraceRoutePacket. No bloqueamos por el ack:
  // lo registramos y dejamos que la UI espere la respuesta real.
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

// Borra el nodo de la radio (si hay conexión) y de la BD/estado local.
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

// Pide la posición a un nodo. La respuesta llega por onPositionPacket (ya
// cablead0) y actualiza nodo+mapa. Como en traceroute, el ack puede expirar
// aunque la respuesta llegue después: no bloqueamos.
export function requestNodePosition(dest: number): void {
  if (!device) throw new Error("Sin conexión");
  device.requestPosition(dest).catch((e: unknown) => {
    const code = (e as { error?: number } | undefined)?.error;
    addLog(`Posición → !${dest.toString(16)}: ack ${routingErrName(code)}`);
  });
}

// Posición fija para nodos sin GPS (el nuestro). El firmware la difunde al mesh.
export async function setFixedPosition(lat: number, lon: number): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  await device.setFixedPosition(lat, lon);
}

export async function clearFixedPosition(): Promise<void> {
  if (!device) throw new Error("Sin conexión");
  await device.removeFixedPosition();
}

// Emite un waypoint al canal. id=0 → nuevo (id aleatorio); id existente → edición.
// El eco del propio paquete vuelve por onWaypointPacket, que es quien lo guarda.
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

// Borrar = reemitirlo con expire en el pasado: así se va de todos los nodos.
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

// Reintenta un mensaje fallido reusando la misma entrada (id/ts intactos).
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
    id: Date.now(), // id local provisional; el definitivo llega con el ack
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
