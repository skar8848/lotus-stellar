import { Suspense } from "react";
import { PoolsClient } from "@/components/pools/PoolsClient";

export const metadata = { title: "Pools: Lotus range pool and vault" };

export default function PoolsPage() {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 text-sm text-mutedfg sm:px-6">Loading pools...</main>}>
      <PoolsClient />
    </Suspense>
  );
}
