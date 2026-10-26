"use client";

// Swap tab of /swap (Lite and Pro): the previous front's SwapPanel (owl/web components/app/SwapPanel.tsx), class for
// class, wired to the directional Lotus pool(s) only: quote_swap on every live instance (best quote kept) for the
// preview, swap(min_out) to execute. No SDEX routing here (that is /trade).

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TrustlineNotice, useAssetAccess } from "@/components/trade/access";
import { useAccount } from "@/lib/account";
import { fromStroops, tryStroops } from "@/lib/amount";
import { useConfig, useNet } from "@/lib/config-context";
import type { PoolInstance } from "@/lib/config-types";
import { explorerTx } from "@/lib/explorer";
import { errMsg, useDebounced, usePolling } from "@/lib/hooks";
import { getPoolClient, type SwapQuote } from "@/lib/pool";
import { assetKey, changeTrustOp, submitClassic, type AssetRef } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { Row, TokenButton, fmtNum } from "./parts";

const num = (v: bigint) => Number(fromStroops(v));
/** reference size for the spot price (price impact): 0.01 of the input asset */
const REF_STROOPS = 100_000n;

type Route = { inst: PoolInstance; buyBase: boolean };
type Best = Route & { q: SwapQuote; spot: number | null };
type Result =
  | { kind: "swap"; hash: string; hashes: string[]; inAmt: number; inCode: string; outAmt: number; outCode: string }
  | { kind: "trust"; hash: string; code: string }
  | { kind: "error"; note: string };

/** Routes of the directional pools that trade `pay` for `recv` (buy = pay the quote, receive the base). */
function routesFor(pools: PoolInstance[], pay: AssetRef, recv: AssetRef): Route[] {
  const p = assetKey(pay);
  const r = assetKey(recv);
  return pools.flatMap((inst): Route[] =>
    assetKey(inst.quote) === p && assetKey(inst.base) === r
      ? [{ inst, buyBase: true }]
      : assetKey(inst.base) === p && assetKey(inst.quote) === r
        ? [{ inst, buyBase: false }]
        : [],
  );
}

/** Full fills first, then the largest output. */
const better = (a: Best, b: Best) => (a.q.partial !== b.q.partial ? (a.q.partial ? b : a) : b.q.amountOut > a.q.amountOut ? b : a);

/** What a swap really pulls on a partial fill (buy: quote = out x avg; sell: base = out / avg). */
function spentOf(b: Best, amountIn: bigint): bigint {
  const { q } = b;
  if (!q.partial || q.avgPrice <= 0n || q.amountOut <= 0n) return amountIn;
  return b.buyBase ? (q.amountOut * q.avgPrice + 9_999_999n) / 10_000_000n : (q.amountOut * 10_000_000n + q.avgPrice - 1n) / q.avgPrice;
}

export function SwapPanel({
  pools,
  pay,
  recv,
  sellOptions,
  buyOptions,
  onSelect,
  onFlip,
  slippage,
}: {
  pools: PoolInstance[];
  pay: AssetRef;
  recv: AssetRef;
  sellOptions: AssetRef[];
  buyOptions: AssetRef[];
  onSelect: (side: "pay" | "recv", a: AssetRef) => void;
  onFlip: () => void;
  slippage: number;
}) {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();

  const [amt, setAmt] = useState("1");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const debounced = useDebounced(amt, 350);
  const amountIn = useMemo(() => tryStroops(debounced), [debounced]);
  const valid = amountIn !== null && amountIn > 0n;
  const amtNum = Number(amt) || 0;

  const routes = useMemo(() => routesFor(pools, pay, recv), [pools, pay, recv]);

  // best of the directional instances, plus a 0.01 reference quote on the same pool for the spot (price impact)
  const quoteFn = useCallback(async (): Promise<Best | null> => {
    const res = await Promise.all(
      routes.map(async (r) => {
        const c = getPoolClient(net, r.inst);
        const [q, ref] = await Promise.all([c.quoteSwap(r.buyBase, amountIn as bigint), c.quoteSwap(r.buyBase, REF_STROOPS).catch(() => null)]);
        return { ...r, q, spot: ref && ref.amountOut > 0n && ref.avgPrice > 0n ? Number(ref.avgPrice) / 1e7 : null } as Best;
      }),
    );
    const filled = res.filter((b) => b.q.amountOut > 0n);
    return filled.length ? filled.reduce(better) : null;
  }, [routes, net, amountIn]);
  const quote = usePolling(quoteFn, 8000, valid && routes.length > 0);
  const best = quote.data;
  const quoting = valid && routes.length > 0 && (amt !== debounced || quote.loading);
  const noLiquidity = valid && amt === debounced && !quote.loading && !quote.error && !best;

  // the result line belongs to the last swap: cleared on a new amount (as the lite SwapPanel does) or pair
  const onAmount = (v: string) => {
    setAmt(v);
    if (!busy) setResult(null);
  };

  const payAccess = useAssetAccess(pay);
  const recvAccess = useAssetAccess(recv);
  const balance = payAccess.available ?? 0;

  const out = best ? num(best.q.amountOut) : null;
  const spent = best && amountIn ? spentOf(best, amountIn) : null;
  const rate = out !== null && spent ? out / num(spent) : null;
  const minOut = best ? (best.q.amountOut * BigInt(10_000 - Math.round(slippage * 100))) / 10_000n : null;
  const avg = best && best.q.avgPrice > 0n ? Number(best.q.avgPrice) / 1e7 : null;
  const impact = best && avg && best.spot ? Math.max(0, (best.buyBase ? avg / best.spot - 1 : 1 - avg / best.spot) * 100) : null;

  const flip = () => {
    if (!busy) setResult(null);
    onFlip();
  };
  const select = (side: "pay" | "recv", a: AssetRef) => {
    if (!busy) setResult(null);
    onSelect(side, a);
  };

  const recvAuthRequired = !!recvAccess.flags?.authRequired;
  const addRecvTrust = recvAccess.state === "no-trustline" && !recvAuthRequired;
  const insufficient = valid && payAccess.available !== null && amtNum > payAccess.available + 1e-9;

  // one button, as the lite page; the label carries the reason when it cannot swap
  type Action = { label: string; disabled?: boolean; href?: string; onClick?: () => void };
  const action: Action = !wallet.address
    ? { label: "Connect a wallet", onClick: () => void wallet.connect() }
    : routes.length === 0
      ? { label: "No Lotus pool for this pair", disabled: true }
      : payAccess.state === "no-trustline" || payAccess.state === "unauthorized"
        ? { label: `Get ${pay.code} on the Faucet`, href: "/faucet" }
        : recvAccess.state === "no-trustline" && recvAuthRequired
          ? { label: `Set up ${recv.code} on the Faucet`, href: "/faucet" }
          : recvAccess.state === "unauthorized"
            ? { label: `${recv.code} not authorized by the issuer`, disabled: true }
            : amtNum <= 0 || !valid
              ? { label: "Enter an amount", disabled: true }
              : insufficient
                ? payAccess.available === 0
                  ? { label: `Get ${pay.code} on the Faucet`, href: "/faucet" }
                  : { label: `Insufficient ${pay.code}`, disabled: true }
                : quoting && !best
                  ? { label: "Swap", disabled: true }
                  : noLiquidity
                    ? { label: "No pool liquidity for this size", disabled: true }
                    : !best
                      ? { label: "Swap", disabled: true }
                      : { label: addRecvTrust ? `Add ${recv.code} trustline & swap` : "Swap", onClick: () => void doSwap() };

  async function doSwap() {
    if (busy || !wallet.address || !amountIn) return;
    setBusy(true);
    setResult(null);
    const hashes: string[] = [];
    try {
      // a missing (non regulated) trustline of what is received goes first, same click: one classic changeTrust
      if (recvAccess.state === "no-trustline") {
        const t = await submitClassic(net, { source: wallet.address, ops: [changeTrustOp(recv)], sign: wallet.sign });
        hashes.push(t.hash);
        acct.refresh();
        if (recvAuthRequired) {
          setResult({ kind: "trust", hash: t.hash, code: recv.code });
          return;
        }
      }
      // re-quote right before signing (docs/pool-abi.md), min_out from the fresh quote
      const fresh = await quoteFn();
      if (!fresh) throw new Error(`No liquidity in the Lotus pool for ${fmtNum(amtNum)} ${pay.code} right now.`);
      const min = (fresh.q.amountOut * BigInt(10_000 - Math.round(slippage * 100))) / 10_000n;
      const r = await getPoolClient(net, fresh.inst).swap({ source: wallet.address, sign: wallet.sign }, fresh.buyBase, amountIn, min);
      if (r.hash) hashes.push(r.hash);
      const got = typeof r.result === "bigint" ? r.result : typeof r.result === "number" ? BigInt(r.result) : fresh.q.amountOut;
      setResult({ kind: "swap", hash: r.hash, hashes, inAmt: num(spentOf(fresh, amountIn)), inCode: pay.code, outAmt: num(got), outCode: recv.code });
      acct.refresh();
      quote.refresh();
    } catch (e) {
      setResult({ kind: "error", note: errMsg(e).slice(0, 220) });
    } finally {
      setBusy(false);
    }
  }

  const btnClass = "mt-2 h-12 w-full text-base";

  return (
    <div className="space-y-1.5" data-testid="lite-swap">
      {/* Sell */}
      <div className="rounded-2xl bg-secondary px-4 py-3.5">
        <div className="text-sm text-mutedfg">Sell</div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amt}
            onChange={(e) => onAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0"
            data-testid="lite-amount"
            className="w-full min-w-0 bg-transparent text-4xl font-medium tabular-nums outline-none placeholder:text-mutedfg/50"
          />
          <TokenButton asset={pay} options={sellOptions} onSelect={(a) => select("pay", a)} />
        </div>
        <button
          onClick={() => onAmount(String(Math.floor(balance * 1e7) / 1e7))}
          className="mt-1 text-sm tabular-nums text-mutedfg transition hover:text-white"
          data-testid="lite-balance"
        >
          Balance: {fmtNum(balance)}
        </button>
      </div>

      {/* flip */}
      <div className="relative h-0">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <button
            onClick={flip}
            aria-label="Flip"
            data-testid="lite-flip"
            className="grid size-9 place-items-center rounded-xl border-4 border-bg bg-secondary text-mutedfg transition hover:text-white"
          >
            <ArrowDown className="size-4" />
          </button>
        </div>
      </div>

      {/* Buy (quoted) */}
      <div className="rounded-2xl bg-secondary px-4 py-3.5">
        <div className="text-sm text-mutedfg">Buy</div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 text-4xl font-medium tabular-nums text-mutedfg" data-testid="lite-out" data-out={best ? fromStroops(best.q.amountOut) : ""}>
            {quoting ? <Loader2 className="size-6 animate-spin" /> : out != null && valid ? fmtNum(out) : "—"}
          </div>
          <TokenButton asset={recv} options={buyOptions} onSelect={(a) => select("recv", a)} />
        </div>
        <div className="mt-1 text-sm tabular-nums text-mutedfg">
          {rate != null && valid && !quoting ? `1 ${pay.code} ≈ ${fmtNum(rate)} ${recv.code}` : "live Lotus pool quote"}
        </div>
      </div>

      {action.href ? (
        <Button asChild className={btnClass}>
          <Link href={action.href} data-testid="lite-submit">
            {action.label}
          </Link>
        </Button>
      ) : (
        <Button className={btnClass} disabled={busy || !!action.disabled} onClick={action.onClick} data-testid="lite-submit">
          {busy ? <Loader2 className="size-5 animate-spin" /> : action.label}
        </Button>
      )}

      {/* quote details, in the lite result box style */}
      {valid && (best || noLiquidity || quote.error) ? (
        <div className="rounded-xl border border-line bg-secondary px-3 py-2.5 text-[11px] text-mutedfg" data-testid="lite-details">
          {best ? (
            <>
              <Row k="Route" v={<span data-testid="lite-route">via Lotus pool{pools.length > 1 ? ` · ${best.inst.label}` : ""}</span>} />
              {avg ? <Row k="Price" v={`1 ${best.inst.base.code} = ${fmtNum(avg)} ${best.inst.quote.code}`} /> : null}
              <Row k="Price impact" v={impact != null ? (impact < 0.01 ? "<0.01%" : `${impact.toFixed(2)}%`) : "—"} />
              <Row k={`Min received (${slippage}% slippage)`} v={minOut !== null ? `${fmtNum(num(minOut))} ${recv.code}` : "—"} testId="lite-min" />
              <Row k="Pool fee" v={`${fmtNum(num(best.q.fee))} ${best.inst.quote.code} · ${best.q.binsCrossed} bin${best.q.binsCrossed === 1 ? "" : "s"}`} />
              {best.q.partial && spent !== null ? (
                <p className="mt-1 text-primary">
                  The pool only has depth for {fmtNum(num(spent))} {pay.code} of this order: only that part is pulled, the rest stays in your wallet.
                </p>
              ) : null}
            </>
          ) : noLiquidity ? (
            <span className="text-red" data-testid="lite-no-liquidity">
              No liquidity in the Lotus pool for {pay.code} → {recv.code} at this size. Try a smaller amount, or place a range order in{" "}
              <Link href="/pools" className="text-primary underline-offset-2 hover:underline">
                Pro
              </Link>
              .
            </span>
          ) : (
            <span className="text-red">{quote.error}</span>
          )}
        </div>
      ) : null}

      {/* trustline / authorization (LBOND is AUTH_REQUIRED): the existing clear message + Faucet link */}
      {recvAccess.state === "unauthorized" || (recvAccess.state === "no-trustline" && recvAuthRequired) ? (
        <div>
          <TrustlineNotice asset={recv} access={recvAccess} verb="receive" />
          <p className="mt-1.5 text-[11px] text-mutedfg">
            The{" "}
            <Link href="/faucet" className="text-primary underline-offset-2 hover:underline">
              Faucet
            </Link>{" "}
            adds the trustline and gets it authorized in one step.
          </p>
        </div>
      ) : null}

      {result && (
        <div className="rounded-xl border border-line bg-secondary px-3 py-2.5 text-[11px] text-mutedfg" data-testid="lite-result" data-kind={result.kind} data-hash={"hash" in result ? result.hash : ""} data-hashes={result.kind === "swap" ? result.hashes.join(",") : ""}>
          {result.kind === "swap" ? (
            <>
              Swapped {fmtNum(result.inAmt)} {result.inCode} → {fmtNum(result.outAmt)} {result.outCode}
              <span className="ml-1 text-green">· on-chain ✓</span>
              {result.hashes.map((h, i) => (
                <a key={h} href={explorerTx(h, config.network)} target="_blank" rel="noreferrer" className="ml-1 text-primary underline-offset-2 transition hover:underline">
                  {result.hashes.length > 1 ? (i === result.hashes.length - 1 ? "swap tx ↗" : "trustline tx ↗") : "view tx ↗"}
                </a>
              ))}
            </>
          ) : result.kind === "trust" ? (
            <>
              {result.code} trustline added
              <span className="ml-1 text-green">· on-chain ✓</span>
              <a href={explorerTx(result.hash, config.network)} target="_blank" rel="noreferrer" className="ml-1 text-primary underline-offset-2 transition hover:underline">
                view tx ↗
              </a>
              <span className="ml-1">· the issuer still has to authorize it before you can receive {result.code}.</span>
            </>
          ) : (
            <span className="text-red">{result.note}</span>
          )}
        </div>
      )}
    </div>
  );
}
