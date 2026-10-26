// Small box-and-arrow diagrams for the scroll story (CoinStory), one per coin face. Pure inline SVG,
// same vocabulary as the old "how it works" diagram: pink outline = Lotus contract or asset, grey = Stellar
// or partner protocol, animated pink dashes (`.flow-line`, globals.css) = funds moving, static dashes = optional.

const PINK = "#F3B1CE";
const LINE = "rgba(255,255,255,0.14)";
const FONT = "var(--font-inter), Inter, system-ui, sans-serif";

type NodeProps = { x: number; y: number; w: number; h?: number; title: string; sub: string; logo?: string; accent?: boolean };

function Node({ x, y, w, h = 60, title, sub, logo, accent }: NodeProps) {
  const L = 26;
  const tx = logo ? x + 16 + L + 10 : x + w / 2;
  const anchor = logo ? "start" : "middle";
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={12}
        fill={accent ? "rgba(243,177,206,0.06)" : "#0a0a0a"}
        stroke={accent ? "rgba(243,177,206,0.55)" : LINE}
        strokeWidth={accent ? 1.5 : 1}
      />
      {logo && <image href={logo} x={x + 16} y={y + (h - L) / 2} width={L} height={L} />}
      <text x={tx} y={y + h / 2 - 2} textAnchor={anchor} fill="#e8eef4" fontSize={15} fontWeight={500} fontFamily={FONT}>
        {title}
      </text>
      <text x={tx} y={y + h / 2 + 15} textAnchor={anchor} fill="rgba(255,255,255,0.42)" fontSize={11} fontFamily={FONT}>
        {sub}
      </text>
    </g>
  );
}

function Edge({ d, id, optional = false }: { d: string; id: string; optional?: boolean }) {
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
      markerEnd={`url(#${id})`}
    />
  );
}

function Label({ x, y, text, anchor = "middle" }: { x: number; y: number; text: string; anchor?: "start" | "middle" | "end" }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill="rgba(255,255,255,0.5)" fontSize={11} fontFamily={FONT}>
      {text}
    </text>
  );
}

function Svg({ id, h, label, children }: { id: string; h: number; label: string; children: React.ReactNode }) {
  return (
    <svg viewBox={`0 0 600 ${h}`} className="mt-7 h-auto w-full max-w-xl" role="img" aria-label={label}>
      <defs>
        <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M1 1 L9 5 L1 9 Z" fill={PINK} />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

/** one range order, waiting on the Lotus pool or on the SDEX */
export function OrderDiagram({ base, quote }: { base: string; quote: string }) {
  const id = "coin-arrow-order";
  return (
    <Svg id={id} h={196} label={`One range order, selling ${base} or buying it with ${quote}, waits on the Lotus pool or on the Stellar DEX.`}>
      <Edge id={id} d="M270 62 C270 100, 150 96, 150 132" />
      <Edge id={id} d="M330 62 C330 100, 450 96, 450 132" />
      <Label x={300} y={104} text="choose where it waits" />
      <Node x={150} y={2} w={300} title="One range order" sub={`sell ${base} over a range, or ${quote} to buy it`} accent />
      <Node x={30} y={134} w={240} logo="/tokens/lotus-pool.svg" title="Lotus pool" sub="Soroban range pool" accent />
      <Node x={330} y={134} w={240} logo="/tokens/xlm.svg" title="Stellar DEX" sub="one offer per bin" />
    </Svg>
  );
}

/** idle receipt: USDC in, receipt minted 1:1, used in SDEX offers, redeemed 1:1 */
export function ReceiptDiagram({ quote, idle }: { quote: string; idle: string }) {
  const id = "coin-arrow-idle";
  return (
    <Svg id={id} h={150} label={`${quote} is deposited in the Lotus vault, which mints ${idle} 1:1 for SDEX offers; ${idle} redeems 1:1 for ${quote}.`}>
      <Edge id={id} d="M152 32 H222" />
      <Label x={187} y={22} text="deposit" />
      <Edge id={id} d="M377 32 H447" />
      <Label x={412} y={22} text="mint 1:1" />
      <Edge id={id} optional d="M525 64 C525 128, 75 128, 75 66" />
      <Label x={300} y={142} text={`redeem 1:1 for ${quote}`} />
      <Node x={0} y={2} w={150} logo="/tokens/usdc.png" title={quote} sub="your wallet" />
      <Node x={225} y={2} w={150} title="Lotus vault" sub={`mints ${idle}`} accent />
      <Node x={450} y={2} w={150} logo="/tokens/lusdc.svg" title={idle} sub="in SDEX offers" accent />
    </Svg>
  );
}

/** yield-bearing receipt: the vault's USDC goes through DeFindex into Blend, the receipt keeps earning in offers */
export function EarningDiagram({ quote, earning }: { quote: string; earning: string }) {
  const id = "coin-arrow-earn";
  return (
    <Svg
      id={id}
      h={176}
      label={`${quote} is deposited in the Lotus vault, which mints ${earning} 1:1 and puts the ${quote} in a DeFindex strategy that lends on Blend. ${earning} keeps earning inside SDEX offers.`}
    >
      <Edge id={id} d="M152 32 H222" />
      <Label x={187} y={22} text="deposit" />
      <Edge id={id} d="M377 32 H447" />
      <Label x={412} y={22} text="mint 1:1" />
      <Edge id={id} d="M300 64 V112" />
      <Label x={310} y={92} text="deposits" anchor="start" />
      <Edge id={id} d="M377 144 H447" />
      <Label x={412} y={134} text="lends" />
      <Edge id={id} optional d="M525 112 V66" />
      <Label x={535} y={92} text="yield" anchor="start" />
      <Node x={0} y={2} w={150} logo="/tokens/usdc.png" title={quote} sub="your wallet" />
      <Node x={225} y={2} w={150} title="Lotus vault" sub={`mints ${earning}`} accent />
      <Node x={450} y={2} w={150} logo="/tokens/lusdcb.svg" title={earning} sub="earns in offers" accent />
      <Node x={225} y={114} w={150} title="DeFindex" sub="yield strategy" />
      <Node x={450} y={114} w={150} title="Blend" sub="lending pool" />
    </Svg>
  );
}
