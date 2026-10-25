import { AppClient } from "@/components/AppClient";
import { loadConfig } from "@/lib/config";

// Config is read from ../deployments at request time so a fresh deploy shows up without a rebuild.
export const dynamic = "force-dynamic";

export default function AppPage() {
  const config = loadConfig();
  return <AppClient config={config} />;
}
