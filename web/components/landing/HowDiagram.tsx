// "How it works" diagram: one receipt, two venues. Pure inline SVG (no client JS).
//
// Two layouts share the same vocabulary and are swapped with CSS:
//   - wide  (>= sm): one connected graph, 920 x 400 viewBox
//   - phone (< sm) : four short left-to-right "sentences", 360 wide, so the text stays readable
//
// Animated pink dashes use the `.flow-line` class from globals.css (dash pattern + keyframes).
// Facts drawn here: the Lotus vault mints lUSDC from USDC and deposits into a DeFindex vault that
// lends on Blend when the strategy allocates there; lUSDC trades against LBOND on the SDEX; the
// Lotus pool is a separate Soroban range pool on LBOND/USDC whose USDC leg can sit in DeFindex.

import type { ReactNode } from "react";

const PINK = "#F3B1CE";
const LINE = "rgba(255,255,255,0.14)";
const FONT = "var(--font-inter), Inter, system-ui, sans-serif";

type NodeProps = {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  /** Lotus-owned contract or asset: pink outline */
  accent?: boolean;
  titleSize?: number;
  subSize?: number;
};

function Node({ x, y, w, h, title, sub, accent, titleSize = 17, subSize = 12 }: NodeProps) {
  const cx = x + w / 2;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={14}
        fill={accent ? "rgba(243,177,206,0.06)" : "#0a0a0a"}
        stroke={accent ? "rgba(243,177,206,0.55)" : LINE}
        strokeWidth={accent ? 1.5 : 1}
      />
      <text x={cx} y={y + h / 2 - 3} textAnchor="middle" fill="#e8eef4" fontSize={titleSize} fontWeight={500} fontFamily={FONT}>
        {title}
      </text>
      <text x={cx} y={y + h / 2 + 15} textAnchor="middle" fill="rgba(255,255,255,0.42)" fontSize={subSize} fontFamily={FONT}>
        {sub}
      </text>
    </g>
  );
}

type EdgeProps = {
  d: string;
  /** arrow on the end / on the start of the path */
  end?: boolean;
  start?: boolean;
  /** optional edge: static, dimmer dashes instead of the animated flow */
  optional?: boolean;
  marker: string;
};

function Edge({ d, end = true, start = false, optional = false, marker }: EdgeProps) {
  return (
    <path
      d={d}
      fill="none"
      stroke={PINK}
      strokeWidth={2}
      strokeLinecap="round"
      className={optional ? undefined : "flow-line"}
      strokeDasharray={optional ? "4 7" : undefined}
      strokeOpacity={optional ? 0.5 : 1}
      markerEnd={end ? `url(#${marker})` : undefined}
      markerStart={start ? `url(#${marker})` : undefined}
    />
  );
}

function Label({ x, y, children, anchor = "start", size = 12 }: { x: number; y: number; children: ReactNode; anchor?: "start" | "middle" | "end"; size?: number }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill="rgba(255,255,255,0.5)" fontSize={size} fontFamily={FONT}>
      {children}
    </text>
  );
}

function Defs({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M1 1 L9 5 L1 9 Z" fill={PINK} />
      </marker>
    </defs>
  );
}

function Wide({ receipt }: { receipt: string }) {
  // columns (w = 170) and rows (h = 64)
  const W = 170;
  const H = 64;
  const c = [10, 255, 500, 745];
  const r = [20, 168, 316];
  const cx = (i: number) => c[i] + W / 2;
  const cy = (j: number) => r[j] + H / 2;
  const m = "arrow-wide";
  return (
    <svg viewBox="0 0 920 400" className="hidden h-auto w-full sm:block" role="img" aria-label={`Diagram: USDC goes into the Lotus vault, which deposits into a DeFindex vault that lends on Blend and mints the ${receipt} receipt. ${receipt} trades against LBOND on the SDEX orderbook. The Lotus pool is a separate range pool on LBOND and USDC.`}>
      <title>How Lotus works</title>
      <Defs id={m} />

      {/* row 1: the vault */}
      <Edge marker={m} d={`M${c[0] + W} ${cy(0)} H${c[1] - 2}`} />
      <Edge marker={m} d={`M${c[1] + W} ${cy(0)} H${c[2] - 2}`} />
      <Edge marker={m} d={`M${c[2] + W} ${cy(0)} H${c[3] - 2}`} />
      <Label x={(c[0] + W + c[1]) / 2} y={cy(0) - 10} anchor="middle">deposit</Label>
      <Label x={(c[2] + W + c[3]) / 2} y={cy(0) - 10} anchor="middle">lends*</Label>

      {/* vault -> lUSDC -> SDEX */}
      <Edge marker={m} d={`M${cx(1)} ${r[0] + H} V${r[1] - 2}`} />
      <Label x={cx(1) + 12} y={(r[0] + H + r[1]) / 2 + 4}>mints 1:1</Label>
      <Edge marker={m} d={`M${cx(1)} ${r[1] + H} V${r[2] - 2}`} />
      <Label x={cx(1) + 12} y={(r[1] + H + r[2]) / 2 + 4}>quote asset</Label>

      {/* pool: optional USDC leg in DeFindex, and LBOND */}
      <Edge marker={m} start optional d={`M${cx(2)} ${r[1] - 2} V${r[0] + H + 2}`} />
      <Label x={cx(2) + 12} y={(r[0] + H + r[1]) / 2 + 4}>pool can park its USDC here</Label>
      <Edge marker={m} start d={`M${cx(2)} ${r[1] + H + 2} V${r[2] - 2}`} />
      <Label x={cx(2) + 12} y={(r[1] + H + r[2]) / 2 + 4}>range liquidity</Label>

      {/* SDEX <-> LBOND */}
      <Edge marker={m} start d={`M${c[1] + W + 2} ${cy(2)} H${c[2] - 2}`} />
      <Label x={(c[1] + W + c[2]) / 2} y={cy(2) - 10} anchor="middle">offers</Label>

      <Node x={c[0]} y={r[0]} w={W} h={H} title="USDC" sub="underlying" />
      <Node x={c[1]} y={r[0]} w={W} h={H} title="Lotus vault" sub="Soroban wrapper" accent />
      <Node x={c[2]} y={r[0]} w={W} h={H} title="DeFindex vault" sub="yield vault" />
      <Node x={c[3]} y={r[0]} w={W} h={H} title="Blend" sub="lending pool" />

      <Node x={c[1]} y={r[1]} w={W} h={H} title={receipt} sub="receipt, classic asset" accent />
      <Node x={c[2]} y={r[1]} w={W} h={H} title="Lotus pool" sub="Soroban range pool" accent />

      <Node x={c[1]} y={r[2]} w={W} h={H} title="SDEX" sub="Stellar orderbook" />
      <Node x={c[2]} y={r[2]} w={W} h={H} title="LBOND" sub="tokenized bond" />

      {/* legend (fills the empty left column and explains the outlines) */}
      <rect x={c[0]} y={r[2] - 6} width={14} height={14} rx={4} fill="rgba(243,177,206,0.06)" stroke="rgba(243,177,206,0.55)" strokeWidth={1.5} />
      <Label x={c[0] + 24} y={r[2] + 5}>Lotus contract or asset</Label>
      <Label x={c[0] + 24} y={r[2] + 29}>Stellar or partner protocol</Label>
      <rect x={c[0]} y={r[2] + 18} width={14} height={14} rx={4} fill="#0a0a0a" stroke={LINE} />
    </svg>
  );
}

function Phone({ receipt }: { receipt: string }) {
  const W = 96;
  const H = 54;
  const xs = [8, 132, 256];
  const rows = [34, 124, 214, 304];
  const m = "arrow-phone";
  const link = (row: number, from: number, to: number, both = false) => (
    <Edge marker={m} start={both} d={`M${xs[from] + W + (both ? 2 : 0)} ${rows[row] + H / 2} H${xs[to] - 2}`} />
  );
  const cap = (row: number, text: string) => (
    <text x={8} y={rows[row] - 12} fill="rgba(255,255,255,0.4)" fontSize={11} letterSpacing={1.4} fontFamily={FONT}>
      {text}
    </text>
  );
  const node = (row: number, col: number, title: string, sub: string, accent = false) => (
    <Node x={xs[col]} y={rows[row]} w={W} h={H} title={title} sub={sub} accent={accent} titleSize={14} subSize={11} />
  );
  return (
    <svg viewBox="0 0 360 372" className="h-auto w-full sm:hidden" role="img" aria-label={`Diagram: USDC goes into the Lotus vault and mints ${receipt}; the vault deposits into a DeFindex vault that lends on Blend; ${receipt} trades against LBOND on the SDEX; the Lotus pool trades LBOND against USDC.`}>
      <title>How Lotus works</title>
      <Defs id={m} />

      {cap(0, "DEPOSIT")}
      {link(0, 0, 1)}
      {link(0, 1, 2)}
      {node(0, 0, "USDC", "underlying")}
      {node(0, 1, "Lotus vault", "Soroban", true)}
      {node(0, 2, receipt, "receipt", true)}

      {cap(1, "YIELD (WHEN ALLOCATED)")}
      {link(1, 0, 1)}
      {link(1, 1, 2)}
      {node(1, 0, "Lotus vault", "Soroban", true)}
      {node(1, 1, "DeFindex", "yield vault")}
      {node(1, 2, "Blend", "lending pool")}

      {cap(2, "VENUE A: SDEX ORDERBOOK")}
      {link(2, 0, 1)}
      {link(2, 1, 2, true)}
      {node(2, 0, receipt, "receipt", true)}
      {node(2, 1, "SDEX", "orderbook")}
      {node(2, 2, "LBOND", "bond")}

      {cap(3, "VENUE B: LOTUS POOL")}
      {link(3, 0, 1, true)}
      {link(3, 1, 2, true)}
      {node(3, 0, "USDC", "quote leg")}
      {node(3, 1, "Lotus pool", "range pool", true)}
      {node(3, 2, "LBOND", "bond")}
    </svg>
  );
}

export function HowDiagram({ receipt = "lUSDC" }: { receipt?: string }) {
  return (
    <div className="how-diagram">
      <style>{`@media (prefers-reduced-motion: reduce){.how-diagram .flow-line{animation:none}}`}</style>
      <Wide receipt={receipt} />
      <Phone receipt={receipt} />
    </div>
  );
}
