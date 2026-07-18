export const API_BASE = (import.meta as any).env?.VITE_API_URL ?? "http://localhost:8787";

export interface Stats {
  treasuryAddress: string;
  solBalance: number;
  totalDepositedSol: number;
  totalSpentSol: number;
  buyCount: number;
  distributionCount: number;
  uniqueRecipients: number;
  mstrMint: string | null;
  buyTargets: { mint: string; weight: number }[];
  autoBuy: boolean;
  autoDistribute: boolean;
}

export interface Holding {
  mint: string;
  uiAmount: number;
  decimals: number;
}

export interface Buy {
  mint: string;
  solIn: number;
  tokensOut: number;
  tx_signature: string | null;
  status: string;
  created_at: number;
}

export interface Deposit {
  signature: string;
  sender: string | null;
  sol: number;
  processed: number;
  created_at: number;
}

export interface Distribution {
  id: number;
  mint: string;
  totalUi: number;
  holder_count: number;
  recipient_count: number;
  sentCount: number;
  status: string;
  created_at: number;
}

export interface Snapshot {
  live: boolean;
  stats: Stats;
  holdings: Holding[];
  buys: Buy[];
  deposits: Deposit[];
  distributions: Distribution[];
}

async function j<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchSnapshot(): Promise<Snapshot> {
  try {
    const [stats, holdings, buys, deposits, distributions] = await Promise.all([
      j<Stats>("/api/stats"),
      j<Holding[]>("/api/holdings"),
      j<Buy[]>("/api/buys"),
      j<Deposit[]>("/api/deposits"),
      j<Distribution[]>("/api/distributions"),
    ]);
    return { live: true, stats, holdings, buys, deposits, distributions };
  } catch {
    return { live: false, ...DEMO };
  }
}

// Sample data shown while the backend is offline, so the layout is
// visible before anything is deployed.
const t = Math.floor(Date.now() / 1000);
const DEMO: Omit<Snapshot, "live"> = {
  stats: {
    treasuryAddress: "TREAsury11111111111111111111111111111111111",
    solBalance: 4.2069,
    totalDepositedSol: 18.5,
    totalSpentSol: 14.1,
    buyCount: 12,
    distributionCount: 3,
    uniqueRecipients: 847,
    mstrMint: null,
    buyTargets: [
      { mint: "PUMP1exampleMintAAAAAAAAAAAAAAAAAAAAAAAApump", weight: 2 },
      { mint: "PUMP2exampleMintBBBBBBBBBBBBBBBBBBBBBBBBpump", weight: 1 },
    ],
    autoBuy: true,
    autoDistribute: false,
  },
  holdings: [
    { mint: "PUMP1exampleMintAAAAAAAAAAAAAAAAAAAAAAAApump", uiAmount: 1_240_500, decimals: 6 },
    { mint: "PUMP2exampleMintBBBBBBBBBBBBBBBBBBBBBBBBpump", uiAmount: 655_000, decimals: 6 },
  ],
  buys: [
    { mint: "PUMP1exampleMintAAAAAAAAAAAAAAAAAAAAAAAApump", solIn: 1.33, tokensOut: 412_000, tx_signature: "5demoSig1", status: "success", created_at: t - 3600 },
    { mint: "PUMP2exampleMintBBBBBBBBBBBBBBBBBBBBBBBBpump", solIn: 0.66, tokensOut: 198_400, tx_signature: "5demoSig2", status: "success", created_at: t - 3620 },
    { mint: "PUMP1exampleMintAAAAAAAAAAAAAAAAAAAAAAAApump", solIn: 2.0, tokensOut: 655_100, tx_signature: "5demoSig3", status: "success", created_at: t - 86400 },
  ],
  deposits: [
    { signature: "3demoDep1", sender: "9wFFdemoSenderAAAA", sol: 2.0, processed: 1, created_at: t - 3700 },
    { signature: "3demoDep2", sender: "9wFFdemoSenderAAAA", sol: 2.0, processed: 1, created_at: t - 86500 },
  ],
  distributions: [
    { id: 3, mint: "PUMP1exampleMintAAAAAAAAAAAAAAAAAAAAAAAApump", totalUi: 900_000, holder_count: 912, recipient_count: 847, sentCount: 847, status: "complete", created_at: t - 172800 },
  ],
};
