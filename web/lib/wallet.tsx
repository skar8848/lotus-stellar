"use client";

// Wallet layer.
//
//  * Real wallets: thin React wrapper around @creit.tech/stellar-wallets-kit v2 (static API).
//    The kit is loaded lazily on the client: it registers web components and touches `window`.
//  * DEV-ONLY signer: a "Dev wallet (testnet secret key)" option so the signed flows can be tested
//    headlessly (Playwright) without a browser extension.
//
//    !!! WARNING !!!  NEXT_PUBLIC_* variables are INLINED into the client bundle. The dev signer is
//    compiled in only when NEXT_PUBLIC_DEV_SIGNER=1 at build/dev-server start, and the secret is
//    read from NEXT_PUBLIC_DEV_SECRET in web/.env.local (git-ignored). Use throwaway TESTNET keys,
//    never a key that holds real value, and never ship a build made with the signer enabled.
//    Format: either one secret ("S...") or a comma separated list "label=S...,label2=S...".

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

type Kit = typeof import("@creit.tech/stellar-wallets-kit/sdk").StellarWalletsKit;

export type WalletKind = "kit" | "dev";
export type DevAccount = { label: string; address: string };

export type WalletState = {
  /** Connected public key, or null. */
  address: string | null;
  /** How the current address is signed. */
  kind: WalletKind | null;
  /** Kit finished loading. */
  ready: boolean;
  busy: boolean;
  error: string | null;
  /** Open the wallet-kit modal (Freighter, xBull, Albedo, ...). */
  connect: () => Promise<void>;
  /** Dev signer accounts available (empty unless NEXT_PUBLIC_DEV_SIGNER=1). */
  devAccounts: DevAccount[];
  connectDev: (label: string) => void;
  disconnect: () => Promise<void>;
  /** Sign a transaction XDR; resolves with the signed XDR. */
  sign: (xdr: string) => Promise<string>;
};

const WalletCtx = createContext<WalletState | null>(null);

let kitInitialised = false;

// ---------------------------------------------------------------------------
// Dev signer (compiled out unless NEXT_PUBLIC_DEV_SIGNER=1)
// ---------------------------------------------------------------------------

const DEV_SIGNER_ON = process.env.NEXT_PUBLIC_DEV_SIGNER === "1";
const DEV_STORAGE_KEY = "lotus.devWallet";

type DevKey = DevAccount & { secret: string };

function parseDevKeys(): DevKey[] {
  if (!DEV_SIGNER_ON) return [];
  const raw = process.env.NEXT_PUBLIC_DEV_SECRET ?? "";
  const out: DevKey[] = [];
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((entry, i) => {
      const eq = entry.indexOf("=");
      const label = eq > 0 ? entry.slice(0, eq).trim() : `account${i + 1}`;
      const secret = (eq > 0 ? entry.slice(eq + 1) : entry).trim();
      try {
        out.push({ label, secret, address: Keypair.fromSecret(secret).publicKey() });
      } catch {
        /* ignore malformed entries */
      }
    });
  return out;
}

// The dev connection lives in sessionStorage (survives a reload of the tab); useSyncExternalStore reads it
// without an effect and without a hydration mismatch (the server snapshot is always "not connected").
const storeListeners = new Set<() => void>();
const subscribeStored = (cb: () => void) => {
  storeListeners.add(cb);
  return () => {
    storeListeners.delete(cb);
  };
};
const readStored = (): string | null => {
  try {
    return window.sessionStorage.getItem(DEV_STORAGE_KEY);
  } catch {
    return null;
  }
};
const readStoredServer = (): string | null => null;
const writeStored = (v: string | null) => {
  try {
    if (v) window.sessionStorage.setItem(DEV_STORAGE_KEY, v);
    else window.sessionStorage.removeItem(DEV_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  storeListeners.forEach((l) => l());
};

export function WalletProvider({ passphrase, children }: { passphrase: string; children: React.ReactNode }) {
  const kitRef = useRef<Kit | null>(null);
  const [kitAddress, setKitAddress] = useState<string | null>(null);
  const storedLabel = useSyncExternalStore(subscribeStored, readStored, readStoredServer);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devKeys = useMemo(() => parseDevKeys(), []);
  const devAccounts = useMemo<DevAccount[]>(() => devKeys.map(({ label, address }) => ({ label, address })), [devKeys]);
  const dev = DEV_SIGNER_ON && storedLabel ? devKeys.find((k) => k.label === storedLabel) ?? null : null;

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
          // no MetaMask module: its adapter tries to reach the extension at init and logs "Failed to connect"
          modules: defaultModules({ filterBy: (m) => m.productId !== "metamask" }),
          network: passphrase as (typeof types.Networks)[keyof typeof types.Networks],
          theme: {
            ...types.SwkAppDarkTheme,
            background: "#0d0d0d",
            "background-secondary": "#161616",
            "foreground-strong": "#ffffff",
            foreground: "#e8eef4",
            "foreground-secondary": "#8898a8",
            primary: "#f3b1ce",
            "primary-foreground": "#1a0a12",
            border: "rgba(255,255,255,0.12)",
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
        setKitAddress(e.payload.address ?? null);
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
      writeStored(null);
      setKitAddress(address);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // closing the modal is not an error worth showing
      if (!/closed|cancel/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  }, []);

  const connectDev = useCallback(
    (label: string) => {
      if (!DEV_SIGNER_ON) return;
      if (!devKeys.some((k) => k.label === label)) return;
      setError(null);
      writeStored(label);
    },
    [devKeys],
  );

  const disconnect = useCallback(async () => {
    writeStored(null);
    try {
      await kitRef.current?.disconnect();
    } finally {
      setKitAddress(null);
    }
  }, []);

  const address = dev ? dev.address : kitAddress;
  const kind: WalletKind | null = dev ? "dev" : kitAddress ? "kit" : null;

  const sign = useCallback(
    async (xdr: string) => {
      if (dev) {
        const tx = TransactionBuilder.fromXDR(xdr, passphrase);
        tx.sign(Keypair.fromSecret(dev.secret));
        return tx.toXDR();
      }
      const kit = kitRef.current;
      if (!kit || !kitAddress) throw new Error("wallet not connected");
      const { signedTxXdr } = await kit.signTransaction(xdr, { networkPassphrase: passphrase, address: kitAddress });
      return signedTxXdr;
    },
    [dev, kitAddress, passphrase],
  );

  const value = useMemo<WalletState>(
    () => ({ address, kind, ready, busy, error, connect, devAccounts, connectDev, disconnect, sign }),
    [address, kind, ready, busy, error, connect, devAccounts, connectDev, disconnect, sign],
  );

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet outside WalletProvider");
  return ctx;
}
