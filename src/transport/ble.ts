import type { Types } from "@meshtastic/core";
import {
  checkPermissions,
  connect,
  disconnect,
  getAdapterState,
  read,
  send,
  startScan,
  stopScan,
  subscribe,
  unsubscribe,
} from "@mnlphlp/plugin-blec";
import { addLog } from "../store";

// Meshtastic GATT (BLE)
const SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
const TORADIO = "f75c76d2-129e-4dad-a1dd-7866124401e7"; // write
const FROMRADIO = "2c55e69e-4993-11ed-b878-0242ac120002"; // read
const FROMNUM = "ed9da18c-a800-4f66-a670-aa7547e34453"; // notify

export interface BleDeviceInfo {
  address: string;
  name: string;
  svc: boolean; // advertises the Meshtastic service
}

// Scans BLE devices. Windows doesn't always expose the services in the
// advertisement, so we return ALL of them (those advertising the service
// first) and let the user choose. Throws if the adapter is off.
export async function scanBleDevices(timeoutMs = 6000): Promise<BleDeviceInfo[]> {
  const perm = await checkPermissions(true).catch((e) => `err ${e}`);
  const state = await getAdapterState().catch(() => "Unknown");
  addLog(`BLE: permisos=${perm} adaptador=${state}`);
  if (state === "Off") throw new Error("Bluetooth apagado");

  await stopScan().catch(() => {}); // limpiar cualquier escaneo previo colgado
  const found = new Map<string, BleDeviceInfo>();
  let updates = 0;
  await startScan((devices) => {
    updates++;
    for (const d of devices) {
      const svc = !!d.services?.some((s) => s.toLowerCase() === SERVICE);
      const prev = found.get(d.address);
      found.set(d.address, {
        address: d.address,
        name: d.name || prev?.name || d.address,
        svc: svc || !!prev?.svc,
      });
    }
  }, timeoutMs);
  await new Promise((r) => setTimeout(r, 300)); // settle
  await stopScan().catch(() => {});
  addLog(
    `BLE: ${updates} updates, ${found.size} disp: ${[...found.values()]
      .map((d) => `${d.svc ? "●" : ""}${d.name}`)
      .join(", ")}`,
  );

  // service-first, then named, then the rest; sorted by name
  return [...found.values()].sort(
    (a, b) =>
      Number(b.svc) - Number(a.svc) ||
      Number(!!b.name && b.name !== b.address) -
        Number(!!a.name && a.name !== a.address) ||
      a.name.localeCompare(b.name),
  );
}

export async function createBleTransport(
  address: string,
  onLost?: () => void,
): Promise<Types.Transport> {
  // btleplug only connects to peripherals seen in an active scan. We rediscover
  // and connect as soon as the node shows up (scan still active → cached).
  const norm = (a: string) => a.replace(/[:-]/g, "").toUpperCase();
  const target = norm(address);
  await stopScan().catch(() => {});
  const addrs = new Set<string>();
  let seenResolve: (v: boolean) => void;
  const seen = new Promise<boolean>((r) => (seenResolve = r));
  void startScan((devices) => {
    for (const d of devices) {
      addrs.add(d.address);
      if (norm(d.address) === target) seenResolve(true);
    }
  }, 20000).catch((e) => addLog(`BLE scan err: ${e}`));
  const ok = await Promise.race([
    seen,
    new Promise<boolean>((r) => setTimeout(() => r(false), 12000)),
  ]);
  addLog(`BLE reconnect visto=${ok} addrs=[${[...addrs].join(", ")}]`);
  try {
    await connect(address, null);
  } finally {
    await stopScan().catch(() => {}); // stop scanning whatever happens
  }

  let controller: ReadableStreamDefaultController<Types.DeviceOutput> | null =
    null;
  let closed = false;
  let wake: (() => void) | null = null;

  const fromDevice = new ReadableStream<Types.DeviceOutput>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
      wake?.();
    },
  });

  // Continuous FROMRADIO polling. BLE delivers one complete FromRadio per read
  // (no framing). We read while there is data; once empty we wait for a
  // FROMNUM notification (or a backup poll) before reading again.
  const readLoop = async () => {
    while (!closed) {
      let got = false;
      try {
        const bytes = await read(FROMRADIO, SERVICE);
        if (bytes && bytes.length) {
          controller?.enqueue({ type: "packet", data: new Uint8Array(bytes) });
          got = true;
        }
      } catch {
        if (!closed) onLost?.(); // unexpected drop (not a manual disconnect)
        break; // desconectado
      }
      if (!got && !closed) {
        // wait for a FROMNUM notify or, as a safety net, 300 ms
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 300);
        });
        wake = null;
      }
    }
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
  };

  // FROMNUM signals new data → wakes the loop. subscribe also validates the
  // encrypted link: without bonding it gives an auth error (0x80650005).
  try {
    await subscribe(FROMNUM, SERVICE, () => wake?.());
  } catch (e) {
    await disconnect().catch(() => {});
    const msg = String(e);
    if (msg.includes("0x80650005") || /autenticaci|authentication/i.test(msg)) {
      throw new Error(
        "El nodo exige emparejar BLE. Empareja en Configuración → Bluetooth de Windows (PIN 123456 o el que muestre el nodo) y reconecta.",
      );
    }
    throw e;
  }

  const toDevice = new WritableStream<Uint8Array>({
    async write(chunk) {
      await send(TORADIO, Array.from(chunk), "withoutResponse", SERVICE);
    },
  });

  void readLoop();

  return {
    toDevice,
    fromDevice,
    async disconnect() {
      closed = true;
      wake?.();
      await unsubscribe(FROMNUM, SERVICE).catch(() => {});
      await disconnect().catch(() => {});
    },
  };
}
