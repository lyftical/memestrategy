import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

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

/** SOL available for buying after the fee/rent reserve. */
export async function spendableLamports(): Promise<number> {
  const lamports = await connection().getBalance(treasuryKeypair().publicKey, "confirmed");
  const reserve = Math.floor(config.reserveSol * LAMPORTS_PER_SOL);
  return Math.max(0, lamports - reserve);
}
