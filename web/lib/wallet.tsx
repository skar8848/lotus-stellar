"use client";

// Thin React wrapper around @creit.tech/stellar-wallets-kit v2 (static API).
// The kit is loaded lazily on the client: it registers web components and touches `window`.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type Kit = typeof import("@creit.tech/stellar-wallets-kit/sdk").StellarWalletsKit;

export type WalletState = {
  /** Connected public key, or null. */
  address: string | null;
  /** Kit finished loading. */
  ready: boolean;
  busy: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Sign a transaction XDR; resolves with the signed XDR. */
  sign: (xdr: string) => Promise<string>;
};

const WalletCtx = createContext<WalletState | null>(null);

let kitInitialised = false;

export function WalletProvider({ passphrase, children }: { passphrase: string; children: React.ReactNode }) {
  const kitRef = useRef<Kit | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    (async () => {
      const [{ StellarWalletsKit }, { defaultModules }, types] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit/sdk"),
        import("@creit.tech/stellar-wallets-kit/modules/utils"),
        import("@creit.tech/stellar-wallets-kit/types"),
      ]);
      if (cancelled) return;
      if (!kitInitialised) {
        StellarWalletsKit.init({
          modules: defaultModules(),
          network: passphrase as (typeof types.Networks)[keyof typeof types.Networks],
          theme: {
            ...types.SwkAppDarkTheme,
            background: "#0a0a0a",
            "background-secondary": "#111111",
            "foreground-strong": "#ffffff",
            foreground: "#ededed",
            "foreground-secondary": "#8898a8",
            primary: "#ffffff",
            "primary-foreground": "#000000",
            border: "rgba(255,255,255,0.14)",
            "border-radius": "10px",
            "font-family": "Inter, system-ui, sans-serif",
          },
          authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
        });
        kitInitialised = true;
      }
      kitRef.current = StellarWalletsKit;
      // Fires at launch too, which restores a previously connected wallet.
      unsub = StellarWalletsKit.on(types.KitEventType.STATE_UPDATED, (e) => {
        setAddress(e.payload.address ?? null);
      });
      setReady(true);
    })().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [passphrase]);

  const connect = useCallback(async () => {
    const kit = kitRef.current;
    if (!kit) return;
    setBusy(true);
    setError(null);
    try {
      const { address } = await kit.authModal();
      setAddress(address);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // closing the modal is not an error worth showing
      if (!/closed|cancel/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const kit = kitRef.current;
    try {
      await kit?.disconnect();
    } finally {
      setAddress(null);
    }
  }, []);

  const sign = useCallback(
    async (xdr: string) => {
      const kit = kitRef.current;
      if (!kit || !address) throw new Error("wallet not connected");
      const { signedTxXdr } = await kit.signTransaction(xdr, { networkPassphrase: passphrase, address });
      return signedTxXdr;
    },
    [address, passphrase],
  );

  return <WalletCtx.Provider value={{ address, ready, busy, error, connect, disconnect, sign }}>{children}</WalletCtx.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet outside WalletProvider");
  return ctx;
}
