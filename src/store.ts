import type { Protobuf, Types } from "@meshtastic/core";
import { hora } from "./fmt";
import { t } from "./i18n";

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
  hasKey?: boolean; // has a public key ⇒ DMs encrypted with PKI
  fav?: boolean; // local: first in the list
  ignored?: boolean; // local: its messages are discarded
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
  // queued: waiting locally · sent: the radio accepted the packet (own echo) ·
  // delivered: routing ACK received · failed: error/timeout
  state: "queued" | "sent" | "delivered" | "failed";
}

export interface ChannelEntry {
  index: number;
  name: string;
  role: number; // Protobuf.Channel.Channel_Role
  settings?: Protobuf.Channel.ChannelSettings; // raw, to export the URL
}

export interface Waypoint {
  id: number;
  lat: number;
  lon: number;
  name: string;
  description: string;
  icon: number; // emoji codepoint (0 = no icon)
  expire: number; // epoch s · 0 = never expires
  lockedTo: number; // 0 = editable by anyone
  from: number; // who sent it
}

export interface Traceroute {
  route: number[];
  snrTowards: number[]; // dB ×4
  routeBack: number[];
  snrBack: number[]; // dB ×4
  ts: number; // epoch ms when received
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
  traceroutes: Map<number, Traceroute>; // key: destination node
  waypoints: Map<number, Waypoint>; // key: waypoint id
  posUpdates: Map<number, number>; // key: node → ts ms of the last PositionPacket
  unread: Map<string, number>; // key: convo → number of unread messages
  log: LogEntry[];
}

// Stored untranslated (key + args) so the whole log re-translates live when the
// language changes, like the rest of the UI. Render with fmtLog().
export interface LogEntry {
  time: number; // epoch ms
  key: string; // t() key, may carry {0}, {1}… placeholders
  args: (string | number)[];
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

// Immutable snapshot for useSyncExternalStore
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

export function addLog(key: string, ...args: (string | number)[]): void {
  mutate((s) => {
    // ponytail: log capped at 500 lines, enough for diagnosis
    s.log = [...s.log.slice(-499), { time: Date.now(), key, args }];
  });
}

/** Render a log entry in the current language. hora() is language-neutral. */
export function fmtLog(e: LogEntry): string {
  return `${hora(e.time)} ${t(e.key, ...e.args)}`;
}

export function markUnread(convo: string): void {
  mutate((s) => {
    s.unread = new Map(s.unread).set(convo, (s.unread.get(convo) ?? 0) + 1);
  });
}

export function clearUnread(convo: string): void {
  if (!state.unread.has(convo)) return; // avoids a useless re-render
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
