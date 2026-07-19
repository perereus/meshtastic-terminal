import Database from "@tauri-apps/plugin-sql";
import type { Message, NodeEntry, Traceroute, Waypoint } from "./store";

let db: Database | undefined;

export async function openDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load("sqlite:meshtastic.db");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER NOT NULL,
      convo TEXT NOT NULL,
      from_num INTEGER NOT NULL,
      to_num INTEGER NOT NULL,
      channel INTEGER NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      mine INTEGER NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (id, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(convo, ts);
    CREATE TABLE IF NOT EXISTS telemetry (
      node INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_node ON telemetry(node, metric, ts);
    CREATE TABLE IF NOT EXISTS nodes (
      num INTEGER PRIMARY KEY,
      long_name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      last_heard INTEGER NOT NULL,
      lat REAL,
      lon REAL,
      hw_model TEXT,
      fav INTEGER DEFAULT 0,
      ignored INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS traceroutes (
      node INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      route TEXT NOT NULL,
      snr_towards TEXT NOT NULL,
      route_back TEXT NOT NULL,
      snr_back TEXT NOT NULL,
      PRIMARY KEY (node, ts)
    );
    CREATE TABLE IF NOT EXISTS hops (
      node INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      hops INTEGER NOT NULL,
      antes INTEGER,
      PRIMARY KEY (node, ts)
    );
    CREATE TABLE IF NOT EXISTS sightings (
      node INTEGER NOT NULL,
      hora INTEGER NOT NULL, -- epoch ms dividido por 3600000
      n INTEGER NOT NULL,
      PRIMARY KEY (node, hora)
    );
    CREATE TABLE IF NOT EXISTS neighbors (
      node INTEGER NOT NULL,
      neighbor INTEGER NOT NULL,
      snr REAL NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (node, neighbor)
    );
    CREATE TABLE IF NOT EXISTS waypoints (
      id INTEGER PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      icon INTEGER NOT NULL,
      expire INTEGER NOT NULL,
      locked_to INTEGER NOT NULL,
      from_num INTEGER NOT NULL
    );
  `);
  // migración BDs anteriores sin fav/ignored (falla si ya existen: ignorar)
  await db.execute(`ALTER TABLE nodes ADD COLUMN fav INTEGER DEFAULT 0`).catch(() => {});
  await db.execute(`ALTER TABLE nodes ADD COLUMN ignored INTEGER DEFAULT 0`).catch(() => {});
  return db;
}

export async function saveMessage(m: Message): Promise<void> {
  const d = await openDb();
  await d.execute(
    `INSERT OR REPLACE INTO messages (id, convo, from_num, to_num, channel, text, ts, mine, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [m.id, m.convo, m.from, m.to, m.channel, m.text, m.ts, m.mine ? 1 : 0, m.state],
  );
}

export async function updateMessageState(
  id: number,
  stateVal: Message["state"],
): Promise<void> {
  const d = await openDb();
  await d.execute(`UPDATE messages SET state = $1 WHERE id = $2`, [
    stateVal,
    id,
  ]);
}

export async function loadMessages(limit = 2000): Promise<Message[]> {
  const d = await openDb();
  const rows = await d.select<
    {
      id: number;
      convo: string;
      from_num: number;
      to_num: number;
      channel: number;
      text: string;
      ts: number;
      mine: number;
      state: string;
    }[]
  >(`SELECT * FROM (SELECT * FROM messages ORDER BY ts DESC LIMIT $1) ORDER BY ts ASC`, [limit]);
  return rows.map((r) => ({
    id: r.id,
    convo: r.convo,
    from: r.from_num,
    to: r.to_num,
    channel: r.channel,
    text: r.text,
    ts: r.ts,
    mine: r.mine === 1,
    state: r.state as Message["state"],
  }));
}

// Persistimos lo estable del nodo (identidad + última posición conocida).
// snr/batería son volátiles: no valen nada tras reabrir.
export async function saveNode(n: NodeEntry): Promise<void> {
  const d = await openDb();
  await d.execute(
    `INSERT OR REPLACE INTO nodes (num, long_name, short_name, last_heard, lat, lon, hw_model, fav, ignored)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      n.num,
      n.longName,
      n.shortName,
      n.lastHeard,
      n.lat ?? null,
      n.lon ?? null,
      n.hwModel ?? null,
      n.fav ? 1 : 0,
      n.ignored ? 1 : 0,
    ],
  );
}

export async function deleteNodeDb(num: number): Promise<void> {
  const d = await openDb();
  await d.execute(`DELETE FROM nodes WHERE num = $1`, [num]);
}

export async function loadNodes(): Promise<NodeEntry[]> {
  const d = await openDb();
  const rows = await d.select<
    {
      num: number;
      long_name: string;
      short_name: string;
      last_heard: number;
      lat: number | null;
      lon: number | null;
      hw_model: string | null;
      fav: number | null;
      ignored: number | null;
    }[]
  >(`SELECT * FROM nodes`);
  return rows.map((r) => ({
    num: r.num,
    longName: r.long_name,
    shortName: r.short_name,
    lastHeard: r.last_heard,
    lat: r.lat ?? undefined,
    lon: r.lon ?? undefined,
    hwModel: r.hw_model ?? undefined,
    fav: !!r.fav,
    ignored: !!r.ignored,
  }));
}

// ponytail: rutas como CSV en TEXT — nadie consulta por salto suelto
export async function saveTraceroute(node: number, t: Traceroute): Promise<void> {
  const d = await openDb();
  await d.execute(
    `INSERT OR REPLACE INTO traceroutes (node, ts, route, snr_towards, route_back, snr_back)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      node,
      t.ts,
      t.route.join(","),
      t.snrTowards.join(","),
      t.routeBack.join(","),
      t.snrBack.join(","),
    ],
  );
}

const nums = (s: string) => (s ? s.split(",").map(Number) : []);

export async function loadTraceroutes(node: number, limit = 20): Promise<Traceroute[]> {
  const d = await openDb();
  const rows = await d.select<
    {
      ts: number;
      route: string;
      snr_towards: string;
      route_back: string;
      snr_back: string;
    }[]
  >(
    `SELECT ts, route, snr_towards, route_back, snr_back FROM traceroutes
     WHERE node = $1 ORDER BY ts DESC LIMIT $2`,
    [node, limit],
  );
  return rows.map((r) => ({
    ts: r.ts,
    route: nums(r.route),
    snrTowards: nums(r.snr_towards),
    routeBack: nums(r.route_back),
    snrBack: nums(r.snr_back),
  }));
}

/** Vecinos declarados por un nodo (módulo NeighborInfo). Se reemplaza el
 *  conjunto entero: el paquete es la foto completa de sus vecinos. */
export async function saveNeighbors(
  node: number,
  neighbors: { num: number; snr: number }[],
  ts: number,
): Promise<void> {
  const d = await openDb();
  await d.execute(`DELETE FROM neighbors WHERE node = $1`, [node]);
  for (const n of neighbors) {
    await d.execute(
      `INSERT OR REPLACE INTO neighbors (node, neighbor, snr, ts) VALUES ($1, $2, $3, $4)`,
      [node, n.num, n.snr, ts],
    );
  }
}

/** Vecinos vistos en los últimos N días. Un enlace que nadie renueva deja de
 *  existir en la malla; sin este corte el grafo acumularía aristas fantasma
 *  aunque nunca se purgue la base. */
export async function loadNeighbors(
  maxAgeDays = 7,
): Promise<{ node: number; neighbor: number; snr: number; ts: number }[]> {
  const d = await openDb();
  return d.select(
    `SELECT node, neighbor, snr, ts FROM neighbors WHERE ts >= $1`,
    [Date.now() - maxAgeDays * 86_400_000],
  );
}

/** Traceroutes recientes de todos los nodos, para dibujar el grafo. */
export async function loadAllTraceroutes(
  limit = 200,
): Promise<{ node: number; ts: number; route: number[]; snr: number[] }[]> {
  const d = await openDb();
  const rows = await d.select<
    { node: number; ts: number; route: string; snr_towards: string }[]
  >(
    `SELECT node, ts, route, snr_towards FROM traceroutes ORDER BY ts DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    node: r.node,
    ts: r.ts,
    route: nums(r.route),
    snr: nums(r.snr_towards),
  }));
}

/** Solo se guardan los cambios de distancia, no el valor en cada paquete: lo
 *  interesante es cuándo se alargó o acortó la ruta, y así la tabla queda
 *  minúscula aunque la malla emita sin parar. */
export async function saveHopChange(
  node: number,
  hops: number,
  antes: number | undefined,
  ts = Date.now(),
): Promise<void> {
  const d = await openDb();
  await d.execute(
    `INSERT OR REPLACE INTO hops (node, ts, hops, antes) VALUES ($1, $2, $3, $4)`,
    [node, ts, hops, antes ?? null],
  );
}

export async function loadHopChanges(
  node: number,
  limit = 10,
): Promise<{ ts: number; hops: number; antes?: number }[]> {
  const d = await openDb();
  const rows = await d.select<
    { ts: number; hops: number; antes: number | null }[]
  >(`SELECT ts, hops, antes FROM hops WHERE node = $1 ORDER BY ts DESC LIMIT $2`, [
    node,
    limit,
  ]);
  return rows.map((r) => ({ ts: r.ts, hops: r.hops, antes: r.antes ?? undefined }));
}

const HORA_MS = 3_600_000;

/** Marca que se ha oído a un nodo en la hora actual. Un contador por nodo y
 *  hora en vez de una fila por paquete: la malla emite sin parar y no hace
 *  falta el detalle al segundo para saber quién estaba vivo y cuándo. */
export async function marcarEscucha(node: number, ts = Date.now()): Promise<void> {
  const d = await openDb();
  await d.execute(
    `INSERT INTO sightings (node, hora, n) VALUES ($1, $2, 1)
     ON CONFLICT(node, hora) DO UPDATE SET n = n + 1`,
    [node, Math.floor(ts / HORA_MS)],
  );
}

/** Actividad por nodo y hora desde una fecha. */
export async function loadActividad(
  desde: number,
): Promise<{ node: number; hora: number; n: number }[]> {
  const d = await openDb();
  return d.select(
    `SELECT node, hora, n FROM sightings WHERE hora >= $1 ORDER BY hora`,
    [Math.floor(desde / HORA_MS)],
  );
}

export async function saveWaypoint(w: Waypoint): Promise<void> {
  const d = await openDb();
  await d.execute(
    `INSERT OR REPLACE INTO waypoints (id, lat, lon, name, description, icon, expire, locked_to, from_num)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [w.id, w.lat, w.lon, w.name, w.description, w.icon, w.expire, w.lockedTo, w.from],
  );
}

export async function deleteWaypointDb(id: number): Promise<void> {
  const d = await openDb();
  await d.execute(`DELETE FROM waypoints WHERE id = $1`, [id]);
}

export async function loadWaypoints(): Promise<Waypoint[]> {
  const d = await openDb();
  const now = Math.floor(Date.now() / 1000);
  // los caducados no vuelven: se limpian al arrancar
  await d.execute(`DELETE FROM waypoints WHERE expire > 0 AND expire < $1`, [now]);
  const rows = await d.select<
    {
      id: number;
      lat: number;
      lon: number;
      name: string;
      description: string;
      icon: number;
      expire: number;
      locked_to: number;
      from_num: number;
    }[]
  >(`SELECT * FROM waypoints`);
  return rows.map((r) => ({
    id: r.id,
    lat: r.lat,
    lon: r.lon,
    name: r.name,
    description: r.description,
    icon: r.icon,
    expire: r.expire,
    lockedTo: r.locked_to,
    from: r.from_num,
  }));
}

export async function dbStats(): Promise<{
  messages: number;
  telemetry: number;
  nodes: number;
}> {
  const d = await openDb();
  const [r] = await d.select<
    { messages: number; telemetry: number; nodes: number }[]
  >(`SELECT (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM telemetry) AS telemetry,
            (SELECT COUNT(*) FROM nodes) AS nodes`);
  return r;
}

const AUTO_PURGE_KEY = "autoPurgeDays";

/** Días de retención para la purga al arrancar. 0 = desactivada (por defecto:
 *  borrar datos sin que el usuario lo pida es lo último que debe pasar solo). */
export function getAutoPurgeDays(): number {
  const n = Number(localStorage.getItem(AUTO_PURGE_KEY));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function setAutoPurgeDays(days: number): void {
  localStorage.setItem(AUTO_PURGE_KEY, String(days > 0 ? Math.floor(days) : 0));
}

// Borra mensajes, telemetría, traceroutes y vecinos anteriores a N días. Los
// nodos no se tocan: son pocos y su identidad es lo que hace legible el
// historial que queda. Los vecinos sí caducan: si no se renuevan, el enlace ya
// no existe y dejarlo pintaría aristas fantasma en el grafo.
export async function purgeOlderThan(days: number): Promise<number> {
  const d = await openDb();
  const cut = Date.now() - days * 86_400_000;
  const a = await d.execute(`DELETE FROM messages WHERE ts < $1`, [cut]);
  const b = await d.execute(`DELETE FROM telemetry WHERE ts < $1`, [cut]);
  const c = await d.execute(`DELETE FROM traceroutes WHERE ts < $1`, [cut]);
  const e = await d.execute(`DELETE FROM neighbors WHERE ts < $1`, [cut]);
  // sightings guarda la hora, no el ms
  const f = await d.execute(`DELETE FROM sightings WHERE hora < $1`, [
    Math.floor(cut / HORA_MS),
  ]);
  const g = await d.execute(`DELETE FROM hops WHERE ts < $1`, [cut]);
  await d.execute(`VACUUM`);
  return (
    a.rowsAffected +
    b.rowsAffected +
    c.rowsAffected +
    e.rowsAffected +
    f.rowsAffected +
    g.rowsAffected
  );
}

export async function saveTelemetry(
  node: number,
  metric: string,
  value: number,
  ts: number,
): Promise<void> {
  const d = await openDb();
  await d.execute(
    `INSERT INTO telemetry (node, metric, value, ts) VALUES ($1, $2, $3, $4)`,
    [node, metric, value, ts],
  );
}

export async function listTelemetryNodes(): Promise<number[]> {
  const d = await openDb();
  const rows = await d.select<{ node: number }[]>(
    `SELECT DISTINCT node FROM telemetry`,
  );
  return rows.map((r) => r.node);
}

export async function listMetrics(node: number): Promise<string[]> {
  const d = await openDb();
  const rows = await d.select<{ metric: string }[]>(
    `SELECT DISTINCT metric FROM telemetry WHERE node = $1 ORDER BY metric`,
    [node],
  );
  return rows.map((r) => r.metric);
}

export async function loadTelemetry(
  node: number,
  metric: string,
  sinceTs: number,
): Promise<{ ts: number; value: number }[]> {
  const d = await openDb();
  return d.select(
    `SELECT ts, value FROM telemetry WHERE node = $1 AND metric = $2 AND ts >= $3 ORDER BY ts ASC`,
    [node, metric, sinceTs],
  );
}
