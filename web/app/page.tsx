import Link from "next/link";
import { HeroVideo } from "@/components/landing/HeroVideo";
import { CoinStory } from "@/components/landing/CoinStory";
import { loadConfig } from "@/lib/config";

// the deployment files decide which receipt is live (lUSDC on the idle v1 vault, lUSDCb on the Blend-backed v2)
export const dynamic = "force-dynamic";

type Codes = { r: string; base: string; quote: string };

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

export default function Landing() {
  const cfg = loadConfig();
  const receipt = cfg.receipt.code;
  const codes: Codes = { r: receipt, base: cfg.rwa.code, quote: cfg.underlying.code };
  // the idle receipt (v1) and the Blend-backed one (v2), named from the strategies file
  const idle = cfg.strategies.find((s) => s.status === "idle")?.receipt.code ?? "lUSDC";
  const earning = cfg.strategies.find((s) => s.status === "live")?.receipt.code ?? receipt;
  const WHY = why(codes);
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
            <p className="mt-5 max-w-md text-xl leading-snug text-white/85 sm:text-2xl">
              Liquidity that{" "}
              <span className="underline decoration-[#F3B1CE] decoration-2 underline-offset-[6px]">earns while it waits</span>.
            </p>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/55 sm:text-base">
              Resting liquidity sits idle, and market makers are rarely paid enough to provide it. Lotus is a new kind of pool
              built for them: post directional range orders, let the idle side earn through DeFindex strategies designed for resting
              liquidity, and keep trading on the Stellar DEX while your portfolio works.
            </p>
            <div className="mt-14 flex w-fit flex-col items-center gap-3 sm:mt-20">
              <Link
                href="/swap"
                className="group inline-flex items-center gap-2.5 rounded-full bg-white px-8 py-4 text-lg font-medium text-black transition-transform hover:scale-[1.02]"
              >
                Launch the app
                <span className="transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
              <p className="text-xs text-white/30">Stellar testnet demo.</p>
            </div>
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
      <CoinStory base={codes.base} quote={codes.quote} idle={idle} earning={earning} />

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

      {/* ─────────────────────────────  ABOUT  ──────────────────────────── */}
      <section id="about" className="scroll-mt-24 border-t border-white/[0.06] px-4 py-20 sm:px-10 lg:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <span className="text-[11px] uppercase tracking-[0.34em] text-white/40">About me</span>
          <h2 className="mt-5 font-[family-name:var(--font-audiowide)] text-3xl sm:text-4xl">Alban</h2>
          <div className="mt-6 flex flex-col items-center gap-2 text-[15px] text-white/55 sm:text-base">
            <p>VP DeVinci Blockchain</p>
            <p>Data &amp; Research @ KPK</p>
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
