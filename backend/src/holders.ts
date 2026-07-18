import { PublicKey } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { config } from "./config.js";
import { connection, treasuryKeypair } from "./treasury.js";

export interface Holder {
  owner: string;
  amountRaw: bigint;
}

/**
 * Snapshot every holder of a mint via getProgramAccounts, checking both
 * the classic token program and Token-2022 (a mint lives in exactly one,
 * but querying both means we don't care which).
 * Requires an RPC that allows gPA with filters (Helius/QuickNode do).
 * Aggregates by owner (one owner can have several token accounts),
 * applies the exclusion list, the treasury self-exclusion, and the
 * minimum-balance floor.
 */
export async function snapshotHolders(mint: PublicKey, decimals: number): Promise<Holder[]> {
  const conn = connection();

  // Classic accounts are exactly 165 bytes; Token-2022 accounts can be
  // larger (extensions), so only the mint memcmp filter applies there.
  const [classic, t22] = await Promise.all([
    conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
    }),
    conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    }),
  ]);

  const treasury = treasuryKeypair().publicKey.toBase58();
  const minRaw = BigInt(Math.floor(config.minHolderUiBalance * 10 ** decimals));

  const byOwner = new Map<string, bigint>();
  for (const { account } of [...classic, ...t22]) {
    if (account.data.length < AccountLayout.span) continue;
    const decoded = AccountLayout.decode(account.data.subarray(0, AccountLayout.span));
    const owner = new PublicKey(decoded.owner).toBase58();
    const amount = decoded.amount; // bigint
    if (amount === 0n) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
  }

  const holders: Holder[] = [];
  for (const [owner, amountRaw] of byOwner) {
    if (owner === treasury) continue;
    if (config.excludedAddresses.has(owner)) continue;
    if (amountRaw < minRaw) continue;
    holders.push({ owner, amountRaw });
  }

  // Largest first — purely cosmetic, but makes logs/DB easy to read.
  holders.sort((a, b) => (b.amountRaw > a.amountRaw ? 1 : b.amountRaw < a.amountRaw ? -1 : 0));
  return holders;
}
