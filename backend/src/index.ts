import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assertRunnable, config } from "./config.js";
import { connection, treasuryKeypair } from "./treasury.js";
import { pollDeposits, backfillDeposits } from "./watcher.js";
import { processPendingDeposits } from "./buyer.js";
import { runDistribution } from "./distributor.js";
import { startApi } from "./api.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  assertRunnable();

  const treasury = treasuryKeypair().publicKey.toBase58();
  log.info(`Treasury: ${treasury}`);
  log.info(`Buy targets: ${config.tokens.length ? config.tokens.map((t) => `${t.mint.toBase58().slice(0, 8)}…×${t.weight}`).join(", ") : "(none set)"}`);
  log.info(`MSTR mint: ${config.mstrMint?.toBase58() ?? "(not launched yet — distributions off)"}`);
  log.info(`Auto-buy: ${config.autoBuy} | Auto-distribute: ${config.autoDistribute}`);

  // API first: the service must be reachable even when the RPC is down
  // or rate-limited — boot never depends on a live RPC call.
  startApi();

  try {
    const balance = await connection().getBalance(treasuryKeypair().publicKey);
    log.info(`Balance:  ${balance / LAMPORTS_PER_SOL} SOL`);
  } catch (err) {
    log.warn(`Balance check failed at boot (RPC unavailable?) — continuing; loops will retry. ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }

  if (config.backfillOnBoot) {
    try {
      const n = await backfillDeposits(100);
      if (n > 0) log.info(`Backfill recovered ${n} missed deposit(s); the buy loop will process them.`);
    } catch (err) {
      log.error("backfill", err);
    }
  }

  // Watch + buy loop. When buys land and auto-distribute is on, the
  // payout follows immediately instead of waiting for the interval.
  let ticking = false;
  let rpcCooldownUntil = 0;
  setInterval(async () => {
    if (ticking) return; // prevent overlap if a tick runs long
    if (Date.now() < rpcCooldownUntil) return; // back off while rate-limited
    ticking = true;
    try {
      await pollDeposits();
      const bought = await processPendingDeposits();
      if (bought > 0 && config.autoDistribute) {
        log.info(`${bought} buy leg(s) landed — distributing to holders now.`);
        const result = await runDistribution();
        log.info(`Post-buy distribution: ${result.message}`);
      }
    } catch (err) {
      log.error("watch/buy tick", err);
      if (String(err).includes("429")) {
        rpcCooldownUntil = Date.now() + 5 * 60_000;
        log.warn("RPC rate-limited — pausing deposit polling for 5 minutes instead of hammering the endpoint.");
      }
    } finally {
      ticking = false;
    }
  }, config.watchIntervalSec * 1000);

  // Optional scheduled distribution: one run shortly after boot (so the
  // behavior is immediately observable), then on the configured interval.
  if (config.autoDistribute) {
    const run = async (label: string): Promise<void> => {
      try {
        const result = await runDistribution();
        log.info(`${label} distribution: ${result.message}`);
      } catch (err) {
        log.error(`${label} distribution`, err);
      }
    };
    setTimeout(() => void run("Initial"), 90_000);
    setInterval(() => void run("Scheduled"), config.distributionIntervalHours * 3600 * 1000);
  }

  log.info("Running. Send SOL to the treasury address to trigger buys.");
}

main().catch((err) => {
  log.error("Fatal", err);
  process.exit(1);
});
