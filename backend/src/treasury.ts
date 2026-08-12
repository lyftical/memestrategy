import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { getMeta } from "./db.js";

let _connection: Connection | null = null;
let _keypair: Keypair | null = null;

export function connection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.rpcUrl, { commitment: "confirmed" });
  }
  return _connection;
}

export function treasuryKeypair(): Keypair {
  if (!_keypair) {
    const raw = config.treasurySecretKey.trim();
    if (raw.startsWith("[")) {
      _keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } else {
      _keypair = Keypair.fromSecretKey(bs58.decode(raw));
    }
  }
  return _keypair;
}

export async function treasurySolBalance(): Promise<number> {
  const lamports = await connection().getBalance(treasuryKeypair().publicKey, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

const ATA_RENT_SOL = 0.00203928;

/**
 * The fee/rent reserve, sized to the holder base instead of a fixed
 * number: worst case every eligible holder (count recorded at the last
 * snapshot) needs a new token account for every buy target, plus 25%
 * margin and a fee cushion. RESERVE_SOL acts as the floor. A fixed
 * reserve was always wrong — right for 7 holders, starved at 114.
 */
export function reserveLamports(): number {
  const holders = Number(getMeta("last_holder_count") ?? 0);
  const dynamic = holders * Math.max(1, config.tokens.length) * ATA_RENT_SOL * 1.25 + 0.02;
  return Math.floor(Math.max(config.reserveSol, dynamic) * LAMPORTS_PER_SOL);
}

/** SOL available for buying after the fee/rent reserve. */
export async function spendableLamports(): Promise<number> {
  const lamports = await connection().getBalance(treasuryKeypair().publicKey, "confirmed");
  return Math.max(0, lamports - reserveLamports());
}
