// "How it works" diagram, kept deliberately short: one range order, waiting on the Lotus pool or on the SDEX,
// and with yield on, backed by DeFindex through the Lotus vault. Pure inline SVG (no client JS).
//
// Two layouts swapped with CSS: wide (>= sm, 920 x 380) and phone (< sm, 360 wide).
// Animated pink dashes use the `.flow-line` class from globals.css (dash pattern + keyframes).
// Asset codes (base, quote) come from the deployment config, never hard-coded here.

const PINK = "#F3B1CE";
const LINE = "rgba(255,255,255,0.14)";
const FONT = "var(--font-inter), Inter, system-ui, sans-serif";

type Codes = { receipt: string; base: string; quote: string };

type NodeProps = {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  logo?: string;
  accent?: boolean;
  titleSize?: number;
  subSize?: number;
};

function Node({ x, y, w, h, title, sub, logo, accent, titleSize = 17, subSize = 12 }: NodeProps) {
  const L = Math.round(h * 0.46);
  // with a logo, the logo and the text block are centred together
  const textW = Math.max(title.length * titleSize * 0.56, sub.length * subSize * 0.52);
  const gap = 12;
  const left = logo ? x + (w - (L + gap + textW)) / 2 : 0;
  const tx = logo ? left + L + gap : x + w / 2;
  const anchor = logo ? "start" : "middle";
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
      {logo && <image href={logo} x={left} y={y + (h - L) / 2} width={L} height={L} />}
      <text x={tx} y={y + h / 2 - 3} textAnchor={anchor} fill="#e8eef4" fontSize={titleSize} fontWeight={500} fontFamily={FONT}>
        {title}
      </text>
      <text x={tx} y={y + h / 2 + 15} textAnchor={anchor} fill="rgba(255,255,255,0.42)" fontSize={subSize} fontFamily={FONT}>
        {sub}
      </text>
    </g>
  );
}

function Edge({ d, marker, optional = false }: { d: string; marker: string; optional?: boolean }) {
  return (
    <path
      d={d}
      fill="none"
      stroke={PINK}
      strokeWidth={2}
      strokeLinecap="round"
      className={optional ? undefined : "flow-line"}
      strokeDasharray={optional ? "4 7" : undefined}
      strokeOpacity={optional ? 0.6 : 1}
      markerEnd={`url(#${marker})`}
    />
  );
}

function Label({ x, y, text, size = 13 }: { x: number; y: number; text: string; size?: number }) {
  return (
    <text x={x} y={y} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize={size} fontFamily={FONT}>
      {text}
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

function ariaText({ base, quote }: Codes) {
  return (
    `Diagram: one range order, selling ${base} across a range or holding ${quote} to buy it, waits either on the Lotus pool ` +
    `or on the Stellar DEX. With yield on, it is fully backed by DeFindex through the Lotus vault.`
  );
}

const POOL_LOGO = "/tokens/lotus-pool.svg";
const SDEX_LOGO = "/tokens/xlm.svg";

function Wide(codes: Codes) {
  const { base, quote } = codes;
  const m = "arrow-wide";
  const C = 460;
  const PC = 270;
  const SC = 650;
  const W = 250;
  const H = 72;
  const yOrder = 10;
  const yVenue = 150;
  const yVault = 290;

  return (
    <svg viewBox="0 0 920 380" className="hidden h-auto w-full sm:block" role="img" aria-label={ariaText(codes)}>
      <title>How Lotus works</title>
      <Defs id={m} />

      <Edge marker={m} d={`M${C - 40} ${yOrder + H} C${C - 40} ${yOrder + H + 40}, ${PC} ${yVenue - 40}, ${PC} ${yVenue - 2}`} />
      <Edge marker={m} d={`M${C + 40} ${yOrder + H} C${C + 40} ${yOrder + H + 40}, ${SC} ${yVenue - 40}, ${SC} ${yVenue - 2}`} />
      <Label x={C} y={(yOrder + H + yVenue) / 2 + 8} text="choose where it waits" />

      <Edge optional marker={m} d={`M${PC} ${yVenue + H} C${PC} ${yVenue + H + 40}, ${C - 40} ${yVault - 40}, ${C - 40} ${yVault - 2}`} />
      <Edge optional marker={m} d={`M${SC} ${yVenue + H} C${SC} ${yVenue + H + 40}, ${C + 40} ${yVault - 40}, ${C + 40} ${yVault - 2}`} />
      <Label x={C} y={(yVenue + H + yVault) / 2 + 8} text="earn yield, optional" />

      <Node x={C - 150} y={yOrder} w={300} h={H} title="One range order" sub={`sell ${base} over a range, or ${quote} to buy it`} accent />
      <Node x={PC - W / 2} y={yVenue} w={W} h={H} logo={POOL_LOGO} title="Lotus pool" sub="Soroban range pool" accent />
      <Node x={SC - W / 2} y={yVenue} w={W} h={H} logo={SDEX_LOGO} title="Stellar DEX" sub="one offer per bin" />
      <Node x={C - 150} y={yVault} w={300} h={H} title="Lotus vault" sub="fully backed by DeFindex" accent />
    </svg>
  );
}

function Phone(codes: Codes) {
  const { base, quote } = codes;
  const m = "arrow-phone";
  const H = 60;
  const W = 166;
  const xs = [8, 186];
  const yOrder = 4;
  const yVenue = 124;
  const yVault = 244;

  return (
    <svg viewBox="0 0 360 310" className="h-auto w-full sm:hidden" role="img" aria-label={ariaText(codes)}>
      <title>How Lotus works</title>
      <Defs id={m} />

      <Edge marker={m} d={`M150 ${yOrder + H} C150 ${yOrder + H + 24}, ${xs[0] + W / 2} ${yVenue - 24}, ${xs[0] + W / 2} ${yVenue - 2}`} />
      <Edge marker={m} d={`M210 ${yOrder + H} C210 ${yOrder + H + 24}, ${xs[1] + W / 2} ${yVenue - 24}, ${xs[1] + W / 2} ${yVenue - 2}`} />
      <Label x={180} y={(yOrder + H + yVenue) / 2 + 5} text="where it waits" size={11} />

      <Edge optional marker={m} d={`M${xs[0] + W / 2} ${yVenue + H} C${xs[0] + W / 2} ${yVenue + H + 24}, 150 ${yVault - 24}, 150 ${yVault - 2}`} />
      <Edge optional marker={m} d={`M${xs[1] + W / 2} ${yVenue + H} C${xs[1] + W / 2} ${yVenue + H + 24}, 210 ${yVault - 24}, 210 ${yVault - 2}`} />
      <Label x={180} y={(yVenue + H + yVault) / 2 + 5} text="yield, optional" size={11} />

      <Node x={8} y={yOrder} w={344} h={H} title="One range order" sub={`sell ${base} over a range, or ${quote} to buy it`} accent titleSize={15} subSize={11} />
      <Node x={xs[0]} y={yVenue} w={W} h={H} logo={POOL_LOGO} title="Lotus pool" sub="range pool" accent titleSize={14} subSize={11} />
      <Node x={xs[1]} y={yVenue} w={W} h={H} logo={SDEX_LOGO} title="Stellar DEX" sub="orderbook" titleSize={14} subSize={11} />
      <Node x={8} y={yVault} w={344} h={H} title="Lotus vault" sub="fully backed by DeFindex" accent titleSize={15} subSize={11} />
    </svg>
  );
}

export function HowDiagram({ receipt, base, quote }: Codes) {
  return (
    <div className="how-diagram">
      <style>{`@media (prefers-reduced-motion: reduce){.how-diagram .flow-line{animation:none}}`}</style>
      <Wide receipt={receipt} base={base} quote={quote} />
      <Phone receipt={receipt} base={base} quote={quote} />
    </div>
  );
}
