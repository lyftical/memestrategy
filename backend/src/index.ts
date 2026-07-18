import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assertRunnable, config } from "./config.js";
import { connection, treasuryKeypair } from "./treasury.js";
import { pollDeposits } from "./watcher.js";
import { processPendingDeposits } from "./buyer.js";
import { runDistribution } from "./distributor.js";
import { startApi } from "./api.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  assertRunnable();

  const treasury = treasuryKeypair().publicKey.toBase58();
  const balance = await connection().getBalance(treasuryKeypair().publicKey);
  log.info(`Treasury: ${treasury}`);
  log.info(`Balance:  ${balance / LAMPORTS_PER_SOL} SOL`);
  log.info(`Buy targets: ${config.tokens.length ? config.tokens.map((t) => `${t.mint.toBase58().slice(0, 8)}…×${t.weight}`).join(", ") : "(none set)"}`);
  log.info(`MSTR mint: ${config.mstrMint?.toBase58() ?? "(not launched yet — distributions off)"}`);
  log.info(`Auto-buy: ${config.autoBuy} | Auto-distribute: ${config.autoDistribute}`);

  startApi();

  // Watch + buy loop
  let ticking = false;
  setInterval(async () => {
    if (ticking) return; // prevent overlap if a tick runs long
    ticking = true;
    try {
      await pollDeposits();
      await processPendingDeposits();
    } catch (err) {
      log.error("watch/buy tick", err);
    } finally {
      ticking = false;
    }
  }, config.watchIntervalSec * 1000);

  // Optional scheduled distribution
  if (config.autoDistribute) {
    setInterval(async () => {
      try {
        const result = await runDistribution();
        log.info(`Scheduled distribution: ${result.message}`);
      } catch (err) {
        log.error("scheduled distribution", err);
      }
    }, config.distributionIntervalHours * 3600 * 1000);
  }

  log.info("Running. Send SOL to the treasury address to trigger buys.");
}

main().catch((err) => {
  log.error("Fatal", err);
  process.exit(1);
});
