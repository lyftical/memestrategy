import { useEffect, useState } from "react";
import { fetchSnapshot, type Snapshot } from "./api";

const short = (a: string | null | undefined, n = 4) =>
  !a ? "—" : `${a.slice(0, n)}…${a.slice(-n)}`;

const fmt = (n: number, d = 2) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
  : n.toLocaleString(undefined, { maximumFractionDigits: d });

const ago = (unix: number) => {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`;

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const s = await fetchSnapshot();
      if (!alive) return;
      setSnap(s);
      setUpdatedAt(new Date());
    };
    load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!snap) {
    return <div className="wrap"><p className="empty">Loading treasury…</p></div>;
  }

  const { stats, holdings, buys, deposits, distributions, live } = snap;

  const copyAddr = async () => {
    await navigator.clipboard.writeText(stats.treasuryAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="wrap">
      <header>
        <div className="wordmark">
          <em>MSTR</em> TREASURY
          <small>BUY · HOLD · DISTRIBUTE</small>
        </div>
        <button className="addr" onClick={copyAddr} title="Copy treasury address">
          <span className={`dot ${live ? "live" : "demo"}`} />
          {copied ? "copied" : short(stats.treasuryAddress, 6)}
        </button>
      </header>

      {!live && (
        <div className="notice">
          Showing sample data — backend not reachable. Start it with <b>npm run dev</b> in /backend.
        </div>
      )}
      {live && !stats.mstrMint && (
        <div className="notice">
          $MSTR has not launched yet. The treasury is buying; distributions switch on once MSTR_MINT is set.
        </div>
      )}

      {/* Signature: the flow pipeline */}
      <section className="pipeline" aria-label="Treasury flow">
        <div className="stage">
          <div className="label">DEPOSITS IN</div>
          <div className="value sol">{fmt(stats.totalDepositedSol)} SOL</div>
          <div className="sub">{deposits.length} recorded</div>
        </div>
        <div className="conn" aria-hidden="true" />
        <div className="stage">
          <div className="label">VAULT</div>
          <div className="value gold">{fmt(stats.solBalance, 3)} SOL</div>
          <div className="sub">{short(stats.treasuryAddress)}</div>
        </div>
        <div className="conn" aria-hidden="true" />
        <div className="stage">
          <div className="label">BUYS</div>
          <div className="value">{stats.buyCount}</div>
          <div className="sub">{fmt(stats.totalSpentSol)} SOL deployed</div>
        </div>
        <div className="conn" aria-hidden="true" />
        <div className="stage">
          <div className="label">TO HOLDERS</div>
          <div className="value">{fmt(stats.uniqueRecipients, 0)}</div>
          <div className="sub">{stats.distributionCount} distributions</div>
        </div>
      </section>

      <section className="stats">
        <div className="stat"><div className="k">AUTO-BUY</div><div className="v">{stats.autoBuy ? "ON" : "OFF"}</div></div>
        <div className="stat"><div className="k">AUTO-DISTRIBUTE</div><div className="v">{stats.autoDistribute ? "ON" : "MANUAL"}</div></div>
        <div className="stat"><div className="k">BUY TARGETS</div><div className="v">{stats.buyTargets.length}</div></div>
        <div className="stat"><div className="k">$MSTR MINT</div><div className="v">{stats.mstrMint ? short(stats.mstrMint) : "pre-launch"}</div></div>
      </section>

      <div className="grid2">
        <section className="panel">
          <h2>TREASURY HOLDINGS</h2>
          {holdings.length === 0 ? (
            <p className="empty">No tokens held yet. Send SOL to the vault to start buying.</p>
          ) : (
            <table>
              <thead><tr><th>Token</th><th className="num">Balance</th></tr></thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.mint}>
                    <td><a className="mintlink" href={solscanToken(h.mint)} target="_blank" rel="noreferrer">{short(h.mint, 5)}</a></td>
                    <td className="num">{fmt(h.uiAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>BUY TARGETS</h2>
          {stats.buyTargets.length === 0 ? (
            <p className="empty">No targets configured. Set TOKENS in the backend .env.</p>
          ) : (
            <table>
              <thead><tr><th>Token</th><th className="num">Weight</th></tr></thead>
              <tbody>
                {stats.buyTargets.map((t) => (
                  <tr key={t.mint}>
                    <td><a className="mintlink" href={solscanToken(t.mint)} target="_blank" rel="noreferrer">{short(t.mint, 5)}</a></td>
                    <td className="num">{t.weight}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>RECENT BUYS</h2>
          {buys.length === 0 ? (
            <p className="empty">No buys yet.</p>
          ) : (
            <table>
              <thead><tr><th>Token</th><th className="num">SOL in</th><th className="num">Tokens out</th><th>Status</th><th className="num">When</th></tr></thead>
              <tbody>
                {buys.slice(0, 12).map((b, i) => (
                  <tr key={i}>
                    <td>
                      {b.tx_signature
                        ? <a className="mintlink" href={solscanTx(b.tx_signature)} target="_blank" rel="noreferrer">{short(b.mint, 4)}</a>
                        : short(b.mint, 4)}
                    </td>
                    <td className="num">{fmt(b.solIn, 3)}</td>
                    <td className="num">{fmt(b.tokensOut)}</td>
                    <td><span className={`tag ${b.status === "success" ? "ok" : "bad"}`}>{b.status}</span></td>
                    <td className="num">{ago(b.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>DISTRIBUTIONS</h2>
          {distributions.length === 0 ? (
            <p className="empty">No distributions yet. They begin once $MSTR launches.</p>
          ) : (
            <table>
              <thead><tr><th>Token</th><th className="num">Amount</th><th className="num">Wallets</th><th>Status</th><th className="num">When</th></tr></thead>
              <tbody>
                {distributions.slice(0, 12).map((d) => (
                  <tr key={d.id}>
                    <td><a className="mintlink" href={solscanToken(d.mint)} target="_blank" rel="noreferrer">{short(d.mint, 4)}</a></td>
                    <td className="num">{fmt(d.totalUi)}</td>
                    <td className="num">{d.sentCount}/{d.recipient_count}</td>
                    <td><span className={`tag ${d.status === "complete" ? "ok" : d.status === "failed" ? "bad" : "pend"}`}>{d.status}</span></td>
                    <td className="num">{ago(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="panel">
        <h2>DEPOSITS</h2>
        {deposits.length === 0 ? (
          <p className="empty">No deposits detected yet. Send SOL to {short(snap.stats.treasuryAddress, 6)} to fuel the machine.</p>
        ) : (
          <table>
            <thead><tr><th>From</th><th className="num">SOL</th><th>State</th><th className="num">When</th></tr></thead>
            <tbody>
              {deposits.slice(0, 12).map((d) => (
                <tr key={d.signature}>
                  <td>
                    <a className="mintlink" href={solscanTx(d.signature)} target="_blank" rel="noreferrer">{short(d.sender, 5)}</a>
                  </td>
                  <td className="num">{fmt(d.sol, 3)}</td>
                  <td>
                    <span className={`tag ${d.processed === 1 ? "ok" : d.processed === 2 ? "bad" : "pend"}`}>
                      {d.processed === 1 ? "bought" : d.processed === 2 ? "skipped" : "pending"}
                    </span>
                  </td>
                  <td className="num">{ago(d.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer>
        <span>{live ? "● live" : "● demo data"} · refreshes every 15s</span>
        <span>updated {updatedAt ? updatedAt.toLocaleTimeString() : "—"}</span>
      </footer>
    </div>
  );
}
