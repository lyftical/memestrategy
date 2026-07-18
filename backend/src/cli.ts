import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const cmd = process.argv[2];

async function main(): Promise<void> {
  switch (cmd) {
    case "wallet": {
      // npm run wallet -- new
      if (process.argv[3] === "new") {
        const kp = Keypair.generate();
        console.log("New treasury wallet generated. SAVE THIS SECRET KEY SECURELY.");
        console.log("");
        console.log(`Public address:  ${kp.publicKey.toBase58()}`);
        console.log(`Secret (base58): ${bs58.encode(kp.secretKey)}`);
        console.log("");
        console.log("Put the secret in .env as TREASURY_SECRET_KEY. Never commit .env.");
      } else {
        const { assertRunnable } = await import("./config.js");
        assertRunnable();
        const { treasuryKeypair, treasurySolBalance } = await import("./treasury.js");
        console.log(`Treasury: ${treasuryKeypair().publicKey.toBase58()}`);
        console.log(`Balance:  ${await treasurySolBalance()} SOL`);
      }
      break;
    }

    case "snapshot": {
      const { assertRunnable, config } = await import("./config.js");
      assertRunnable();
      if (!config.mstrMint) throw new Error("MSTR_MINT not set.");
      const { connection } = await import("./treasury.js");
      const { snapshotHolders } = await import("./holders.js");
      const info = await connection().getParsedAccountInfo(config.mstrMint);
      const decimals =
        (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals ?? 6;
      const { holders, autoExcluded } = await snapshotHolders(config.mstrMint, decimals);
      if (autoExcluded.length > 0) {
        console.log(`${autoExcluded.length} pool/program address(es) auto-excluded:`);
        for (const e of autoExcluded.slice(0, 10)) {
          console.log(`  ${e.owner}  ${Number(e.amountRaw) / 10 ** decimals}  (${e.reason})`);
        }
      }
      console.log(`${holders.length} eligible holders`);
      for (const h of holders.slice(0, 25)) {
        console.log(`${h.owner}  ${Number(h.amountRaw) / 10 ** decimals}`);
      }
      if (holders.length > 25) console.log(`… and ${holders.length - 25} more`);
      break;
    }

    case "distribute": {
      const { assertRunnable } = await import("./config.js");
      assertRunnable();
      const { runDistribution } = await import("./distributor.js");
      const result = await runDistribution();
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    default:
      console.log("Usage: tsx src/cli.ts <wallet [new] | snapshot | distribute>");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
