"use client";

// Polls the connected wallet's Horizon account (balances, trustlines, liabilities)
// and shares it across panels.

import { createContext, useCallback, useContext } from "react";
import { fetchAccount, type HorizonAccount } from "./stellar";
import { usePolling, type Polled } from "./hooks";
import { useWallet } from "./wallet";

type AccountState = Polled<HorizonAccount | null> & { address: string | null };

const AccountCtx = createContext<AccountState | null>(null);

export function AccountProvider({ horizon, children }: { horizon: string; children: React.ReactNode }) {
  const { address } = useWallet();
  const fn = useCallback(() => (address ? fetchAccount(horizon, address) : Promise.resolve(null)), [horizon, address]);
  const polled = usePolling(fn, 6000, !!address);
  return <AccountCtx.Provider value={{ ...polled, address }}>{children}</AccountCtx.Provider>;
}

export function useAccount(): AccountState {
  const ctx = useContext(AccountCtx);
  if (!ctx) throw new Error("useAccount outside AccountProvider");
  return ctx;
}
