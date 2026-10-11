// The Randomizer. Seeded by mulberry32 — the same seed always reproduces the
// same art. Drops a generative base onto the bottom of the layer stack plus
// 1-2 moderate procedural effect layers, as ONE undo entry. Each roll REPLACES
// the previous roll's layers (tagged meta.randomizer) in place, so repeated
// clicks give fresh ideas instead of hiding new art under the old base.
// Rolls are capped at MAX_ROLLS per document; earlier seeds stay in `ideas`
// and can be restored for free.
//
// Base art comes from a weighted set. Four of the six bases are procedural
// layers with exact GLSL twins (gradient, noise field, voronoi, wave
// interference) — a doc made only of those exports as a fully self-contained
// shader. The other two (flow field, scattered shapes) are particle/shape
// driven and render on the CPU into a raster layer; shader export then uses
// a texture for them.

import type { Doc, Layer, ParamValue } from '../types';
import { identityTransform, newId } from '../types';
import { mulberry32, generatePalette, randRange, randInt, pick, pickWeighted, rgbToHex, type Rng } from './rng';
import { makeNode } from './procedural';
import { makeCanvas, canvasToImageData, setPixels } from './pixels';
import { useStore, pushHistory, bumpLayer, touch, newDoc, setStatus, requestFit, MAX_ROLLS } from '../store';

type Vec3 = [number, number, number];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const v3 = (c: Vec3): Vec3 => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];

// ---- tiny seeded 2D value noise for the CPU flow field ----
function makeNoise2D(rng: Rng): (x: number, y: number) => number {
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h: number, x: number, y: number) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 0.7; // ~-1..1
  };
}

function renderFlowField(rng: Rng, w: number, h: number, palette: Vec3[]): ImageData {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = rgbToHex(palette[0]);
  ctx.fillRect(0, 0, w, h);
  const noise = makeNoise2D(rng);
  const scale = randRange(rng, 1.5, 4) / Math.max(w, h);
  const curl = randRange(rng, 1.5, 4);
  const particles = randInt(rng, 1800, 4200);
  const steps = randInt(rng, 30, 90);
  const stepLen = randRange(rng, 2, 5);
  for (let i = 0; i < particles; i++) {
    let x = rng() * w;
    let y = rng() * h;
    const col = pick(rng, palette.slice(1));
    ctx.strokeStyle = rgbToHex(col);
    ctx.globalAlpha = randRange(rng, 0.08, 0.35);
    ctx.lineWidth = randRange(rng, 0.6, 2.4);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < steps; s++) {
      const a = noise(x * scale * 700, y * scale * 700) * Math.PI * curl;
      x += Math.cos(a) * stepLen;
      y += Math.sin(a) * stepLen;
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) break;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return canvasToImageData(c);
}

function renderScatter(rng: Rng, w: number, h: number, palette: Vec3[]): ImageData {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d')!;
  // background: subtle two-stop gradient from the dark anchor
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, rgbToHex(palette[0]));
  g.addColorStop(1, rgbToHex(v3([palette[0][0] * 1.6 + 0.03, palette[0][1] * 1.6 + 0.03, palette[0][2] * 1.6 + 0.03])));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const count = randInt(rng, 30, 110);
  for (let i = 0; i < count; i++) {
    const kind = pick(rng, ['circle', 'ring', 'blob', 'capsule'] as const);
    const col = pick(rng, palette.slice(1));
    const x = rng() * w;
    const y = rng() * h;
    const r = randRange(rng, 8, Math.min(w, h) * 0.16);
    ctx.globalAlpha = randRange(rng, 0.5, 1);
    ctx.fillStyle = rgbToHex(col);
    ctx.strokeStyle = rgbToHex(col);
    ctx.beginPath();
    if (kind === 'circle') {
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'ring') {
      ctx.lineWidth = Math.max(2, r * randRange(rng, 0.12, 0.35));
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === 'capsule') {
      const a = rng() * Math.PI * 2;
      const len = r * randRange(rng, 1.5, 3);
      ctx.lineWidth = r * randRange(rng, 0.4, 0.9);
      ctx.lineCap = 'round';
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    } else {
      // blob: closed bezier around jittered radius
      const pts = 6 + randInt(rng, 0, 4);
      const radii = Array.from({ length: pts }, () => r * randRange(rng, 0.6, 1.3));
      for (let k = 0; k <= pts; k++) {
        const a0 = (k / pts) * Math.PI * 2;
        const px = x + Math.cos(a0) * radii[k % pts];
        const py = y + Math.sin(a0) * radii[k % pts];
        if (k === 0) ctx.moveTo(px, py);
        else {
          const am = ((k - 0.5) / pts) * Math.PI * 2;
          const mr = (radii[(k - 1) % pts] + radii[k % pts]) / 2 * 1.1;
          ctx.quadraticCurveTo(x + Math.cos(am) * mr, y + Math.sin(am) * mr, px, py);
        }
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  return canvasToImageData(c);
}

type BaseKind = 'gradient' | 'noise-field' | 'voronoi' | 'waves' | 'flow-field' | 'scatter';

function makeLayer(name: string, kind: Layer['kind']): Layer {
  return {
    id: newId(), name, kind, visible: true, opacity: 1, blend: 'normal',
    locked: false, transform: identityTransform(), meta: { randomizer: true },
  };
}

const COOLDOWN_MS = 150;
let lastRollAt = 0;

export const isRandomizerLayer = (l: Layer): boolean => l.meta?.randomizer === true;

/**
 * Run the Randomizer with the given seed. A normal roll counts toward the
 * per-document cap; `restore` re-creates an idea already rolled on this doc
 * and is free.
 */
export function randomize(seed: number, opts: { restore?: boolean } = {}): void {
  const now = performance.now();
  if (now - lastRollAt < COOLDOWN_MS) return; // swallow key-repeat / double-click bursts
  const state = useStore.getState();
  if (!state.doc) {
    newDoc(1024, 1024, 'transparent');
  }
  const restore = !!opts.restore && useStore.getState().ideas.includes(seed);
  if (!restore && useStore.getState().rollsUsed >= MAX_ROLLS) {
    setStatus(`Randomize limit reached (${MAX_ROLLS}/${MAX_ROLLS} on this document) — pick a past idea, or start a new document`);
    return;
  }
  lastRollAt = now;
  const doc = useStore.getState().doc!;
  const rng = mulberry32(seed);
  const { colors: palette, scheme } = generatePalette(rng, 5);
  const w = doc.width;
  const h = doc.height;

  const base = pickWeighted<BaseKind>(rng, [
    ['gradient', 1.2], ['noise-field', 2], ['voronoi', 1.6], ['waves', 1.6],
    ['flow-field', 2], ['scatter', 1.6],
  ]);

  const colorParams: Record<string, ParamValue> = {
    color1: v3(palette[0]),
    color2: v3(palette[2]),
    color3: v3(palette[4]),
  };

  const newLayers: Layer[] = [];
  if (base === 'flow-field' || base === 'scatter') {
    const layer = makeLayer(`Random ${base}`, 'raster');
    const px = base === 'flow-field' ? renderFlowField(rng, w, h, palette) : renderScatter(rng, w, h, palette);
    setPixels(layer.id, px);
    newLayers.push(layer);
  } else {
    const layer = makeLayer(`Random ${base}`, 'procedural');
    if (base === 'gradient') {
      layer.procedural = makeNode('gen-gradient', {
        ...colorParams,
        angle: randRange(rng, 0, Math.PI * 2),
        bend: randRange(rng, 0.6, 1.8),
      });
    } else if (base === 'noise-field') {
      layer.procedural = makeNode('gen-noise-field', {
        ...colorParams,
        scale: randRange(rng, 1.5, 6),
        warp: randRange(rng, 0.2, 1.4),
        seed: randInt(rng, 0, 100),
      });
    } else if (base === 'voronoi') {
      layer.procedural = makeNode('gen-voronoi', {
        ...colorParams,
        scale: randRange(rng, 4, 14),
        edge: randRange(rng, 0.3, 0.85),
        seed: randInt(rng, 0, 100),
      });
    } else {
      layer.procedural = makeNode('gen-waves', {
        ...colorParams,
        frequency: randRange(rng, 8, 40),
        sources: randInt(rng, 2, 5),
        seed: randInt(rng, 0, 100),
      });
    }
    newLayers.push(layer);
  }

  // 1-2 random effect layers from the safe subset, moderate strength
  const effectPool: Array<[string, () => Record<string, ParamValue>]> = [
    ['glitch', () => ({ intensity: randRange(rng, 0.15, 0.45), shift: randRange(rng, 0.003, 0.014), blocks: randInt(rng, 12, 48), seed: randInt(rng, 0, 100) })],
    ['chromatic-aberration', () => ({ amount: randRange(rng, 0.004, 0.018) })],
    ['dither', () => ({ levels: randInt(rng, 3, 6), scale: pick(rng, [1, 1, 2]) })],
    ['bloom', () => ({ threshold: randRange(rng, 0.45, 0.7), amount: randRange(rng, 0.3, 0.9), radius: randInt(rng, 8, 28) })],
    ['vignette', () => ({ amount: randRange(rng, 0.3, 0.6), radius: randRange(rng, 0.6, 0.95), softness: randRange(rng, 0.25, 0.6) })],
    ['pixelate', () => ({ size: randInt(rng, 3, 10) })],
  ];
  const effectCount = randInt(rng, 1, 2);
  const shuffled = [...effectPool].sort(() => rng() - 0.5);
  for (let i = 0; i < effectCount; i++) {
    const [type, params] = shuffled[i];
    const layer = makeLayer(`Random ${type}`, 'adjustment');
    layer.procedural = makeNode(type, params());
    newLayers.push(layer);
  }

  // replace the previous roll in place (or insert at the bottom of the stack),
  // effects directly above their base
  const before = useStore.getState().doc!;
  const firstOld = before.layers.findIndex(isRandomizerLayer);
  const kept = before.layers.filter((l) => !isRandomizerLayer(l));
  const insertAt = firstOld < 0 ? 0 : before.layers.slice(0, firstOld).filter((l) => !isRandomizerLayer(l)).length;
  const layers = [...kept.slice(0, insertAt), ...newLayers, ...kept.slice(insertAt)];
  const activeKept = kept.some((l) => l.id === before.activeLayerId);
  const after: Doc = {
    ...before,
    layers,
    activeLayerId: activeKept
      ? before.activeLayerId
      : kept.length ? kept[kept.length - 1].id : newLayers[newLayers.length - 1].id,
  };
  const replaced = before.layers.length - kept.length;
  const s0 = useStore.getState();
  const rollsUsed = restore ? s0.rollsUsed : s0.rollsUsed + 1;
  const ideas = s0.ideas.includes(seed) ? s0.ideas : [...s0.ideas, seed];
  useStore.setState({ doc: after, seed, rollsUsed, ideas });
  for (const l of newLayers) bumpLayer(l.id);
  pushHistory({
    label: restore ? 'Restore Idea' : 'Randomize',
    undo: () => {
      useStore.setState({ doc: before });
      for (const l of before.layers) bumpLayer(l.id);
      touch();
    },
    redo: () => {
      useStore.setState({ doc: after });
      for (const l of newLayers) bumpLayer(l.id);
    },
  });
  requestFit();
  const count = restore ? 'restored idea' : `roll ${rollsUsed}/${MAX_ROLLS}`;
  setStatus(`Randomized! ${count} · seed ${seed} · ${base} base · ${scheme} palette · ${newLayers.length - 1} effect(s)${replaced ? ' · replaced previous roll (undo brings it back)' : ''}`);
}
