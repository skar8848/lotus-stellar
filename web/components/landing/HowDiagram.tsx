// "How it works" diagram: one order, four places to wait. Pure inline SVG (no client JS).
//
// Two layouts share the same vocabulary and are swapped with CSS:
//   - wide  (>= sm): one connected graph, 920 x 660 viewBox, read top to bottom
//   - phone (< sm) : short stacked "sentences", 360 wide, so the text stays readable
//
// Animated pink dashes use the `.flow-line` class from globals.css (dash pattern + keyframes).
// Facts drawn here: a user creates ONE directional range limit order and chooses, once, at creation,
// where it waits (Lotus pool or Stellar DEX) and whether it earns yield. Pool + yield = the vault-backed
// pool instance, whose USDC leg sits in DeFindex; SDEX + yield = a ladder quoted in the receipt, minted
// 1:1 by the Lotus vault, which deposits into DeFindex. DeFindex lends on Blend. Takers swap on the pool
// or trade / path-pay on the SDEX; a bot-run arbitrage keeps the two prices aligned.
// Asset codes (base, quote, receipt) come from the deployment config, never hard-coded here.

import type { ReactNode } from "react";

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
  /** off-chain or optional link: static, dimmer dashes instead of the animated flow */
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

function Label({
  x,
  y,
  children,
  anchor = "start",
  size = 12,
  fill = "rgba(255,255,255,0.5)",
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end";
  size?: number;
  fill?: string;
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill={fill} fontSize={size} fontFamily={FONT}>
      {children}
    </text>
  );
}

function Caption({ x, y, children, anchor = "start" }: { x: number; y: number; children: ReactNode; anchor?: "start" | "middle" | "end" }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill="rgba(255,255,255,0.4)" fontSize={11} letterSpacing={1.4} fontFamily={FONT}>
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

function Legend({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y - 11} width={14} height={14} rx={4} fill="rgba(243,177,206,0.06)" stroke="rgba(243,177,206,0.55)" strokeWidth={1.5} />
      <Label x={x + 24} y={y}>Lotus contract or asset</Label>
      <rect x={x} y={y + 13} width={14} height={14} rx={4} fill="#0a0a0a" stroke={LINE} />
      <Label x={x + 24} y={y + 24}>Stellar or partner protocol</Label>
    </g>
  );
}

function ariaText({ receipt, base, quote }: Codes) {
  return (
    `Diagram: a user creates one directional range limit order, selling ${base} across a range or holding ${quote} to buy it. ` +
    `At creation they choose where it waits, the Lotus pool or the Stellar DEX, and whether it earns yield. ` +
    `On the pool, yield uses the vault-backed pool instance, whose ${quote} leg sits in DeFindex. ` +
    `On the Stellar DEX, the order becomes a ladder of offers, one per bin at the same prices, quoted in ${quote}, or in the receipt ${receipt} when yield is on; ${receipt} is minted 1:1 by the Lotus vault, which deposits into DeFindex. ` +
    `DeFindex lends on Blend. Takers swap on the Lotus pool or trade and path-pay on the Stellar DEX, and a bot-run arbitrage keeps the two prices aligned.`
  );
}

function Wide(codes: Codes) {
  const { receipt, base, quote } = codes;
  const m = "arrow-wide";
  // two columns: Lotus pool (left) and Stellar DEX (right)
  const PC = 355;
  const SC = 605;
  const CW = 230; // choice cell width
  const VW = 160; // venue / protocol node width
  const H = 64;
  // rows
  const yOrder = 14;
  const yFrame = 122;
  const yOff = 166;
  const yOn = 234;
  const CH = 56;
  const yFrameEnd = 304;
  const yVenue = 352;
  const yYield = 474;
  const yBlend = 584;

  return (
    <svg viewBox="0 0 920 660" className="hidden h-auto w-full sm:block" role="img" aria-label={ariaText(codes)}>
      <title>How Lotus works</title>
      <Defs id={m} />

      {/* 1. one order */}
      <Edge marker={m} d={`M460 ${yOrder + 66} V${yFrame - 2}`} />
      <Label x={472} y={(yOrder + 66 + yFrame) / 2 + 5}>choose where it waits, and yield on or off</Label>

      {/* 2. the 2 x 2 choice, made once at creation */}
      <rect x={150} y={yFrame} width={620} height={yFrameEnd - yFrame} rx={16} fill="none" stroke={LINE} strokeDasharray="3 5" />
      <Caption x={166} y={yFrame + 22}>ONCE, AT CREATION</Caption>
      <Label x={PC} y={yFrame + 34} anchor="middle" size={13} fill="rgba(255,255,255,0.8)">Lotus pool</Label>
      <Label x={SC} y={yFrame + 34} anchor="middle" size={13} fill="rgba(255,255,255,0.8)">Stellar DEX</Label>
      <Label x={166} y={yOff + CH / 2 + 4}>Yield off</Label>
      <Label x={166} y={yOn + CH / 2 + 4}>Earn yield</Label>
      <Node x={PC - CW / 2} y={yOff} w={CW} h={CH} title="Idle pool" sub={`${quote} stays in the pool`} accent titleSize={14} subSize={11} />
      <Node x={PC - CW / 2} y={yOn} w={CW} h={CH} title="Vault-backed pool" sub={`${quote} leg held in DeFindex`} accent titleSize={14} subSize={11} />
      <Node x={SC - CW / 2} y={yOff} w={CW} h={CH} title="Offer ladder" sub={`quoted in ${quote}`} titleSize={14} subSize={11} />
      <Node x={SC - CW / 2} y={yOn} w={CW} h={CH} title="Offer ladder" sub={`quoted in ${receipt}, keeps earning`} accent titleSize={14} subSize={11} />

      {/* 3. venues, takers, arbitrage */}
      <Edge marker={m} d={`M${PC} ${yFrameEnd} V${yVenue - 2}`} />
      <Label x={PC + 10} y={(yFrameEnd + yVenue) / 2 + 4}>one position</Label>
      <Edge marker={m} d={`M${SC} ${yFrameEnd} V${yVenue - 2}`} />
      <Label x={SC + 10} y={(yFrameEnd + yVenue) / 2 + 4}>one offer per bin, same prices</Label>

      <Edge marker={m} d={`M180 ${yVenue + H / 2} H${PC - VW / 2 - 2}`} />
      <Edge marker={m} d={`M740 ${yVenue + H / 2} H${SC + VW / 2 + 2}`} />
      <Edge marker={m} start optional d={`M${PC + VW / 2 + 3} ${yVenue + H / 2} H${SC - VW / 2 - 3}`} />
      <Label x={(PC + SC) / 2} y={yVenue + H / 2 - 10} anchor="middle" size={11}>arb bot</Label>
      <Label x={(PC + SC) / 2} y={yVenue + H / 2 + 20} anchor="middle" size={11}>aligns prices</Label>

      <Node x={20} y={yVenue} w={160} h={H} title="Takers" sub="swap on /swap" titleSize={15} />
      <Node x={PC - VW / 2} y={yVenue} w={VW} h={H} title="Lotus pool" sub="Soroban range pool" accent />
      <Node x={SC - VW / 2} y={yVenue} w={VW} h={H} title="SDEX" sub="classic orderbook" />
      <Node x={740} y={yVenue} w={160} h={H} title="Takers" sub="trade, path-pay /trade" titleSize={15} />

      {/* 4. yield: pool leg straight to DeFindex, SDEX via the receipt vault */}
      <Edge marker={m} start d={`M${PC} ${yVenue + H + 2} V${yYield - 2}`} />
      <Label x={PC + 10} y={(yVenue + H + yYield) / 2 + 4}>{`${quote} leg, if yield on`}</Label>
      <Edge marker={m} d={`M${SC} ${yYield - 2} V${yVenue + H + 2}`} />
      <Label x={SC + 10} y={(yVenue + H + yYield) / 2 + 4}>{`${receipt} in your offers`}</Label>
      <Edge marker={m} d={`M${SC - VW / 2 - 2} ${yYield + H / 2} H${PC + VW / 2 + 2}`} />
      <Label x={(PC + SC) / 2} y={yYield + H / 2 - 10} anchor="middle" size={11}>backing</Label>

      <Node x={PC - VW / 2} y={yYield} w={VW} h={H} title="DeFindex" sub="yield vault" />
      <Node x={SC - VW / 2} y={yYield} w={VW} h={H} title="Lotus vault" sub={`mints ${receipt} 1:1`} accent />

      <Edge marker={m} d={`M${PC} ${yYield + H} V${yBlend - 2}`} />
      <Label x={PC + 10} y={(yYield + H + yBlend) / 2 + 4}>lends*</Label>
      <Node x={PC - VW / 2} y={yBlend} w={VW} h={H} title="Blend" sub="lending pool" />

      {/* layers (left column) */}
      <Caption x={20} y={yYield + 8}>STELLAR CLASSIC</Caption>
      <Label x={20} y={yYield + 28}>{`SDEX · ${base} · ${quote} · ${receipt}`}</Label>
      <Caption x={20} y={yYield + 64}>SOROBAN</Caption>
      <Label x={20} y={yYield + 84}>lotus_pool · lotus_vault</Label>
      <Label x={20} y={yYield + 102}>DeFindex · Blend</Label>

      <Legend x={SC - VW / 2} y={yBlend + 24} />

      {/* 1. drawn last so it sits on top */}
      <Node x={330} y={yOrder} w={260} h={66} title="One range order" sub={`sell ${base} over a range, or ${quote} to buy it`} accent />
    </svg>
  );
}

function Phone(codes: Codes) {
  const { receipt, base, quote } = codes;
  const m = "arrow-phone";
  const W3 = 96; // 3-node rows
  const xs3 = [8, 132, 256];
  const CW = 166; // 2 x 2 cells
  const cx2 = [8, 186];
  const H = 54;

  const rOrder = 30;
  const rHead = 128;
  const rOff = 138;
  const rOn = 198;
  const rVenue = 292;
  const rPool = 390;
  const rSdex = 486;

  const px = (i: number) => xs3[i];
  const sx = px;

  return (
    <svg viewBox="0 0 360 610" className="h-auto w-full sm:hidden" role="img" aria-label={ariaText(codes)}>
      <title>How Lotus works</title>
      <Defs id={m} />

      <Caption x={8} y={rOrder - 12}>1 · ONE ORDER</Caption>
      <Node x={8} y={rOrder} w={344} h={H} title="One range order" sub={`sell ${base} over a range, or ${quote} to buy it`} accent titleSize={15} subSize={11} />

      <Caption x={8} y={rHead - 22}>2 · ONCE: WHERE IT WAITS × YIELD</Caption>
      <Label x={cx2[0] + CW / 2} y={rHead} anchor="middle" fill="rgba(255,255,255,0.8)">Lotus pool</Label>
      <Label x={cx2[1] + CW / 2} y={rHead} anchor="middle" fill="rgba(255,255,255,0.8)">Stellar DEX</Label>
      <Node x={cx2[0]} y={rOff + 4} w={CW} h={50} title="Idle pool" sub="yield off" accent titleSize={13} subSize={11} />
      <Node x={cx2[0]} y={rOn} w={CW} h={50} title="Vault-backed pool" sub="earn yield" accent titleSize={13} subSize={11} />
      <Node x={cx2[1]} y={rOff + 4} w={CW} h={50} title={`Ladder in ${quote}`} sub="yield off" titleSize={13} subSize={11} />
      <Node x={cx2[1]} y={rOn} w={CW} h={50} title={`Ladder in ${receipt}`} sub="earn yield" accent titleSize={13} subSize={11} />

      <Caption x={8} y={rVenue - 12}>3 · TAKERS FILL IT</Caption>
      <Edge marker={m} start optional d={`M${8 + 130 + 3} ${rVenue + H / 2} H${222 - 3}`} />
      <Label x={180} y={rVenue + H / 2 - 8} anchor="middle" size={10}>arb bot</Label>
      <Label x={180} y={rVenue + H / 2 + 16} anchor="middle" size={10}>aligns prices</Label>
      <Node x={8} y={rVenue} w={130} h={H} title="Lotus pool" sub="swap on /swap" accent titleSize={14} subSize={11} />
      <Node x={222} y={rVenue} w={130} h={H} title="SDEX" sub="trade on /trade" titleSize={14} subSize={11} />

      <Caption x={8} y={rPool - 12}>4 · YIELD ON THE POOL</Caption>
      <Edge marker={m} d={`M${px(0) + W3} ${rPool + H / 2} H${px(1) - 2}`} />
      <Edge marker={m} d={`M${px(1) + W3} ${rPool + H / 2} H${px(2) - 2}`} />
      <Node x={px(0)} y={rPool} w={W3} h={H} title="Lotus pool" sub={`${quote} leg`} accent titleSize={13} subSize={11} />
      <Node x={px(1)} y={rPool} w={W3} h={H} title="DeFindex" sub="yield vault" titleSize={13} subSize={11} />
      <Node x={px(2)} y={rPool} w={W3} h={H} title="Blend" sub="lends*" titleSize={13} subSize={11} />

      <Caption x={8} y={rSdex - 12}>5 · YIELD ON THE SDEX</Caption>
      <Edge marker={m} d={`M${sx(1) - 2} ${rSdex + H / 2} H${sx(0) + W3 + 2}`} />
      <Edge marker={m} d={`M${sx(1) + W3} ${rSdex + H / 2} H${sx(2) - 2}`} />
      <Node x={sx(0)} y={rSdex} w={W3} h={H} title={receipt} sub="in your offers" accent titleSize={13} subSize={11} />
      <Node x={sx(1)} y={rSdex} w={W3} h={H} title="Lotus vault" sub="mints 1:1" accent titleSize={13} subSize={11} />
      <Node x={sx(2)} y={rSdex} w={W3} h={H} title="DeFindex" sub="→ Blend" titleSize={13} subSize={11} />

      <Legend x={8} y={rSdex + H + 34} />
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
