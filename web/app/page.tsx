import Link from "next/link";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function Landing() {
  const cfg = loadConfig();
  const u = cfg.underlying.issuer ? cfg.underlying.code : "XLM";
  const r = cfg.receipt.code;
  const rwa = cfg.rwa.code;

  const cards = [
    {
      k: "01",
      title: "Deposit, earn",
      body: `Deposit ${u}, receive ${r} 1:1. The ${u} is lent on Blend through a DeFindex vault and the yield is minted to ${r} holders pro-rata.`,
    },
    {
      k: "02",
      title: "Trade it on SDEX",
      body: `Quote ${rwa}/${r} on Stellar's native orderbook. An offer only sets a selling liability: the ${r} never leaves your account, so it keeps earning while it sits in the book.`,
    },
    {
      k: "03",
      title: "Regulated RWAs",
      body: `${rwa} is a tokenized bond with AUTH_REQUIRED and CLAWBACK: the issuer authorizes every holder. A taker with plain ${u} buys it in one path payment, ${u} → ${r} → ${rwa}.`,
    },
  ];

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between px-4 sm:px-8">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-6 w-6" />
          <span className="wordmark text-base leading-none">LOTUS</span>
        </div>
        <Link href="/app" className="btn btn-sm">
          Open app
        </Link>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
        <p className="label mb-6">Stellar · {cfg.network}</p>
        <h1 className="wordmark text-5xl leading-none sm:text-7xl md:text-8xl">LOTUS</h1>
        <p className="mt-6 max-w-xl text-balance text-lg text-muted-fg sm:text-xl">Yield-bearing liquidity for Stellar&apos;s orderbook.</p>
        <p className="mt-2 max-w-lg text-balance text-sm text-muted">
          A receipt token that earns Blend yield and lives on the SDEX. Offers keep earning while they wait.
        </p>
        <Link href="/app" className="btn btn-primary mt-8 px-5 py-2.5">
          Open app
        </Link>

        <div className="mt-16 grid w-full max-w-5xl gap-3 text-left sm:grid-cols-3">
          {cards.map((c) => (
            <div key={c.k} className="card p-5">
              <div className="label">{c.k}</div>
              <h2 className="mt-2 text-sm font-semibold">{c.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-fg">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-2 px-4 py-6 text-[11px] text-muted sm:px-8">
        <span>Soroban vault · classic receipt asset · SDEX · path payments</span>
        <span>HackMeridian</span>
      </footer>
    </main>
  );
}
