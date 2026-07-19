// Self-check: node --experimental-strip-types src/transport/fake.test.ts
// Connects a real MeshDevice (the same one the app uses) to the simulated
// transport and verifies the full cycle: handshake, NodeDB, traceroute with a
// reply and message acks. If this passes, whatever the app does with the
// events is radio.ts's business, not the protocol's.
import assert from "node:assert";
import { MeshDevice } from "@meshtastic/core";
import { createFakeTransport } from "./fake.ts";

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const transporte = await createFakeTransport();
const device = new MeshDevice(transporte);
// quiet: the core logs every packet and clutters the test output
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

// traceroute to a simulated node: it must reply with a route and SNR in dB×4
const destino = 0x7f00a003;
await device.traceRoute(destino).catch(() => {});
await espera(1500);

assert.ok(trace, "el traceroute debe recibir respuesta");
assert.equal(trace.from, destino);
assert.ok(trace.route.length >= 1, "la ruta debe pasar por un intermedio");
assert.ok(trace.snrTowards.length >= 1);

// text message: the simulator's ack must resolve the send promise
// (without an ack, sendText would hang until the core's timeout)
await device.sendText("prueba", 0xffffffff);

await espera(100);
await transporte.disconnect();
console.log(
  `fake.test.ts OK · ${nodos.size} nodos, traceroute con ${trace.route.length} salto(s), ${vecinos} NeighborInfo`,
);
// the simulator's timers are stopped by disconnect; clean exit
process.exit(0);
