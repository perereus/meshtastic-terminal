// Self-check: node --experimental-strip-types src/battery.test.ts
import assert from "node:assert";
import { preverBateria, textoPrevision, type Muestra } from "./battery.ts";

const NOW = 1_700_000_000_000;
const H = 3_600_000;

/** serie que empieza en `desde` % y cambia `porHora` cada hora, hacia atrás */
const serie = (desde: number, porHora: number, n = 12, ruido = 0): Muestra[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: NOW - (n - 1 - i) * H * 0.5, // una muestra cada media hora
    value: desde + porHora * ((n - 1 - i) * -0.5) + (i % 2 ? ruido : -ruido),
  }));

// descarga limpia: 2 %/h desde el 50 % ⇒ 25 h hasta cero
const baja = preverBateria(serie(50, -2), 12, NOW);
assert.ok(baja, "debería haber previsión");
assert.ok(Math.abs(baja.pendiente + 2) < 0.01, `pendiente ${baja.pendiente}`);
assert.ok(Math.abs((baja.horasRestantes ?? 0) - 25) < 0.5, `horas ${baja.horasRestantes}`);
assert.ok(baja.ajuste > 0.99);

// cargando: no se predice agotamiento
const sube = preverBateria(serie(60, 3), 12, NOW);
assert.ok(sube);
assert.equal(sube.horasRestantes, undefined, "cargando no se agota");

// batería plana: nada de convertir el ruido en un aviso de agotamiento
const plana = preverBateria(serie(80, 0), 12, NOW);
assert.ok(plana);
assert.equal(plana.horasRestantes, undefined);

// pocos datos: mejor no decir nada que inventar una recta
assert.equal(preverBateria(serie(50, -2, 3), 12, NOW), undefined);

// fuera de ventana: muestras viejas no cuentan
const viejas: Muestra[] = Array.from({ length: 10 }, (_, i) => ({
  ts: NOW - (50 + i) * H,
  value: 90 - i,
}));
assert.equal(preverBateria(viejas, 6, NOW), undefined);

// >100 % es alimentación externa: se descarta y deja de haber datos suficientes
const enchufado: Muestra[] = Array.from({ length: 10 }, (_, i) => ({
  ts: NOW - i * H * 0.5,
  value: 101,
}));
assert.equal(preverBateria(enchufado, 12, NOW), undefined);

// serie ruidosa: el ajuste debe bajar y avisar de que no es fiable
const ruidosa = preverBateria(serie(50, -0.2, 12, 18), 12, NOW);
assert.ok(ruidosa);
assert.ok(ruidosa.ajuste < 0.5, `ajuste ${ruidosa.ajuste} debería ser bajo`);
assert.equal(textoPrevision(ruidosa)[0], "BATERÍA IRREGULAR · sin previsión fiable");

// textos según el caso
assert.equal(textoPrevision(baja)[0], "SE AGOTA EN ~{0} h");
assert.equal(textoPrevision(sube)[0], "CARGANDO · {0} %/h");
assert.equal(textoPrevision(plana)[0], "ESTABLE · sin descarga apreciable");
// descarga lentísima: se expresa en días, no en horas de tres cifras
const lenta = preverBateria(serie(90, -0.5), 12, NOW);
assert.ok(lenta);
assert.equal(textoPrevision(lenta)[0], "SE AGOTA EN ~{0} días");

console.log("battery.test.ts OK");
