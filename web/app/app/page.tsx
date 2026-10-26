import { redirect } from "next/navigation";

// The old single-page app lives on as /trade (SDEX front), /pools (range pool + vault) and /portfolio.
export default function AppRedirect() {
  redirect("/swap");
}
