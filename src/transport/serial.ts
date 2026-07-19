import type { Types } from "@meshtastic/core";
import { SerialPort } from "tauri-plugin-serialplugin";
import { makeTransport } from "./bridge";

export async function listSerialPorts(): Promise<string[]> {
  const ports = await SerialPort.available_ports();
  return Object.keys(ports);
}

export async function createSerialTransport(
  path: string,
  onLost?: () => void,
): Promise<Types.Transport> {
  // Si quedó abierto de una sesión anterior (p. ej. recarga), liberarlo
  await SerialPort.forceClose(path).catch(() => {});
  const port = new SerialPort({ path, baudRate: 115200 });
  await port.open();
  // Las placas USB-CDC (nRF52/RAK) no transmiten hasta ver DTR activo
  await port.writeDataTerminalReady(true).catch(() => {});
  await port.startListening();
  // USB desenchufado → avisar para auto-reconexión (no salta en close manual)
  if (onLost) await port.disconnected(onLost).catch(() => {});

  return makeTransport(
    async (chunk) => {
      await port.writeBinary(chunk);
    },
    async (onData) => {
      const unlisten = await port.listen((data: Uint8Array) => {
        onData(data);
      }, false);
      return unlisten;
    },
    async () => {
      await port.cancelAllListeners().catch(() => {});
      await port.close();
    },
  );
}
