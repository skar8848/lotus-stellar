"use client";

import dynamic from "next/dynamic";

// WebGL / video: client-only and code-split, so the landing's first paint never waits on three.js.
// While the chunk loads (or if WebGL is unavailable) the hero shows a plain black box.
const AsciiVideo = dynamic(() => import("./AsciiVideo").then((m) => m.AsciiVideo), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-black" />,
});

export function HeroVideo() {
  return <AsciiVideo cellSize={13} saturation={3.5} zoom={1.15} light={1} />;
}
