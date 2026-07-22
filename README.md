# MSTR Treasury

A Solana airdrop engine.

**Flow:** anyone sends SOL to the treasury wallet → the backend detects the deposit → swaps the SOL into the configured pump tokens (via Jupiter) → immediately distributes everything the treasury holds to eligible $MSTR holders, proportional to their share of supply. A daily interval run and a boot-time run sweep anything the instant path missed.

```
mstr-treasury/
└── backend/     Node + TypeScript service (watcher, buyer, distributor, API)
```

## Quick start

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
TOKENS=MintAddressOne...pump:1,MintAddressTwo...pump:1
```

Weights are relative — `2` gets twice the SOL of `1`. Leave `MSTR_MINT` empty until launch; buys work without it, distributions stay off.

Run it:

```bash
npm run dev        # development
# or for production:
npm run build && npm start
```

Send SOL to the printed treasury address. Within ~20 seconds the watcher records the deposit, the buyer swaps it into your token list, and (with `AUTO_DISTRIBUTE=true` and `MSTR_MINT` set) the payout to holders follows immediately.

**Railway:** create a service from this repo, set **Root Directory** to `backend` (the included `backend/railway.json` handles build and start commands), paste your `.env` values into the Variables tab, and attach a **volume mounted at `/app/data`** so the SQLite history survives redeploys.

The backend needs a persistent process (the watcher loop), so serverless hosts won't work — use Railway/Render/Fly/VPS.

## Distribution safety rails

- **Fresh snapshot every run** — holders are queried live (classic SPL and Token-2022) seconds before each payout.
- **Pools excluded automatically** (`AUTO_EXCLUDE_POOLS=true`): liquidity pools, bonding curves, and other program-owned addresses never receive airdrops. Add team wallets to `EXCLUDED_ADDRESSES` manually.
- **USD eligibility floor** (`MIN_HOLDER_USD`): holders must hold at least this many dollars' worth of $MSTR (priced via Jupiter at snapshot time). Falls back to `MIN_HOLDER_UI_BALANCE` tokens when the mint has no price yet.
- **Dry run first:** `GET /api/preview-distribution` shows the exact holder list, shares, auto-exclusions, applied floor, and rent cost of the next payout without sending anything.

## Changing the $MSTR mint (launch day)

1. Set `AUTO_DISTRIBUTE=false` (auto-distribute fires ~90s after boot and right after buys — pause it first).
2. Change `MSTR_MINT` to the new mint.
3. Check `/api/preview-distribution`: holders look right, the pool shows up under `autoExcluded`.
4. Set `AUTO_DISTRIBUTE=true`.

## Operational notes — read before real money

- **This is a hot wallet.** The secret key sits in env on your server. If the server is compromised, the treasury is gone. Keep balances working-capital sized. Never commit `.env`.
- **ATA rent:** sending a token to a wallet that's never held it costs ~0.002 SOL, paid by the treasury — per token, so 5 buy targets ≈ 0.01 SOL per fresh holder per cycle. The USD floor keeps this sane.
- **Slippage:** pump tokens are thin. `SLIPPAGE_BPS=300` (3%) is the default; big deposits into small tokens will move the price.
- **Failed legs are safe:** a failed buy leaves the SOL in the vault; a failed distribution batch leaves the tokens in the vault. The next cycle (or the daily sweep) picks them up. `BACKFILL_ON_BOOT=true` also recovers deposits sent while the service was down.
- A token whose pitch is "hold it and receive automated payouts" can be treated as a security in a lot of jurisdictions. Worth 30 minutes with someone who knows the rules where you live.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/stats` | Treasury address, balances, totals, config |
| `GET /api/holdings` | Tokens currently in the vault |
| `GET /api/deposits` | Deposit feed |
| `GET /api/buys` | Buy feed |
| `GET /api/distributions` | Distribution runs |
| `GET /api/distributions/:id/items` | Per-wallet payout detail |
| `GET /api/preview-distribution` | Dry run: who would get what, and at what cost |
| `POST /api/admin/distribute` | Trigger a payout (`x-admin-key` header) |

## Config reference

Everything lives in `backend/.env` — see `.env.example`, every knob is documented inline.
