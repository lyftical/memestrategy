# MSTR Treasury — project context for Claude Code

## What this is
A Solana airdrop engine, live in production on Railway. Flow: anyone sends SOL to the treasury
wallet → the backend detects the deposit (~20s) → swaps it into the configured pump tokens via
Jupiter (even split) → immediately distributes everything held to eligible $MSTR holders,
proportional to their share of supply. A 24h interval run and a boot-time run sweep anything the
instant path missed. There is no frontend — the read-only API is the interface.

## Structure
- `backend/` — Node 22 + TypeScript service (the whole project). Deposit watcher with
  `BACKFILL_ON_BOOT` recovery scan, buy engine (Jupiter lite-api /swap/v1), holder snapshot
  (getProgramAccounts across classic SPL **and Token-2022**), proportional distributor
  (batched 5 recipients/tx, idempotent ATA creation, transferChecked), SQLite history in
  `data/`, Express API on :8787.
  CLI: `npm run wallet -- new` | `npm run snapshot` | `npm run distribute`.
- `backend/railway.json` — Railway build/start config (Root Directory = backend, volume at /app/data).

## Key behaviors (all verified on mainnet)
- Fresh holder snapshot before every distribution — never a cached list.
- Liquidity pools / bonding curves / program-owned addresses are auto-excluded
  (`AUTO_EXCLUDE_POOLS=true`): wallets are System-Program-owned, pools are not. Manual
  `EXCLUDED_ADDRESSES` remains for team wallets.
- Eligibility floor: `MIN_HOLDER_USD` (Jupiter-priced at snapshot time); falls back to
  `MIN_HOLDER_UI_BALANCE` tokens with a logged warning when the mint has no price.
- `GET /api/preview-distribution` is the dry run: holders, shares, auto-exclusions, applied
  floor, per-recipient payout plan, rent cost estimate. Check it before changing MSTR_MINT.
- Safe mint-swap ritual: set AUTO_DISTRIBUTE=false → change MSTR_MINT → check preview →
  re-enable. Auto-distribute fires ~90s after boot and instantly after buys.

## API
Read-only: /api/stats, /api/holdings, /api/deposits, /api/buys, /api/distributions[,/:id/items],
/api/preview-distribution. Admin: POST /api/admin/distribute (x-admin-key header).

## Hard rules — do not violate
- NEVER generate, read aloud, paste, or handle the treasury wallet secret key. The user runs
  `npm run wallet -- new` themselves and pastes `TREASURY_SECRET_KEY` into Railway themselves.
  Same for any exchange/bank/card credentials.
- Never commit `.env` (gitignored). Never print env var values into logs or chat.
- Never read Railway service variables wholesale (they include the treasury secret).
- Before pointing MSTR_MINT at a new token: preview first, with auto-distribute paused.
- ATA rent is ~0.002 SOL per first-time recipient per token — with 5 buy targets that is
  ~0.01 SOL per fresh holder per full cycle. Remind the user of cost math before big changes.

## Config quick reference
All knobs documented inline in `backend/.env.example`. Key ones: RPC_URL (needs
getProgramAccounts — Helius/QuickNode), TOKENS (MINT:WEIGHT,...), MSTR_MINT, MIN_HOLDER_USD (25),
AUTO_DISTRIBUTE, AUTO_EXCLUDE_POOLS, BACKFILL_ON_BOOT, RESERVE_SOL (0.05), SLIPPAGE_BPS (300),
ADMIN_KEY.
