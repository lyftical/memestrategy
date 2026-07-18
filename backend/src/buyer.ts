import { LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
import { config } from "./config.js";
import { connection, treasuryKeypair, spendableLamports } from "./treasury.js";
import { db, now } from "./db.js";
import { pendingDeposits, markDeposit } from "./watcher.js";
import { log } from "./log.js";

const WSOL = "So11111111111111111111111111111111111111112";

const insertBuy = db.prepare(
  `INSERT INTO buys (deposit_signature, mint, sol_in_lamports, tokens_out_raw, decimals, tx_signature, status, error, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

interface QuoteResponse {
  outAmount: string;
  [k: string]: unknown;
}

async function getQuote(outputMint: string, lamports: number): Promise<QuoteResponse> {
  const url = new URL(`${config.jupiterBase}/quote`);
  url.searchParams.set("inputMint", WSOL);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", String(lamports));
  url.searchParams.set("slippageBps", String(config.slippageBps));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text()}`);
  return (await res.json()) as QuoteResponse;
}

async function executeSwap(quote: QuoteResponse): Promise<string> {
  const kp = treasuryKeypair();
  const res = await fetch(`${config.jupiterBase}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports: 2_000_000 },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap ${res.status}: ${await res.text()}`);
  const { swapTransaction } = (await res.json()) as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([kp]);

  const conn = connection();
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const latest = await conn.getLatestBlockhash("confirmed");
  const conf = await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  if (conf.value.err) throw new Error(`Swap tx failed on-chain: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function mintDecimals(mint: string): Promise<number> {
  const info = await connection().getParsedAccountInfo(new (await import("@solana/web3.js")).PublicKey(mint));
  const parsed = info.value?.data as { parsed?: { info?: { decimals?: number } } } | null;
  return parsed?.parsed?.info?.decimals ?? 6;
}

/**
 * Convert pending deposits into token buys, split by configured weights.
 * Each deposit is spent independently so the buy feed maps 1:1 to deposits.
 */
export async function processPendingDeposits(): Promise<void> {
  if (!config.autoBuy) return;
  if (config.tokens.length === 0) {
    log.warn("Deposits pending but TOKENS is empty — nothing to buy.");
    return;
  }

  const pending = pendingDeposits();
  if (pending.length === 0) return;

  const totalWeight = config.tokens.reduce((s, t) => s + t.weight, 0);

  for (const dep of pending) {
    // Cap by what's actually spendable (reserve protected).
    const available = await spendableLamports();
    const budget = Math.min(dep.lamports, available);
    if (budget < config.minDepositSol * LAMPORTS_PER_SOL) {
      log.warn(`Deposit ${dep.signature.slice(0, 12)}… below spendable minimum, skipping.`);
      markDeposit(dep.signature, 2);
      continue;
    }

    let anySuccess = false;

    for (const target of config.tokens) {
      const share = Math.floor((budget * target.weight) / totalWeight);
      if (share <= 0) continue;
      const mint = target.mint.toBase58();
      try {
        const quote = await getQuote(mint, share);
        const sig = await executeSwap(quote);
        const decimals = await mintDecimals(mint);
        insertBuy.run(dep.signature, mint, share, quote.outAmount, decimals, sig, "success", null, now());
        anySuccess = true;
        log.info(`Bought ${mint.slice(0, 8)}… with ${share / LAMPORTS_PER_SOL} SOL → tx ${sig.slice(0, 12)}…`);
      } catch (err) {
        insertBuy.run(dep.signature, mint, share, "0", 0, null, "failed", err instanceof Error ? err.message : String(err), now());
        log.error(`Buy failed for ${mint.slice(0, 8)}…`, err);
      }
    }

    // Mark processed either way; failed legs are visible in the buys table
    // and their SOL stays in the treasury for the next deposit cycle.
    markDeposit(dep.signature, anySuccess ? 1 : 2);
  }
}
