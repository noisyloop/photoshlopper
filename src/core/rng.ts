// Seeded RNG (mulberry32) + palette generation for the Randomiser.
// Same seed => same art, always.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

export const randRange = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
export const randInt = (rng: Rng, lo: number, hi: number) => Math.floor(randRange(rng, lo, hi + 1));
export const pick = <T,>(rng: Rng, arr: T[]): T => arr[Math.floor(rng() * arr.length)];

export function pickWeighted<T>(rng: Rng, entries: Array<[T, number]>): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return entries[entries.length - 1][0];
}

// ---- color helpers ----

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

export const rgbToHex = ([r, g, b]: [number, number, number]) =>
  '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

export function hexToRgb01(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
}

export type PaletteScheme = 'analogous' | 'triad' | 'complementary';

/** Auto-pick a harmonious palette: random base hue + scheme. Returns RGB 0..1 triples. */
export function generatePalette(rng: Rng, count = 5): { colors: [number, number, number][]; scheme: PaletteScheme } {
  const scheme = pick<PaletteScheme>(rng, ['analogous', 'triad', 'complementary']);
  const baseHue = rng() * 360;
  const hues: number[] = [];
  for (let i = 0; i < count; i++) {
    if (scheme === 'analogous') hues.push(baseHue + randRange(rng, -1, 1) * 45);
    else if (scheme === 'triad') hues.push(baseHue + pick(rng, [0, 120, 240]) + randRange(rng, -12, 12));
    else hues.push(baseHue + pick(rng, [0, 0, 180]) + randRange(rng, -18, 18));
  }
  const colors = hues.map((h, i) => {
    const s = randRange(rng, 0.55, 0.95);
    // spread lightness so palettes have both dark anchors and bright pops
    const l = i === 0 ? randRange(rng, 0.08, 0.2) : randRange(rng, 0.35, 0.8);
    return hslToRgb(h, s, l);
  });
  return { colors, scheme };
}
