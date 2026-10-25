"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { AssetField, Panel, Spinner, Stat, TxStatus } from "@/components/common";
import { StatusBadge } from "@/components/vault/StrategyCard";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAccount } from "@/lib/account";
import { toStroops, tryStroops } from "@/lib/amount";
import type { Strategy } from "@/lib/config-types";
import { useConfig, useNet } from "@/lib/config-context";
import { useTx } from "@/lib/hooks";
import { buildMarkets, marketForReceipt } from "@/lib/markets";
import {
  addressArg,
  changeTrustOp,
  findBalance,
  fromStroops,
  i128Arg,
  invokeContract,
  isNative,
  shortAddr,
  submitClassic,
  type VaultStats,
} from "@/lib/stellar";
import { fmtAmt, hasContract, inOffers, redeemEstimate, spendable } from "@/lib/vault";
import { useWallet } from "@/lib/wallet";

function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" }) {
  return (
    <div
      className={
        tone === "warn"
          ? "rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-xs leading-relaxed text-destructive"
          : "rounded-xl border border-line bg-secondary/60 px-3.5 py-2.5 text-xs leading-relaxed text-mutedfg"
      }
    >
      {children}
    </div>
  );
}

/** Deposit / Redeem for one Lotus vault. Remount with key={strategy.id} so inputs reset on a strategy change. */
export function VaultActions({ strategy, stats, onDone }: { strategy: Strategy; stats: VaultStats | null; onDone: () => void }) {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const markets = useMemo(() => buildMarkets(config), [config]);

  const u = strategy.underlying;
  const r = strategy.receipt;
  const contractOk = hasContract(strategy);
  const connected = !!wallet.address;

  const uBal = findBalance(acct.data, u);
  const rBal = findBalance(acct.data, r);
  const uSpend = spendable(uBal, isNative(u) ? 2 : 0); // native: keep 2 XLM for reserve and fees
  const rSpend = spendable(rBal);
  const uLocked = inOffers(uBal);
  const rLocked = inOffers(rBal);

  const [tab, setTab] = useState<"deposit" | "redeem">("deposit");
  const [depAmt, setDepAmt] = useState("");
  const [redAmt, setRedAmt] = useState("");
  const depTx = useTx("Deposit");
  const redTx = useTx("Redeem");
  const tlTx = useTx("Add trustline");
  const busy = depTx.running || redTx.running || tlTx.running;

  const dep = tryStroops(depAmt);
  const red = tryStroops(redAmt);
  const depOver = dep !== null && uSpend !== null && dep > toStroops(uSpend);
  const redOver = red !== null && rSpend !== null && red > toStroops(rSpend);
  const est = red !== null ? redeemEstimate(red, stats?.vaultValue ?? null, stats?.supply ?? null) : null;

  const supply = stats?.supply ?? null;
  const heldPct =
    rBal && supply !== null && supply > 0n ? Number((toStroops(rBal.balance) * 1_000_000n) / supply) / 10_000 : null;

  const market = marketForReceipt(markets, r);
  const tradeHref = market ? `/trade?market=${market.id}` : "/trade";

  const addTrustline = () =>
    tlTx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      const res = await submitClassic(net, { source: wallet.address, ops: [changeTrustOp(r)], sign: wallet.sign, onStage });
      acct.refresh();
      return { ...res, note: `${r.code} trustline added` };
    });

  const deposit = () =>
    depTx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      const amount = toStroops(depAmt);
      if (amount <= 0n) throw new Error("Enter an amount");
      let pre = "";
      if (!rBal) {
        const tl = await submitClassic(net, {
          source: wallet.address,
          ops: [changeTrustOp(r)],
          sign: wallet.sign,
          onStage: (st) => onStage(st, `${r.code} trustline`),
        });
        pre = `trustline ${shortAddr(tl.hash, 4)}; `;
      }
      const res = await invokeContract(net, {
        contractId: strategy.lotusVault,
        method: "deposit",
        args: [addressArg(wallet.address), i128Arg(amount)],
        source: wallet.address,
        sign: wallet.sign,
        onStage: (st) => onStage(st, "deposit"),
      });
      setDepAmt("");
      acct.refresh();
      onDone();
      // deposit() returns the DeFindex shares; the receipt is minted 1:1 against the amount
      return { hash: res.hash, result: res.result, note: `${pre}minted ${fromStroops(amount)} ${r.code} for ${fromStroops(amount)} ${u.code}` };
    });

  const redeem = () =>
    redTx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      const amount = toStroops(redAmt);
      if (amount <= 0n) throw new Error("Enter an amount");
      const res = await invokeContract(net, {
        contractId: strategy.lotusVault,
        method: "redeem",
        args: [addressArg(wallet.address), i128Arg(amount)],
        source: wallet.address,
        sign: wallet.sign,
        onStage: (st) => onStage(st, "redeem"),
      });
      setRedAmt("");
      acct.refresh();
      onDone();
      const paid = typeof res.result === "bigint" ? `${fromStroops(res.result)} ${u.code}` : u.code;
      return { hash: res.hash, result: res.result, note: `burnt ${fromStroops(amount)} ${r.code}, returned ${paid}` };
    });

  const depDisabled = busy || (connected && (!contractOk || dep === null || dep <= 0n || depOver || !acct.data));
  const redDisabled = busy || (connected && (!contractOk || red === null || red <= 0n || redOver || !rBal));

  return (
    <Panel
      id="vault-actions"
      title={strategy.label}
      subtitle={`${u.code} in, ${r.code} out 1:1. Redeem any time.`}
      right={<StatusBadge status={strategy.status} className="hidden sm:inline-flex" />}
    >
      {!contractOk ? (
        <Note>This vault has no contract on testnet yet, so there is nothing to deposit into.</Note>
      ) : (
        <>
          {strategy.status === "idle" ? (
            <div className="mb-3">
              <Note>
                Idle on testnet: the DeFindex vault behind this Lotus vault holds {u.code} without allocating it, so depositing earns no Blend interest. Your {r.code} is
                still redeemable 1:1.
              </Note>
            </div>
          ) : null}

          <div className="mb-4 grid grid-cols-3 gap-3" data-testid="vault-balances">
            <Stat
              label={`${u.code} available`}
              value={connected ? (uSpend === null ? "—" : fmtAmt(toStroops(uSpend))) : "—"}
              sub={uLocked > 0n ? `${fmtAmt(uLocked)} in offers` : connected ? "wallet" : "not connected"}
            />
            <Stat
              label={`${r.code} available`}
              value={connected ? (rSpend === null ? "—" : fmtAmt(toStroops(rSpend))) : "—"}
              sub={
                rLocked > 0n ? <span className="text-green">{fmtAmt(rLocked)} in offers, still earning</span> : connected ? (rBal ? "wallet" : "no trustline") : "not connected"
              }
            />
            <Stat
              label="Share of supply"
              value={heldPct === null ? "—" : heldPct > 0 && heldPct < 0.01 ? "<0.01%" : `${heldPct.toFixed(2)}%`}
              sub={`of ${r.code}`}
            />
          </div>
          {connected && acct.data === null && acct.updatedAt ? (
            <div className="mb-3">
              <Note tone="warn">Account not found on {config.network}. Fund it with Friendbot first.</Note>
            </div>
          ) : null}

          <Tabs value={tab} onValueChange={(v) => setTab(v as "deposit" | "redeem")}>
            <TabsList className="w-full">
              <TabsTrigger value="deposit" data-testid="vault-tab-deposit">
                Deposit
              </TabsTrigger>
              <TabsTrigger value="redeem" data-testid="vault-tab-redeem">
                Redeem
              </TabsTrigger>
            </TabsList>

            <TabsContent value="deposit" className="mt-3 space-y-1.5">
              <AssetField
                label="Deposit"
                testId="vault-deposit-amount"
                value={depAmt}
                onChange={setDepAmt}
                asset={u}
                balance={connected ? uSpend : null}
              />
              <AssetField label="You receive" readOnly value={depAmt} asset={r} hint="minted 1:1 by the vault" />

              {connected && acct.data && !uBal ? (
                <Note tone="warn">
                  This account holds no {u.code}. Get testnet {u.code} first (Blend faucet), then come back.
                </Note>
              ) : null}
              {depOver ? <Note tone="warn">Amount exceeds your available {u.code} ({uSpend}).</Note> : null}
              {connected && acct.data && !rBal ? (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-secondary/60 px-3.5 py-2.5 text-xs text-mutedfg">
                  <span>
                    No {r.code} trustline yet. Depositing adds it first (two signatures), or add it now.
                  </span>
                  <Button type="button" size="xs" variant="outline" data-testid="vault-trustline" onClick={addTrustline} disabled={busy}>
                    {tlTx.running ? <Spinner /> : null}
                    Add trustline
                  </Button>
                </div>
              ) : null}
              <TxStatus state={tlTx.state} network={config.network} onDismiss={tlTx.reset} />

              <Button
                className="mt-2 h-12 w-full text-base"
                data-testid="vault-deposit-submit"
                onClick={connected ? deposit : wallet.connect}
                disabled={connected ? depDisabled : !wallet.ready || wallet.busy}
              >
                {depTx.running ? <Spinner /> : null}
                {!connected ? "Connect a wallet" : !rBal ? "Add trustline and deposit" : "Deposit"}
              </Button>
              <TxStatus state={depTx.state} network={config.network} onDismiss={depTx.reset} />
            </TabsContent>

            <TabsContent value="redeem" className="mt-3 space-y-1.5">
              <AssetField
                label="Redeem"
                testId="vault-redeem-amount"
                value={redAmt}
                onChange={setRedAmt}
                asset={r}
                balance={connected ? rSpend : null}
                hint={rLocked > 0n ? `${fmtAmt(rLocked)} committed to offers` : undefined}
              />
              <AssetField
                label="You receive (estimate)"
                readOnly
                value={est === null ? "" : fromStroops(est)}
                placeholder="—"
                asset={u}
                hint="1:1 while fully backed, pro-rata otherwise"
              />
              {rLocked > 0n ? (
                <Note>
                  {fmtAmt(rLocked)} {r.code} sits in open SDEX offers: it keeps earning there, but cannot be redeemed until the offers are cancelled.
                </Note>
              ) : null}
              {redOver ? <Note tone="warn">Amount exceeds your redeemable {r.code} ({rSpend}).</Note> : null}

              <Button
                className="mt-2 h-12 w-full text-base"
                data-testid="vault-redeem-submit"
                onClick={connected ? redeem : wallet.connect}
                disabled={connected ? redDisabled : !wallet.ready || wallet.busy}
              >
                {redTx.running ? <Spinner /> : null}
                {connected ? "Redeem" : "Connect a wallet"}
              </Button>
              <TxStatus state={redTx.state} network={config.network} onDismiss={redTx.reset} />
            </TabsContent>
          </Tabs>

          <Button asChild variant="outline" className="mt-4 w-full" data-testid="vault-trade-link">
            <Link href={tradeHref}>
              Trade {r.code} on the SDEX <ArrowUpRight />
            </Link>
          </Button>
          <p className="mt-2 text-[11px] leading-relaxed text-mutedfg">
            Quote {r.code} on the Stellar order book and the offers keep earning: they only set a selling liability.
          </p>
        </>
      )}
    </Panel>
  );
}
