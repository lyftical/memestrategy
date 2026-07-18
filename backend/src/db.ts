import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "treasury.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  signature TEXT PRIMARY KEY,
  sender TEXT,
  lamports INTEGER NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  processed INTEGER NOT NULL DEFAULT 0,   -- 0 pending, 1 bought, 2 skipped
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS buys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deposit_signature TEXT,
  mint TEXT NOT NULL,
  sol_in_lamports INTEGER NOT NULL,
  tokens_out_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  tx_signature TEXT,
  status TEXT NOT NULL,                   -- success | failed
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS distributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  total_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  holder_count INTEGER NOT NULL,
  recipient_count INTEGER NOT NULL,
  status TEXT NOT NULL,                   -- running | complete | partial | failed
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS distribution_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  tx_signature TEXT,
  status TEXT NOT NULL,                   -- pending | sent | failed
  error TEXT,
  FOREIGN KEY (distribution_id) REFERENCES distributions(id)
);

CREATE INDEX IF NOT EXISTS idx_items_dist ON distribution_items(distribution_id);
`);

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export const now = () => Math.floor(Date.now() / 1000);
