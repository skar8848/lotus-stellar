import Link from "next/link";
import { HeroVideo } from "@/components/landing/HeroVideo";
import { HowDiagram } from "@/components/landing/HowDiagram";
import { loadConfig } from "@/lib/config";

// the deployment files decide which receipt is live (lUSDC on the idle v1 vault, lUSDCb on the Blend-backed v2)
export const dynamic = "force-dynamic";

type Codes = { r: string; base: string; quote: string };

const steps = ({ r, base, quote }: Codes) => [
  {
    title: "Create one order",
    body: `Sell ${base} across a price range, or leave ${quote} waiting to buy it. Swap Pro sets a range, Limit sets one price; Pools builds the same order over the live chart.`,
  },
  {
    title: "Choose where it waits",
    body: "Lotus pool: one directional position in the Soroban range pool. Stellar DEX: a ladder of SDEX offers, one per bin, at the same prices. Chosen once, at creation.",
  },
  {
    title: "Earn yield, or not",
    body: `With yield on, the ${quote} leg goes through DeFindex into Blend: on the pool through the vault-backed instance, on the SDEX by quoting in ${r}, minted 1:1 by the Lotus vault and still earning inside open offers.`,
  },
  {
    title: "Takers fill it",
    body: `Takers swap on the Lotus pool, or trade and path-pay on the SDEX. A bot-run arbitrage keeps the two prices aligned, and ${r} redeems 1:1 for ${quote}.`,
  },
];

const why = ({ r, base, quote }: Codes) => [
  {
    title: "Native orderbook",
    body: `Each bin of a range becomes one SDEX offer at the same price. No AMM curve in the middle, and a taker can path-pay ${quote} into ${base} through the book in one transaction.`,
  },
  {
    title: "Offers move nothing",
    body: `An SDEX offer only sets a selling liability: funds stay in your account. The ${r} behind your offers keeps earning until someone takes it.`,
  },
  {
    title: "Soroban next to classic",
    body: `lotus_pool and lotus_vault are Soroban contracts that compose with DeFindex and Blend, while ${base}, ${quote} and ${r} stay classic assets the SDEX can trade.`,
  },
  {
    title: "Regulated assets welcome",
    body: `${base} carries AUTH_REQUIRED, revocable and clawback flags, and still trades on the same orderbook and in the same pool as everything else.`,
  },
];

const try_ = ({ r }: Codes) => [
  { href: "/swap", title: "Swap", body: "Swap on the Lotus pool, or place a Limit or Pro range order." },
  { href: "/pools", title: "Pools", body: "New position: Lotus pool or SDEX, with or without yield." },
  { href: "/trade", title: "Trade", body: "SDEX orderbook: swaps, path payments, limit orders." },
  { href: "/portfolio", title: "Portfolio", body: `Balances, open offers, positions, redeem ${r} 1:1.` },
];

export default function Landing() {
  const cfg = loadConfig();
  const receipt = cfg.receipt.code;
  const codes: Codes = { r: receipt, base: cfg.rwa.code, quote: cfg.underlying.code };
  // real Blend interest only when the active receipt vault is a live strategy (v2); v1 stays idle
  const liveYield = cfg.strategies.some((s) => s.status === "live" && s.lotusVault === cfg.lotusVault);
  const STEPS = steps(codes);
  const WHY = why(codes);
  const TRY = try_(codes);
  return (
    <main className="relative bg-black text-white">
      {/* ─────────────────────────────  HERO  ───────────────────────────── */}
      <section className="relative overflow-hidden">
        {/* top bar */}
        <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-5 sm:px-10 sm:py-6">
          <Link href="/" aria-label="Lotus">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/lotus-logo.svg" alt="Lotus" className="h-9 w-auto sm:h-10" />
          </Link>
          <nav className="flex items-center gap-4 text-[13px] text-white/55 sm:gap-8">
            <Link href="#how" className="hidden transition-colors hover:text-white sm:inline">
              how it works
            </Link>
            <Link href="#why" className="hidden transition-colors hover:text-white sm:inline">
              why Stellar
            </Link>
            <Link
              href="/swap"
              className="rounded-full border border-white/20 px-4 py-1.5 text-white/85 transition-colors hover:border-white/50 hover:text-white"
            >
              Launch app
            </Link>
          </nav>
        </header>

        <div className="grid grid-cols-1 lg:min-h-screen lg:grid-cols-[1fr_1.1fr]">
          {/* left: copy */}
          <div className="relative z-10 flex flex-col justify-center px-4 pb-12 pt-28 sm:px-10 lg:pb-0 lg:pl-16 lg:pr-10 lg:pt-0">
            <h1 className="font-[family-name:var(--font-audiowide)] text-5xl leading-[1.05] tracking-tight sm:text-6xl">Lotus</h1>
            <p className="mt-5 max-w-md text-xl leading-snug text-white/85 sm:text-2xl">Liquidity that earns while it waits.</p>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/55 sm:text-base">
              Resting liquidity sits idle, and market makers are rarely paid enough to provide it. Lotus is a new kind of pool
              built for them: post directional range orders, let the idle side earn Blend yield, and keep trading on the Stellar DEX
              while your portfolio works.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4 sm:mt-14">
              <Link
                href="/swap"
                className="group inline-flex items-center gap-2.5 rounded-full bg-white px-8 py-4 text-lg font-medium text-black transition-transform hover:scale-[1.02]"
              >
                Launch the app
                <span className="transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
            </div>
            <p className="mt-6 text-xs text-white/30">Stellar testnet demo.</p>
          </div>

          {/* right: ascii video (lazy, client-only) */}
          <div className="relative h-[50vh] w-full lg:h-screen">
            <HeroVideo />
            {/* bright white spotlight bleeding from the top-left over the plant */}
            <div className="pointer-events-none absolute left-0 top-0 h-4/5 w-4/5 bg-[radial-gradient(closest-side_at_top_left,rgba(255,253,250,0.2),transparent_72%)] mix-blend-screen" />
            {/* fade the video into the black background: on the left edge when side by side, on top when stacked */}
            <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-40 bg-gradient-to-r from-black to-transparent lg:block" />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black to-transparent lg:hidden" />
          </div>
        </div>
      </section>

      {/* ───────────────────────────  HOW IT WORKS  ─────────────────────── */}
      <section id="how" className="scroll-mt-24 border-t border-white/[0.06] px-4 py-20 sm:px-10 lg:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <span className="text-[11px] uppercase tracking-[0.34em] text-white/40">How it works</span>
          <h2 className="mt-5 font-[family-name:var(--font-audiowide)] text-balance text-3xl leading-[1.15] sm:text-4xl">One order. Four places to wait.</h2>
        </div>

        <div className="mx-auto mt-12 max-w-4xl">
          <HowDiagram receipt={receipt} base={codes.base} quote={codes.quote} />
          <p className="mx-auto mt-4 max-w-2xl text-center text-xs leading-relaxed text-white/35">
            {liveYield
              ? `* Yield is real Blend testnet interest, through our DeFindex vault. The rate follows Blend's testnet utilization: observed, not a forecast. Stellar testnet only.`
              : "* Blend lending applies when the strategy allocates to it. The active testnet vault keeps its funds idle in DeFindex, so no lending interest is assumed. Stellar testnet only."}
          </p>
        </div>

        <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-y-12 text-center sm:grid-cols-2 sm:gap-x-12 lg:grid-cols-4 lg:gap-x-10">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex flex-col items-center">
              <span className="font-[family-name:var(--font-audiowide)] text-sm text-white/30">0{i + 1}</span>
              <h3 className="mt-2 text-lg font-medium text-white">{s.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-white/45">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───────────────────────────  WHY STELLAR  ──────────────────────── */}
      <section id="why" className="scroll-mt-24 border-t border-white/[0.06] px-4 py-20 sm:px-10 lg:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <span className="text-[11px] uppercase tracking-[0.34em] text-white/40">Why Stellar</span>
          <h2 className="mt-5 font-[family-name:var(--font-audiowide)] text-balance text-3xl leading-[1.15] sm:text-4xl">Built for the orderbook</h2>
        </div>
        <div className="mx-auto mt-14 grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {WHY.map((w) => (
            <div key={w.title} className="card p-5">
              <h3 className="text-base font-medium text-white">{w.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-white/45">{w.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─────────────────────────────  TRY IT  ─────────────────────────── */}
      <section className="border-t border-white/[0.06] px-4 py-16 sm:px-10">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <span className="text-[11px] uppercase tracking-[0.34em] text-white/40">Try it</span>
          </div>
          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TRY.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className="group flex items-center justify-between gap-4 rounded-2xl border border-white/10 px-5 py-4 transition-colors hover:border-white/30 hover:bg-white/[0.03]"
              >
                <span className="min-w-0">
                  <span className="block text-base font-medium text-white">{t.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-white/45">{t.body}</span>
                </span>
                <span className="shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5 group-hover:text-white">→</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────────────────────  FOOTER  ─────────────────────────── */}
      <footer className="relative overflow-hidden border-t border-white/[0.06] px-4 pt-20 sm:px-10 sm:pt-24">
        <div className="mx-auto flex max-w-7xl flex-col items-center">
          <nav className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-[13px] text-white/45">
            <Link href="#how" className="transition-colors hover:text-white">
              how it works
            </Link>
            <Link href="#why" className="transition-colors hover:text-white">
              why Stellar
            </Link>
            <Link href="/swap" className="transition-colors hover:text-white">
              swap
            </Link>
            <Link href="/trade" className="transition-colors hover:text-white">
              trade
            </Link>
            <Link href="/pools" className="transition-colors hover:text-white">
              pools
            </Link>
            <Link href="/portfolio" className="transition-colors hover:text-white">
              portfolio
            </Link>
          </nav>
          <p className="mt-8 text-center text-xs text-white/30">Lotus, built for HackMeridian. Stellar testnet.</p>
        </div>

        {/* giant wordmark dissolving into the black: the box is clamped to the glyph height
            and clips the font descent so there is no empty band (no over-scroll) below it */}
        <div className="pointer-events-none mt-10 flex h-[16.5vw] select-none items-end justify-center overflow-hidden">
          <span className="block -translate-y-[0.02em] bg-gradient-to-b from-white/30 to-black bg-clip-text font-[family-name:var(--font-audiowide)] text-[23vw] leading-[0.72] tracking-[0.03em] text-transparent">
            LOTUS
          </span>
        </div>
      </footer>
    </main>
  );
}
