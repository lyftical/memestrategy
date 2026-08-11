import express from "express";
import cors from "cors";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { connection, treasuryKeypair, treasurySolBalance } from "./treasury.js";
import { treasuryHoldings, runDistribution, computeShares } from "./distributor.js";
import { snapshotHolders } from "./holders.js";
import { log } from "./log.js";

/**
 * Memoize an async producer for ttlMs. Public endpoints are hit by
 * community members and bots — without this every page view costs live
 * RPC calls, which is what exhausts free-tier RPC quotas.
 */
function cached<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0;
  let val: Promise<T> | null = null;
  return () => {
    if (!val || Date.now() - at > ttlMs) {
      at = Date.now();
      val = fn().catch((err) => {
        val = null; // don't cache failures
        throw err;
      });
    }
    return val;
  };
}

export function startApi(): void {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const cachedSolBalance = cached(15_000, () => treasurySolBalance());
  const cachedHoldings = cached(15_000, () => treasuryHoldings());

  // ── Public, read-only ────────────────────────────────────────────

  app.get("/api/stats", async (_req, res) => {
    try {
      // Serve DB-backed stats even when the RPC is down; balance goes null.
      const sol = await cachedSolBalance().catch(() => null);
      const totals = db
        .prepare(
          `SELECT
             (SELECT COALESCE(SUM(lamports), 0) FROM deposits) AS deposited,
             (SELECT COALESCE(SUM(sol_in_lamports), 0) FROM buys WHERE status = 'success') AS spent,
             (SELECT COUNT(*) FROM buys WHERE status = 'success') AS buy_count,
             (SELECT COUNT(*) FROM distributions WHERE status IN ('complete','partial')) AS distribution_count,
             (SELECT COUNT(DISTINCT recipient) FROM distribution_items WHERE status = 'sent') AS unique_recipients`
        )
        .get() as Record<string, number>;

      res.json({
        treasuryAddress: treasuryKeypair().publicKey.toBase58(),
        solBalance: sol,
        totalDepositedSol: totals.deposited / LAMPORTS_PER_SOL,
        totalSpentSol: totals.spent / LAMPORTS_PER_SOL,
        buyCount: totals.buy_count,
        distributionCount: totals.distribution_count,
        uniqueRecipients: totals.unique_recipients,
        mstrMint: config.mstrMint?.toBase58() ?? null,
        buyTargets: config.tokens.map((t) => ({ mint: t.mint.toBase58(), weight: t.weight })),
        autoBuy: config.autoBuy,
        autoDistribute: config.autoDistribute,
      });
    } catch (err) {
      log.error("/api/stats", err);
      res.status(500).json({ error: "stats_failed" });
    }
  });

  app.get("/api/holdings", async (_req, res) => {
    try {
      const holdings = await cachedHoldings();
      res.json(
        holdings.map((h) => ({
          mint: h.mint.toBase58(),
          amountRaw: h.amountRaw.toString(),
          uiAmount: Number(h.amountRaw) / 10 ** h.decimals,
          decimals: h.decimals,
        }))
      );
    } catch (err) {
      log.error("/api/holdings", err);
      res.status(500).json({ error: "holdings_failed" });
    }
  });

  app.get("/api/deposits", (_req, res) => {
    const rows = db
      .prepare("SELECT signature, sender, lamports, block_time, processed, created_at FROM deposits ORDER BY created_at DESC LIMIT 100")
      .all() as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({ ...r, sol: (r.lamports as number) / LAMPORTS_PER_SOL })));
  });

  app.get("/api/buys", (_req, res) => {
    const rows = db
      .prepare("SELECT mint, sol_in_lamports, tokens_out_raw, decimals, tx_signature, status, error, created_at FROM buys ORDER BY created_at DESC LIMIT 100")
      .all() as Array<Record<string, unknown>>;
    res.json(
      rows.map((r) => ({
        ...r,
        solIn: (r.sol_in_lamports as number) / LAMPORTS_PER_SOL,
        tokensOut: Number(r.tokens_out_raw) / 10 ** (r.decimals as number),
      }))
    );
  });

  app.get("/api/distributions", (_req, res) => {
    const dists = db
      .prepare("SELECT * FROM distributions ORDER BY created_at DESC LIMIT 50")
      .all() as Array<Record<string, unknown>>;
    const itemCount = db.prepare(
      "SELECT COUNT(*) AS c FROM distribution_items WHERE distribution_id = ? AND status = 'sent'"
    );
    res.json(
      dists.map((d) => ({
        ...d,
        totalUi: Number(d.total_raw) / 10 ** (d.decimals as number),
        sentCount: (itemCount.get(d.id) as { c: number }).c,
      }))
    );
  });

  app.get("/api/distributions/:id/items", (req, res) => {
    const rows = db
      .prepare("SELECT recipient, amount_raw, tx_signature, status FROM distribution_items WHERE distribution_id = ? ORDER BY CAST(amount_raw AS INTEGER) DESC LIMIT 1000")
      .all(req.params.id);
    res.json(rows);
  });

  // Dry run: compute exactly what a distribution would send, without
  // sending anything. Read-only; everything here is public on-chain data.
  const buildPreview = async () => {
      if (!config.mstrMint) return null;
      const holdings = await cachedHoldings();
      const mintInfo = await connection().getParsedAccountInfo(config.mstrMint);
      const mstrDecimals =
        (mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals ?? 6;
      const { holders, autoExcluded, priceUsd, minTokensRequired } = await snapshotHolders(config.mstrMint, mstrDecimals);
      const supply = holders.reduce((s, h) => s + h.amountRaw, 0n);

      const plan = holdings.map((h) => {
        const shares = computeShares(h.amountRaw, holders);
        return {
          mint: h.mint.toBase58(),
          totalToDistribute: Number(h.amountRaw) / 10 ** h.decimals,
          recipientCount: shares.size,
          payouts: [...shares.entries()].slice(0, 50).map(([recipient, amt]) => ({
            recipient,
            amount: Number(amt) / 10 ** h.decimals,
          })),
        };
      });

      const totalRecipientSlots = plan.reduce((s, p) => s + p.recipientCount, 0);

      // Exact rent: count destination ATAs that don't exist yet, per mint.
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const { PublicKey } = await import("@solana/web3.js");
      const conn = connection();
      let missingAtas = 0;
      for (const h of holdings) {
        const shares = computeShares(h.amountRaw, holders);
        const atas = [...shares.keys()].map((owner) =>
          getAssociatedTokenAddressSync(h.mint, new PublicKey(owner), false, h.programId)
        );
        for (let i = 0; i < atas.length; i += 100) {
          const infos = await conn.getMultipleAccountsInfo(atas.slice(i, i + 100), "confirmed");
          missingAtas += infos.filter((x) => x === null).length;
        }
      }
      const exactRentSol = +(missingAtas * 0.00203928).toFixed(6);
      const feeEstSol = +(plan.reduce((s, p) => s + Math.ceil(p.recipientCount / 5), 0) * 0.00016).toFixed(6);
      return {
        dryRun: true,
        mstrMint: config.mstrMint.toBase58(),
        minHolderBalance: config.minHolderUiBalance,
        minHolderUsd: config.minHolderUsd || null,
        mstrPriceUsd: priceUsd,
        effectiveMinTokens: minTokensRequired,
        eligibleHolders: holders.length,
        holders: holders.slice(0, 50).map((h) => ({
          owner: h.owner,
          balance: Number(h.amountRaw) / 10 ** mstrDecimals,
          sharePct: supply > 0n ? Number((h.amountRaw * 10000n) / supply) / 100 : 0,
        })),
        autoExcluded: autoExcluded.slice(0, 20).map((e) => ({
          owner: e.owner,
          balance: Number(e.amountRaw) / 10 ** mstrDecimals,
          reason: e.reason,
        })),
        plan,
        costEstimate: {
          treasurySolBalance: await cachedSolBalance(),
          newAccountsToCreate: missingAtas,
          exactRentSol,
          feeEstSol,
          totalCostSol: +(exactRentSol + feeEstSol).toFixed(6),
          worstCaseAtaRentSol: +(totalRecipientSlots * 0.00203928).toFixed(6),
          note: "exactRentSol counts destination token accounts that don't exist yet; rent lands in recipients' accounts, not burned.",
        },
      };
  };
  // The preview walks every holder and checks hundreds of accounts — by
  // far the most RPC-expensive endpoint, and it's public. Cache hard.
  const cachedPreview = cached(60_000, buildPreview);

  app.get("/api/preview-distribution", async (_req, res) => {
    try {
      const payload = await cachedPreview();
      if (!payload) {
        res.status(400).json({ error: "mstr_mint_not_set", message: "MSTR_MINT is empty — nothing to snapshot." });
        return;
      }
      res.json(payload);
    } catch (err) {
      log.error("/api/preview-distribution", err);
      res.status(500).json({ error: "preview_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Admin (ADMIN_KEY header) ─────────────────────────────────────

  const requireAdmin: express.RequestHandler = (req, res, next) => {
    if (!config.adminKey || req.header("x-admin-key") !== config.adminKey) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.post("/api/admin/distribute", requireAdmin, async (_req, res) => {
    try {
      const result = await runDistribution();
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      log.error("manual distribution", err);
      res.status(500).json({ error: err instanceof Error ? err.message : "distribution_failed" });
    }
  });

  app.listen(config.port, () => log.info(`API listening on :${config.port}`));
}
