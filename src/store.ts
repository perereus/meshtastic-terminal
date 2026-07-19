import type { Protobuf, Types } from "@meshtastic/core";

export interface NodeEntry {
  num: number;
  longName: string;
  shortName: string;
  lastHeard: number; // epoch s
  snr?: number;
  batteryLevel?: number;
  voltage?: number;
  lat?: number;
  lon?: number;
  hwModel?: string;
  hopsAway?: number;
  viaMqtt?: boolean;
  hasKey?: boolean; // tiene clave pública ⇒ DM cifrados con PKI
  fav?: boolean; // local: primero en la lista
  ignored?: boolean; // local: sus mensajes se descartan
}

export interface Message {
  id: number;
  convo: string; // "ch:N" o "dm:nodeNum"
  from: number;
  to: number;
  channel: number;
  text: string;
  ts: number; // epoch ms
  mine: boolean;
  // queued: en cola local · sent: la radio aceptó el paquete (eco propio) ·
  // delivered: ACK de routing recibido · failed: error/timeout
  state: "queued" | "sent" | "delivered" | "failed";
}

export interface ChannelEntry {
  index: number;
  name: string;
  role: number; // Protobuf.Channel.Channel_Role
  settings?: Protobuf.Channel.ChannelSettings; // crudo, para exportar URL
}

export interface Waypoint {
  id: number;
  lat: number;
  lon: number;
  name: string;
  description: string;
  icon: number; // codepoint del emoji (0 = sin icono)
  expire: number; // epoch s · 0 = no caduca
  lockedTo: number; // 0 = editable por cualquiera
  from: number; // quién lo emitió
}

export interface Traceroute {
  route: number[];
  snrTowards: number[]; // dB ×4
  routeBack: number[];
  snrBack: number[]; // dB ×4
  ts: number; // epoch ms de recepción
}

interface State {
  status?: Types.DeviceStatusEnum;
  myNodeNum?: number;
  nodes: Map<number, NodeEntry>;
  messages: Message[];
  channels: Map<number, ChannelEntry>;
  config: Map<string, Protobuf.Config.Config["payloadVariant"]["value"]>;
  moduleConfig: Map<
    string,
    Protobuf.ModuleConfig.ModuleConfig["payloadVariant"]["value"]
  >;
  traceroutes: Map<number, Traceroute>; // key: nodo destino
  waypoints: Map<number, Waypoint>; // key: id del waypoint
  posUpdates: Map<number, number>; // key: nodo → ts ms del último PositionPacket
  unread: Map<string, number>; // key: convo → nº mensajes sin leer
  log: string[];
}

const state: State = {
  nodes: new Map(),
  messages: [],
  channels: new Map(),
  config: new Map(),
  moduleConfig: new Map(),
  traceroutes: new Map(),
  waypoints: new Map(),
  posUpdates: new Map(),
  unread: new Map(),
  log: [],
};

// Instantánea inmutable para useSyncExternalStore
let snapshot = { ...state, version: 0 };
const listeners = new Set<() => void>();

export function mutate(fn: (s: State) => void): void {
  fn(state);
  snapshot = { ...state, version: snapshot.version + 1 };
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getSnapshot() {
  return snapshot;
}

export function addLog(text: string): void {
  mutate((s) => {
    // ponytail: log acotado a 500 líneas, suficiente para diagnóstico
    s.log = [
      ...s.log.slice(-499),
      `${new Date().toLocaleTimeString()} ${text}`,
    ];
  });
}

export function markUnread(convo: string): void {
  mutate((s) => {
    s.unread = new Map(s.unread).set(convo, (s.unread.get(convo) ?? 0) + 1);
  });
}

export function clearUnread(convo: string): void {
  if (!state.unread.has(convo)) return; // evita re-render inútil
  mutate((s) => {
    const m = new Map(s.unread);
    m.delete(convo);
    s.unread = m;
  });
}

export function convoKey(msg: {
  from: number;
  to: number;
  channel: number;
  mine: boolean;
}): string {
  const BROADCAST = 0xffffffff;
  if (msg.to !== BROADCAST) {
    return `dm:${msg.mine ? msg.to : msg.from}`;
  }
  return `ch:${msg.channel}`;
}
