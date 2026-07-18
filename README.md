# MSTR Treasury

A Solana treasury machine with a public dashboard.

**Flow:** you send SOL to the treasury wallet → the backend detects the deposit → it swaps the SOL into your configured pump tokens (via Jupiter) → on each distribution run, everything the treasury holds is sent to $MSTR holders, proportional to their share of supply.

```
mstr-treasury/
├── backend/     Node + TypeScript service (watcher, buyer, distributor, API)
└── dashboard/   Vite + React public dashboard
```

## Quick start

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Generate a fresh treasury wallet (never reuse an existing wallet):

```bash
npm run wallet -- new
```

Put the printed base58 secret into `.env` as `TREASURY_SECRET_KEY`, set `RPC_URL` (Helius or QuickNode — you need one that allows `getProgramAccounts`), and set `TOKENS` with your pump token mints:

```
TOKENS=MintAddressOne...pump:2,MintAddressTwo...pump:1
```

Weights are relative — `2` gets twice the SOL of `1`. Leave `MSTR_MINT` empty until launch; buys work without it, distributions stay off.

Run it:

```bash
npm run dev        # development
# or for production:
npm run build && npm start
```

Send SOL to the printed treasury address. Within ~20 seconds the watcher records the deposit and the buyer swaps it into your token list.

### 2. Dashboard

```bash
cd dashboard
npm install
npm run dev                     # local, points at http://localhost:8787
```

For production, build with the deployed API URL:

```bash
VITE_API_URL=https://your-backend-host npm run build
```

**Vercel (dashboard only):** a `vercel.json` at the repo root is included — import the repo as-is and Vercel will build the dashboard automatically, no settings changes needed. Just add the `VITE_API_URL` environment variable (your backend URL) in the Vercel project and redeploy after the backend is up.

**Railway (backend):** create a service from the same repo, set **Root Directory** to `backend` (the included `backend/railway.json` handles build and start commands), paste your `.env` values into the Variables tab, and attach a **volume mounted at `/app/data`** so the SQLite history survives redeploys. Railway's generated public URL is what goes into Vercel's `VITE_API_URL`.

The backend **will not work on Vercel serverless** — the watcher loop needs a persistent process, which is why it lives on Railway/Render/Fly/VPS.

Until the backend is reachable, the dashboard shows clearly-labeled sample data so you can see the design.

### 3. When $MSTR launches

1. Put the mint in `.env` as `MSTR_MINT=...`
2. Add addresses that should NOT receive distributions to `EXCLUDED_ADDRESSES` — at minimum the pump.fun bonding curve / Raydium LP address, plus any team wallets. The treasury excludes itself automatically.
3. Restart the backend.
4. Test with a dry look first: `npm run snapshot` prints the eligible holder list.
5. Run your first payout manually: `npm run distribute` (or `POST /api/admin/distribute` with the `x-admin-key` header). Flip `AUTO_DISTRIBUTE=true` once you trust it.

## Operational notes — read before real money

- **This is a hot wallet.** The secret key sits in `.env` on your server. If the server is compromised, the treasury is gone. Keep balances working-capital sized: send what you intend to deploy, not a war chest. Never commit `.env` (add it to `.gitignore` — already done).
- **ATA rent:** sending a token to a wallet that's never held it costs ~0.002 SOL to create their token account, paid by the treasury. 1,000 fresh holders ≈ 2+ SOL in rent per token distributed. `MIN_HOLDER_UI_BALANCE` and rounding (dust floors to zero) keep this sane — tune the minimum before your first big run.
- **Slippage:** pump tokens are thin. `SLIPPAGE_BPS=300` (3%) is the default; big deposits into small tokens will move the price. Consider splitting large sends into several smaller ones.
- **Failed legs are safe:** if a buy fails, that SOL simply stays in the vault for the next cycle. If a distribution batch fails, the tokens stay in the vault and go out in the next run. Nothing is retried blindly.
- **First run behavior:** the watcher starts from "now" — SOL already sitting in the wallet before first boot isn't treated as a deposit. Send a fresh (small!) test amount after starting.
- **Test sequence:** 0.05 SOL deposit → confirm buys on Solscan → set MSTR_MINT on a test token you hold → `npm run snapshot` → `npm run distribute` → check a recipient wallet. Only then scale up.
- One more thing worth a real look before launch: a token whose pitch is "hold it and receive automated payouts" can be treated as a security in a lot of jurisdictions. Worth 30 minutes with someone who knows the rules where you live.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/stats` | Treasury address, balances, totals, config |
| `GET /api/holdings` | Tokens currently in the vault |
| `GET /api/deposits` | Deposit feed |
| `GET /api/buys` | Buy feed |
| `GET /api/distributions` | Distribution runs |
| `GET /api/distributions/:id/items` | Per-wallet payout detail |
| `POST /api/admin/distribute` | Trigger a payout (`x-admin-key` header) |

## Config reference

Everything lives in `backend/.env` — see `.env.example`, every knob is documented inline.
