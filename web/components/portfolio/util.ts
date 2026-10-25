import { findBalance, type AssetRef, type HorizonAccount, type HorizonBalance } from "@/lib/stellar";

/** Balance line of an asset in a Horizon account, undefined when there is no trustline. */
export const findBal = (acct: HorizonAccount | null | undefined, asset: AssetRef): HorizonBalance | undefined =>
  asset.issuer ? findBalance(acct, asset) : acct?.balances.find((b) => b.asset_type === "native");

/** Display amount for balances and values: 2 fixed decimals, but tiny non-zero amounts keep up to 7 so they never read as 0. */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (n === 0) return "0.00";
  const abs = Math.abs(n);
  if (abs < 0.01) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 7 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
