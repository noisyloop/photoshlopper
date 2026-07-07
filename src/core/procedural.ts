// Procedural node registry. Each node (adjustment / effect / generator) is
// defined ONCE as a GLSL snippet plus param metadata. The WebGL2 compositor
// compiles the snippet with params as uniforms; the shader exporter inlines
// the same snippet with params baked as locals. That is what makes exported
// shaders match the on-canvas result.
//
// Snippet contract:
//   - statements executed with `vec2 uv` (0..1, origin top-left) in scope
//   - must assign `result` (vec4, straight alpha)
//   - params are in scope as `p_<key>` (float or vec3 for colors)
//   - effects may sample the composite *below* them via `SRC(p)` (vec2 -> vec4)
//   - `RES` (vec2 pixels) and `TIME` (float seconds; 0.0 in the editor,
//     animated in Shadertoy exports) macros are available
//   - helper libs (noise/color) are injected when `needsNoise`/`needsColor`

import type { ParamValue, ProceduralNode } from '../types';

export interface ParamDef {
  key: string;
  label: string;
  type: 'float' | 'color';
  min?: number;
  max?: number;
  step?: number;
  def: ParamValue;
}

export interface ProcDef {
  type: string;
  label: string;
  kind: 'generator' | 'effect';
  category: 'adjust' | 'blur' | 'stylize' | 'distort' | 'generate';
  params: ParamDef[];
  needsNoise?: boolean;
  needsColor?: boolean;
  body: string;
}

export const NOISE_GLSL = /* glsl */ `
float ns_hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 ns_hash22(vec2 p) {
  float n = ns_hash21(p);
  return vec2(n, ns_hash21(p + n + 17.17));
}
float ns_vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = ns_hash21(i);
  float b = ns_hash21(i + vec2(1.0, 0.0));
  float c = ns_hash21(i + vec2(0.0, 1.0));
  float d = ns_hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float ns_fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * ns_vnoise(p);
    p = p * 2.03 + vec2(11.3, 7.9);
    a *= 0.5;
  }
  return v;
}
vec3 ns_permute3(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
// 2D simplex noise (Ashima Arts / stegu, MIT), returns roughly -1..1
float ns_snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = ns_permute3(ns_permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
// ordered-dither thresholds without arrays (portable to old GLSL)
float ns_bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float ns_bayer4(vec2 a) { return ns_bayer2(0.5 * a) * 0.25 + ns_bayer2(a); }
`;

export const COLOR_GLSL = /* glsl */ `
vec3 cs_rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  if (mx == mn) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float cs_hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 cs_hsl2rgb(vec3 hsl) {
  if (hsl.y == 0.0) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(cs_hue2rgb(p, q, hsl.x + 1.0 / 3.0), cs_hue2rgb(p, q, hsl.x), cs_hue2rgb(p, q, hsl.x - 1.0 / 3.0));
}
`;

const F = (key: string, label: string, def: number, min: number, max: number, step = 0.01): ParamDef =>
  ({ key, label, type: 'float', def, min, max, step });
const C = (key: string, label: string, def: [number, number, number]): ParamDef =>
  ({ key, label, type: 'color', def });

export const PROC_DEFS: ProcDef[] = [
  // ---------- adjustments ----------
  {
    type: 'brightness-contrast', label: 'Brightness/Contrast', kind: 'effect', category: 'adjust',
    params: [F('brightness', 'Brightness', 0, -1, 1), F('contrast', 'Contrast', 1, 0, 3)],
    body: `
      vec4 c = SRC(uv);
      c.rgb = (c.rgb - 0.5) * p_contrast + 0.5 + p_brightness;
      result = vec4(clamp(c.rgb, 0.0, 1.0), c.a);`,
  },
  {
    type: 'hue-saturation', label: 'Hue/Saturation', kind: 'effect', category: 'adjust', needsColor: true,
    params: [F('hue', 'Hue shift', 0, -0.5, 0.5), F('saturation', 'Saturation', 1, 0, 2), F('lightness', 'Lightness', 0, -1, 1)],
    body: `
      vec4 c = SRC(uv);
      vec3 hsl = cs_rgb2hsl(c.rgb);
      hsl.x = fract(hsl.x + p_hue);
      hsl.y = clamp(hsl.y * p_saturation, 0.0, 1.0);
      hsl.z = clamp(hsl.z + p_lightness * 0.5, 0.0, 1.0);
      result = vec4(cs_hsl2rgb(hsl), c.a);`,
  },
  {
    type: 'levels', label: 'Levels', kind: 'effect', category: 'adjust',
    params: [F('inlo', 'Input black', 0, 0, 1), F('inhi', 'Input white', 1, 0, 1), F('gamma', 'Gamma', 1, 0.1, 4), F('outlo', 'Output black', 0, 0, 1), F('outhi', 'Output white', 1, 0, 1)],
    body: `
      vec4 c = SRC(uv);
      vec3 v = clamp((c.rgb - p_inlo) / max(p_inhi - p_inlo, 0.0001), 0.0, 1.0);
      v = pow(v, vec3(1.0 / p_gamma));
      result = vec4(mix(vec3(p_outlo), vec3(p_outhi), v), c.a);`,
  },
  {
    type: 'invert', label: 'Invert', kind: 'effect', category: 'adjust',
    params: [],
    body: `
      vec4 c = SRC(uv);
      result = vec4(1.0 - c.rgb, c.a);`,
  },
  {
    type: 'posterize', label: 'Posterize', kind: 'effect', category: 'adjust',
    params: [F('levels', 'Levels', 4, 2, 16, 1)],
    body: `
      vec4 c = SRC(uv);
      float n = max(p_levels, 2.0);
      result = vec4(floor(c.rgb * (n - 0.001)) / (n - 1.0), c.a);`,
  },
  {
    type: 'threshold', label: 'Threshold', kind: 'effect', category: 'adjust',
    params: [F('level', 'Level', 0.5, 0, 1)],
    body: `
      vec4 c = SRC(uv);
      float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
      result = vec4(vec3(step(p_level, l)), c.a);`,
  },
  {
    type: 'grayscale', label: 'Grayscale', kind: 'effect', category: 'adjust',
    params: [F('amount', 'Amount', 1, 0, 1)],
    body: `
      vec4 c = SRC(uv);
      float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
      result = vec4(mix(c.rgb, vec3(l), p_amount), c.a);`,
  },
  // ---------- blurs ----------
  {
    type: 'gaussian-blur', label: 'Gaussian Blur', kind: 'effect', category: 'blur',
    params: [F('radius', 'Radius (px)', 8, 0, 64, 1)],
    body: `
      vec4 acc = vec4(0.0);
      float wsum = 0.0;
      for (int x = -6; x <= 6; x++) {
        for (int y = -6; y <= 6; y++) {
          vec2 o = vec2(float(x), float(y));
          float w = exp(-dot(o, o) / 9.0);
          acc += SRC(uv + o * (p_radius / 6.0) / RES) * w;
          wsum += w;
        }
      }
      result = acc / wsum;`,
  },
  {
    type: 'box-blur', label: 'Box Blur', kind: 'effect', category: 'blur',
    params: [F('radius', 'Radius (px)', 6, 0, 64, 1)],
    body: `
      vec4 acc = vec4(0.0);
      for (int x = -4; x <= 4; x++) {
        for (int y = -4; y <= 4; y++) {
          acc += SRC(uv + vec2(float(x), float(y)) * (p_radius / 4.0) / RES);
        }
      }
      result = acc / 81.0;`,
  },
  {
    type: 'motion-blur', label: 'Motion Blur', kind: 'effect', category: 'blur',
    params: [F('distance', 'Distance (px)', 24, 0, 200, 1), F('angle', 'Angle', 0, 0, 6.2832)],
    body: `
      vec2 dir = vec2(cos(p_angle), sin(p_angle)) * p_distance / RES;
      vec4 acc = vec4(0.0);
      for (int i = -8; i <= 8; i++) {
        acc += SRC(uv + dir * (float(i) / 8.0) * 0.5);
      }
      result = acc / 17.0;`,
  },
  // ---------- stylize ----------
  {
    type: 'glitch', label: 'Glitch', kind: 'effect', category: 'stylize', needsNoise: true,
    params: [F('intensity', 'Intensity', 0.35, 0, 1), F('shift', 'RGB shift', 0.008, 0, 0.05, 0.001), F('blocks', 'Blocks', 24, 4, 96, 1), F('seed', 'Seed', 7, 0, 100, 1)],
    body: `
      vec2 buv = uv;
      float band = floor(uv.y * p_blocks) / p_blocks;
      float rnd = ns_hash21(vec2(band * 37.1, p_seed + floor(TIME * 8.0)));
      if (rnd > 1.0 - p_intensity * 0.5) {
        buv.x += (ns_hash21(vec2(band, p_seed + 1.0 + floor(TIME * 8.0))) - 0.5) * p_intensity * 0.2;
      }
      vec4 c;
      c.r = SRC(buv + vec2(p_shift, 0.0)).r;
      c.g = SRC(buv).g;
      c.b = SRC(buv - vec2(p_shift, 0.0)).b;
      c.a = SRC(buv).a;
      result = c;`,
  },
  {
    type: 'chromatic-aberration', label: 'Chromatic Aberration', kind: 'effect', category: 'stylize',
    params: [F('amount', 'Amount', 0.01, 0, 0.06, 0.001)],
    body: `
      vec2 d = (uv - 0.5) * p_amount * 2.0;
      vec4 c;
      c.r = SRC(uv + d).r;
      c.g = SRC(uv).g;
      c.b = SRC(uv - d).b;
      c.a = SRC(uv).a;
      result = c;`,
  },
  {
    type: 'pixelate', label: 'Pixelate', kind: 'effect', category: 'stylize',
    params: [F('size', 'Cell size (px)', 12, 1, 128, 1)],
    body: `
      vec2 cell = max(p_size, 1.0) / RES;
      vec2 puv = (floor(uv / cell) + 0.5) * cell;
      result = SRC(puv);`,
  },
  {
    type: 'dither', label: 'Dither (Bayer)', kind: 'effect', category: 'stylize', needsNoise: true,
    params: [F('levels', 'Levels', 3, 2, 8, 1), F('scale', 'Pattern scale', 1, 1, 8, 1)],
    body: `
      vec4 c = SRC(uv);
      float th = ns_bayer4(uv * RES / p_scale) - 0.5;
      float n = max(p_levels, 2.0) - 1.0;
      vec3 q = clamp(floor(c.rgb * n + 0.5 + th) / n, 0.0, 1.0);
      result = vec4(q, c.a);`,
  },
  {
    type: 'halftone', label: 'Halftone', kind: 'effect', category: 'stylize',
    params: [F('size', 'Dot size (px)', 8, 3, 48, 1), F('angle', 'Angle', 0.6, 0, 3.1416)],
    body: `
      float s = max(p_size, 2.0);
      mat2 rot = mat2(cos(p_angle), -sin(p_angle), sin(p_angle), cos(p_angle));
      vec2 px = rot * (uv * RES);
      vec2 cellCenter = (floor(px / s) + 0.5) * s;
      // rotate back to sample the source at the cell center
      mat2 inv = mat2(cos(p_angle), sin(p_angle), -sin(p_angle), cos(p_angle));
      vec2 suv = (inv * cellCenter) / RES;
      vec4 c = SRC(suv);
      float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
      float r = sqrt(1.0 - l) * s * 0.7;
      float d = length(px - cellCenter);
      float ink = 1.0 - smoothstep(r - 1.0, r + 1.0, d);
      result = vec4(mix(vec3(1.0), vec3(0.0), ink), c.a);`,
  },
  {
    type: 'noise-grain', label: 'Noise Grain', kind: 'effect', category: 'stylize', needsNoise: true,
    params: [F('amount', 'Amount', 0.15, 0, 1), F('scale', 'Scale', 1, 1, 8, 1)],
    body: `
      vec4 c = SRC(uv);
      float g = ns_hash21(floor(uv * RES / p_scale) + fract(TIME) * 13.7) - 0.5;
      result = vec4(clamp(c.rgb + g * p_amount, 0.0, 1.0), c.a);`,
  },
  {
    type: 'vignette', label: 'Vignette', kind: 'effect', category: 'stylize',
    params: [F('amount', 'Amount', 0.5, 0, 1), F('radius', 'Radius', 0.75, 0.2, 1.5), F('softness', 'Softness', 0.45, 0.05, 1)],
    body: `
      vec4 c = SRC(uv);
      float d = length((uv - 0.5) * vec2(RES.x / RES.y, 1.0) * 1.4142);
      float v = smoothstep(p_radius - p_softness, p_radius + p_softness * 0.5, d);
      result = vec4(c.rgb * (1.0 - v * p_amount), c.a);`,
  },
  {
    type: 'bloom', label: 'Bloom', kind: 'effect', category: 'stylize',
    params: [F('threshold', 'Threshold', 0.6, 0, 1), F('amount', 'Amount', 0.8, 0, 2), F('radius', 'Radius (px)', 16, 2, 64, 1)],
    body: `
      vec4 base = SRC(uv);
      vec3 glow = vec3(0.0);
      float wsum = 0.0;
      for (int x = -4; x <= 4; x++) {
        for (int y = -4; y <= 4; y++) {
          vec2 o = vec2(float(x), float(y));
          float w = exp(-dot(o, o) / 6.0);
          vec3 s = SRC(uv + o * (p_radius / 4.0) / RES).rgb;
          float l = dot(s, vec3(0.3, 0.59, 0.11));
          glow += max(l - p_threshold, 0.0) * s * w;
          wsum += w;
        }
      }
      result = vec4(base.rgb + glow / wsum * p_amount * 2.0, base.a);`,
  },
  // ---------- distort ----------
  {
    type: 'wave', label: 'Wave', kind: 'effect', category: 'distort',
    params: [F('amplitude', 'Amplitude', 0.02, 0, 0.2, 0.001), F('frequency', 'Frequency', 8, 1, 40, 0.5), F('phase', 'Phase', 0, 0, 6.2832)],
    body: `
      vec2 w = uv;
      w.x += sin(uv.y * p_frequency + p_phase + TIME) * p_amplitude;
      w.y += cos(uv.x * p_frequency + p_phase + TIME) * p_amplitude * 0.6;
      result = SRC(w);`,
  },
  {
    type: 'ripple', label: 'Ripple', kind: 'effect', category: 'distort',
    params: [F('amplitude', 'Amplitude', 0.015, 0, 0.1, 0.001), F('frequency', 'Frequency', 24, 2, 80, 1)],
    body: `
      vec2 d = uv - 0.5;
      float r = length(d);
      float off = sin(r * p_frequency - TIME * 2.0) * p_amplitude;
      result = SRC(uv + normalize(d + 0.0001) * off);`,
  },
  {
    type: 'kaleidoscope', label: 'Kaleidoscope', kind: 'effect', category: 'distort',
    params: [F('segments', 'Segments', 6, 2, 16, 1), F('rotation', 'Rotation', 0, 0, 6.2832)],
    body: `
      vec2 d = uv - 0.5;
      float a = atan(d.y, d.x) + p_rotation;
      float r = length(d);
      float seg = 6.2831853 / max(p_segments, 2.0);
      a = abs(mod(a, seg * 2.0) - seg);
      result = SRC(clamp(vec2(cos(a), sin(a)) * r + 0.5, 0.0, 1.0));`,
  },
  // ---------- generators (Randomiser base art with exact GLSL twins) ----------
  {
    type: 'gen-gradient', label: 'Gradient', kind: 'generator', category: 'generate',
    params: [C('color1', 'Color 1', [0.1, 0.1, 0.3]), C('color2', 'Color 2', [0.9, 0.3, 0.5]), C('color3', 'Color 3', [1.0, 0.8, 0.3]), F('angle', 'Angle', 0.8, 0, 6.2832), F('bend', 'Bend', 1, 0.3, 3)],
    body: `
      vec2 dir = vec2(cos(p_angle), sin(p_angle));
      float t = clamp(dot(uv - 0.5, dir) + 0.5, 0.0, 1.0);
      t = pow(t, p_bend);
      vec3 col = t < 0.5 ? mix(p_color1, p_color2, t * 2.0) : mix(p_color2, p_color3, t * 2.0 - 1.0);
      result = vec4(col, 1.0);`,
  },
  {
    type: 'gen-noise-field', label: 'Noise Field', kind: 'generator', category: 'generate', needsNoise: true,
    params: [C('color1', 'Color 1', [0.05, 0.05, 0.12]), C('color2', 'Color 2', [0.2, 0.6, 0.7]), C('color3', 'Color 3', [0.95, 0.85, 0.4]), F('scale', 'Scale', 3, 0.5, 12, 0.1), F('warp', 'Warp', 0.6, 0, 2), F('seed', 'Seed', 11, 0, 100, 1)],
    body: `
      vec2 p = uv * p_scale + p_seed * 3.7;
      vec2 q = vec2(ns_fbm(p), ns_fbm(p + vec2(5.2, 1.3)));
      float f = ns_fbm(p + q * p_warp * 2.0);
      vec3 col = f < 0.5 ? mix(p_color1, p_color2, f * 2.0) : mix(p_color2, p_color3, f * 2.0 - 1.0);
      col += 0.08 * ns_snoise(p * 4.0);
      result = vec4(clamp(col, 0.0, 1.0), 1.0);`,
  },
  {
    type: 'gen-voronoi', label: 'Voronoi Cells', kind: 'generator', category: 'generate', needsNoise: true,
    params: [C('color1', 'Color 1', [0.08, 0.05, 0.15]), C('color2', 'Color 2', [0.85, 0.3, 0.4]), C('color3', 'Color 3', [0.98, 0.85, 0.5]), F('scale', 'Scale', 6, 2, 20, 1), F('edge', 'Edge darkness', 0.6, 0, 1), F('seed', 'Seed', 4, 0, 100, 1)],
    body: `
      vec2 p = uv * vec2(RES.x / RES.y, 1.0) * p_scale + p_seed * 7.3;
      vec2 ip = floor(p);
      vec2 fp = fract(p);
      float d1 = 8.0;
      float d2 = 8.0;
      vec2 cellId = vec2(0.0);
      for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
          vec2 g = vec2(float(x), float(y));
          vec2 o = ns_hash22(ip + g);
          float d = length(g + o - fp);
          if (d < d1) { d2 = d1; d1 = d; cellId = ip + g; }
          else if (d < d2) { d2 = d; }
        }
      }
      float h = ns_hash21(cellId);
      vec3 col = h < 0.5 ? mix(p_color1, p_color2, h * 2.0) : mix(p_color2, p_color3, h * 2.0 - 1.0);
      float edge = smoothstep(0.0, 0.12, d2 - d1);
      col *= mix(1.0 - p_edge, 1.0, edge);
      result = vec4(col, 1.0);`,
  },
  {
    type: 'gen-waves', label: 'Wave Interference', kind: 'generator', category: 'generate',
    params: [C('color1', 'Color 1', [0.02, 0.05, 0.15]), C('color2', 'Color 2', [0.1, 0.7, 0.8]), C('color3', 'Color 3', [1.0, 0.9, 0.6]), F('frequency', 'Frequency', 18, 4, 60, 1), F('sources', 'Sources', 3, 2, 5, 1), F('seed', 'Seed', 2, 0, 100, 1)],
    body: `
      vec2 p = uv * vec2(RES.x / RES.y, 1.0);
      float sum = 0.0;
      for (int i = 0; i < 5; i++) {
        if (float(i) >= p_sources) break;
        float fi = float(i) + p_seed;
        vec2 src = vec2(fract(sin(fi * 12.9898) * 43758.5453), fract(sin(fi * 78.233) * 12543.123));
        src.x *= RES.x / RES.y;
        sum += sin(length(p - src) * p_frequency + fi * 1.7);
      }
      float t = sum / p_sources * 0.5 + 0.5;
      vec3 col = t < 0.5 ? mix(p_color1, p_color2, t * 2.0) : mix(p_color2, p_color3, t * 2.0 - 1.0);
      result = vec4(col, 1.0);`,
  },
];

const byType = new Map(PROC_DEFS.map((d) => [d.type, d]));

export function getProcDef(type: string): ProcDef {
  const d = byType.get(type);
  if (!d) throw new Error(`Unknown procedural node type: ${type}`);
  return d;
}

export function makeNode(type: string, overrides: Record<string, ParamValue> = {}): ProceduralNode {
  const def = getProcDef(type);
  const params: Record<string, ParamValue> = {};
  for (const p of def.params) params[p.key] = overrides[p.key] ?? (Array.isArray(p.def) ? [...p.def] as [number, number, number] : p.def);
  return { type, params };
}

/** GLSL uniform declarations for a node's params (compositor mode). */
export function paramUniformDecls(def: ProcDef): string {
  return def.params
    .map((p) => (p.type === 'color' ? `uniform vec3 p_${p.key};` : `uniform float p_${p.key};`))
    .join('\n');
}

const fmt = (n: number) => {
  const s = Number(n.toFixed(6)).toString();
  return s.includes('.') || s.includes('e') ? s : s + '.0';
};

/** GLSL local declarations with baked values (shader-export mode). */
export function paramLocalDecls(def: ProcDef, node: ProceduralNode): string {
  return def.params
    .map((p) => {
      const v = node.params[p.key] ?? p.def;
      if (p.type === 'color') {
        const c = v as [number, number, number];
        return `  vec3 p_${p.key} = vec3(${fmt(c[0])}, ${fmt(c[1])}, ${fmt(c[2])});`;
      }
      return `  float p_${p.key} = ${fmt(v as number)};`;
    })
    .join('\n');
}
