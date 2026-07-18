import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { config } from "./config.js";
import { connection, treasuryKeypair } from "./treasury.js";
import { snapshotHolders, type Holder } from "./holders.js";
import { db, now } from "./db.js";
import { log } from "./log.js";

const RECIPIENTS_PER_TX = 5;

interface TreasuryHolding {
  mint: PublicKey;
  amountRaw: bigint;
  decimals: number;
  programId: PublicKey;
}

/** Everything the treasury currently holds from buys (excluding MSTR itself), across both token programs. */
export async function treasuryHoldings(): Promise<TreasuryHolding[]> {
  const conn = connection();
  const owner = treasuryKeypair().publicKey;
  const holdings: TreasuryHolding[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed");
    for (const { account } of resp.value) {
      const info = account.data.parsed.info;
      const amountRaw = BigInt(info.tokenAmount.amount);
      if (amountRaw === 0n) continue;
      const mint = new PublicKey(info.mint);
      if (config.mstrMint && mint.equals(config.mstrMint)) continue;
      holdings.push({ mint, amountRaw, decimals: info.tokenAmount.decimals, programId });
    }
  }
  return holdings;
}

export function computeShares(total: bigint, holders: Holder[]): Map<string, bigint> {
  const supply = holders.reduce((s, h) => s + h.amountRaw, 0n);
  const shares = new Map<string, bigint>();
  if (supply === 0n) return shares;
  for (const h of holders) {
    const share = (total * h.amountRaw) / supply; // floor division, dust stays in treasury
    if (share > 0n) shares.set(h.owner, share);
  }
  return shares;
}

/**
 * Distribute the treasury's entire balance of every bought token,
 * proportional to each wallet's share of MSTR supply (after exclusions).
 *
 * Idempotent per run: each run creates its own distribution record.
 * Failed batches are recorded and the remaining tokens simply stay in
 * the treasury for the next run.
 */
export async function runDistribution(): Promise<{ ok: boolean; message: string }> {
  if (!config.mstrMint) {
    return { ok: false, message: "MSTR_MINT is not set — distributions are disabled until the token launches." };
  }

  const holdings = await treasuryHoldings();
  if (holdings.length === 0) {
    return { ok: false, message: "Treasury holds no distributable tokens." };
  }

  // MSTR decimals for the min-balance floor
  const conn = connection();
  const mintInfo = await conn.getParsedAccountInfo(config.mstrMint);
  const mstrDecimals =
    (mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals ?? 6;

  const holders = await snapshotHolders(config.mstrMint, mstrDecimals);
  if (holders.length === 0) {
    return { ok: false, message: "No eligible MSTR holders found." };
  }
  log.info(`Snapshot: ${holders.length} eligible MSTR holders.`);

  const kp = treasuryKeypair();

  for (const holding of holdings) {
    const shares = computeShares(holding.amountRaw, holders);
    if (shares.size === 0) continue;

    const distId = db
      .prepare(
        `INSERT INTO distributions (mint, total_raw, decimals, holder_count, recipient_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`
      )
      .run(holding.mint.toBase58(), holding.amountRaw.toString(), holding.decimals, holders.length, shares.size, now())
      .lastInsertRowid as number;

    const insertItem = db.prepare(
      `INSERT INTO distribution_items (distribution_id, recipient, amount_raw, tx_signature, status, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const sourceAta = getAssociatedTokenAddressSync(holding.mint, kp.publicKey, false, holding.programId);
    const entries = [...shares.entries()];
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < entries.length; i += RECIPIENTS_PER_TX) {
      const batch = entries.slice(i, i + RECIPIENTS_PER_TX);
      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports })
      );

      for (const [recipient, amount] of batch) {
        const owner = new PublicKey(recipient);
        const destAta = getAssociatedTokenAddressSync(holding.mint, owner, false, holding.programId);
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, destAta, owner, holding.mint, holding.programId),
          createTransferCheckedInstruction(
            sourceAta,
            holding.mint,
            destAta,
            kp.publicKey,
            amount,
            holding.decimals,
            [],
            holding.programId
          )
        );
      }

      try {
        const latest = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = latest.blockhash;
        tx.feePayer = kp.publicKey;
        tx.sign(kp);
        const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
        const conf = await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));
        for (const [recipient, amount] of batch) {
          insertItem.run(distId, recipient, amount.toString(), sig, "sent", null);
          sent++;
        }
        log.info(`Distributed batch of ${batch.length} → ${sig.slice(0, 12)}…`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const [recipient, amount] of batch) {
          insertItem.run(distId, recipient, amount.toString(), null, "failed", msg);
          failed++;
        }
        log.error(`Distribution batch failed`, err);
      }
    }

    const status = failed === 0 ? "complete" : sent === 0 ? "failed" : "partial";
    db.prepare("UPDATE distributions SET status = ?, finished_at = ? WHERE id = ?").run(status, now(), distId);
    log.info(`Distribution ${distId} for ${holding.mint.toBase58().slice(0, 8)}…: ${status} (${sent} sent, ${failed} failed)`);
  }

  return { ok: true, message: "Distribution run finished. See /api/distributions for detail." };
}
