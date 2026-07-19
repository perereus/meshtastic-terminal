export interface Muestra {
  ts: number; // epoch ms
  value: number; // % de batería
}

export interface Prevision {
  /** %/hora: negativo se descarga, positivo carga */
  pendiente: number;
  /** horas hasta 0 % al ritmo actual · undefined si no se descarga */
  horasRestantes?: number;
  /** epoch ms del agotamiento · undefined si no se descarga */
  agota?: number;
  /** cuánto fiarse: 0..1 según dispersión de los puntos sobre la recta */
  ajuste: number;
  muestras: number;
  ultimo: number; // último % conocido
}

/** Regresión lineal por mínimos cuadrados sobre las últimas `horas` de batería.
 *
 *  Un nodo solar sube de día y baja de noche: ajustar sobre una ventana larga
 *  daría pendiente ~0 y una previsión inútil. Con ventana corta se predice el
 *  tramo actual, que es lo accionable ("esta noche no llega").
 *
 *  Devuelve undefined si no hay datos suficientes para decir nada honesto. */
export function preverBateria(
  muestras: Muestra[],
  horas = 6,
  ahora = Date.now(),
): Prevision | undefined {
  const desde = ahora - horas * 3_600_000;
  // >100 % es alimentación externa, no batería: falsearía la recta
  const pts = muestras
    .filter((m) => m.ts >= desde && m.value <= 100)
    .sort((a, b) => a.ts - b.ts);
  if (pts.length < 4) return undefined;

  const t0 = pts[0].ts;
  // x en horas desde la primera muestra: evita números enormes en la regresión
  const xs = pts.map((p) => (p.ts - t0) / 3_600_000);
  const ys = pts.map((p) => p.value);
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  // todas las muestras en el mismo instante: no hay recta posible
  if (sxx === 0) return undefined;
  const pendiente = sxy / sxx;
  const interseccion = my - pendiente * mx;

  // R²: si los puntos no siguen una recta, la previsión no vale nada
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (interseccion + pendiente * xs[i])) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  // batería plana (ssTot 0): la recta es exacta, R²=1 por convenio
  const ajuste = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  const ultimo = ys[n - 1];
  const r: Prevision = { pendiente, ajuste, muestras: n, ultimo };
  // solo tiene sentido predecir agotamiento si de verdad baja; un umbral algo
  // por debajo de 0 evita convertir el ruido de una batería plana en un aviso
  if (pendiente < -0.05) {
    r.horasRestantes = ultimo / -pendiente;
    r.agota = ahora + r.horasRestantes * 3_600_000;
  }
  return r;
}

/** Texto corto para la UI. Devuelve la clave y los argumentos para t(). */
export function textoPrevision(p: Prevision): [string, ...(string | number)[]] {
  if (p.ajuste < 0.5) return ["BATERÍA IRREGULAR · sin previsión fiable"];
  if (p.pendiente > 0.05) return ["CARGANDO · {0} %/h", p.pendiente.toFixed(1)];
  if (p.horasRestantes === undefined) return ["ESTABLE · sin descarga apreciable"];
  const h = p.horasRestantes;
  if (h < 48) return ["SE AGOTA EN ~{0} h", Math.round(h)];
  return ["SE AGOTA EN ~{0} días", Math.round(h / 24)];
}
