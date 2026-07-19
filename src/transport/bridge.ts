import { Types, Utils } from "@meshtastic/core";

/**
 * Builds a @meshtastic/core Transport from three primitives: write bytes,
 * subscribe to incoming bytes and close. The protocol framing is handled by
 * Utils.toDeviceStream/fromDeviceStream.
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
