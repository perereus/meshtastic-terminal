// ponytail: tslog (dentro de @meshtastic/core) referencia `process` al cargar;
// este módulo debe ser el PRIMER import de main.tsx.
(globalThis as Record<string, unknown>).process ??= {
  env: {},
  argv: [],
  stdout: undefined,
  stderr: undefined,
  cwd: () => "/",
};
// tslog también llama Buffer.isBuffer() en cada log
(globalThis as Record<string, unknown>).Buffer ??= {
  isBuffer: () => false,
};
export {};
