// Self-check: node --experimental-strip-types src/transport/fake.test.ts
// Conecta un MeshDevice real (el mismo que usa la app) al transporte simulado
// y verifica el ciclo completo: handshake, NodeDB, traceroute con respuesta y
// ack de mensajes. Si esto pasa, lo que la app haga con los eventos ya es
// asunto de radio.ts, no del protocolo.
import assert from "node:assert";
import { MeshDevice } from "@meshtastic/core";
import { createFakeTransport } from "./fake.ts";

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const transporte = await createFakeTransport();
const device = new MeshDevice(transporte);
// silencio: el core loguea cada paquete y ensucia la salida del test
device.log.settings.minLevel = 6;

let configurado = false;
const nodos = new Set<number>();
let trace: { from: number; route: number[]; snrTowards: number[] } | undefined;
let vecinos = 0;

device.events.onDeviceStatus.subscribe((s) => {
  if (s === 7 /* DeviceConfigured */) configurado = true;
});
device.events.onNodeInfoPacket.subscribe((n) => nodos.add(n.num));
device.events.onTraceRoutePacket.subscribe((p) => {
  trace = { from: p.from, route: p.data.route, snrTowards: p.data.snrTowards };
});
device.events.onNeighborInfoPacket.subscribe(() => vecinos++);

await device.configure().catch(() => {});
await espera(400);

assert.ok(configurado, "el handshake debe terminar en DeviceConfigured");
assert.ok(nodos.size >= 6, `NodeDB corta: ${nodos.size} nodos`);

// traceroute a un nodo simulado: debe responder con ruta y SNR en dB×4
const destino = 0x7f00a003;
await device.traceRoute(destino).catch(() => {});
await espera(1500);

assert.ok(trace, "el traceroute debe recibir respuesta");
assert.equal(trace.from, destino);
assert.ok(trace.route.length >= 1, "la ruta debe pasar por un intermedio");
assert.ok(trace.snrTowards.length >= 1);

// mensaje de texto: el ack del simulador debe resolver la promesa de envío
// (sin ack, sendText se quedaría pendiente hasta el timeout del core)
await device.sendText("prueba", 0xffffffff);

await espera(100);
await transporte.disconnect();
console.log(
  `fake.test.ts OK · ${nodos.size} nodos, traceroute con ${trace.route.length} salto(s), ${vecinos} NeighborInfo`,
);
// los timers del simulador quedan parados por disconnect; salida limpia
process.exit(0);
