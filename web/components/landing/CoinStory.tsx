"use client";

// "How it works" as a scroll story: a round coin stays pinned while the section scrolls, and flips from the
// Lotus logo to the idle receipt, then to the yield-bearing receipt. Each face comes with a short text and a
// small diagram (CoinDiagrams). The coin has two faces (backface-visibility hidden); the face that is about to turn into
// view is swapped to the next logo while it is hidden.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EarningDiagram, OrderDiagram, ReceiptDiagram } from "./CoinDiagrams";

type Step = { logo: string; kicker: string; title: string; body: string; diagram: ReactNode; note?: string };

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
// share of each step spent flipping to the next one (the rest holds the face still)
const FLIP = 0.35;
// extra scroll (in vh) on the last step before the next section
const HOLD = 70;

export function CoinStory({ base, quote, idle, earning }: { base: string; quote: string; idle: string; earning: string }) {
  const steps: Step[] = [
    {
      logo: "/tokens/lotus-pool.svg",
      kicker: "Lotus",
      title: "Trade seamlessly on Lotus",
      body: `One-way range orders: sell ${base} across a price range, or leave ${quote} waiting to buy it. The order fills bin by bin as the price walks through it, on the Lotus pool or on the Stellar DEX, chosen once at creation.`,
      diagram: <OrderDiagram base={base} quote={quote} />,
    },
    {
      logo: "/tokens/lusdc.svg",
      kicker: idle,
      title: `${idle}, ${quote} as a receipt`,
      body: `Provide liquidity on Lotus or the SDEX and lock your position in Lotus' DeFindex vault. You hold ${idle}, 1:1 with ${quote}, and redeem it whenever you want.`,
      diagram: <ReceiptDiagram quote={quote} idle={idle} />,
      note: "Idle on testnet: no lending behind it.",
    },
    {
      logo: "/tokens/lusdcb.svg",
      kicker: earning,
      title: `${earning}, the receipt that earns`,
      body: `Same flow, but the DeFindex strategy lends the ${quote} on Blend: your liquidity earns while it waits, and the yield is paid out to ${earning} holders.`,
      diagram: <EarningDiagram quote={quote} earning={earning} />,
      note: "Blend testnet interest, observed, not a forecast.",
    },
  ];
  const n = steps.length;

  const ref = useRef<HTMLElement>(null);
  const [p, setP] = useState(0); // 0 .. n - 1

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // one viewport of scroll per step; the extra height (HOLD) keeps the last face pinned a little longer
      setP(Math.min(n - 1, Math.max(0, -r.top / window.innerHeight)));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [n]);

  // hold each face, then flip during the last FLIP share of the step
  const k = Math.min(Math.floor(p), n - 1);
  const frac = p - k;
  const turn = k >= n - 1 ? 0 : ease(Math.min(1, Math.max(0, (frac - (1 - FLIP)) / FLIP)));
  const angle = 180 * (k + turn);
  const front = steps[Math.min(n - 1, 2 * Math.round(angle / 360))].logo;
  const back = steps[Math.min(n - 1, 2 * Math.floor(angle / 360) + 1)].logo;
  const active = Math.round(k + turn);

  return (
    <section id="how" ref={ref} className="relative scroll-mt-0 border-t border-white/[0.06]" style={{ height: `${n * 100 + HOLD}vh` }}>
      <div className="sticky top-0 flex h-screen items-center overflow-hidden px-4 sm:px-10">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-6 sm:gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:gap-12">
          {/* coin */}
          <div className="flex justify-center" style={{ perspective: 1200 }}>
            <div
              className="relative size-28 sm:size-56 lg:size-72"
              style={{ transformStyle: "preserve-3d", transform: `rotateY(${angle}deg)` }}
            >
              {[front, back].map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt=""
                  className="absolute inset-0 size-full rounded-full shadow-[0_0_80px_rgba(243,177,206,0.18)]"
                  style={{
                    backfaceVisibility: "hidden",
                    // backface-visibility alone lets the two coplanar faces z-fight: show only the one facing us
                    opacity: (Math.cos((angle * Math.PI) / 180) >= 0) === (i === 0) ? 1 : 0,
                    transform: i ? "rotateY(180deg) translateZ(1px)" : "translateZ(1px)",
                  }}
                />
              ))}
            </div>
          </div>

          {/* text: one block per step, cross-faded */}
          <div className="relative min-h-[460px] sm:min-h-[540px]">
            {steps.map((s, i) => (
              <div
                key={s.kicker}
                aria-hidden={i !== active}
                className="absolute inset-0 text-center transition-all duration-500"
                style={{ opacity: i === active ? 1 : 0, transform: `translateY(${(i - active) * 16}px)`, pointerEvents: i === active ? "auto" : "none" }}
              >
                <span className="text-[11px] uppercase tracking-[0.34em] text-white/40">
                  0{i + 1} · {s.kicker}
                </span>
                <h2 className="mt-4 font-[family-name:var(--font-audiowide)] text-balance text-3xl leading-[1.15] sm:text-4xl">{s.title}</h2>
                <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-white/55 sm:text-base">{s.body}</p>
                {s.diagram}
                {s.note && <p className="mt-4 text-xs text-white/30">{s.note}</p>}
              </div>
            ))}
          </div>
        </div>

        {/* progress dots */}
        <div className="absolute right-8 top-1/2 hidden -translate-y-1/2 flex-col gap-2 sm:flex">
          {steps.map((s, i) => (
            <span key={s.kicker} className={`size-1.5 rounded-full transition-colors ${i === active ? "bg-[#F3B1CE]" : "bg-white/20"}`} />
          ))}
        </div>
      </div>
    </section>
  );
}
