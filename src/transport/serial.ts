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
  // If it was left open from a previous session (e.g. a reload), release it
  await SerialPort.forceClose(path).catch(() => {});
  const port = new SerialPort({ path, baudRate: 115200 });
  await port.open();
  // USB-CDC boards (nRF52/RAK) don't transmit until they see DTR asserted
  await port.writeDataTerminalReady(true).catch(() => {});
  await port.startListening();
  // USB unplugged → report it for auto-reconnection (doesn't fire on manual close)
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
