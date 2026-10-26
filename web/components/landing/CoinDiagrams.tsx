// Small box-and-arrow diagrams for the scroll story (CoinStory), one per coin face. Pure inline SVG,
// same vocabulary as the old "how it works" diagram: pink outline = Lotus contract or asset, grey = Stellar
// or partner protocol, animated pink dashes (`.flow-line`, globals.css) = funds moving, static dashes = optional.

const PINK = "#F3B1CE";
const LINE = "rgba(255,255,255,0.14)";
const FONT = "var(--font-inter), Inter, system-ui, sans-serif";

type NodeProps = { x: number; y: number; w: number; h?: number; title: string; sub: string; logo?: string | string[]; accent?: boolean };

function Node({ x, y, w, h = 60, title, sub, logo, accent }: NodeProps) {
  const L = 26;
  // several logos overlap like a token pair
  const logos = logo ? [logo].flat() : [];
  // logo(s) + text are centred as one group in the box (text width estimated from the font sizes)
  const logoW = logos.length ? L + (logos.length - 1) * 20 + 10 : 0;
  const textW = Math.max(title.length * 16 * 0.56, sub.length * 12 * 0.52);
  const left = x + Math.max(14, (w - logoW - textW) / 2);
  const tx = logos.length ? left + logoW : x + w / 2;
  const anchor = logos.length ? "start" : "middle";
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
      {logos.map((src, i) => (
        <image key={src} href={src} x={left + i * 20} y={y + (h - L) / 2} width={L} height={L} />
      ))}
      <text x={tx} y={y + h / 2 - 2} textAnchor={anchor} fill="#e8eef4" fontSize={16} fontWeight={500} fontFamily={FONT}>
        {title}
      </text>
      <text x={tx} y={y + h / 2 + 15} textAnchor={anchor} fill="rgba(255,255,255,0.45)" fontSize={12} fontFamily={FONT}>
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
    <text x={x} y={y} textAnchor={anchor} fill="rgba(255,255,255,0.55)" fontSize={12} fontFamily={FONT}>
      {text}
    </text>
  );
}

function Svg({ id, h, label, children }: { id: string; h: number; label: string; children: React.ReactNode }) {
  return (
    <svg viewBox={`0 0 600 ${h}`} className="mx-auto mt-8 h-auto w-full max-w-2xl" role="img" aria-label={label}>
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
    <Svg id={id} h={208} label={`One range order, selling ${base} or buying it with ${quote}, waits on the Lotus pool or on the Stellar DEX.`}>
      <Edge id={id} d="M300 62 V92 H130 V144" />
      <Edge id={id} d="M300 92 H470 V144" />
      <Label x={300} y={122} text="choose where it waits" />
      <Node x={150} y={2} w={300} title="One range order" sub={`sell ${base} over a range, or ${quote} to buy it`} accent />
      <Node x={0} y={146} w={260} logo="/tokens/lotus-pool.svg" title="Lotus pool" sub="Soroban range pool" accent />
      <Node x={340} y={146} w={260} logo="/tokens/xlm.svg" title="Stellar DEX" sub="native orderbook" />
    </Svg>
  );
}

const VENUES = ["/tokens/lotus-pool.svg", "/tokens/xlm.svg"];

/** buffer receipt: USDC kept unlent in the Lotus DeFindex vault, receipt minted 1:1, for near-price orders and working capital */
export function ReceiptDiagram({ quote, idle }: { quote: string; idle: string }) {
  const id = "coin-arrow-idle";
  return (
    <Svg
      id={id}
      h={214}
      label={`${quote} sits unlent in the Lotus DeFindex vault, which mints ${idle} 1:1. ${idle} is an instant buffer for orders close to the price and for working capital, and redeems 1:1 for ${quote}.`}
    >
      <Edge id={id} optional d="M525 40 V20 H75 V38" />
      <Label x={300} y={13} text={`redeem 1:1 for ${quote}, instantly`} />
      <Edge id={id} d="M152 72 H222" />
      <Label x={187} y={62} text="deposit" />
      <Edge id={id} d="M377 72 H447" />
      <Label x={412} y={62} text="mint 1:1" />
      <Edge id={id} d="M525 104 V128 H300 V150" />
      <Edge id={id} d="M525 128 V150" />
      <Node x={0} y={42} w={150} logo="/tokens/usdc.png" title={quote} sub="your wallet" />
      <Node x={225} y={42} w={150} title="Lotus vault" sub="unlent in DeFindex" accent />
      <Node x={450} y={42} w={150} logo="/tokens/lusdc.svg" title={idle} sub="instant buffer" accent />
      <Node x={210} y={152} w={180} title="Near-price orders" sub="about to fill" />
      <Node x={420} y={152} w={180} title="Working capital" sub="always withdrawable" />
    </Svg>
  );
}

/** yield-bearing receipt: same flow, the DeFindex strategy lends on Blend and the liquidity keeps earning */
export function EarningDiagram({ quote, earning }: { quote: string; earning: string }) {
  const id = "coin-arrow-earn";
  return (
    <Svg
      id={id}
      h={176}
      label={`${quote} is locked in the Lotus vault, which mints ${earning} 1:1 and puts the ${quote} in a DeFindex strategy that lends on Blend. ${earning} provides liquidity on the Lotus pool or the Stellar DEX and keeps earning.`}
    >
      <Edge id={id} d="M152 32 H222" />
      <Label x={187} y={22} text="deposit" />
      <Edge id={id} d="M377 32 H447" />
      <Label x={412} y={22} text="mint 1:1" />
      <Edge id={id} d="M300 64 V112" />
      <Label x={310} y={92} text="locks" anchor="start" />
      <Edge id={id} d="M223 144 H153" />
      <Label x={188} y={134} text="lends" />
      <Edge id={id} d="M525 64 V112" />
      <Label x={515} y={92} text="provide liquidity" anchor="end" />
      <Edge id={id} optional d="M377 144 H408" />
      <Label x={392} y={134} text="yield" />
      <Node x={0} y={2} w={150} logo="/tokens/usdc.png" title={quote} sub="your wallet" />
      <Node x={225} y={2} w={150} title="Lotus vault" sub={`mints ${earning}`} accent />
      <Node x={450} y={2} w={150} logo="/tokens/lusdcb.svg" title={earning} sub="1:1, earning" accent />
      <Node x={0} y={114} w={150} title="Blend" sub="lending pool" />
      <Node x={225} y={114} w={150} title="DeFindex" sub="yield strategy" />
      <Node x={410} y={114} w={190} logo={VENUES} title="Lotus or SDEX" sub="your orders earn" />
    </Svg>
  );
}
