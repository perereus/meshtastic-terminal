import { Types, Utils } from "@meshtastic/core";

/**
 * Construye un Transport de @meshtastic/core a partir de tres primitivas:
 * escribir bytes, suscribirse a bytes entrantes y cerrar. El framing del
 * protocolo lo ponen Utils.toDeviceStream/fromDeviceStream.
 */
export async function makeTransport(
  writeRaw: (chunk: Uint8Array) => Promise<void>,
  subscribeRaw: (
    onData: (chunk: Uint8Array) => void,
  ) => Promise<() => void>,
  close: () => Promise<void>,
): Promise<Types.Transport> {
  const toDeviceTransform = Utils.toDeviceStream();
  toDeviceTransform.readable.pipeTo(
    new WritableStream<Uint8Array>({
      write: (chunk) => {
        console.debug("[transport] →", chunk.length, "bytes");
        return writeRaw(chunk);
      },
    }),
  );

  const fromDeviceTransform = Utils.fromDeviceStream();
  const rawWriter = fromDeviceTransform.writable.getWriter();
  const unsubscribe = await subscribeRaw((chunk) => {
    console.debug("[transport] ←", chunk.length, "bytes");
    rawWriter.write(chunk).catch(() => {});
  });

  return {
    toDevice: toDeviceTransform.writable,
    fromDevice: fromDeviceTransform.readable,
    async disconnect() {
      unsubscribe();
      await close().catch(() => {});
    },
  };
}
