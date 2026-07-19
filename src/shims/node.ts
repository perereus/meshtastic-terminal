// ponytail: os/path/util shim for the @meshtastic/core bundle (tslog);
// in a browser runtime tslog never calls these functions.
export function hostname(): string {
  return "tauri";
}

export function normalize(p: string): string {
  return p;
}

export function formatWithOptions(_opts: unknown, ...args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
}

export const types = {
  isError: (e: unknown): boolean => e instanceof Error,
};

export default { hostname, normalize, formatWithOptions, types };
