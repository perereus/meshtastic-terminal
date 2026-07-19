import { Protobuf } from "@meshtastic/core";

export function ago(epochS: number): string {
  if (!epochS) return "—";
  const s = Math.floor(Date.now() / 1000 - epochS);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** [███████░░░]  72% — o PWR si está enchufado.
 *  Los bloques U+2588/U+2591 dependen de la JetBrains Mono empaquetada en
 *  App.css: los subsets de Google Fonts recortan ese rango y descuadran.
 *  El porcentaje se alinea con NBSP porque el HTML colapsa espacios normales. */
export function asciiBattery(level?: number): string {
  if (level === undefined) return "—";
  if (level > 100) return "[██████████] PWR";
  const full = Math.min(10, Math.max(0, Math.round(level / 10)));
  const pct = String(level).padStart(3, " ");
  return `[${"█".repeat(full)}${"░".repeat(10 - full)}] ${pct}%`;
}

/** clase de color según SNR: ≥5 ok, 0–5 warn, <0 err */
export function snrClass(snr?: number): string {
  if (snr === undefined) return "dim";
  if (snr >= 5) return "ok";
  if (snr >= 0) return "warn";
  return "err";
}

function enumName(
  schema: { values: readonly { name: string; number: number }[] },
  num: number,
): string {
  return schema.values.find((v) => v.number === num)?.name ?? String(num);
}

export function hwName(hwModel?: string): string {
  if (hwModel === undefined) return "—";
  return enumName(Protobuf.Mesh.HardwareModelSchema, Number(hwModel));
}

export function regionName(region?: number): string {
  if (region === undefined) return "—";
  return enumName(Protobuf.Config.Config_LoRaConfig_RegionCodeSchema, region);
}
