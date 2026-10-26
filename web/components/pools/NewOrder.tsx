"use client";

// "New order": one directional range limit order (Ask sells LBOND, Bid waits with USDC to buy it), built with the
// pool grid, then two choices made at creation only: where it waits (Lotus pool | SDEX) and whether it earns yield.
// Routing rules and the ladder conversion live in lib/orderRoute.ts, execution in lib/orderTx.ts.

import Link from "next/link";
import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExplorerLink, Segmented, Spinner, TxStatus } from "@/components/common";
import { TrustlineNotice, useAssetAccess } from "@/components/trade/access";
import { useAccount } from "@/lib/account";
import { fromStroops } from "@/lib/amount";
import { useConfig, useNet } from "@/lib/config-context";
import type { PoolInstance } from "@/lib/config-types";
import { errMsg, useTx } from "@/lib/hooks";
import { buildMarkets } from "@/lib/markets";
import type { PoolClient } from "@/lib/pool";
import type { PositionPlan } from "@/lib/poolGrid";
import {
  MAX_SDEX_LEVELS,
  PROXIMITY_MIN_BINS,
  ladderFromPlan,
  orderSummary,
  signaturesNeeded,
  yieldGuard,
  type Venue,
} from "@/lib/orderRoute";
import { PairError, placeOrder, repostOffers, sdexQuote } from "@/lib/orderTx";
import { assetReady, fmt, isContractId, type AssetRef, type OrderBook } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { RangeInputs, Row, type PoolForm } from "./RangeInputs";

const RESERVE_PER_ENTRY_XLM = 0.5;
const sameAsset = (a: AssetRef, b: AssetRef) => a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);

/**
 * Pool instances of this flow: the FIRST instance without a vault (USDC idle, yield off) and the first one with a
 * vault (yield on), in testnet.pool.json order. Any other instance (the separate two-way LP pool) is not part of
 * New order and keeps its own builder. Two-way support on an instance does not matter here: New order always
 * sends Mode::Directional.
 */
export function directionalPools(pools: PoolInstance[]) {
  const usable = pools.filter((p) => p.status !== "coming-soon" && p.status !== "retired");
  const idle = usable.find((p) => !p.vault) ?? null;
  const vaulted = usable.find((p) => !!p.vault) ?? null;
  const list = [idle, vaulted].filter((p): p is PoolInstance => p !== null);
  return { list, idle, vaulted, others: usable.filter((p) => !list.includes(p)) };
}

type Pending = { side: PositionPlan["side"]; offers: ReturnType<typeof ladderFromPlan>["offers"]; firstHash: string | null; amount: bigint };

export function NewOrder({
  inst,
  client,
  pools,
  onSelectPool,
  form,
  setForm,
  plan,
  refPrice,
  refSource,
  books,
  onDone,
}: {
  /** the pool instance shown on the page (the Pool destination when venue = pool) */
  inst: PoolInstance;
  client: PoolClient;
  pools: PoolInstance[];
  onSelectPool: (id: string) => void;
  form: PoolForm;
  setForm: (f: PoolForm) => void;
  plan: PositionPlan;
  refPrice: number;
  refSource: string;
  /** SDEX books of BASE against USDC and against the receipt (crossing warning) */
  books: { usdc: OrderBook | null; receipt: OrderBook | null };
  onDone: () => void;
}) {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("New order");
  const retryTx = useTx("Post offers");
  const [venue, setVenue] = useState<Venue>("pool");
  const [sdexYield, setSdexYield] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const { idle, vaulted } = directionalPools(pools);
  const base = inst.base;
  const quote = inst.quote;
  const receipt: AssetRef = config.receipt;
  const vaultOk = isContractId(config.lotusVault) && assetReady(receipt) && sameAsset(config.underlying, quote);
  const yieldOn = venue === "pool" ? !!inst.vault : sdexYield && vaultOk;
  const side = form.side;

  const baseAccess = useAssetAccess(base);
  const quoteAccess = useAssetAccess(quote);
  const receiptAccess = useAssetAccess(receipt);
  const xlmAccess = useAssetAccess({ code: "XLM", issuer: null });

  const guard = yieldGuard({ side, venue, hiBin: plan.hiBin, stepBps: inst.binStepBps, refPrice });
  const guardActive = plan.ok && guard.blocked;
  const ladder = useMemo(() => ladderFromPlan(plan), [plan]);
  const sq = sdexQuote({ yieldOn, quote, receipt });

  // strategy name for the copy ("Blend yield" only when the strategy is live)
  const strat =
    venue === "pool"
      ? config.strategies.find((s) => s.id === vaulted?.strategyId)
      : config.strategies.find((s) => s.lotusVault === config.lotusVault);
  const yieldName = strat?.status === "live" ? "Blend yield" : "vault yield";

  // trustlines the classic tx adds in front of the offers (SDEX Ask: where the proceeds land). A Bid with yield needs
  // the receipt trustline BEFORE the deposit (the vault mints to it), so that one is its own first transaction.
  const addTrust: AssetRef[] = [];
  if (venue === "sdex") {
    if (side === "Ask" && !yieldOn && quoteAccess.state === "no-trustline") addTrust.push(quote);
    if (side === "Ask" && yieldOn && receiptAccess.state === "no-trustline") addTrust.push(receipt);
  }
  const needsReceiptTrustline = venue === "sdex" && yieldOn && side === "Bid" && receiptAccess.state === "no-trustline";
  const signatures = signaturesNeeded({ side, venue, yieldOn, needsReceiptTrustline });

  const sold = side === "Ask" ? base : quote;
  const soldAccess = side === "Ask" ? baseAccess : quoteAccess;
  const need = plan.ok ? Number(fromStroops(plan.deposit)) : 0;
  const reserveXlm = venue === "sdex" ? (ladder.offers.length + addTrust.length + (needsReceiptTrustline ? 1 : 0)) * RESERVE_PER_ENTRY_XLM : 0;

  // SDEX levels that would cross the current book and fill at once
  const book = yieldOn ? books.receipt : books.usdc;
  const bestBid = book?.bids[0] ? Number(book.bids[0].price) : null;
  const bestAsk = book?.asks[0] ? Number(book.asks[0].price) : null;
  const crossing =
    venue === "sdex"
      ? ladder.offers.filter((o) => {
          const p = Number(o.priceStroops) / 1e7;
          return side === "Ask" ? bestBid !== null && p <= bestBid : bestAsk !== null && p >= bestAsk;
        }).length
      : 0;

  const lbondBlocked = baseAccess.state === "no-trustline" || baseAccess.state === "unauthorized";
  const blockedBy = !wallet.address
    ? "Connect a wallet"
    : lbondBlocked
      ? baseAccess.state === "unauthorized"
        ? `${base.code}: not authorized by the issuer`
        : `${base.code} trustline needed`
      : (venue === "pool" || side === "Bid") && (quoteAccess.state === "no-trustline" || quoteAccess.state === "unauthorized")
        ? `${quote.code} trustline needed`
        : !(Number(form.amount) > 0)
          ? "Enter an amount"
          : !plan.ok
            ? (plan.errors[0] ?? "Enter a range and an amount")
            : venue === "sdex" && ladder.errors.length > 0
              ? `Max ${MAX_SDEX_LEVELS} levels on the SDEX`
              : venue === "pool" && yieldOn && guardActive
                ? "Too close to the price for yield"
                : venue === "sdex" && yieldOn && !vaultOk
                  ? "No Lotus vault configured"
                  : soldAccess.available !== null && need > soldAccess.available + 1e-9
                    ? `Insufficient ${sold.code}`
                    : xlmAccess.available !== null && reserveXlm > xlmAccess.available + 1e-9
                      ? "Not enough XLM for the reserve"
                      : null;

  const summary = plan.ok
    ? orderSummary({
        side,
        venue,
        yieldOn,
        amount: plan.deposit,
        loPrice: plan.bins[0]?.price ?? 0n,
        hiPrice: plan.bins[plan.bins.length - 1]?.price ?? 0n,
        baseCode: base.code,
        quoteCode: quote.code,
        receiptCode: receipt.code,
        yieldName,
        signatures,
      })
    : null;

  const setVenueTo = (v: Venue) => {
    if (v === venue) return;
    if (v === "pool") {
      // keep the yield choice when moving to the pool, if a matching instance exists
      const target = sdexYield ? (vaulted ?? idle) : (idle ?? vaulted);
      if (target && target.id !== inst.id) onSelectPool(target.id);
    } else setSdexYield(!!inst.vault);
    setVenue(v);
  };
  const setYield = (on: boolean) => {
    if (venue === "pool") {
      const target = on ? vaulted : idle;
      if (target && target.id !== inst.id) onSelectPool(target.id);
    } else setSdexYield(on);
  };

  const yieldOnDisabledWhy =
    venue === "pool"
      ? !vaulted
        ? "No vault-backed pool instance is deployed."
        : side === "Bid" && guardActive
          ? guard.reason
          : null
      : !vaultOk
        ? "No Lotus vault (receipt) is configured in testnet.contract.json."
        : null;

  const submit = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      setPending(null);
      const ctx = { source: wallet.address, sign: wallet.sign, onStage };
      try {
        const r = await placeOrder(net, ctx, {
          side,
          venue,
          yieldOn,
          plan,
          offers: ladder.offers,
          base,
          quote,
          receipt,
          lotusVault: config.lotusVault,
          pool: venue === "pool" ? client : null,
          addTrust: needsReceiptTrustline ? [receipt, ...addTrust] : addTrust,
        });
        setForm({ ...form, amount: "" });
        return { hash: r.hashes[r.hashes.length - 1] ?? "", hashes: r.hashes, result: r.result, note: r.note };
      } catch (e) {
        if (e instanceof PairError && e.phase === "second") {
          setPending({ side, offers: ladder.offers, firstHash: e.firstHash, amount: plan.deposit });
          throw new Error(
            `The deposit went through but the offers did not (${e.message}). You hold ${fromStroops(plan.deposit)} ${receipt.code}, redeemable at par on the Vault tab; you can post the offers again below.`,
          );
        }
        throw e instanceof Error ? e : new Error(errMsg(e));
      } finally {
        acct.refresh();
        onDone();
      }
    });

  const repost = () =>
    retryTx.run(async (onStage) => {
      if (!wallet.address || !pending) throw new Error("Nothing to post");
      const r = await repostOffers(net, { source: wallet.address, sign: wallet.sign, onStage }, { side: pending.side, offers: pending.offers, base, receipt });
      setPending(null);
      tx.reset();
      acct.refresh();
      onDone();
      return { hash: r.hashes[0], hashes: r.hashes, note: r.note };
    });

  const markets = buildMarkets(config);
  const sdexMarket = markets.find((m) => sameAsset(m.base, base) && sameAsset(m.quote, sq));
  const lo = plan.bins[0];
  const hi = plan.bins[plan.bins.length - 1];

  return (
    <div className="space-y-2" data-testid="new-order" data-venue={venue} data-yield={yieldOn ? "on" : "off"} data-pool={inst.id}>
      <RangeInputs
        base={base}
        quote={quote}
        form={form}
        setForm={setForm}
        plan={plan}
        refPrice={refPrice}
        balance={soldAccess.available !== null ? fmt(soldAccess.available, 2) : wallet.address ? "-" : undefined}
        sideHelp={
          side === "Ask"
            ? `A range limit order: your ${base.code} is sold level by level as the price rises through the range. It never buys back.`
            : `A range limit order: your ${quote.code} buys ${base.code} level by level as the price falls through the range. It never sells back.`
        }
      />

      {/* where it waits + yield */}
      <div className="rounded-2xl bg-secondary px-4 py-3.5" data-testid="order-destination">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
          <span className="text-sm text-mutedfg">Where it waits</span>
          <Segmented
            value={venue}
            onChange={setVenueTo}
            size="sm"
            testId="order-venue"
            options={[
              { value: "pool", label: "Lotus pool", title: "One add_position on the Lotus pool (Soroban)" },
              { value: "sdex", label: "SDEX", title: "One offer per bin on the Stellar DEX, one classic transaction" },
            ]}
          />
          <span className="flex items-center gap-1 text-sm text-mutedfg">
            Earn yield
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="About yield" className="text-mutedfg hover:text-foreground">
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[18rem] text-[11px] leading-relaxed">
                Pool: the {quote.code} side sits in DeFindex (Blend) inside the pool. For an Ask the yield is on the proceeds that wait in the vault; for a Bid
                on the {quote.code} waiting to buy, which every fill recalls from the vault, so a bid within {PROXIMITY_MIN_BINS} bins of the price cannot turn
                it on. SDEX: the order is quoted in {receipt.code}, the Lotus receipt; a receipt resting in an offer never leaves your account and keeps
                earning. Ask and SDEX are never blocked.
              </TooltipContent>
            </Tooltip>
          </span>
          <Segmented
            value={yieldOn ? "on" : "off"}
            onChange={(v) => setYield(v === "on")}
            size="sm"
            testId="order-yield"
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On", disabled: !!yieldOnDisabledWhy && !yieldOn, title: yieldOnDisabledWhy ?? undefined },
            ]}
          />
        </div>
        {venue === "pool" && side === "Bid" && guardActive ? (
          <p className="mt-2 text-[11px] leading-relaxed text-primary" data-testid="order-proximity">
            {guard.reason} The top of your range is {fmt(Math.max(0, guard.distance ?? 0), 1)} bins under the reference price ({fmt(refPrice, 4, 4)}, {refSource}); yield needs at
            least {PROXIMITY_MIN_BINS}.{yieldOn ? " Switch yield off or move the range down." : ""}
          </p>
        ) : null}
        <p className="mt-2 text-[11px] leading-relaxed text-mutedfg" data-testid="order-destination-detail">
          {venue === "pool" ? (
            <>
              Rests in <span className="text-foreground">{inst.label}</span>
              {isContractId(inst.contract) ? (
                <>
                  {" "}
                  (<ExplorerLink kind="contract" id={inst.contract} network={config.network} />)
                </>
              ) : null}
              . One add_position, one signature.
            </>
          ) : (
            <>
              {ladder.offers.length} offers on{" "}
              {sdexMarket ? (
                <Link href={`/trade?market=${sdexMarket.id}`} className="text-foreground underline decoration-white/20 underline-offset-2 hover:text-primary">
                  {sdexMarket.label}
                </Link>
              ) : (
                `${base.code}/${sq.code}`
              )}
              , one per bin at the grid price.
              {yieldOn && side === "Bid"
                ? ` Two transactions (a Soroban call cannot share a transaction with offers): deposit ${quote.code} into the Lotus vault for ${receipt.code}, then the offers. The offers are only sent if the deposit succeeds.`
                : " One classic transaction."}
            </>
          )}
        </p>
      </div>

      <div className="rounded-xl border border-border px-3 py-2.5 text-xs" data-testid="order-details">
        <Row k="Average price" v={plan.ok && plan.avgPrice !== null ? `${fmt(Number(plan.avgPrice) / 1e7, 4, 4)} ${venue === "sdex" ? sq.code : quote.code}` : "-"} />
        <Row k={venue === "sdex" ? "Offers" : "Bins"} v={plan.ok ? `${plan.bins.length} (${plan.loBin} to ${plan.hiBin})` : "-"} testId="order-bins" />
        <Row k="Price range" v={plan.ok && lo && hi ? `${fmt(Number(lo.price) / 1e7, 4, 4)} to ${fmt(Number(hi.price) / 1e7, 4, 4)}` : "-"} />
        <Row
          k="If fully filled you receive"
          v={plan.ok ? `${fmt(fromStroops(plan.proceedsIfFilled), 2)} ${side === "Ask" ? (venue === "sdex" ? sq.code : quote.code) : base.code}${venue === "pool" ? " (before the pool fee)" : ""}` : "-"}
        />
        {venue === "pool" ? <Row k="Pool fee" v={`${fmt(inst.feeBps / 100, 2)}% of the ${quote.code} leg of each fill`} /> : null}
        {venue === "sdex" ? <Row k="XLM base reserve" v={`${fmt(reserveXlm, 1)} XLM (0.5 per offer or trustline)`} /> : null}
        {addTrust.length > 0 || needsReceiptTrustline ? (
          <Row k="Adds trustline" v={[...(needsReceiptTrustline ? [receipt] : []), ...addTrust].map((a) => a.code).join(", ")} />
        ) : null}
        <Row k="Signatures" v={String(signatures)} testId="order-signatures" />
        <Row k="Reference price" v={`${fmt(refPrice, 4, 4)} (${refSource})`} />
      </div>

      {summary ? (
        <p className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5 text-xs leading-relaxed text-foreground" data-testid="order-summary-line">
          {summary}
        </p>
      ) : null}
      {signatures > 1 && plan.ok ? (
        <p className="px-1 text-[11px] leading-relaxed text-primary" data-testid="order-two-signatures">
          Your wallet will ask for {signatures} signatures, one after the other
          {needsReceiptTrustline ? ` (${receipt.code} trustline, then the deposit, then the offers)` : " (the deposit, then the offers)"}. Nothing is sent before you
          have signed both, and the offers are dropped if the deposit fails.
        </p>
      ) : null}
      {crossing > 0 ? (
        <p className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2 text-[11px] text-primary" data-testid="order-crosses">
          {crossing} level{crossing === 1 ? "" : "s"} cross the {base.code}/{sq.code} book and would fill immediately (you act as taker).
        </p>
      ) : null}
      {venue === "sdex" && ladder.errors.length > 0 && plan.ok ? <p className="px-1 text-[11px] text-destructive">{ladder.errors[0]}</p> : null}

      <TrustlineNotice asset={base} access={baseAccess} verb={side === "Ask" ? "sell" : "receive"} showOk />
      {venue === "pool" || side === "Bid" ? <TrustlineNotice asset={quote} access={quoteAccess} verb="hold" /> : null}

      <Button className={cn("h-12 w-full text-base")} onClick={submit} disabled={tx.running || retryTx.running || blockedBy !== null} data-testid="order-submit">
        {tx.running ? <Spinner className="size-5" /> : (blockedBy ?? (signatures > 1 ? `Create order · sign ${signatures} transactions` : "Create order · 1 signature"))}
      </Button>
      <TxStatus state={tx.state} network={config.network} onDismiss={tx.reset} />

      {pending ? (
        <div className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5 text-xs" data-testid="order-pending">
          <p className="text-foreground">
            You hold {fromStroops(pending.amount)} {receipt.code}
            {pending.firstHash ? (
              <>
                {" "}
                (deposit <ExplorerLink kind="tx" id={pending.firstHash} network={config.network} />)
              </>
            ) : null}
            . It is redeemable at par on the{" "}
            <Link href="/pools?tab=vault" className="underline underline-offset-2 hover:text-primary">
              Vault tab
            </Link>
            , or you can post the {pending.offers.length} offers again (one signature).
          </p>
          <Button size="sm" className="mt-2" onClick={repost} disabled={retryTx.running} data-testid="order-repost">
            {retryTx.running ? <Spinner /> : null}
            Post the offers again
          </Button>
          <TxStatus state={retryTx.state} network={config.network} onDismiss={retryTx.reset} />
        </div>
      ) : null}
    </div>
  );
}
