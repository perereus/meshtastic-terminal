import type { NodeEntry } from "./store";

import type { Prevision } from "./battery";

export interface AlertCfg {
  on: boolean;
  battery: number; // % · avisar por debajo
  silentH: number; // horas sin dar señal
  autonomiaH: number; // horas de autonomía restante · 0 = no avisar
}

export const DEFAULT_ALERTS: AlertCfg = {
  on: false,
  battery: 20,
  silentH: 12,
  autonomiaH: 12,
};

const KEY = "alerts";

export function getAlertCfg(): AlertCfg {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_ALERTS, ...JSON.parse(raw) } : DEFAULT_ALERTS;
  } catch {
    return DEFAULT_ALERTS;
  }
}

export function setAlertCfg(cfg: AlertCfg): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

/** Sin texto ya formado: el módulo se mantiene puro (y testeable sin DOM);
 *  quien notifica se encarga de traducirlo. */
export interface Alert {
  key: string; // nodo+tipo, para no repetir el aviso
  kind: "bateria" | "mudo" | "autonomia";
  name: string; // nombre legible del nodo
  value: number; // % de batería · horas de silencio
  threshold: number;
}

/** Repetir el mismo aviso cada poco sería ruido; una vez cada 6 h basta para
 *  no olvidarse del problema sin convertirse en spam. */
export const COOLDOWN_MS = 6 * 3_600_000;

/** Alertas pendientes. Solo mira favoritos: con ~100 nodos en la malla,
 *  avisar de todos sería ruido puro; el favorito es la señal de "me importa".
 *  `lastFired` lleva la última vez que se avisó de cada key (se muta aquí). */
export function evalAlerts(
  nodes: Iterable<NodeEntry>,
  cfg: AlertCfg,
  lastFired: Map<string, number>,
  now = Date.now(),
  myNodeNum?: number,
): Alert[] {
  if (!cfg.on) return [];
  const out: Alert[] = [];
  const due = (key: string) => now - (lastFired.get(key) ?? -Infinity) >= COOLDOWN_MS;

  for (const n of nodes) {
    if (!n.fav || n.num === myNodeNum) continue;
    const who = n.longName || n.shortName || `!${n.num.toString(16)}`;

    // batteryLevel > 100 significa alimentación externa, no batería
    if (
      n.batteryLevel !== undefined &&
      n.batteryLevel <= cfg.battery &&
      n.batteryLevel <= 100
    ) {
      const key = `bat:${n.num}`;
      if (due(key)) {
        out.push({
          key,
          kind: "bateria",
          name: who,
          value: n.batteryLevel,
          threshold: cfg.battery,
        });
      }
    }

    // lastHeard en epoch s; 0 = nunca se ha oído, no es un silencio medible
    if (n.lastHeard > 0) {
      const horas = (now - n.lastHeard * 1000) / 3_600_000;
      if (horas >= cfg.silentH) {
        const key = `mudo:${n.num}`;
        if (due(key)) {
          out.push({
            key,
            kind: "mudo",
            name: who,
            value: Math.floor(horas),
            threshold: cfg.silentH,
          });
        }
      }
    }
  }

  for (const a of out) lastFired.set(a.key, now);
  return out;
}

/** Aviso por autonomía: la batería no está baja todavía, pero al ritmo actual
 *  lo estará pronto. Se calla si la previsión no es fiable — avisar de un
 *  agotamiento sacado de una serie irregular sería peor que no avisar. */
export function evalAutonomia(
  nodo: { num: number; nombre: string; fav?: boolean },
  prevision: Prevision | undefined,
  cfg: AlertCfg,
  lastFired: Map<string, number>,
  now = Date.now(),
): Alert | undefined {
  if (!cfg.on || !cfg.autonomiaH || !nodo.fav) return undefined;
  const h = prevision?.horasRestantes;
  if (h === undefined || prevision!.ajuste < 0.5) return undefined;
  if (h > cfg.autonomiaH) return undefined;
  const key = `auto:${nodo.num}`;
  if (now - (lastFired.get(key) ?? -Infinity) < COOLDOWN_MS) return undefined;
  lastFired.set(key, now);
  return {
    key,
    kind: "autonomia",
    name: nodo.nombre,
    value: Math.round(h),
    threshold: cfg.autonomiaH,
  };
}
