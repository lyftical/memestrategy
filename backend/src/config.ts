import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Config ${name} is not a number: ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

export interface BuyTarget {
  mint: PublicKey;
  weight: number;
}

function parseTokens(raw: string | undefined): BuyTarget[] {
  if (!raw || raw.trim() === "") return [];
  // Forgive common paste mistakes: surrounding quotes, an accidental
  // "TOKENS=" prefix, and newlines/spaces used instead of commas.
  const cleaned = raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^TOKENS=/i, "");
  const entries = cleaned.split(/[\s,]+/).filter(Boolean);
  return entries.map((entry) => {
    const [mint, weight] = entry.split(":");
    const w = weight ? Number(weight) : 1;
    if (Number.isNaN(w) || w <= 0) {
      throw new Error(`Config TOKENS entry "${entry}" has an invalid weight — expected MINT:WEIGHT like abc...pump:2`);
    }
    try {
      return { mint: new PublicKey(mint), weight: w };
    } catch {
      throw new Error(`Config TOKENS entry "${entry}" is not a valid mint address — expected MINT:WEIGHT,MINT:WEIGHT`);
    }
  });
}

function parseExcluded(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const a of raw.split(",")) {
    const t = a.trim();
    if (t) set.add(new PublicKey(t).toBase58());
  }
  return set;
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? "",
  treasurySecretKey: process.env.TREASURY_SECRET_KEY ?? "",
  tokens: parseTokens(process.env.TOKENS),
  mstrMint: process.env.MSTR_MINT ? new PublicKey(process.env.MSTR_MINT) : null,

  autoBuy: bool("AUTO_BUY", true),
  minDepositSol: num("MIN_DEPOSIT_SOL", 0.01),
  reserveSol: num("RESERVE_SOL", 0.05),
  slippageBps: num("SLIPPAGE_BPS", 300),
  priorityFeeMicroLamports: num("PRIORITY_FEE_MICROLAMPORTS", 100_000),
  watchIntervalSec: num("WATCH_INTERVAL_SEC", 20),
  jupiterBase: process.env.JUPITER_BASE ?? "https://lite-api.jup.ag/swap/v1",

  autoDistribute: bool("AUTO_DISTRIBUTE", false),
  distributionIntervalHours: num("DISTRIBUTION_INTERVAL_HOURS", 24),
  minHolderUiBalance: num("MIN_HOLDER_UI_BALANCE", 1),
  excludedAddresses: parseExcluded(process.env.EXCLUDED_ADDRESSES),

  port: num("PORT", 8787),
  adminKey: process.env.ADMIN_KEY ?? "",
};

export function assertRunnable(): void {
  const missing: string[] = [];
  if (!config.rpcUrl) missing.push("RPC_URL");
  if (!config.treasurySecretKey) missing.push("TREASURY_SECRET_KEY");
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(", ")} — copy .env.example to .env and fill it in.`);
  }
}
