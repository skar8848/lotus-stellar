import { Effect } from "postprocessing";
import * as THREE from "three";

// "Standard" character ramp, dark → light.
const STANDARD = " .:-=+*#%@";

// Build a single-row glyph atlas (one square cell per character).
function makeAtlas(chars: string, cell = 64): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = cell * chars.length;
  c.height = cell;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.floor(cell * 0.82)}px "Courier New", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < chars.length; i++) ctx.fillText(chars[i], i * cell + cell / 2, cell / 2 + cell * 0.04);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

const fragment = /* glsl */ `
uniform sampler2D uChars;
uniform float uCellPx;
uniform float uCount;
uniform float uSaturation;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 cells = resolution.xy / uCellPx;
  vec2 cellId = floor(uv * cells);
  vec2 cellCenter = (cellId + 0.5) / cells;
  vec3 src = texture2D(inputBuffer, cellCenter).rgb;
  float lum = dot(src, vec3(0.2126, 0.7152, 0.0722));
  float idx = floor(clamp(lum, 0.0, 0.999) * uCount);
  vec2 local = fract(uv * cells);
  // flip Y so glyphs aren't upside-down
  vec2 atlasUv = vec2((idx + local.x) / uCount, 1.0 - local.y);
  float glyph = texture2D(uChars, atlasUv).r;
  vec3 col = mix(vec3(lum), src, uSaturation);
  outputColor = vec4(col * glyph, inputColor.a);
}
`;

export class AsciiEffect extends Effect {
  constructor({ cellSize = 13, saturation = 1, characters = STANDARD } = {}) {
    super("AsciiEffect", fragment, {
      uniforms: new Map<string, THREE.Uniform>([
        ["uChars", new THREE.Uniform(makeAtlas(characters))],
        ["uCellPx", new THREE.Uniform(cellSize)],
        ["uCount", new THREE.Uniform(characters.length)],
        ["uSaturation", new THREE.Uniform(saturation)],
      ]),
    });
  }
}
