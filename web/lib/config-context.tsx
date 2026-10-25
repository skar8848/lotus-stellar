"use client";

// Client-side access to the deployment config. The server renders the first value (read from
// ../deployments at request time); the provider then re-reads /api/config every 20 s so a
// strategies file written while the app is open (a second Lotus vault) shows up on its own.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { LotusConfig, Strategy } from "./config-types";
import type { NetCfg } from "./stellar";

const ConfigCtx = createContext<LotusConfig | null>(null);

const signature = (c: LotusConfig) => JSON.stringify({ ...c, loadedAt: undefined });

export function ConfigProvider({ initial, children }: { initial: LotusConfig; children: React.ReactNode }) {
  const [config, setConfig] = useState(initial);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as LotusConfig;
        if (alive && signature(next) !== signature(config)) setConfig(next);
      } catch {
        /* offline / dev server restarting: keep the last config */
      }
    };
    const id = setInterval(tick, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [config]);

  return <ConfigCtx.Provider value={config}>{children}</ConfigCtx.Provider>;
}

export function useConfig(): LotusConfig {
  const ctx = useContext(ConfigCtx);
  if (!ctx) throw new Error("useConfig outside ConfigProvider");
  return ctx;
}

export function useNet(): NetCfg {
  const c = useConfig();
  return useMemo(() => ({ rpc: c.rpc, horizon: c.horizon, passphrase: c.passphrase }), [c.rpc, c.horizon, c.passphrase]);
}

export function useStrategies(): Strategy[] {
  return useConfig().strategies;
}
