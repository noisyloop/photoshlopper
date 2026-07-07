// Single source of truth for blend-mode math: written once as GLSL, used by
// the WebGL2 compositor AND inlined verbatim by the shader exporter.
// Formulas follow the W3C compositing-and-blending spec (what Photoshop does).

import type { BlendMode } from '../types';

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

export function blendModeIndex(mode: BlendMode): number {
  const i = BLEND_MODES.indexOf(mode);
  return i < 0 ? 0 : i;
}

/**
 * GLSL library: 16 separable + non-separable blend functions, a dispatch
 * switch, and the Porter-Duff "source over" composite that applies them.
 * Compatible with GLSL ES 3.00 and desktop GLSL 1.20+ (no arrays/bitwise).
 */
export const BLEND_GLSL = /* glsl */ `
float bl_lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 bl_clipColor(vec3 c) {
  float l = bl_lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}

vec3 bl_setLum(vec3 c, float l) { return bl_clipColor(c + (l - bl_lum(c))); }

float bl_sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

vec3 bl_setSat(vec3 c, float s) {
  float mn = min(min(c.r, c.g), c.b);
  float mx = max(max(c.r, c.g), c.b);
  return (mx > mn) ? (c - mn) * s / (mx - mn) : vec3(0.0);
}

float bl_dodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}

float bl_burn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}

float bl_hardLight(float b, float s) {
  return (s <= 0.5) ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
}

float bl_softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = (b <= 0.25) ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}

// mode indices match BLEND_MODES order in src/core/blend.ts
vec3 bl_blend(int mode, vec3 b, vec3 s) {
  if (mode == 0) return s;                                   // normal
  if (mode == 1) return b * s;                               // multiply
  if (mode == 2) return b + s - b * s;                       // screen
  if (mode == 3) return vec3(bl_hardLight(s.r, b.r), bl_hardLight(s.g, b.g), bl_hardLight(s.b, b.b)); // overlay
  if (mode == 4) return min(b, s);                           // darken
  if (mode == 5) return max(b, s);                           // lighten
  if (mode == 6) return vec3(bl_dodge(b.r, s.r), bl_dodge(b.g, s.g), bl_dodge(b.b, s.b));       // color-dodge
  if (mode == 7) return vec3(bl_burn(b.r, s.r), bl_burn(b.g, s.g), bl_burn(b.b, s.b));          // color-burn
  if (mode == 8) return vec3(bl_hardLight(b.r, s.r), bl_hardLight(b.g, s.g), bl_hardLight(b.b, s.b)); // hard-light
  if (mode == 9) return vec3(bl_softLight(b.r, s.r), bl_softLight(b.g, s.g), bl_softLight(b.b, s.b)); // soft-light
  if (mode == 10) return abs(b - s);                         // difference
  if (mode == 11) return b + s - 2.0 * b * s;                // exclusion
  if (mode == 12) return bl_setLum(bl_setSat(s, bl_sat(b)), bl_lum(b)); // hue
  if (mode == 13) return bl_setLum(bl_setSat(b, bl_sat(s)), bl_lum(b)); // saturation
  if (mode == 14) return bl_setLum(s, bl_lum(b));            // color
  return bl_setLum(b, bl_lum(s));                            // luminosity
}

// Blend src over dst (both straight alpha) with the given blend mode.
vec4 bl_composite(vec4 dst, vec4 src, int mode) {
  vec3 B = bl_blend(mode, dst.rgb, src.rgb);
  vec3 cs = mix(src.rgb, B, dst.a);
  float ao = src.a + dst.a * (1.0 - src.a);
  vec3 co = src.a * cs + dst.a * dst.rgb * (1.0 - src.a);
  return (ao > 0.0) ? vec4(co / ao, ao) : vec4(0.0);
}
`;
