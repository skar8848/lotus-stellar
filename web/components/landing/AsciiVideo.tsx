"use client";

import { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useVideoTexture } from "@react-three/drei";
import { EffectComposer, wrapEffect } from "@react-three/postprocessing";
import * as THREE from "three";
import { AsciiEffect } from "@/components/landing/asciiEffect";

const Ascii = wrapEffect(AsciiEffect);

const vert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const frag = /* glsl */ `
  uniform sampler2D uVideo;
  uniform float uHover;
  uniform vec2 uMouse;
  uniform float uCanvasA;
  uniform float uVideoA;
  uniform float uZoom;
  uniform float uLight;
  varying vec2 vUv;
  float rand(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
  void main() {
    // cover-fit the video into the plane, then zoom in around the center
    vec2 sc = uCanvasA > uVideoA ? vec2(1.0, uVideoA / uCanvasA) : vec2(uCanvasA / uVideoA, 1.0);
    vec2 uv = (vUv - 0.5) * sc / uZoom + 0.5;
    // pixel distortion under the cursor on hover
    float d = distance(vUv, uMouse);
    float infl = uHover * smoothstep(0.35, 0.0, d);
    if (infl > 0.001) {
      float px = mix(900.0, 38.0, infl);
      vec2 cell = floor(uv * px);
      uv = cell / px + (vec2(rand(cell), rand(cell + 3.1)) - 0.5) * 0.05 * infl;
    }
    vec3 col = texture2D(uVideo, clamp(uv, 0.0, 1.0)).rgb;
    // directional key light from the top-left grazing the plant: a bright neutral-white
    // spotlight on the lit side, gently shaded on the far side. Multiplicative, so the
    // black background stays black.
    float light = smoothstep(1.25, 0.0, distance(vUv, vec2(0.10, 0.90)));
    vec3 spot = vec3(1.0, 0.995, 0.985);
    col *= mix(vec3(0.78), spot * (1.0 + uLight), light);
    gl_FragColor = vec4(col, 1.0);
  }
`;

function VideoPlane({ zoom, light }: { zoom: number; light: number }) {
  const tex = useVideoTexture("/lotus.mp4", { muted: true, loop: true, start: true, crossOrigin: "anonymous" });
  const mat = useRef<THREE.ShaderMaterial>(null);
  const target = useRef(0);
  const { viewport, size } = useThree();

  const uniforms = useMemo(
    () => ({
      uVideo: { value: null as THREE.Texture | null },
      uHover: { value: 0 },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uCanvasA: { value: 1 },
      uVideoA: { value: 1 },
      uZoom: { value: zoom },
      uLight: { value: light },
    }),
    [zoom, light]
  );

  useFrame(() => {
    const u = mat.current?.uniforms;
    if (!u) return;
    u.uVideo.value = tex;
    u.uCanvasA.value = size.width / size.height;
    const v = tex.image as HTMLVideoElement | undefined;
    if (v?.videoWidth) u.uVideoA.value = v.videoWidth / v.videoHeight;
    u.uHover.value += (target.current - u.uHover.value) * 0.12;
  });

  return (
    <mesh
      scale={[viewport.width, viewport.height, 1]}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => e.uv && mat.current?.uniforms.uMouse.value.set(e.uv.x, e.uv.y)}
      onPointerOver={() => (target.current = 1)}
      onPointerOut={() => (target.current = 0)}
    >
      <planeGeometry args={[1, 1]} />
      <shaderMaterial ref={mat} vertexShader={vert} fragmentShader={frag} uniforms={uniforms} />
    </mesh>
  );
}

export function AsciiVideo({
  cellSize = 13,
  saturation = 1,
  zoom = 1,
  light = 0,
}: {
  cellSize?: number;
  saturation?: number;
  zoom?: number;
  light?: number;
}) {
  return (
    <Canvas orthographic camera={{ position: [0, 0, 1], zoom: 1 }} gl={{ antialias: false }} dpr={[1, 2]}>
      <VideoPlane zoom={zoom} light={light} />
      <EffectComposer>
        <Ascii cellSize={cellSize} saturation={saturation} />
      </EffectComposer>
    </Canvas>
  );
}
