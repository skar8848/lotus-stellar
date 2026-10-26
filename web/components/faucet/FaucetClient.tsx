"use client";

// /faucet: everything a fresh testnet wallet needs to try Lotus in a minute.
//   1. Friendbot (only when the account does not exist yet)
//   2. Add trustlines: ONE classic tx with every missing changeTrust, signed by the wallet
//   3. Claim test tokens: POST /api/faucet, the server authorizes LBOND and sends LBOND, USDC and the receipt
// Codes and issuers come from the deployment config (useConfig), never from constants.

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Check, Copy, Droplets } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AssetLink, Empty, ExplorerLink, Panel, Spinner, TokenIcon, TxStatus } from "@/components/common";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { errMsg, useTx } from "@/lib/hooks";
import { faucetAssets, lineState, missingTrustlines, type ClaimResponse, type ClaimResult } from "@/lib/faucet";
import { changeTrustOp, fmt, shortAddr, submitClassic } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";

const FRIENDBOT = "https://friendbot.stellar.org";

export function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      title={`Copy ${text}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked (insecure origin): the value is still visible in the title */
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-mutedfg transition hover:border-primary/50 hover:text-foreground"
    >
      {done ? <Check className="size-3 text-green" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      {done ? "Copied" : label}
    </button>
  );
}

function StepBadge({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
        done ? "bg-green/15 text-green" : "bg-primary/15 text-primary",
      )}
    >
      {done ? <Check className="size-3" aria-hidden /> : n}
    </span>
  );
}

export function FaucetClient() {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const address = wallet.address;
  const assets = useMemo(() => faucetAssets(config), [config]);
  const testnet = config.network === "testnet";

  const notFunded = !!address && acct.data === null && acct.updatedAt !== null;
  const loaded = !!address && acct.data !== null;
  const missing = useMemo(() => (acct.data ? missingTrustlines(acct.data.balances, assets) : assets), [acct.data, assets]);

  const fundTx = useTx("Friendbot");
  const trustTx = useTx("Trustlines");
  const [claiming, setClaiming] = useState(false);
  const [claim, setClaim] = useState<{ results?: ClaimResult[]; error?: string } | null>(null);

  const friendbot = () =>
    fundTx.run(async (onStage) => {
      if (!address) throw new Error("connect a wallet first");
      onStage("sending", "Friendbot");
      const r = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
      const j = (await r.json().catch(() => ({}))) as { hash?: string; detail?: string; extras?: { result_codes?: { operations?: string[] } } };
      if (!r.ok) {
        const ops = j.extras?.result_codes?.operations ?? [];
        if (ops.includes("op_already_exists") || /already/i.test(j.detail ?? "")) throw new Error("this account already exists on testnet");
        throw new Error(`Friendbot: ${j.detail ?? `HTTP ${r.status}`}`);
      }
      acct.refresh();
      return { hash: j.hash ?? "", note: "10,000 test XLM" };
    });

  const addTrustlines = () =>
    trustTx.run(async (onStage) => {
      if (!address) throw new Error("connect a wallet first");
      if (missing.length === 0) throw new Error("every trustline is already there");
      const r = await submitClassic(net, { source: address, ops: missing.map((m) => changeTrustOp(m.asset)), sign: wallet.sign, onStage });
      acct.refresh();
      return { ...r, note: `${missing.map((m) => m.asset.code).join(", ")} trustline${missing.length > 1 ? "s" : ""} added` };
    });

  const claimTokens = useCallback(async () => {
    if (!address) return;
    setClaiming(true);
    setClaim(null);
    try {
      const r = await fetch("/api/faucet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
      const j = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as ClaimResponse;
      setClaim({ results: j.results, error: j.ok ? undefined : j.error ?? (j.results ? undefined : `HTTP ${r.status}`) });
    } catch (e) {
      setClaim({ error: errMsg(e) });
    } finally {
      setClaiming(false);
      acct.refresh();
    }
  }, [address, acct]);

  const anyTrust = loaded && missing.length < assets.length;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-16 pt-5 sm:px-6" data-testid="faucet">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Droplets className="size-5 text-primary" aria-hidden /> Testnet faucet
        </h1>
        <p className="mt-1 text-sm text-mutedfg">
          Three steps to try Lotus with a fresh wallet: fund the account, add the trustlines, claim test tokens. Testnet only, no
          real value.
        </p>
      </div>

      {!testnet ? (
        <Panel title="Faucet unavailable">
          <Empty>The faucet only runs on Stellar testnet (this deployment is on {config.network}).</Empty>
        </Panel>
      ) : (
        <div className="space-y-4">
          {/* Step 1: account */}
          <Panel
            title={
              <span className="flex items-center gap-2">
                <StepBadge n={1} done={loaded} /> Testnet account
              </span>
            }
            subtitle="A new Stellar account must hold XLM before it exists. Friendbot sends 10,000 test XLM."
          >
            {!address ? (
              <p className="text-sm text-mutedfg" data-testid="faucet-connect-prompt">
                Connect a wallet (top right). Freighter, xBull, Albedo, Lobstr and Hana work; switch the wallet to Testnet.
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <ExplorerLink kind="account" id={address} network={config.network} n={6} />
                  <CopyButton text={address} label="Copy" />
                  {loaded ? (
                    <Badge variant="outline" className="border-green/40 text-green" data-testid="faucet-account-ok">
                      {fmt(acct.data?.balances.find((b) => b.asset_type === "native")?.balance, 2)} XLM
                    </Badge>
                  ) : notFunded ? (
                    <Badge variant="outline" className="border-destructive/40 text-destructive" data-testid="faucet-unfunded">
                      not on testnet yet
                    </Badge>
                  ) : (
                    <Spinner />
                  )}
                </span>
                {notFunded ? (
                  <Button size="sm" onClick={friendbot} disabled={fundTx.running} data-testid="faucet-friendbot">
                    {fundTx.running ? <Spinner /> : null} Fund with Friendbot
                  </Button>
                ) : null}
              </div>
            )}
            <TxStatus state={fundTx.state} network={config.network} onDismiss={fundTx.reset} />
            {acct.error ? <p className="mt-2 text-xs text-destructive">Horizon: {acct.error}</p> : null}
          </Panel>

          {/* Step 2: trustlines */}
          <Panel
            title={
              <span className="flex items-center gap-2">
                <StepBadge n={2} done={loaded && missing.length === 0} /> Trustlines
              </span>
            }
            subtitle="A Stellar account only holds an asset after it opts in with a trustline (0.5 XLM reserve each). One transaction adds every missing one."
            right={
              <Button
                size="sm"
                onClick={addTrustlines}
                disabled={!loaded || missing.length === 0 || trustTx.running}
                data-testid="faucet-add-trustlines"
                data-missing={loaded ? missing.length : undefined}
              >
                {trustTx.running ? <Spinner /> : null}
                {loaded && missing.length === 0 ? "All trustlines added" : `Add trustlines${loaded ? ` (${missing.length})` : ""}`}
              </Button>
            }
          >
            <div className="divide-y divide-border" data-testid="faucet-assets">
              {assets.map((f) => {
                const st = acct.data ? lineState(acct.data.balances, f.asset) : null;
                const pair = `${f.asset.code}:${f.asset.issuer}`;
                return (
                  <div key={f.role} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`faucet-asset-${f.role}`} data-code={f.asset.code} data-trust={st ? (st.has ? (st.authorized ? "authorized" : "unauthorized") : "missing") : "unknown"}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <TokenIcon code={f.asset.code} size={22} />
                        <AssetLink asset={f.asset} network={config.network} className="font-medium" />
                        <span className="text-xs text-mutedfg">{f.label}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-mutedfg">
                        <span>Issuer</span>
                        <ExplorerLink kind="account" id={f.asset.issuer} network={config.network} n={6} className="text-xs" />
                        <CopyButton text={f.asset.issuer} label="Issuer" testId={`faucet-copy-issuer-${f.role}`} />
                        <CopyButton text={pair} label="CODE:ISSUER" testId={`faucet-copy-pair-${f.role}`} />
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-xs sm:flex-col sm:items-end sm:gap-1">
                      {!st ? (
                        <span className="text-mutedfg">{address ? "-" : "connect a wallet"}</span>
                      ) : !st.has ? (
                        <Badge variant="outline" className="border-destructive/40 text-destructive">no trustline</Badge>
                      ) : f.role === "rwa" && !st.authorized ? (
                        <Badge variant="outline" className="border-primary/40 text-primary" title="LBOND is AUTH_REQUIRED: the claim asks the issuer to authorize it">
                          trustline, not authorized yet
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-green/40 text-green">trustline ok</Badge>
                      )}
                      <span className="num text-mutedfg">
                        {st?.has ? `${fmt(st.balance, 4)} ${f.asset.code}` : ""} <span className="text-mutedfg/70">· faucet {f.amount}</span>
                      </span>
                    </div>
                  </div>
                );
              })}
              {assets.length === 0 ? <Empty>No asset in the deployment config.</Empty> : null}
            </div>
            <TxStatus state={trustTx.state} network={config.network} onDismiss={trustTx.reset} />
          </Panel>

          {/* Step 3: claim */}
          <Panel
            title={
              <span className="flex items-center gap-2">
                <StepBadge n={3} done={!!claim?.results?.some((r) => r.status === "sent")} /> Claim test tokens
              </span>
            }
            subtitle={`${assets.map((f) => `${f.amount} ${f.asset.code}`).join(" + ")}, once per address. The ${config.rwa.code} issuer also authorizes your ${config.rwa.code} trustline.`}
            right={
              <Button size="sm" onClick={claimTokens} disabled={!anyTrust || claiming} data-testid="faucet-claim">
                {claiming ? <Spinner /> : null} Claim test tokens
              </Button>
            }
          >
            {!anyTrust ? <p className="text-xs text-mutedfg">Add at least one trustline first.</p> : null}
            {claiming ? (
              <div className="mt-1 flex items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-xs text-mutedfg">
                <Spinner /> Sending from the faucet accounts (a few seconds)...
              </div>
            ) : null}
            {claim?.error ? (
              <div data-testid="faucet-claim-error" className="mt-1 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                {claim.error}
              </div>
            ) : null}
            {claim?.results ? (
              <ul className="mt-2 space-y-1.5 text-xs" data-testid="faucet-claim-results">
                {claim.results.map((r) => (
                  <li key={r.role} className="flex flex-wrap items-center gap-2" data-testid={`faucet-result-${r.role}`} data-status={r.status} data-hash={r.hash}>
                    <TokenIcon code={r.code} size={16} />
                    <span className="num font-medium">
                      {r.amount} {r.code}
                    </span>
                    {r.status === "sent" ? (
                      <>
                        <span className="text-green">sent</span>
                        {r.hash ? <ExplorerLink kind="tx" id={r.hash} network={config.network} n={6} /> : null}
                        {r.message ? <span className="text-mutedfg">· {r.message}</span> : null}
                      </>
                    ) : r.status === "skipped" ? (
                      <span className="text-mutedfg">skipped · {r.message}</span>
                    ) : (
                      <span className="text-destructive">failed · {r.message}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {claim?.results?.some((r) => r.status === "sent") ? (
              <p className="mt-3 text-xs text-mutedfg">
                Done. Try a swap on <Link href="/trade" className="text-primary hover:underline">Trade</Link>, a range order on{" "}
                <Link href="/pools" className="text-primary hover:underline">Pools</Link>, or see everything on{" "}
                <Link href="/portfolio" className="text-primary hover:underline">Portfolio</Link>.
              </p>
            ) : null}
            {address ? <p className="mt-3 text-[11px] text-mutedfg/70">Claiming for {shortAddr(address, 6)}.</p> : null}
          </Panel>
        </div>
      )}
    </main>
  );
}
