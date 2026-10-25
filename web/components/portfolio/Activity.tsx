"use client";

import { Empty, ExplorerLink, Panel } from "@/components/common";
import { cn } from "@/lib/utils";
import type { ActivityData } from "./data";
import { fmtTime } from "./model";

const KIND_TONE = { op: "", fill: "text-green", vault: "text-primary" } as const;

/** Recent activity: Horizon operations, order-book fills and this account's vault deposits and redeems. */
export function Activity({ data, error, network }: { data: ActivityData | null; error: string | null; network: string }) {
  return (
    <Panel
      title="Recent activity"
      subtitle="Operations touching this account, your order-book fills and your Lotus vault deposits and redeems, newest first."
      className="min-w-0"
    >
      <div data-testid="portfolio-activity">
        {error ? (
          <Empty>
            <span className="text-destructive">Activity unavailable: {error}</span>
          </Empty>
        ) : !data ? (
          <Empty>Loading...</Empty>
        ) : data.rows.length === 0 ? (
          <Empty>No activity found for this account.</Empty>
        ) : (
          <ul>
            {data.rows.map((r) => (
              <li key={r.id} className="flex items-start gap-3 border-t border-border py-2 text-xs first:border-t-0" data-testid="activity-row" data-kind={r.kind}>
                <span className="num w-24 shrink-0 pt-px text-mutedfg">{fmtTime(r.time)}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn("break-words font-medium", KIND_TONE[r.kind])}>{r.title}</span>
                  {r.detail ? <span className="block break-words text-[11px] text-mutedfg">{r.detail}</span> : null}
                </span>
                <span className="w-16 shrink-0 text-right">
                  {r.tx ? <ExplorerLink kind="tx" id={r.tx} network={network} label="tx" /> : <span className="text-mutedfg">-</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {data && data.unavailable.length > 0 ? (
          <p className="mt-2 text-[11px] text-mutedfg" data-testid="activity-unavailable">
            Unavailable right now: {data.unavailable.join(", ")}. The rows above come from the sources that answered.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
