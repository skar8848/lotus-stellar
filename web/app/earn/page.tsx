import { redirect } from "next/navigation";

// /earn became the "Vault & receipt (lUSDC)" tab of /pools. Keep old links (and ?strategy=) working.
export default async function EarnRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "vault" });
  const strategy = Array.isArray(sp.strategy) ? sp.strategy[0] : sp.strategy;
  if (strategy) q.set("strategy", strategy);
  redirect(`/pools?${q.toString()}`);
}
