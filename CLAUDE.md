# MSTR Treasury — project context for Claude Code

## What this is
A Solana treasury machine with a public dashboard, built in a Claude.ai chat and handed off here.
Flow: owner sends SOL to a treasury wallet → backend detects the deposit → swaps SOL into configured
pump.fun tokens via Jupiter → distributions send everything held to $MSTR holders, proportional to
their share of supply. $MSTR has NOT launched yet — buys work now, distributions unlock when
MSTR_MINT is set in backend/.env.

## Structure
- `backend/` — Node 22 + TypeScript service. Deposit watcher (signature polling), buy engine
  (Jupiter lite-api /swap/v1), holder snapshot (getProgramAccounts), proportional distributor
  (batched 5 recipients/tx, idempotent ATA creation), SQLite history in `data/`, Express read-only
  API on :8787 plus `POST /api/admin/distribute` guarded by `x-admin-key`.
  CLI: `npm run wallet -- new` | `npm run snapshot` | `npm run distribute`. Typechecks clean.
- `dashboard/` — Vite + React. Polls the API every 15s; shows clearly-labeled demo data when the
  backend is unreachable. Builds clean. `VITE_API_URL` selects the backend at build time.
- `vercel.json` (root) — builds the dashboard from a repo-root import, no settings needed.
- `backend/railway.json` — build/start commands for Railway (still set Root Directory = backend).

## Current state / what's left to do
Code is complete and verified locally. Nothing is deployed. Remaining work, in order:
1. `git init`, create a GitHub repo (private is fine), push.
2. Deploy dashboard to Vercel (import repo; vercel.json handles the build). A previous attempt
   deployed the repo root with no config and did nothing — that's fixed by vercel.json.
3. Deploy backend to Railway: Root Directory `backend`, attach a volume at `/app/data`
   (SQLite lives there), set env vars from `backend/.env.example`.
4. Set `VITE_API_URL` in Vercel to the Railway public URL, redeploy dashboard.
5. Later, when the user provides them: put pump token mints in `TOKENS=mint:weight,...`, and at
   $MSTR launch set `MSTR_MINT` plus `EXCLUDED_ADDRESSES` (LP/bonding curve, team wallets).

## Hard rules — do not violate
- NEVER generate, read aloud, paste, or handle the treasury wallet secret key. The user runs
  `npm run wallet -- new` themselves and pastes `TREASURY_SECRET_KEY` into Railway themselves.
  Same for any exchange/bank/card credentials.
- Never commit `.env` (already gitignored). Never print env var values into logs or chat.
- Before the first real distribution: run `npm run snapshot` and show the user the holder list;
  distributions are manual (`AUTO_DISTRIBUTE=false`) until the user has verified a test run.
- Recommend a small end-to-end test (~0.05 SOL) before any real size. ATA rent is ~0.002 SOL per
  first-time recipient — remind the user of the cost math before large distributions.

## Config quick reference
All knobs documented inline in `backend/.env.example`. Key ones: RPC_URL (needs
getProgramAccounts — Helius/QuickNode), TOKENS, SLIPPAGE_BPS (300), RESERVE_SOL (0.05),
MIN_HOLDER_UI_BALANCE, ADMIN_KEY.
