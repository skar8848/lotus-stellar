import { redirect } from "next/navigation";

// /earn (the nav "Earn" entry) lands on /pools, where the yield strategies are chosen as the last step of a new
// position. Old vault links (/earn?strategy=...) pointed at the receipt deposit / redeem page, which is gone: held
// receipts are redeemed from /portfolio.
export default async function EarnRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  if (sp.strategy) redirect("/portfolio#receipts");
  redirect("/pools");
}
