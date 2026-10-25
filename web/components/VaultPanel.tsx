"use client";

import { useCallback, useState } from "react";
import type { LotusConfig } from "@/lib/config";
import { useAccount } from "@/lib/account";
import { useTx, usePolling } from "@/lib/hooks";
import {
  addressArg,
  assetLabel,
  assetReady,
  changeTrustOp,
  explorerContract,
  findBalance,
  fmt,
  i128Arg,
  invokeContract,
  isContractId,
  isNative,
  readVaultStats,
  shortAddr,
  submitClassic,
  toStroops,
  type NetCfg,
} from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { AmountInput, Dot, Panel, Spinner, Stat, TxStatus } from "./ui";

function available(balance: string | undefined, selling: string | undefined, native: boolean): string | null {
  if (balance === undefined) return null;
  const b = Number(balance) - Number(selling ?? 0) - (native ? 2 : 0); // keep 2 XLM for reserve + fees
  return b > 0 ? b.toFixed(7).replace(/0+$/, "").replace(/\.$/, "") : "0";
}

export function VaultPanel({ config }: { config: LotusConfig }) {
  const net: NetCfg = { rpc: config.rpc, horizon: config.horizon, passphrase: config.passphrase };
  const wallet = useWallet();
  const acct = useAccount();
  const contractOk = isContractId(config.lotusVault);
  const receiptOk = assetReady(config.receipt);
  const uLabel = assetLabel(config.underlying);
  const rLabel = config.receipt.code;

  const statsFn = useCallback(
    () => readVaultStats(net, config.lotusVault, wallet.address ?? undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.rpc, config.horizon, config.passphrase, config.lotusVault, wallet.address],
  );
  const stats = usePolling(statsFn, 10000, contractOk);

  const uBal = findBalance(acct.data, config.underlying);
  const rBal = findBalance(acct.data, config.receipt);
  const uAvail = available(uBal?.balance, uBal?.selling_liabilities, isNative(config.underlying));
  const rAvail = available(rBal?.balance, rBal?.selling_liabilities, false);

  const [depAmt, setDepAmt] = useState("");
  const [redAmt, setRedAmt] = useState("");
  const depTx = useTx();
  const redTx = useTx();
  const tlTx = useTx();

  const s = stats.data;
  const accruedPct =
    s?.surplus !== null && s?.surplus !== undefined && s.supply && s.supply > 0n ? (Number(s.surplus) / Number(s.supply)) * 100 : null;

  const addTrustline = () =>
    tlTx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      const r = await submitClassic(net, { source: wallet.address, ops: [changeTrustOp(config.receipt)], sign: wallet.sign, onStage });
      acct.refresh();
      return { ...r, note: `${rLabel} trustline added` };
    });

  const deposit = () =>
    depTx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      const amount = toStroops(depAmt);
      if (amount <= 0n) throw new Error("Enter an amount");
      let note = "";
      if (!rBal) {
        const tl = await submitClassic(net, {
          source: wallet.address,
          ops: [changeTrustOp(config.receipt)],
          sign: wallet.sign,
          onStage: (st) => onStage(st, `${rLabel} trustline`),
        });
        note = `trustline ${shortAddr(tl.hash, 4)} · `;
      }
      const r = await invokeContract(net, {
        contractId: config.lotusVault,
        method: "deposit",
        args: [addressArg(wallet.address), i128Arg(amount)],
        source: wallet.address,
        sign: wallet.sign,
        onStage: (st) => onStage(st, "deposit"),
      });
      setDepAmt("");
      acct.refresh();
      stats.refresh();
      const minted = typeof r.result === "bigint" ? `minted ${fmt(r.result, 2)} ${rLabel}` : "deposit";
      return { ...r, note: note + minted };
    });

  const redeem = () =>
    redTx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      const amount = toStroops(redAmt);
      if (amount <= 0n) throw new Error("Enter an amount");
      const r = await invokeContract(net, {
        contractId: config.lotusVault,
        method: "redeem",
        args: [addressArg(wallet.address), i128Arg(amount)],
        source: wallet.address,
        sign: wallet.sign,
        onStage: (st) => onStage(st, "redeem"),
      });
      setRedAmt("");
      acct.refresh();
      stats.refresh();
      const out = typeof r.result === "bigint" ? `returned ${fmt(r.result, 2)} ${uLabel}` : "redeem";
      return { ...r, note: out };
    });

  const busy = depTx.running || redTx.running || tlTx.running;

  return (
    <Panel
      title="Vault"
      subtitle={
        <>
          {uLabel} in, {rLabel} out 1:1. Underlying is lent on Blend via DeFindex.
        </>
      }
      right={
        contractOk ? (
          <a
            href={explorerContract(config.lotusVault, config.network)}
            target="_blank"
            rel="noreferrer"
            className="num text-xs text-muted-fg hover:text-foreground"
          >
            {shortAddr(config.lotusVault, 4)}
          </a>
        ) : (
          <span className="text-xs text-muted">not deployed</span>
        )
      }
      className="h-full"
    >
      {/* Contract state */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Vault value" value={`${fmt(s?.vaultValue ?? null, 2)}`} sub={uLabel} />
        <Stat label="Supply" value={`${fmt(s?.supply ?? null, 2)}`} sub={rLabel} />
        <Stat
          label="Surplus"
          value={<span className={s?.surplus && s.surplus > 0n ? "text-green" : ""}>{fmt(s?.surplus ?? null, 4)}</span>}
          sub={accruedPct === null ? "undistributed yield" : `${fmt(accruedPct, 4)}% of supply`}
        />
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-fg">
        A keeper mints the surplus to {rLabel} holders pro-rata. Holdings grow in your account, including the part sitting in open offers.
        {stats.error && contractOk ? <span className="text-red"> · views unavailable: {stats.error}</span> : null}
      </p>

      <div className="hairline my-4" />

      {/* Wallet balances */}
      {!wallet.address ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-xs text-muted-fg">Connect a wallet to deposit, redeem and quote.</p>
          <button className="btn btn-primary" onClick={wallet.connect} disabled={!wallet.ready || wallet.busy}>
            {wallet.busy ? <Spinner /> : null}
            Connect wallet
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label={`${uLabel} balance`}
              value={fmt(uBal?.balance ?? null, 2)}
              sub={uBal?.selling_liabilities && Number(uBal.selling_liabilities) > 0 ? `${fmt(uBal.selling_liabilities, 2)} in offers` : "wallet"}
            />
            <Stat
              label={`${rLabel} balance`}
              value={rBal ? fmt(rBal.balance, 2) : "—"}
              sub={
                rBal ? (
                  Number(rBal.selling_liabilities ?? 0) > 0 ? (
                    <span className="text-green">{fmt(rBal.selling_liabilities, 2)} in offers, still earning</span>
                  ) : (
                    "wallet"
                  )
                ) : receiptOk ? (
                  <button className="text-foreground underline underline-offset-2" onClick={addTrustline} disabled={busy}>
                    add trustline
                  </button>
                ) : (
                  "no trustline"
                )
              }
            />
          </div>
          {acct.data === null && acct.updatedAt ? (
            <p className="mt-2 text-xs text-red">Account not found on {config.network}. Fund it with Friendbot first.</p>
          ) : null}
          <TxStatus state={tlTx.state} network={config.network} onDismiss={tlTx.reset} />

          <div className="hairline my-4" />

          {/* Deposit */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="label mb-1.5">Deposit {uLabel}</div>
              <AmountInput value={depAmt} onChange={setDepAmt} max={uAvail} suffix={uLabel} disabled={busy} />
              <button className="btn btn-primary mt-2 w-full" onClick={deposit} disabled={busy || !contractOk || !receiptOk || !depAmt}>
                {depTx.running ? <Spinner /> : null}
                {rBal ? "Deposit" : `Add trustline + deposit`}
              </button>
              <TxStatus state={depTx.state} network={config.network} onDismiss={depTx.reset} />
            </div>
            <div>
              <div className="label mb-1.5">Redeem {rLabel}</div>
              <AmountInput value={redAmt} onChange={setRedAmt} max={rAvail} suffix={rLabel} disabled={busy} />
              <button className="btn mt-2 w-full" onClick={redeem} disabled={busy || !contractOk || !rBal || !redAmt}>
                {redTx.running ? <Spinner /> : null}
                Redeem
              </button>
              <TxStatus state={redTx.state} network={config.network} onDismiss={redTx.reset} />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-fg">
            <Dot ok={acct.error ? false : acct.data ? true : null} pulse={acct.loading} />
            {acct.error ? `Horizon: ${acct.error}` : acct.updatedAt ? `balances refreshed ${new Date(acct.updatedAt).toLocaleTimeString()}` : "loading balances"}
          </div>
        </>
      )}
      {s?.config && Object.keys(s.config).length > 0 ? (
        <details className="mt-4 text-[11px] text-muted-fg">
          <summary className="cursor-pointer hover:text-foreground">get_config()</summary>
          <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-black p-2 text-[10px] leading-relaxed">
            {JSON.stringify(s.config, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}
          </pre>
        </details>
      ) : null}
    </Panel>
  );
}
