// The Lotus client: reads (config, markets, books, pools, positions, offers, vault, APR) and builders that return
// UNSIGNED transactions (base64 XDR) for the account's wallet to sign. Nothing here holds a key; signing is the
// caller's (or signer.ts fromSecret for testnet scripts).

import { Operation, xdr } from "@stellar/stellar-sdk";
import { SCALE, divRound, fromStroops, gcd, toStroops } from "./shared/amount.ts";
import { MAX_BIN, MIN_BIN, planPosition, type PositionPlan, type Shape, type Side } from "./shared/poolGrid.ts";
import { aprFromSamples, sampleFromReserve, type ReserveSample } from "./shared/yieldRate.ts";
import { loadConfig, netOf, type LoadConfigOptions, type LotusConfig, type PoolInstance, type Strategy } from "./config.ts";
import { buildMarkets, findMarket, type Market } from "./markets.ts";
import {
  assetKey,
  bestPrices,
  fetchAccount,
  fetchAssetFlags,
  fetchOffers,
  fetchOrderBook,
  fetchTrades,
  findBalance,
  isAccountId,
  isContractId,
  isNative,
  sameAsset,
  sameHorizonAsset,
  simulateView,
  toAssetRef,
  toSdkAsset,
  type AssetRef,
  type HorizonAccount,
  type HorizonOffer,
  type NetCfg,
  type OrderBook,
} from "./net.ts";
import { PoolReader, addressArg, boolArg, i128Arg, i32Arg, modeArg, readVaultStats, redeemEstimate, sideArg, u64Arg, weightsArg, type Position, type SwapQuote } from "./pool.ts";
import { STRATEGIES, crossText, directionalPools, evaluate, orderEnv, type Destination, type MarketSnapshot, type StrategyId } from "./order.ts";
import {
  buildClassic,
  prepareInvoke,
  signAndSubmit,
  sourceAccount,
  submitSequence,
  toBuilt,
  type BuildResult,
  type ContractCall,
  type SequenceResult,
  type Signer,
} from "./tx.ts";

export const EXPLORER = "https://stellar.expert/explorer";

export type PositionRow = Position & { pool: string; poolId: string; poolLabel: string; retired: boolean; vaultedPool: boolean };
export type OfferRow = { id: string; selling: AssetRef; buying: AssetRef; amount: string; price: string; priceR: { n: number; d: number }; lastModified?: string };

const ref = (a: { code: string; issuer: string | null }): AssetRef => ({ code: a.code, issuer: a.issuer ?? null });
const s = (v: bigint) => fromStroops(v);

function amountStroops(v: string | number, what: string): bigint {
  let x: bigint;
  try {
    x = toStroops(String(v));
  } catch {
    throw new Error(`${what}: not a valid amount (${v}); use a decimal with at most 7 decimals`);
  }
  if (x <= 0n) throw new Error(`${what} must be positive`);
  return x;
}

/** manageSellOffer price: exact reduced rational when it fits int32 (`invert` = 1/price). Port of web/lib/stellar.ts priceArg. */
export function priceArg(price: string, invert = false): string | { n: number; d: number } {
  let n = toStroops(price);
  let d = SCALE;
  const g = gcd(n, d);
  n /= g;
  d /= g;
  if (invert) [n, d] = [d, n];
  const MAX = 2147483647n;
  if (n <= 0n || d <= 0n || n > MAX || d > MAX) return invert ? (1 / Number(price)).toPrecision(12) : price;
  return { n: Number(n), d: Number(d) };
}

const manageSellOfferOp = (p: { selling: AssetRef; buying: AssetRef; amount: string; price: string | { n: number; d: number }; offerId?: string }) =>
  Operation.manageSellOffer({ selling: toSdkAsset(p.selling), buying: toSdkAsset(p.buying), amount: p.amount, price: p.price, offerId: p.offerId ?? "0" });
const changeTrustOp = (a: AssetRef) => Operation.changeTrust({ asset: toSdkAsset(a) });

export type RangeOrderInput = {
  account: string;
  /** Ask = sell BASE (LBOND) as the price rises; Bid = buy BASE with QUOTE (USDC) as the price falls */
  side: Side;
  /** price nearest to the market: lowest for an Ask, highest for a Bid (QUOTE per BASE, decimal) */
  startPrice: string;
  /** far end: highest for an Ask, lowest for a Bid */
  endPrice: string;
  /** amount of the SOLD asset (BASE for Ask, QUOTE for Bid), decimal */
  amount: string;
  shape?: Shape;
};

export class Lotus {
  readonly net: NetCfg;
  private _markets: Market[] | null = null;
  constructor(readonly config: LotusConfig) {
    this.net = netOf(config);
  }

  static async connect(opts: LoadConfigOptions = {}): Promise<Lotus> {
    return new Lotus(await loadConfig(opts));
  }

  // ---- links ------------------------------------------------------------------------------------------------------
  get explorerNet(): string {
    return this.config.network === "public" || this.config.network === "mainnet" ? "public" : "testnet";
  }
  txUrl = (hash: string) => `${EXPLORER}/${this.explorerNet}/tx/${hash}`;
  accountUrl = (g: string) => `${EXPLORER}/${this.explorerNet}/account/${g}`;
  contractUrl = (c: string) => `${EXPLORER}/${this.explorerNet}/contract/${c}`;
  offerUrl = (id: string) => `${EXPLORER}/${this.explorerNet}/offer/${id}`;
  assetUrl = (a: AssetRef) => `${EXPLORER}/${this.explorerNet}/asset/${isNative(a) ? "XLM" : `${a.code}-${a.issuer}`}`;

  // ---- config / markets -------------------------------------------------------------------------------------------
  markets(): Market[] {
    return (this._markets ??= buildMarkets(this.config));
  }
  market(id: string): Market {
    const m = findMarket(this.markets(), id);
    if (!m) throw new Error(`unknown market "${id}" (known: ${this.markets().map((x) => x.id).join(", ")})`);
    return m;
  }
  /** The three assets of the flow: BASE (LBOND), QUOTE (USDC), and the active receipt. */
  assets(): { base: AssetRef; quote: AssetRef; receipt: AssetRef } {
    const { idle, vaulted } = directionalPools(this.config.pools);
    const main = idle ?? vaulted ?? this.config.pools[0];
    return { base: ref(main ? main.base : this.config.rwa), quote: ref(main ? main.quote : this.config.underlying), receipt: ref(this.config.receipt) };
  }

  async orderbook(marketId: string, limit = 20): Promise<{ market: Market; book: OrderBook; bid: number | null; ask: number | null; mid: number | null; spread: number | null }> {
    const market = this.market(marketId);
    const book = await fetchOrderBook(this.config.horizon, market.base, market.quote, limit);
    const { bid, ask } = bestPrices(book);
    return { market, book, bid, ask, mid: bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask), spread: bid !== null && ask !== null ? ask - bid : null };
  }
  trades(marketId: string, limit = 20) {
    const m = this.market(marketId);
    return fetchTrades(this.config.horizon, m.base, m.quote, limit);
  }

  // ---- pools ------------------------------------------------------------------------------------------------------
  pools(opts: { includeRetired?: boolean } = {}): PoolInstance[] {
    return opts.includeRetired ? [...this.config.pools, ...this.config.retiredPools] : this.config.pools;
  }
  pool(idOrContract: string): PoolInstance {
    const p = this.pools({ includeRetired: true }).find((x) => x.id === idOrContract || x.contract === idOrContract);
    if (!p) throw new Error(`unknown pool "${idOrContract}" (known: ${this.pools({ includeRetired: true }).map((x) => x.id).join(", ")})`);
    return p;
  }
  reader(p: PoolInstance | string): PoolReader {
    const inst = typeof p === "string" ? this.pool(p) : p;
    if (!isContractId(inst.contract)) throw new Error(`pool ${inst.id} has no deployed contract`);
    return new PoolReader(this.net, inst.contract);
  }
  directionalPools() {
    return directionalPools(this.config.pools);
  }

  /** quote_swap on one pool, or on every live directional instance (best kept: full fills first, then largest output). */
  async quoteSwap(p: { buyBase: boolean; amountIn: string; pool?: string }): Promise<{ best: { pool: PoolInstance; quote: SwapQuote } | null; all: { pool: PoolInstance; quote: SwapQuote | null; error?: string }[] }> {
    const amt = amountStroops(p.amountIn, "amountIn");
    const pools = p.pool ? [this.pool(p.pool)] : this.directionalPools().list;
    const all = await Promise.all(
      pools.map(async (pool) => {
        try {
          return { pool, quote: await this.reader(pool).quoteSwap(p.buyBase, amt) };
        } catch (e) {
          return { pool, quote: null, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    const ok = all.filter((x): x is { pool: PoolInstance; quote: SwapQuote } => !!x.quote && x.quote.amountOut > 0n);
    ok.sort((a, b) => (a.quote.partial !== b.quote.partial ? (a.quote.partial ? 1 : -1) : a.quote.amountOut > b.quote.amountOut ? -1 : a.quote.amountOut < b.quote.amountOut ? 1 : 0));
    return { best: ok[0] ?? null, all };
  }

  /** Open positions of `owner` on every pool instance (retired ones included, so they can still be removed). */
  async positions(owner: string): Promise<{ rows: PositionRow[]; errors: string[] }> {
    if (!isAccountId(owner)) throw new Error(`not an account id: ${owner}`);
    const errors: string[] = [];
    const per = await Promise.all(
      this.pools({ includeRetired: true })
        .filter((p) => isContractId(p.contract))
        .map(async (p) => {
          try {
            const rows = await this.reader(p).positionsOf(owner);
            return rows.map((r) => ({ ...r, pool: p.contract, poolId: p.id, poolLabel: p.label, retired: p.status === "retired", vaultedPool: !!p.vault }));
          } catch (e) {
            errors.push(`${p.id}: ${e instanceof Error ? e.message : String(e)}`);
            return [];
          }
        }),
    );
    return { rows: per.flat(), errors };
  }

  async account(id: string): Promise<HorizonAccount | null> {
    return fetchAccount(this.config.horizon, id);
  }

  async offers(account: string): Promise<OfferRow[]> {
    const rows = await fetchOffers(this.config.horizon, account);
    return rows.map((o: HorizonOffer) => ({
      id: o.id,
      selling: toAssetRef(o.selling),
      buying: toAssetRef(o.buying),
      amount: o.amount,
      price: o.price,
      priceR: o.price_r,
      lastModified: o.last_modified_time,
    }));
  }

  // ---- vault / yield ----------------------------------------------------------------------------------------------
  strategy(id?: string): Strategy {
    const st = id
      ? this.config.strategies.find((x) => x.id === id || x.lotusVault === id)
      : this.config.strategies.find((x) => x.lotusVault === this.config.lotusVault);
    if (!st) throw new Error(id ? `unknown strategy "${id}"` : "no active Lotus vault in the config");
    if (!isContractId(st.lotusVault)) throw new Error(`strategy ${st.id} has no deployed lotus_vault (${st.status})`);
    return st;
  }
  vaultStats(strategyId?: string) {
    return readVaultStats(this.net, this.strategy(strategyId).lotusVault);
  }
  redeemEstimate = redeemEstimate;

  /** Last APR measured by the deployment team (config `observed`), never a forecast. */
  observedApr(strategyId?: string): { aprPct: number | null; summary: string | null; measuredOn: string | null } {
    let st: Strategy | undefined;
    try {
      st = this.strategy(strategyId);
    } catch {
      st = undefined;
    }
    return { aprPct: st?.observed?.aprPct ?? null, summary: st?.observed?.summary ?? null, measuredOn: st?.observed?.measuredOn ?? null };
  }

  /**
   * Live Blend supply APR of the quote asset: two `get_reserve` simulations `windowSeconds` apart, annualized b_rate
   * growth (web/lib/yieldRate.ts, shared). Gross Blend rate, BLND emissions not counted; a snapshot, not a forecast.
   */
  async blendApr(opts: { windowSeconds?: number } = {}): Promise<{ aprPct: number | null; windowSeconds: number; samples: ReserveSample[]; blendPool: string; asset: string }> {
    const pool = this.config.blendPool;
    const asset = this.config.underlying.sac;
    if (!isContractId(pool) || !asset) throw new Error("no Blend pool / underlying SAC in the config");
    const read = async () => sampleFromReserve(await simulateView(this.net, pool, "get_reserve", [addressArg(asset)]));
    const a = await read();
    await new Promise((r) => setTimeout(r, Math.max(10, opts.windowSeconds ?? 12) * 1000));
    const b = await read();
    if (!a || !b) throw new Error("get_reserve returned no b_rate");
    return { aprPct: aprFromSamples(a, b), windowSeconds: b.time - a.time, samples: [a, b], blendPool: pool, asset };
  }

  // ---- builders ---------------------------------------------------------------------------------------------------
  private async invokeTx(account: string, call: ContractCall, label: string): Promise<BuildResult["txs"][number]> {
    const acct = await sourceAccount(this.net, account);
    const tx = await prepareInvoke(this.net, acct, call);
    return toBuilt(tx, "soroban", label, this.net.passphrase);
  }
  private async requireAccount(account: string): Promise<HorizonAccount> {
    if (!isAccountId(account)) throw new Error(`not an account id: ${account}`);
    const a = await this.account(account);
    if (!a) throw new Error(`account ${account} does not exist on ${this.config.network} (fund it with Friendbot: https://friendbot.stellar.org/?addr=${account})`);
    return a;
  }
  private async requireLine(acct: HorizonAccount, asset: AssetRef, why: string) {
    if (isNative(asset)) return;
    const b = findBalance(acct, asset);
    if (!b) throw new Error(`${asset.code} trustline missing (${why}): build the trustlines first (buildTrustlines)`);
    if (b.is_authorized === false) throw new Error(`${asset.code} trustline is not authorized by the issuer (${why}); the Lotus faucet authorizes LBOND trustlines`);
  }
  private requireAvailable(acct: HorizonAccount, asset: AssetRef, need: bigint) {
    const b = findBalance(acct, asset);
    if (!b) return;
    const avail = toStroops(b.balance) - toStroops(b.selling_liabilities ?? "0");
    if (avail < need) throw new Error(`insufficient ${asset.code}: available ${s(avail)}, needed ${s(need)}`);
  }

  /** changeTrust for each missing asset (default: BASE, QUOTE and the active receipt), one classic transaction. */
  async buildTrustlines(p: { account: string; assets?: AssetRef[] }): Promise<BuildResult> {
    const acct = await this.requireAccount(p.account);
    const { base, quote, receipt } = this.assets();
    const wanted = (p.assets ?? [quote, base, receipt]).filter((a) => !isNative(a));
    const missing = wanted.filter((a) => !findBalance(acct, a));
    const warnings: string[] = [];
    for (const a of wanted) {
      const b = findBalance(acct, a);
      if (b && b.is_authorized === false) warnings.push(`${a.code}: trustline exists but is not authorized by the issuer (the faucet authorizes LBOND)`);
    }
    for (const a of missing) {
      const f = a.issuer ? await fetchAssetFlags(this.config.horizon, a.issuer) : null;
      if (f?.authRequired) warnings.push(`${a.code} is AUTH_REQUIRED: after this trustline the issuer must authorize it (the Lotus faucet does it on claim)`);
    }
    if (missing.length === 0) return { txs: [], summary: `all trustlines already exist (${wanted.map((a) => a.code).join(", ")})`, warnings };
    const tx = buildClassic(this.net, await sourceAccount(this.net, p.account), missing.map(changeTrustOp));
    return {
      txs: [toBuilt(tx, "classic", `add trustlines: ${missing.map((a) => a.code).join(", ")}`, this.net.passphrase)],
      summary: `adds ${missing.length} trustline(s): ${missing.map((a) => a.code).join(", ")} (0.5 XLM reserve each)`,
      warnings,
    };
  }

  /** Pool swap. buyBase: pay QUOTE (USDC), receive BASE (LBOND); otherwise sell BASE for QUOTE. Re-quoted now, min_out from slippage. */
  async buildSwap(p: { account: string; buyBase: boolean; amountIn: string; slippageBps?: number; pool?: string }): Promise<BuildResult> {
    const acct = await this.requireAccount(p.account);
    const amt = amountStroops(p.amountIn, "amountIn");
    const slip = BigInt(Math.max(0, Math.min(5000, Math.round(p.slippageBps ?? 50))));
    const q = await this.quoteSwap({ buyBase: p.buyBase, amountIn: p.amountIn, pool: p.pool });
    if (!q.best) throw new Error(`no liquidity in the Lotus pool${p.pool ? ` ${p.pool}` : "s"} for this swap (${q.all.map((x) => `${x.pool.id}: ${x.error ?? "0 out"}`).join("; ")})`);
    const { pool, quote } = q.best;
    const paid = ref(p.buyBase ? pool.quote : pool.base);
    const got = ref(p.buyBase ? pool.base : pool.quote);
    await this.requireLine(acct, paid, "asset paid");
    await this.requireLine(acct, got, "asset received");
    this.requireAvailable(acct, paid, amt);
    const minOut = (quote.amountOut * (10_000n - slip)) / 10_000n;
    const tx = await this.invokeTx(
      p.account,
      { contractId: pool.contract, method: "swap", args: [addressArg(p.account), boolArg(p.buyBase), i128Arg(amt), i128Arg(minOut)] },
      `swap ${s(amt)} ${paid.code} -> ${got.code} on ${pool.id}`,
    );
    const warnings = quote.partial ? [`partial fill: the pool's depth (or max_bins_per_swap) ends before ${s(amt)} ${paid.code} is used; only what is needed is pulled`] : [];
    return {
      txs: [tx],
      summary: `swap up to ${s(amt)} ${paid.code} for ~${s(quote.amountOut)} ${got.code} (min ${s(minOut)}, slippage ${slip} bps) on ${pool.label}, avg price ${s(quote.avgPrice)}, fee ${s(quote.fee)} ${pool.quote.code}, ${quote.binsCrossed} bins`,
      warnings,
      details: { pool: pool.id, contract: pool.contract, amountIn: s(amt), expectedOut: s(quote.amountOut), minOut: s(minOut), avgPrice: s(quote.avgPrice), fee: s(quote.fee), binsCrossed: quote.binsCrossed, partial: quote.partial },
    };
  }

  /** Live tops of every book a range-order strategy can target (as NewPosition.tsx `market`). */
  async marketSnapshot(): Promise<MarketSnapshot> {
    const { base, quote, receipt } = this.assets();
    const { idle, vaulted } = this.directionalPools();
    const [rb, ub, pi, pv] = await Promise.all([
      receipt.issuer ? fetchOrderBook(this.config.horizon, base, receipt, 50).catch(() => null) : null,
      fetchOrderBook(this.config.horizon, base, quote, 50).catch(() => null),
      idle ? this.reader(idle).top().catch(() => ({ bid: null, ask: null })) : { bid: null, ask: null },
      vaulted ? this.reader(vaulted).top().catch(() => ({ bid: null, ask: null })) : { bid: null, ask: null },
    ]);
    return { usdc: bestPrices(ub), receipt: bestPrices(rb), pool: { idle: pi, vaulted: pv } };
  }

  /** Plan a range order and evaluate the four strategies for `account` (no transaction built). */
  async evaluateRangeOrder(p: RangeOrderInput): Promise<{ plan: PositionPlan; destinations: Destination[]; market: MarketSnapshot }> {
    const acct = isAccountId(p.account) ? await this.account(p.account) : null;
    const { idle, vaulted } = this.directionalPools();
    const main = idle ?? vaulted;
    if (!main) throw new Error("no directional pool instance in the config");
    const plan = planPosition({ side: p.side, startPrice: p.startPrice, endPrice: p.endPrice, shape: p.shape ?? "uniform", amount: p.amount, stepBps: main.binStepBps, feeBps: main.feeBps });
    const market = await this.marketSnapshot();
    const env = orderEnv(this.config, acct, plan);
    const destinations = STRATEGIES.map((st) => evaluate(env, plan, main.binStepBps, market, st));
    return { plan, destinations, market };
  }

  /**
   * Directional range limit order, built for one strategy (web/lib/orderTx.ts placeOrder, same shapes):
   *   pool / pool-yield : add_position(Directional) on the idle / vault-backed instance       1 Soroban tx
   *   sdex              : one manageSellOffer per bin on BASE/USDC (+ proceeds trustline)       1 classic tx
   *   sdex-yield Ask    : the ladder quoted in the receipt (+ receipt trustline)               1 classic tx
   *   sdex-yield Bid    : lotus_vault.deposit(USDC) at s+1, then the receipt ladder at s+2     2 txs, IN ORDER:
   *                       submit tx 2 only after tx 1 succeeded (if tx 1 fails, discard tx 2)
   */
  async buildRangeOrder(p: RangeOrderInput & { strategy: StrategyId }): Promise<BuildResult> {
    const stDef = STRATEGIES.find((x) => x.id === p.strategy);
    if (!stDef) throw new Error(`unknown strategy "${p.strategy}" (pool | pool-yield | sdex | sdex-yield)`);
    await this.requireAccount(p.account);
    const { plan, destinations } = await this.evaluateRangeOrder(p);
    const d = destinations.find((x) => x.id === p.strategy) as Destination;
    if (!plan.ok) throw new Error(plan.errors[0] ?? "invalid range");
    const others = destinations
      .filter((x) => x.id !== p.strategy)
      .map((x) => `${x.id}: ${x.blockedBy ?? "available"}`)
      .join("; ");
    if (d.unavailable) throw new Error(`strategy ${p.strategy} unavailable: ${d.unavailable} (others: ${others})`);
    if (d.needsReceiptTrustline) throw new Error(`${this.config.receipt.code} trustline needed before the deposit (the vault mints to it): build the trustlines first`);
    if (d.blockedBy) throw new Error(`cannot place the order: ${d.blockedBy}`);

    const { base, quote, receipt } = this.assets();
    const warnings: string[] = [];
    if (d.crossing > 0) warnings.push(crossText(d, plan.side, base.code, quote.code, receipt.code, plan.bins.filter((b) => b.amount > 0n).length));
    const details = {
      strategy: p.strategy,
      side: plan.side,
      loBin: plan.loBin,
      hiBin: plan.hiBin,
      bins: plan.bins.length,
      loPrice: s(plan.bins[0].price),
      hiPrice: s(plan.bins[plan.bins.length - 1].price),
      deposit: s(plan.deposit),
      avgPrice: plan.avgPrice === null ? null : s(plan.avgPrice),
      proceedsIfFilled: s(plan.proceedsIfFilled),
      reference: { price: Number(d.ref.price.toFixed(7)), source: d.ref.source },
      signatures: d.signatures,
      reserveXlm: d.reserveXlm,
      pool: d.inst?.id ?? null,
    };
    const summary = d.summary ?? "";

    if (d.venue === "pool") {
      const inst = d.inst as PoolInstance;
      const tx = await this.invokeTx(
        p.account,
        {
          contractId: inst.contract,
          method: "add_position",
          args: [addressArg(p.account), sideArg(plan.side), modeArg("Directional"), i32Arg(plan.loBin), i32Arg(plan.hiBin), i128Arg(plan.deposit), weightsArg(plan.weights)],
        },
        `add_position ${plan.side} ${plan.loBin}..${plan.hiBin} ${s(plan.deposit)} ${plan.side === "Ask" ? base.code : quote.code} on ${inst.id}`,
      );
      return { txs: [tx], summary, warnings, details };
    }

    const ladder = orderEnv(this.config, null, plan).ladder;
    const q = d.sdexQuote;
    const offerOps = ladder.offers.map((o) =>
      plan.side === "Ask"
        ? manageSellOfferOp({ selling: base, buying: q, amount: fromStroops(o.sellAmount), price: o.price })
        : manageSellOfferOp({ selling: q, buying: base, amount: fromStroops(o.sellAmount), price: o.price }),
    );
    const sold = plan.side === "Ask" ? base : quote;
    const amountText = `${s(plan.deposit)} ${sold.code}`;

    if (d.yieldOn && plan.side === "Bid") {
      const vault = this.strategy().lotusVault;
      const acct = await sourceAccount(this.net, p.account);
      const tx1 = await prepareInvoke(this.net, acct, { contractId: vault, method: "deposit", args: [addressArg(p.account), i128Arg(plan.deposit)] }); // s+1
      const tx2 = buildClassic(this.net, acct, [...d.addTrust.map(changeTrustOp), ...offerOps]); // s+2
      warnings.push("two transactions: submit tx 2 ONLY after tx 1 succeeded; if tx 1 fails, discard tx 2 (nothing moved). If tx 2 fails you hold the receipt, redeemable 1:1.");
      return {
        txs: [
          toBuilt(tx1, "soroban", `deposit ${amountText} into the Lotus vault for ${s(plan.deposit)} ${receipt.code}`, this.net.passphrase),
          toBuilt(tx2, "classic", `${ladder.offers.length} bids on ${base.code}/${receipt.code}`, this.net.passphrase),
        ],
        summary,
        warnings,
        details,
      };
    }
    const tx = buildClassic(this.net, await sourceAccount(this.net, p.account), [...d.addTrust.map(changeTrustOp), ...offerOps]);
    const trustNote = d.addTrust.length > 0 ? ` (+ ${d.addTrust.map((a) => a.code).join(", ")} trustline)` : "";
    return {
      txs: [toBuilt(tx, "classic", `${ladder.offers.length} ${plan.side === "Ask" ? "asks" : "bids"} on ${base.code}/${q.code}, ${amountText}${trustNote}`, this.net.passphrase)],
      summary,
      warnings,
      details: { ...details, offers: ladder.offers.map((o) => ({ bin: o.bin, price: s(o.priceStroops), sell: s(o.sellAmount) })) },
    };
  }

  private async positionCall(p: { account: string; pool: string; positionId: string | number | bigint }, method: "claim" | "remove_position"): Promise<BuildResult> {
    await this.requireAccount(p.account);
    const inst = this.pool(p.pool);
    const id = BigInt(p.positionId);
    const pos = await this.reader(inst).getPosition(id);
    if (pos.owner !== p.account) throw new Error(`position ${id} on ${inst.id} is owned by ${pos.owner}, not ${p.account}`);
    const tx = await this.invokeTx(p.account, { contractId: inst.contract, method, args: [addressArg(p.account), u64Arg(id)] }, `${method} #${id} on ${inst.id}`);
    const base = inst.base.code;
    const quote = inst.quote.code;
    const [procCode, invCode] = pos.side === "Ask" ? [quote, base] : [base, quote];
    const pays =
      method === "claim"
        ? `pending proceeds ${s(pos.pendingProceeds)} ${pos.mode === "TwoWay" ? quote : procCode} + fees ${s(pos.pendingFees)} ${quote}`
        : `unfilled ${s(pos.inventory)} ${invCode} + proceeds ${s(pos.pendingProceeds)} ${procCode} + fees ${s(pos.pendingFees)} ${quote}`;
    return { txs: [tx], summary: `${method === "claim" ? "claim" : "remove"} position #${id} (${pos.side} ${pos.loBin}..${pos.hiBin}) on ${inst.label}: pays ${pays}`, warnings: [], details: { pool: inst.id, positionId: String(id) } };
  }
  buildClaim(p: { account: string; pool: string; positionId: string | number | bigint }) {
    return this.positionCall(p, "claim");
  }
  /** remove_position: pays the unfilled inventory + pending proceeds + fees and closes the position (works on-chain at any fill level). */
  buildRemove(p: { account: string; pool: string; positionId: string | number | bigint }) {
    return this.positionCall(p, "remove_position");
  }

  /** One SDEX limit order on a market: sell `amount` BASE at `price`, or buy `amount` BASE at `price` (QUOTE per BASE). */
  async buildLimitOrder(p: { account: string; market: string; side: "buy" | "sell"; price: string; amount: string }): Promise<BuildResult> {
    const acct = await this.requireAccount(p.account);
    const m = this.market(p.market);
    const pr = amountStroops(p.price, "price");
    const a = amountStroops(p.amount, "amount");
    await this.requireLine(acct, m.base, `${m.base.code} of ${m.label}`);
    await this.requireLine(acct, m.quote, `${m.quote.code} of ${m.label}`);
    const quoteTotal = divRound(a * pr, SCALE);
    const op =
      p.side === "sell"
        ? manageSellOfferOp({ selling: m.base, buying: m.quote, amount: fromStroops(a), price: priceArg(p.price) })
        : manageSellOfferOp({ selling: m.quote, buying: m.base, amount: fromStroops(quoteTotal), price: priceArg(p.price, true) });
    this.requireAvailable(acct, p.side === "sell" ? m.base : m.quote, p.side === "sell" ? a : quoteTotal);
    const { bid, ask } = bestPrices(await fetchOrderBook(this.config.horizon, m.base, m.quote, 5).catch(() => null));
    const px = Number(p.price);
    const warnings: string[] = [];
    if (p.side === "sell" ? bid !== null && px <= bid : ask !== null && px >= ask) warnings.push(`crosses the book (best ${p.side === "sell" ? `bid ${bid}` : `ask ${ask}`}): fills at once as a taker`);
    const tx = buildClassic(this.net, await sourceAccount(this.net, p.account), [op]);
    return {
      txs: [toBuilt(tx, "classic", `${p.side === "sell" ? "ask" : "bid"} ${s(a)} ${m.base.code} @ ${s(pr)} on ${m.label}`, this.net.passphrase)],
      summary: `${p.side} ${s(a)} ${m.base.code} at ${s(pr)} ${m.quote.code} (total ${s(quoteTotal)} ${m.quote.code}) on the SDEX ${m.label}`,
      warnings,
    };
  }

  /** Cancel one of the account's OWN offers (amount 0, same assets and price). */
  async buildCancelOffer(p: { account: string; offerId: string }): Promise<BuildResult> {
    await this.requireAccount(p.account);
    const mine = await this.offers(p.account);
    const o = mine.find((x) => x.id === String(p.offerId));
    if (!o) throw new Error(`offer ${p.offerId} is not an open offer of ${p.account} (only your own offers can be cancelled)`);
    const op = manageSellOfferOp({ selling: o.selling, buying: o.buying, amount: "0", price: o.priceR, offerId: o.id });
    const tx = buildClassic(this.net, await sourceAccount(this.net, p.account), [op]);
    return { txs: [toBuilt(tx, "classic", `cancel offer ${o.id}`, this.net.passphrase)], summary: `cancel offer ${o.id}: ${o.amount} ${o.selling.code} for ${o.buying.code} @ ${o.price}`, warnings: [] };
  }

  /** lotus_vault.deposit: USDC in, the receipt minted 1:1 (needs the receipt trustline). */
  async buildDeposit(p: { account: string; amount: string; strategy?: string }): Promise<BuildResult> {
    const acct = await this.requireAccount(p.account);
    const st = this.strategy(p.strategy);
    const a = amountStroops(p.amount, "amount");
    await this.requireLine(acct, ref(st.underlying), "deposited");
    await this.requireLine(acct, ref(st.receipt), "the vault mints the receipt to it");
    this.requireAvailable(acct, ref(st.underlying), a);
    const tx = await this.invokeTx(p.account, { contractId: st.lotusVault, method: "deposit", args: [addressArg(p.account), i128Arg(a)] }, `deposit ${s(a)} ${st.underlying.code} into ${st.id}`);
    return { txs: [tx], summary: `deposit ${s(a)} ${st.underlying.code} into the Lotus vault ${st.label}, receive ${s(a)} ${st.receipt.code}`, warnings: st.status === "live" ? [] : [`strategy ${st.id} is ${st.status}: no yield accrues`] };
  }

  /** lotus_vault.redeem: the receipt burned, USDC back (1:1 while fully backed, pro rata otherwise). */
  async buildRedeem(p: { account: string; amount: string; strategy?: string }): Promise<BuildResult> {
    const acct = await this.requireAccount(p.account);
    const st = this.strategy(p.strategy);
    const a = amountStroops(p.amount, "amount");
    await this.requireLine(acct, ref(st.receipt), "redeemed");
    await this.requireLine(acct, ref(st.underlying), "paid out");
    this.requireAvailable(acct, ref(st.receipt), a);
    const stats = await readVaultStats(this.net, st.lotusVault);
    const est = redeemEstimate(a, stats.vaultValue, stats.supply);
    const tx = await this.invokeTx(p.account, { contractId: st.lotusVault, method: "redeem", args: [addressArg(p.account), i128Arg(a)] }, `redeem ${s(a)} ${st.receipt.code} from ${st.id}`);
    return { txs: [tx], summary: `redeem ${s(a)} ${st.receipt.code}, receive ~${est === null ? "?" : s(est)} ${st.underlying.code}`, warnings: [] };
  }

  // ---- submission -------------------------------------------------------------------------------------------------
  /** Submit signed transaction(s) in order, stopping at the first failure. See tx.ts submitSequence. */
  submit(signed: string | string[], opts: { signer?: Signer } = {}): Promise<SequenceResult> {
    return submitSequence(this.net, Array.isArray(signed) ? signed : [signed], opts);
  }
  /** Sign every transaction of a build with `signer` and submit in order (testnet automation). */
  signAndSubmit(built: BuildResult, signer: Signer, log?: (m: string) => void): Promise<SequenceResult> {
    return signAndSubmit(this.net, built, signer, log);
  }

  // ---- faucet -----------------------------------------------------------------------------------------------------
  /** POST <appUrl>/api/faucet {address}: the app sends LBOND (and authorizes the trustline), USDC and the receipt. */
  static async faucetClaim(appUrl: string, address: string): Promise<{ ok: boolean; results?: { role: string; code: string; amount: string; status: string; hash?: string; message?: string }[]; error?: string; status: number }> {
    const res = await fetch(`${appUrl.replace(/\/+$/, "")}/api/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ address }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; results?: never[]; error?: string };
    return { ...j, status: res.status };
  }
}

export { MIN_BIN, MAX_BIN, assetKey, sameAsset, sameHorizonAsset };
export type { xdr };
