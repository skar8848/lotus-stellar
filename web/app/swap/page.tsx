import { Suspense } from "react";
import { SwapClient } from "@/components/swap/SwapClient";

export const metadata = { title: "Swap: Lotus pool" };

// The previous front's order screen (owl/web app/lite + app/pro, components/app/LimitScreen.tsx) as one page:
// Lite (swap against the directional Lotus pool, or a one-price limit order) and Pro (?mode=pro: the range order
// over the liquidity chart), switched in place by the Lite / Pro pill.
export default function SwapPage() {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 text-sm text-mutedfg sm:px-6">Loading...</main>}>
      <SwapClient />
    </Suspense>
  );
}
