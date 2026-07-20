// Self-check: node --experimental-strip-types src/handshake.test.ts
// The bug this guards against: taking a connection for granted the moment
// wantConfigId is written. A rebooting node accepts the write and never
// answers, so without waiting for DeviceConfigured the auto-reconnect
// declares victory and stops retrying.
import assert from "node:assert";
import { Types } from "@meshtastic/core";
import { waitConfigured, type StatusSource } from "./handshake.ts";

const { DeviceConfigured, DeviceConfiguring, DeviceDisconnected, DeviceConnected } =
  Types.DeviceStatusEnum;

/** Minimal stand-in for MeshDevice's status event. */
function radioFalsa() {
  const subs = new Set<(s: Types.DeviceStatusEnum) => void>();
  const src: StatusSource = {
    events: {
      onDeviceStatus: {
        subscribe(fn) {
          subs.add(fn);
          return () => subs.delete(fn);
        },
      },
    },
  };
  return {
    src,
    emitir: (s: Types.DeviceStatusEnum) => subs.forEach((f) => f(s)),
    get suscritos() {
      return subs.size;
    },
  };
}

// reaching DeviceConfigured resolves, and unsubscribes
{
  const r = radioFalsa();
  const p = waitConfigured(r.src, 1000);
  assert.equal(r.suscritos, 1);
  r.emitir(DeviceConfiguring); // intermediate: doesn't settle anything
  r.emitir(DeviceConfigured);
  await p;
  assert.equal(r.suscritos, 0, "debe darse de baja o el handler se acumula");
}

// a node that never answers: rejects instead of hanging forever
{
  const r = radioFalsa();
  await assert.rejects(waitConfigured(r.src, 30), /no completó la configuración/);
  assert.equal(r.suscritos, 0, "el timeout también debe dar de baja");
}

// link dropping mid-handshake: rejects right away, no waiting out the timeout
{
  const r = radioFalsa();
  const t0 = Date.now();
  const p = assert.rejects(waitConfigured(r.src, 10_000), /enlace perdido/);
  r.emitir(DeviceDisconnected);
  await p;
  assert.ok(Date.now() - t0 < 1000, "no debe esperar al timeout");
}

// DeviceConnected is NOT enough: that's the half-open link that caused the bug
{
  const r = radioFalsa();
  const p = waitConfigured(r.src, 60);
  r.emitir(DeviceConnected);
  await assert.rejects(p, /no completó la configuración/);
}

// a late status must not throw on an already-settled promise
{
  const r = radioFalsa();
  const p = waitConfigured(r.src, 1000);
  r.emitir(DeviceConfigured);
  await p;
  r.emitir(DeviceDisconnected); // unsubscribed: nothing should happen
}

console.log("handshake.test.ts OK");
