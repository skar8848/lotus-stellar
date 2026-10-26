import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PoolsClient } from "@/components/pools/PoolsClient";

export const metadata = { title: "Pools: new position, Lotus pool or Stellar DEX, with or without Blend yield" };

// The receipt (vault) is no longer a page of its own: it is how "Stellar DEX + Blend yield" earns, and receipts are
// redeemed from /portfolio. Old /pools?tab=vault links land there.
export default async function PoolsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const tab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  if (tab === "vault") redirect("/portfolio#receipts");
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 text-sm text-mutedfg sm:px-6">Loading pools...</main>}>
      <PoolsClient />
    </Suspense>
  );
}
