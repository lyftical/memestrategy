import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { connection, treasuryKeypair } from "./treasury.js";
import { db, getMeta, setMeta, now } from "./db.js";
import { log } from "./log.js";

export interface Deposit {
  signature: string;
  sender: string | null;
  lamports: number;
  slot: number;
  blockTime: number | null;
}

const insertDeposit = db.prepare(
  `INSERT OR IGNORE INTO deposits (signature, sender, lamports, slot, block_time, processed, created_at)
   VALUES (?, ?, ?, ?, ?, 0, ?)`
);

/**
 * Scan for new transactions on the treasury address, record any that
 * increased its SOL balance (i.e. deposits). Returns newly found deposits.
 *
 * On the very first run we mark the current head as the starting point
 * instead of processing history — pre-existing balance is not treated as
 * a fresh deposit (change INITIAL_SYNC below if you want backfill).
 */
export async function pollDeposits(): Promise<Deposit[]> {
  const conn = connection();
  const treasury = treasuryKeypair().publicKey;
  const lastSeen = getMeta("last_signature");

  const sigInfos = await conn.getSignaturesForAddress(
    treasury,
    lastSeen ? { until: lastSeen, limit: 200 } : { limit: 1 },
    "confirmed"
  );

  if (sigInfos.length === 0) return [];

  // Newest first from RPC — process oldest first.
  const ordered = [...sigInfos].reverse();

  if (!lastSeen) {
    // First run: set the watermark, don't backfill.
    setMeta("last_signature", ordered[ordered.length - 1].signature);
    log.info(`Watcher initialized at signature ${ordered[ordered.length - 1].signature.slice(0, 12)}…`);
    return [];
  }

  const found: Deposit[] = [];

  for (const info of ordered) {
    if (info.err) continue;
    const tx = await conn.getTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) continue;

    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined,
    });
    const idx = keys.staticAccountKeys
      .concat(keys.accountKeysFromLookups?.writable ?? [], keys.accountKeysFromLookups?.readonly ?? [])
      .findIndex((k: PublicKey) => k.equals(treasury));
    if (idx === -1) continue;

    const delta = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
    // Only positive deltas where we didn't sign it ourselves (fee payer = index 0).
    const feePayer = keys.staticAccountKeys[0];
    if (delta <= 0 || feePayer.equals(treasury)) continue;

    const dep: Deposit = {
      signature: info.signature,
      sender: feePayer.toBase58(),
      lamports: delta,
      slot: info.slot,
      blockTime: info.blockTime ?? null,
    };
    insertDeposit.run(dep.signature, dep.sender, dep.lamports, dep.slot, dep.blockTime, now());
    found.push(dep);
    log.info(`Deposit ${dep.lamports / LAMPORTS_PER_SOL} SOL from ${dep.sender?.slice(0, 8)}… (${dep.signature.slice(0, 12)}…)`);
  }

  setMeta("last_signature", ordered[ordered.length - 1].signature);

  // Filter dust
  return found.filter((d) => d.lamports / LAMPORTS_PER_SOL >= config.minDepositSol);
}

/**
 * One-shot recovery scan: walk the most recent `limit` transactions and
 * record any deposits not already in the table (e.g. sent while the
 * service was down or before the watermark was set). Idempotent — known
 * signatures are ignored. Does not move the forward watermark.
 */
export async function backfillDeposits(limit = 100): Promise<number> {
  const conn = connection();
  const treasury = treasuryKeypair().publicKey;
  const sigInfos = await conn.getSignaturesForAddress(treasury, { limit }, "confirmed");
  let recovered = 0;

  for (const info of [...sigInfos].reverse()) {
    if (info.err) continue;
    const exists = db.prepare("SELECT 1 FROM deposits WHERE signature = ?").get(info.signature);
    if (exists) continue;
    const tx = await conn.getTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) continue;

    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined,
    });
    const idx = keys.staticAccountKeys
      .concat(keys.accountKeysFromLookups?.writable ?? [], keys.accountKeysFromLookups?.readonly ?? [])
      .findIndex((k: PublicKey) => k.equals(treasury));
    if (idx === -1) continue;

    const delta = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
    const feePayer = keys.staticAccountKeys[0];
    if (delta <= 0 || feePayer.equals(treasury)) continue;

    insertDeposit.run(info.signature, feePayer.toBase58(), delta, info.slot, info.blockTime ?? null, now());
    recovered++;
    log.info(`Backfilled deposit ${delta / LAMPORTS_PER_SOL} SOL from ${feePayer.toBase58().slice(0, 8)}… (${info.signature.slice(0, 12)}…)`);
  }

  if (recovered === 0) log.info("Backfill scan complete — no missed deposits found.");
  return recovered;
}

/** Deposits recorded but not yet converted into buys. */
export function pendingDeposits(): { signature: string; lamports: number }[] {
  return db
    .prepare("SELECT signature, lamports FROM deposits WHERE processed = 0 ORDER BY created_at ASC")
    .all() as { signature: string; lamports: number }[];
}

export function markDeposit(signature: string, state: 1 | 2): void {
  db.prepare("UPDATE deposits SET processed = ? WHERE signature = ?").run(state, signature);
}
