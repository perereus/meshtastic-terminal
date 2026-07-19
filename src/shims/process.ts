// ponytail: tslog (inside @meshtastic/core) references `process` on load;
// this module must be the FIRST import in main.tsx.
(globalThis as Record<string, unknown>).process ??= {
  env: {},
  argv: [],
  stdout: undefined,
  stderr: undefined,
  cwd: () => "/",
};
// tslog also calls Buffer.isBuffer() on every log
(globalThis as Record<string, unknown>).Buffer ??= {
  isBuffer: () => false,
};
export {};
