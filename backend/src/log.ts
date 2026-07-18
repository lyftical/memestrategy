const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const log = {
  info: (msg: string) => console.log(`[${ts()}] ${msg}`),
  warn: (msg: string) => console.warn(`[${ts()}] WARN ${msg}`),
  error: (msg: string, err?: unknown) =>
    console.error(`[${ts()}] ERROR ${msg}`, err instanceof Error ? err.message : err ?? ""),
};
