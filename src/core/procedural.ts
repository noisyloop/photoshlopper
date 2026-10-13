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
  {
    type: 'gradient-map', label: 'Gradient Map', kind: 'effect', category: 'adjust',
    params: [C('color1', 'Shadow', [0.08, 0.04, 0.2]), C('color2', 'Midtone', [0.85, 0.25, 0.45]), C('color3', 'Highlight', [1.0, 0.88, 0.5]), F('midpoint', 'Mid position', 0.5, 0.05, 0.95), F('amount', 'Amount', 1, 0, 1)],
    body: `
      vec4 c = SRC(uv);
      float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
      float m = clamp(p_midpoint, 0.01, 0.99);
      vec3 g = l < m ? mix(p_color1, p_color2, l / m) : mix(p_color2, p_color3, (l - m) / (1.0 - m));
      result = vec4(mix(c.rgb, g, p_amount), c.a);`,
  },
  {
    type: 'duotone', label: 'Duotone', kind: 'effect', category: 'adjust',
    params: [C('color1', 'Dark', [0.1, 0.08, 0.32]), C('color2', 'Light', [1.0, 0.6, 0.45]), F('contrast', 'Contrast', 1.2, 0, 3)],
    body: `
      vec4 c = SRC(uv);
      float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
      l = clamp((l - 0.5) * p_contrast + 0.5, 0.0, 1.0);
      result = vec4(mix(p_color1, p_color2, l), c.a);`,
  },
  {
    // tints are offsets from neutral gray; luminosity is preserved
    type: 'color-balance', label: 'Color Balance', kind: 'effect', category: 'adjust',
    params: [C('shadows', 'Shadows tint (gray = none)', [0.4, 0.5, 0.62]), C('midtones', 'Midtones tint (gray = none)', [0.5, 0.5, 0.5]), C('highlights', 'Highlights tint (gray = none)', [0.62, 0.52, 0.4]), F('amount', 'Amount', 1, 0, 2)],
    body: `
      vec4 c = SRC(uv);
      vec3 lw = vec3(0.3, 0.59, 0.11);
      float l = dot(c.rgb, lw);
      float ws = 1.0 - smoothstep(0.0, 0.5, l);
      float wh = smoothstep(0.5, 1.0, l);
      float wm = 1.0 - ws - wh;
      vec3 shift = (p_shadows - 0.5) * ws + (p_midtones - 0.5) * wm + (p_highlights - 0.5) * wh;
      vec3 col = c.rgb + shift * p_amount;
      col += l - dot(col, lw);
      result = vec4(clamp(col, 0.0, 1.0), c.a);`,
  },
  {
    type: 'channel-mixer', label: 'Channel Swap', kind: 'effect', category: 'adjust',
    params: [F('mode', 'Order (0 RGB, 1 RBG, 2 GRB, 3 GBR, 4 BRG, 5 BGR)', 5, 0, 5, 1), F('amount', 'Amount', 1, 0, 1)],
    body: `
      vec4 c = SRC(uv);
      float m = floor(p_mode + 0.5);
      vec3 s = c.rgb;
      if (m > 4.5) s = c.bgr;
      else if (m > 3.5) s = c.brg;
      else if (m > 2.5) s = c.gbr;
      else if (m > 1.5) s = c.grb;
      else if (m > 0.5) s = c.rbg;
      result = vec4(mix(c.rgb, s, p_amount), c.a);`,
  },
  {
    // unsharp mask; the blur is alpha-weighted so cut-out edges don't halo
    type: 'sharpen', label: 'Sharpen', kind: 'effect', category: 'adjust',
    params: [F('amount', 'Amount', 1, 0, 4), F('radius', 'Radius (px)', 2, 0.5, 16, 0.5)],
    body: `
      vec4 c = SRC(uv);
      vec3 acc = vec3(0.0);
      float wsum = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec2 o = vec2(float(x), float(y));
          vec4 s = SRC(uv + o * (p_radius / 2.0) / RES);
          float w = exp(-dot(o, o) / 2.0) * s.a;
          acc += s.rgb * w;
          wsum += w;
        }
      }
      vec3 blur = wsum > 0.0001 ? acc / wsum : c.rgb;
      result = vec4(clamp(c.rgb + (c.rgb - blur) * p_amount, 0.0, 1.0), c.a);`,
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
  {
    // sobel on alpha-weighted luminance, so cut-out silhouettes get outlined too
    type: 'edge-detect', label: 'Edge Detect', kind: 'effect', category: 'stylize',
    params: [F('mode', 'Mode (0 edges only, 1 ink over image)', 1, 0, 1, 1), C('color', 'Line color', [0.06, 0.05, 0.08]), F('thickness', 'Thickness (px)', 1.5, 0.5, 8, 0.5), F('strength', 'Strength', 1, 0.1, 4)],
    body: `
      vec4 c = SRC(uv);
      vec3 lw = vec3(0.3, 0.59, 0.11);
      vec2 px = max(p_thickness, 0.5) / RES;
      vec4 s;
      s = SRC(uv + vec2(-px.x, -px.y)); float tl = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(0.0, -px.y)); float tc = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(px.x, -px.y)); float tr = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(-px.x, 0.0)); float ml = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(px.x, 0.0)); float mr = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(-px.x, px.y)); float bl = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(0.0, px.y)); float bc = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(px.x, px.y)); float br = dot(s.rgb, lw) * s.a;
      float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
      float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
      float ink = smoothstep(0.15, 0.6, length(vec2(gx, gy)) * p_strength);
      vec3 paper = vec3(step(dot(p_color, lw), 0.5));
      vec3 under = p_mode < 0.5 ? paper : c.rgb;
      result = vec4(mix(under, p_color, ink), c.a);`,
  },
  {
    type: 'emboss', label: 'Emboss', kind: 'effect', category: 'stylize',
    params: [F('angle', 'Light angle', 2.356, 0, 6.2832), F('strength', 'Strength', 2, 0, 8)],
    body: `
      vec4 c = SRC(uv);
      vec3 lw = vec3(0.3, 0.59, 0.11);
      vec2 d = vec2(cos(p_angle), -sin(p_angle)) * 1.5 / RES;
      vec4 a1 = SRC(uv + d);
      vec4 a2 = SRC(uv + d * 2.0);
      vec4 b1 = SRC(uv - d);
      vec4 b2 = SRC(uv - d * 2.0);
      float hi = dot(a1.rgb, lw) * a1.a + dot(a2.rgb, lw) * a2.a;
      float lo = dot(b1.rgb, lw) * b1.a + dot(b2.rgb, lw) * b2.a;
      result = vec4(vec3(clamp(0.5 + (hi - lo) * 0.5 * p_strength, 0.0, 1.0)), c.a);`,
  },
  {
    // value posterize (keeps hue) + sobel ink outlines
    type: 'toon', label: 'Toon', kind: 'effect', category: 'stylize',
    params: [F('levels', 'Levels', 4, 2, 12, 1), F('outline', 'Outline strength', 1, 0, 3), F('thickness', 'Outline thickness (px)', 1.5, 0.5, 8, 0.5)],
    body: `
      vec4 c = SRC(uv);
      vec3 lw = vec3(0.3, 0.59, 0.11);
      vec2 px = max(p_thickness, 0.5) / RES;
      vec4 s;
      s = SRC(uv + vec2(-px.x, -px.y)); float tl = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(0.0, -px.y)); float tc = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(px.x, -px.y)); float tr = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(-px.x, 0.0)); float ml = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(px.x, 0.0)); float mr = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(-px.x, px.y)); float bl = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(0.0, px.y)); float bc = dot(s.rgb, lw) * s.a;
      s = SRC(uv + vec2(px.x, px.y)); float br = dot(s.rgb, lw) * s.a;
      float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
      float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
      float ink = smoothstep(0.2, 0.6, length(vec2(gx, gy)) * p_outline);
      float n = max(p_levels, 2.0);
      float v = max(max(c.r, c.g), c.b);
      float q = min((floor(v * n) + 1.0) / n, 1.0);
      vec3 col = v > 0.001 ? clamp(c.rgb * (q / v), 0.0, 1.0) : c.rgb;
      result = vec4(mix(col, vec3(0.03), ink), c.a);`,
  },
  {
    // 4-quadrant kuwahara on a 5x5 grid (25 taps), premultiplied so
    // transparent neighbours don't darken edges
    type: 'kuwahara', label: 'Kuwahara (Painterly)', kind: 'effect', category: 'stylize',
    params: [F('radius', 'Radius (px)', 6, 2, 24, 1)],
    body: `
      vec2 st = max(p_radius, 1.0) * 0.5 / RES;
      vec4 m0 = vec4(0.0); vec4 m1 = vec4(0.0); vec4 m2 = vec4(0.0); vec4 m3 = vec4(0.0);
      vec3 q0 = vec3(0.0); vec3 q1 = vec3(0.0); vec3 q2 = vec3(0.0); vec3 q3 = vec3(0.0);
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec4 s = SRC(uv + vec2(float(x), float(y)) * st);
          vec4 pm = vec4(s.rgb * s.a, s.a);
          vec3 sq = pm.rgb * pm.rgb;
          if (x <= 0 && y <= 0) { m0 += pm; q0 += sq; }
          if (x >= 0 && y <= 0) { m1 += pm; q1 += sq; }
          if (x <= 0 && y >= 0) { m2 += pm; q2 += sq; }
          if (x >= 0 && y >= 0) { m3 += pm; q3 += sq; }
        }
      }
      m0 /= 9.0; m1 /= 9.0; m2 /= 9.0; m3 /= 9.0;
      float v0 = dot(q0 / 9.0 - m0.rgb * m0.rgb, vec3(1.0));
      float v1 = dot(q1 / 9.0 - m1.rgb * m1.rgb, vec3(1.0));
      float v2 = dot(q2 / 9.0 - m2.rgb * m2.rgb, vec3(1.0));
      float v3 = dot(q3 / 9.0 - m3.rgb * m3.rgb, vec3(1.0));
      vec4 best = m0;
      float bv = v0;
      if (v1 < bv) { best = m1; bv = v1; }
      if (v2 < bv) { best = m2; bv = v2; }
      if (v3 < bv) { best = m3; bv = v3; }
      vec4 c = SRC(uv);
      vec3 col = best.a > 0.0001 ? clamp(best.rgb / best.a, 0.0, 1.0) : c.rgb;
      result = vec4(col, c.a);`,
  },
  {
    // barrel-warped screen; everything outside the curved glass is transparent
    type: 'crt', label: 'CRT Screen', kind: 'effect', category: 'stylize',
    params: [F('curvature', 'Curvature', 0.3, 0, 1), F('scanlines', 'Scanlines', 0.4, 0, 1), F('mask', 'Phosphor mask', 0.3, 0, 1), F('size', 'Line size (px)', 4, 2, 16, 1), F('vignette', 'Vignette', 0.5, 0, 1)],
    body: `
      vec2 cc = uv * 2.0 - 1.0;
      cc += cc * (cc.yx * cc.yx) * (p_curvature * 0.35);
      vec2 suv = cc * 0.5 + 0.5;
      vec2 edge = min(suv, 1.0 - suv) * RES;
      float inside = clamp(min(edge.x, edge.y) + 0.5, 0.0, 1.0);
      vec4 c = SRC(suv);
      float sz = max(p_size, 1.0);
      float scan = 0.5 + 0.5 * cos(suv.y * RES.y * 6.2831853 / sz);
      vec3 col = c.rgb * mix(1.0, scan, p_scanlines) * (1.0 + p_scanlines * 0.35);
      float sub = mod(floor(uv.x * RES.x * 3.0 / sz), 3.0);
      vec3 ph = vec3(0.65) + 0.7 * vec3(step(sub, 0.5), step(0.5, sub) * step(sub, 1.5), step(1.5, sub));
      col *= mix(vec3(1.0), ph, p_mask);
      vec2 vq = clamp(suv, 0.0, 1.0);
      float vig = pow(max(16.0 * vq.x * vq.y * (1.0 - vq.x) * (1.0 - vq.y), 0.0), 0.25);
      col *= mix(1.0, vig, p_vignette);
      result = vec4(clamp(col, 0.0, 1.0), c.a * inside);`,
  },
  {
    // tracking wobble + a rolling noise band, chroma smeared and offset in YIQ
    type: 'vhs', label: 'VHS', kind: 'effect', category: 'stylize', needsNoise: true,
    params: [F('tracking', 'Tracking wobble', 0.004, 0, 0.03, 0.0005), F('chroma', 'Chroma bleed', 0.005, 0, 0.03, 0.0005), F('noise', 'Tape noise', 0.4, 0, 1)],
    body: `
      float t = TIME;
      float row = floor(uv.y * RES.y);
      float frame = floor(t * 30.0);
      float bp = fract(0.82 + t * 0.09);
      float band = 1.0 - smoothstep(0.0, 0.035, abs(uv.y - bp));
      float jitter = ns_hash21(vec2(row, frame));
      float wob = (ns_vnoise(vec2(uv.y * 24.0, t * 4.0)) - 0.5) * p_tracking * 2.0
        + sin(uv.y * 9.0 + t * 2.3) * p_tracking * 0.4
        + band * (jitter - 0.5) * p_tracking * 6.0;
      vec2 suv = vec2(uv.x + wob, uv.y);
      vec4 c = SRC(suv);
      vec3 bleed = vec3(0.0);
      for (int i = 0; i < 5; i++) {
        bleed += SRC(suv - vec2(p_chroma * (1.0 + float(i) * 0.5), 0.0)).rgb;
      }
      bleed /= 5.0;
      float yy = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      float ci = dot(bleed, vec3(0.596, -0.274, -0.322));
      float cq = dot(bleed, vec3(0.211, -0.523, 0.312));
      vec3 col = vec3(yy + 0.956 * ci + 0.621 * cq, yy - 0.272 * ci - 0.647 * cq, yy - 1.106 * ci + 1.703 * cq);
      float grain = ns_hash21(floor(uv * RES) + fract(t) * 13.7) - 0.5;
      float lineNoise = ns_hash21(vec2(row * 0.37, frame + 3.0)) - 0.5;
      float streak = step(0.9, ns_hash21(vec2(floor(uv.x * RES.x / 6.0), row + frame * 7.0)));
      col += (grain * 0.25 + lineNoise * 0.08) * p_noise + streak * band * p_noise;
      result = vec4(clamp(col, 0.0, 1.0), c.a);`,
  },
  {
    // two-ink separation (least-squares onto the inks' absorption), each ink
    // misregistered, grainy and posterized to 4 tones, multiplied on paper
    type: 'risograph', label: 'Risograph', kind: 'effect', category: 'stylize', needsNoise: true,
    params: [C('color1', 'Ink A', [1.0, 0.28, 0.55]), C('color2', 'Ink B', [0.0, 0.47, 0.75]), F('offset', 'Misregistration (px)', 3, 0, 20, 0.5), F('grain', 'Grain', 0.35, 0, 1)],
    body: `
      vec4 c = SRC(uv);
      vec4 s1 = SRC(uv + vec2(p_offset, p_offset * 0.5) / RES);
      vec4 s2 = SRC(uv + vec2(-p_offset * 0.6, p_offset) / RES);
      vec3 a1 = 1.0 - p_color1;
      vec3 a2 = 1.0 - p_color2;
      float g11 = dot(a1, a1);
      float g12 = dot(a1, a2);
      float g22 = dot(a2, a2);
      float det = max(g11 * g22 - g12 * g12, 0.0001);
      vec3 b1 = (1.0 - s1.rgb) * s1.a;
      vec3 b2 = (1.0 - s2.rgb) * s2.a;
      float d1 = (g22 * dot(a1, b1) - g12 * dot(a2, b1)) / det;
      float d2 = (g11 * dot(a2, b2) - g12 * dot(a1, b2)) / det;
      vec2 pix = floor(uv * RES);
      d1 *= 0.85 + 0.3 * ns_vnoise(uv * RES / 40.0);
      d2 *= 0.85 + 0.3 * ns_vnoise(uv * RES / 40.0 + 19.7);
      float k1 = floor(clamp(d1 + (ns_hash21(pix + 3.1) - 0.5) * p_grain, 0.0, 1.0) * 3.0 + 0.5) / 3.0;
      float k2 = floor(clamp(d2 + (ns_hash21(pix + 17.9) - 0.5) * p_grain, 0.0, 1.0) * 3.0 + 0.5) / 3.0;
      vec3 col = vec3(0.97, 0.95, 0.9) * mix(vec3(1.0), p_color1, k1) * mix(vec3(1.0), p_color2, k2);
      result = vec4(col, c.a);`,
  },
  {
    type: 'lcd-palette', label: 'LCD Palette', kind: 'effect', category: 'stylize',
    params: [C('color1', 'Darkest', [0.059, 0.22, 0.059]), C('color2', 'Dark', [0.188, 0.384, 0.188]), C('color3', 'Light', [0.545, 0.675, 0.059]), C('color4', 'Lightest', [0.608, 0.737, 0.059]), F('size', 'Pixel size (px)', 4, 1, 32, 1), F('grid', 'Pixel grid', 0.5, 0, 1)],
    body: `
      float s = max(p_size, 1.0);
      vec2 g = uv * RES / s;
      vec4 c = SRC((floor(g) + 0.5) * s / RES);
      float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
      vec3 col = l < 0.25 ? p_color1 : (l < 0.5 ? p_color2 : (l < 0.75 ? p_color3 : p_color4));
      vec2 f = fract(g) * s;
      float gridLine = s >= 3.0 ? 1.0 - step(1.0, min(f.x, f.y)) : 0.0;
      col = mix(col, mix(col, p_color4, 0.5), gridLine * p_grid);
      result = vec4(col, c.a);`,
  },
  {
    // per-cell luminance picks one of 8 glyphs drawn as distance fields:
    // space . : + x o # @
    type: 'ascii', label: 'ASCII Art', kind: 'effect', category: 'stylize',
    params: [F('cell', 'Cell size (px)', 10, 4, 48, 1), C('fg', 'Glyph color', [0.55, 1.0, 0.6]), C('bg', 'Background', [0.03, 0.04, 0.05]), F('keep', 'Keep source colors (0/1)', 1, 0, 1, 1)],
    body: `
      float s = max(p_cell, 4.0);
      vec2 g = uv * RES / s;
      vec4 c = SRC((floor(g) + 0.5) * s / RES);
      float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
      float lv = floor(clamp(l, 0.0, 0.999) * 8.0);
      vec2 q = fract(g) - 0.5;
      vec2 aq = abs(q);
      float w = 0.07;
      float d = 1.0;
      if (lv < 0.5) d = 1.0;
      else if (lv < 1.5) d = length(q - vec2(0.0, 0.22)) - 0.09;
      else if (lv < 2.5) d = min(length(q - vec2(0.0, 0.18)), length(q + vec2(0.0, 0.18))) - 0.09;
      else if (lv < 3.5) d = min(max(aq.x - 0.3, aq.y - w), max(aq.x - w, aq.y - 0.3));
      else if (lv < 4.5) {
        vec2 ar = abs(vec2(q.x + q.y, q.x - q.y) * 0.7071);
        d = min(max(ar.x - 0.4, ar.y - w), max(ar.x - w, ar.y - 0.4));
      }
      else if (lv < 5.5) d = abs(length(q) - 0.27) - w;
      else if (lv < 6.5) {
        vec2 h = abs(aq - 0.15);
        d = min(max(h.x - w, aq.y - 0.36), max(h.y - w, aq.x - 0.36));
      }
      else d = min(abs(length(q) - 0.33) - w, length(q) - 0.15);
      float aa = 1.0 / s;
      float ink = 1.0 - smoothstep(-aa, aa, d);
      vec3 fg = mix(p_fg, c.rgb, step(0.5, p_keep));
      result = vec4(mix(p_bg, fg, ink), c.a);`,
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
  {
    type: 'twirl', label: 'Twirl', kind: 'effect', category: 'distort',
    params: [F('angle', 'Angle', 3, -12, 12, 0.05), F('radius', 'Radius', 0.45, 0.05, 1.5), F('cx', 'Center X', 0.5, 0, 1), F('cy', 'Center Y', 0.5, 0, 1)],
    body: `
      vec2 asp = vec2(RES.x / RES.y, 1.0);
      vec2 ctr = vec2(p_cx, p_cy);
      vec2 d = (uv - ctr) * asp;
      float t = clamp(1.0 - length(d) / max(p_radius, 0.001), 0.0, 1.0);
      float a = p_angle * t * t;
      float cs = cos(a);
      float sn = sin(a);
      d = vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
      result = SRC(ctr + d / asp);`,
  },
  {
    // inside the radius r' = R * (r/R)^e; e > 1 magnifies (bulge), e < 1 pinches
    type: 'bulge', label: 'Bulge / Pinch', kind: 'effect', category: 'distort',
    params: [F('strength', 'Strength (negative = pinch)', 0.6, -1, 1), F('radius', 'Radius', 0.4, 0.05, 1.5), F('cx', 'Center X', 0.5, 0, 1), F('cy', 'Center Y', 0.5, 0, 1)],
    body: `
      vec2 asp = vec2(RES.x / RES.y, 1.0);
      vec2 ctr = vec2(p_cx, p_cy);
      vec2 d = (uv - ctr) * asp;
      float r = length(d);
      float rad = max(p_radius, 0.001);
      vec2 suv = uv;
      if (r < rad) {
        float rs = rad * pow(max(r / rad, 0.000001), exp(p_strength * 1.2));
        suv = ctr + d * (rs / max(r, 0.000001)) / asp;
      }
      result = SRC(suv);`,
  },
  {
    // like Photoshop: rect->polar wraps the image around the center (top row
    // at the center); polar->rect unrolls it
    type: 'polar', label: 'Polar Coordinates', kind: 'effect', category: 'distort',
    params: [F('mode', 'Mode (0 rect→polar, 1 polar→rect)', 0, 0, 1, 1)],
    body: `
      vec2 suv;
      if (p_mode < 0.5) {
        vec2 d = uv - 0.5;
        float a = atan(d.x, -d.y + 0.000001) / 6.2831853 + 0.5;
        suv = vec2(a, length(d) * 2.0);
      } else {
        float a = (uv.x - 0.5) * 6.2831853;
        suv = 0.5 + uv.y * 0.5 * vec2(sin(a), -cos(a));
      }
      result = SRC(suv);`,
  },
  {
    type: 'mirror-tile', label: 'Mirror / Tile', kind: 'effect', category: 'distort',
    params: [F('mode', 'Mode (0 mirror X, 1 mirror Y, 2 quad mirror, 3 tile)', 2, 0, 3, 1), F('count', 'Tiles (tile mode)', 3, 1, 12, 1)],
    body: `
      float m = floor(p_mode + 0.5);
      vec2 q = uv;
      if (m < 0.5) q.x = 0.5 - abs(uv.x - 0.5);
      else if (m < 1.5) q.y = 0.5 - abs(uv.y - 0.5);
      else if (m < 2.5) q = 0.5 - abs(uv - 0.5);
      else q = fract(uv * max(floor(p_count + 0.5), 1.0));
      result = SRC(q);`,
  },
  {
    type: 'displace', label: 'Noise Displace', kind: 'effect', category: 'distort', needsNoise: true,
    params: [F('amount', 'Amount', 0.04, 0, 0.3, 0.001), F('scale', 'Scale', 4, 0.5, 20, 0.1), F('speed', 'Drift speed (animated)', 0.3, 0, 2), F('seed', 'Seed', 3, 0, 100, 1)],
    body: `
      vec2 p = uv * vec2(RES.x / RES.y, 1.0) * p_scale + p_seed * 3.7;
      vec2 drift = vec2(TIME * p_speed, TIME * p_speed * 0.7);
      vec2 off = vec2(ns_fbm(p + drift), ns_fbm(p + vec2(5.2, 1.3) - drift)) - 0.47;
      result = SRC(uv + off * 2.0 * p_amount);`,
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
