import { Suspense } from "react";
import { TradeClient } from "@/components/trade/TradeClient";

export const metadata = { title: "Trade: Lotus on the SDEX" };

export default function TradePage() {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 text-sm text-mutedfg sm:px-6">Loading market...</main>}>
      <TradeClient />
    </Suspense>
  );
}
