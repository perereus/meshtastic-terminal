import type { Types } from "@meshtastic/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { makeTransport } from "./bridge";

export async function createTcpTransport(
  host: string,
  onLost?: () => void,
): Promise<Types.Transport> {
  await invoke("tcp_connect", { host });
  // The Rust side emits tcp-closed only on a real drop (EOF/error), not on a
  // manual tcp_disconnect (which aborts the reader without emitting).
  const unlistenClosed = onLost
    ? await listen("tcp-closed", () => onLost())
    : undefined;

  return makeTransport(
    async (chunk) => {
      await invoke("tcp_send", { data: Array.from(chunk) });
    },
    async (onData) => {
      const unlisten = await listen<number[]>("tcp-data", (e) => {
        onData(new Uint8Array(e.payload));
      });
      return unlisten;
    },
    async () => {
      unlistenClosed?.();
      await invoke("tcp_disconnect");
    },
  );
}
