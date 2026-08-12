import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { config } from "./config.js";
import { connection, treasuryKeypair } from "./treasury.js";
import { setMeta } from "./db.js";
import { log } from "./log.js";

export interface Holder {
  owner: string;
  amountRaw: bigint;
}

export interface AutoExcluded {
  owner: string;
  amountRaw: bigint;
  reason: string;
}

export interface HolderSnapshot {
  holders: Holder[];
  autoExcluded: AutoExcluded[];
  /** USD price used for the MIN_HOLDER_USD floor, null if unavailable. */
  priceUsd: number | null;
  /** The effective minimum token balance applied to this snapshot. */
  minTokensRequired: number;
}

/** Jupiter price lookup; returns null when the token has no quoted price. */
async function fetchPriceUsd(mint: PublicKey): Promise<number | null> {
  try {
    const res = await fetch(`${config.priceApiBase}?ids=${mint.toBase58()}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Record<string, { price?: string | number } | null> };
    const p = Number(body.data?.[mint.toBase58()]?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

// Program IDs we can name in reports. Anything else program-owned still
// gets excluded — these labels just make the preview readable.
const KNOWN_PROGRAMS: Record<string, string> = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
};

/**
 * Snapshot every holder of a mint via getProgramAccounts, checking both
 * the classic token program and Token-2022 (a mint lives in exactly one,
 * but querying both means we don't care which).
 * Requires an RPC that allows gPA with filters (Helius/QuickNode do).
 * Aggregates by owner (one owner can have several token accounts),
 * applies the exclusion list, the treasury self-exclusion, and the
 * minimum-balance floor.
 *
 * With AUTO_EXCLUDE_POOLS on (default), holders whose owning account is a
 * program-owned address — liquidity pools, bonding curves, AMM vaults,
 * lending protocols — are excluded automatically: a human wallet is owned
 * by the System Program, a pool is owned by its AMM program. Note this
 * also excludes program-based multisigs (e.g. Squads); list such wallets
 * nowhere or handle them manually if you ever need to pay one.
 */
export async function snapshotHolders(mint: PublicKey, decimals: number): Promise<HolderSnapshot> {
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

  // Eligibility floor: MIN_HOLDER_UI_BALANCE tokens, raised to whatever
  // token amount is worth MIN_HOLDER_USD when a USD floor is configured
  // and the token has a live price. Without a price (e.g. pre-launch),
  // the token floor applies alone — logged so it's never silent.
  let minRaw = BigInt(Math.floor(config.minHolderUiBalance * 10 ** decimals));
  let priceUsd: number | null = null;
  if (config.minHolderUsd > 0) {
    priceUsd = await fetchPriceUsd(mint);
    if (priceUsd) {
      const usdFloorRaw = BigInt(Math.ceil((config.minHolderUsd / priceUsd) * 10 ** decimals));
      if (usdFloorRaw > minRaw) minRaw = usdFloorRaw;
      log.info(
        `Eligibility floor: $${config.minHolderUsd} at $${priceUsd}/token = ${Number(minRaw) / 10 ** decimals} tokens minimum.`
      );
    } else {
      log.warn(
        `MIN_HOLDER_USD=${config.minHolderUsd} set but no price available for ${mint.toBase58().slice(0, 8)}… — falling back to MIN_HOLDER_UI_BALANCE=${config.minHolderUiBalance}.`
      );
    }
  }

  const byOwner = new Map<string, bigint>();
  for (const { account } of [...classic, ...t22]) {
    if (account.data.length < AccountLayout.span) continue;
    const decoded = AccountLayout.decode(account.data.subarray(0, AccountLayout.span));
    const owner = new PublicKey(decoded.owner).toBase58();
    const amount = decoded.amount; // bigint
    if (amount === 0n) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
  }

  const candidates: Holder[] = [];
  for (const [owner, amountRaw] of byOwner) {
    if (owner === treasury) continue;
    if (config.excludedAddresses.has(owner)) continue;
    if (amountRaw < minRaw) continue;
    candidates.push({ owner, amountRaw });
  }

  const autoExcluded: AutoExcluded[] = [];
  let holders = candidates;

  if (config.autoExcludePools && candidates.length > 0) {
    // A holder's "owner" is a wallet only if that address is owned by the
    // System Program (or doesn't exist on-chain yet). Program-owned owners
    // are pools/vaults/PDAs — never pay them.
    holders = [];
    for (let i = 0; i < candidates.length; i += 100) {
      const batch = candidates.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(
        batch.map((h) => new PublicKey(h.owner)),
        "confirmed"
      );
      batch.forEach((h, j) => {
        const info = infos[j];
        if (info && !info.owner.equals(SystemProgram.programId)) {
          const prog = info.owner.toBase58();
          const reason = KNOWN_PROGRAMS[prog] ?? `program-owned (${prog.slice(0, 8)}…)`;
          autoExcluded.push({ owner: h.owner, amountRaw: h.amountRaw, reason });
          log.info(`Auto-excluded ${h.owner.slice(0, 8)}… — ${reason}`);
        } else {
          holders.push(h);
        }
      });
    }
  }

  // Largest first — purely cosmetic, but makes logs/DB easy to read.
  holders.sort((a, b) => (b.amountRaw > a.amountRaw ? 1 : b.amountRaw < a.amountRaw ? -1 : 0));
  autoExcluded.sort((a, b) => (b.amountRaw > a.amountRaw ? 1 : b.amountRaw < a.amountRaw ? -1 : 0));
  // Feed the dynamic fee/rent reserve (treasury.reserveLamports).
  setMeta("last_holder_count", String(holders.length));
  return { holders, autoExcluded, priceUsd, minTokensRequired: Number(minRaw) / 10 ** decimals };
}
