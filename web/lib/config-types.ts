// Client-safe config types (no node:fs). The server loader lives in lib/config.ts.

export type AssetCfg = {
  /** Asset code. For the native asset this is typically "XLM" and `issuer` is null. */
  code: string;
  /** Classic issuer (G...). null => native XLM. */
  issuer: string | null;
  /** Stellar Asset Contract id (C...), when known. */
  sac?: string;
};

export type StrategyStatus = "live" | "idle" | "coming-soon";

/** One Lotus vault instance: a lotus_vault contract + the DeFindex vault / Blend pool behind it. */
export type Strategy = {
  id: string;
  label: string;
  status: StrategyStatus;
  /** lotus_vault Soroban contract (C...). Empty string when the strategy is only announced. */
  lotusVault: string;
  underlying: AssetCfg;
  receipt: AssetCfg;
  defindexVault: string;
  defindexStrategy: string | null;
  blendPool: string;
  notes: string;
  /** Yield measured by the deployment team (testnet.contract.json observed_apr). Not computed by this app, never a forecast. */
  observed?: { summary: string; measuredOn: string };
  /** "file" when read from testnet.strategies.json, "derived" when synthesised from testnet.contract.json. */
  origin: "file" | "derived";
};

export type PoolStatus = "live" | "idle" | "coming-soon" | "mock";

/** One Lotus POOL instance: a lotus_pool Soroban range pool for a pair (LBOND / USDC) and a yield strategy for its USDC leg. */
export type PoolInstance = {
  id: string;
  label: string;
  status: PoolStatus;
  /** lotus_pool contract (C...). Empty for the local simulation. */
  contract: string;
  base: AssetCfg;
  quote: AssetCfg;
  /** DeFindex vault holding the pool's USDC leg, or null when the USDC sits idle in the pool. */
  vault: string | null;
  /** Entry of testnet.strategies.json describing the DeFindex strategy behind `vault`. */
  strategyId: string | null;
  binStepBps: number;
  feeBps: number;
  supportsTwoWay: boolean;
  /** true => no deployed contract: the UI runs against a local in-browser simulation. */
  mock: boolean;
};

export type LotusConfig = {
  network: string;
  rpc: string;
  horizon: string;
  passphrase: string;
  /** Primary lotus_vault contract id (C...) from testnet.contract.json. Empty when not deployed. */
  lotusVault: string;
  underlying: AssetCfg;
  receipt: AssetCfg;
  /** The simulated tokenized bond (LBOND), from testnet.classic.json. */
  rwa: AssetCfg;
  defindexVault: string;
  blendPool: string;
  /** Every Lotus vault instance (testnet.strategies.json, or ONE derived from testnet.contract.json). */
  strategies: Strategy[];
  /** Lotus pool instances (testnet.pool.json); a single local simulation instance until that file exists. */
  pools: PoolInstance[];
  /** Named demo accounts (maker, taker, peg_lp, rwa_issuer, ...) merged from the deployment files. Public keys only. */
  accounts: Record<string, string>;
  /** Where each half came from: an absolute file path, or "example" / "derived" / "none". */
  sources: { contract: string; classic: string; strategies: string; pools: string };
  /** ISO timestamp of the read (lets the client see when config last refreshed). */
  loadedAt: string;
};
