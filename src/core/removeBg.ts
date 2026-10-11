// Remove Background. Two ways to build a soft "keep" mask (0 = background,
// 1 = subject) over the active layer's content, then a live-previewed edge
// refinement before committing as one undo step:
//
//   - subject (AI): U²-Net-P salient-object segmentation (Apache-2.0, 4.5 MB,
//     shipped in public/models — no network calls) run with onnxruntime-web's
//     single-threaded WASM backend. Works on busy backdrops (car in front of a
//     house). Runtime + model load lazily on first use.
//   - backdrop (color): flood from the image border through pixels close to
//     the border color. Pixel-exact for studio/product shots on plain colors.
//
// While the dialog is open the layer shows a preview (no history); Apply
// commits original → result, Cancel restores the original.

import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { useStore, commitPixels, paintTarget, bumpLayer, setStatus } from '../store';
import { getPixels, setPixels, cloneImageData, contentBounds, makeCanvas, imageDataToCanvas, type Rect } from './pixels';

export type BgMode = 'subject' | 'backdrop';

const SIZE = 320; // U²-Net-P input resolution
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// ---------- model ----------

let sessionP: Promise<{ session: InferenceSession; Tensor: typeof Tensor }> | null = null;

function loadModel(): Promise<{ session: InferenceSession; Tensor: typeof Tensor }> {
  if (!sessionP) {
    sessionP = (async () => {
      const [ort, wasm, mjs] = await Promise.all([
        import('onnxruntime-web/wasm'),
        import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url'),
        import('onnxruntime-web/ort-wasm-simd-threaded.mjs?url'),
      ]);
      ort.env.wasm.wasmPaths = { wasm: wasm.default, mjs: mjs.default };
      ort.env.wasm.numThreads = 1; // threads need cross-origin isolation headers
      const res = await fetch(`${import.meta.env.BASE_URL}models/u2netp.onnx`);
      if (!res.ok) throw new Error(`model download failed (${res.status})`);
      const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
        executionProviders: ['wasm'],
      });
      return { session, Tensor: ort.Tensor };
    })();
    sessionP.catch(() => { sessionP = null; }); // allow a retry after a failure
  }
  return sessionP;
}

/** Soft subject mask for `rect` of `px`, values 0..1, rect-sized. */
async function subjectMask(px: ImageData, rect: Rect): Promise<Float32Array> {
  const { session, Tensor } = await loadModel();
  // model input: region stretched to 320², scaled by its max, ImageNet-normalized
  const small = makeCanvas(SIZE, SIZE);
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(imageDataToCanvas(px), rect.x, rect.y, rect.w, rect.h, 0, 0, SIZE, SIZE);
  const rgba = sctx.getImageData(0, 0, SIZE, SIZE).data;
  let max = 1;
  for (let i = 0; i < rgba.length; i++) if ((i & 3) !== 3 && rgba[i] > max) max = rgba[i];
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (rgba[i * 4 + c] / max - MEAN[c]) / STD[c];
  }
  const out = await session.run({ [session.inputNames[0]]: new Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const pred = out[session.outputNames[0]].data as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of pred) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  // upscale the 320² prediction back to the region with bilinear smoothing
  const maskImg = new ImageData(SIZE, SIZE);
  for (let i = 0; i < plane; i++) maskImg.data[i * 4 + 3] = Math.round(((pred[i] - lo) / span) * 255);
  const big = makeCanvas(rect.w, rect.h);
  const bctx = big.getContext('2d', { willReadFrequently: true })!;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(imageDataToCanvas(maskImg), 0, 0, rect.w, rect.h);
  const up = bctx.getImageData(0, 0, rect.w, rect.h).data;
  const mask = new Float32Array(rect.w * rect.h);
  for (let i = 0; i < mask.length; i++) mask[i] = up[i * 4 + 3] / 255;
  return mask;
}

/** Soft mask removing the border-connected backdrop color, rect-sized. */
function backdropMask(px: ImageData, rect: Rect, tolerance: number): Float32Array {
  const { w, h } = rect;
  const d = px.data;
  const at = (x: number, y: number) => ((rect.y + y) * px.width + rect.x + x) * 4;
  // backdrop color = per-channel median of the region's border pixels
  const border: number[][] = [[], [], []];
  const pushBorder = (x: number, y: number) => { const o = at(x, y); for (let c = 0; c < 3; c++) border[c].push(d[o + c]); };
  for (let x = 0; x < w; x++) { pushBorder(x, 0); pushBorder(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { pushBorder(0, y); pushBorder(w - 1, y); }
  const bg = border.map((ch) => ch.sort((a, b) => a - b)[ch.length >> 1]);
  const dist = (o: number) => Math.hypot(d[o] - bg[0], d[o + 1] - bg[1], d[o + 2] - bg[2]);

  const mask = new Float32Array(w * h).fill(1);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (x: number, y: number) => {
    const i = y * w + x;
    if (seen[i]) return;
    seen[i] = 1;
    const o = at(x, y);
    const dd = d[o + 3] === 0 ? 0 : dist(o); // already-transparent pixels are backdrop
    if (dd > tolerance) return;
    mask[i] = (dd / Math.max(1, tolerance)) * 0.5; // soft ramp up to the edge
    stack.push(i);
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) tryPush(x - 1, y);
    if (x < w - 1) tryPush(x + 1, y);
    if (y > 0) tryPush(x, y - 1);
    if (y < h - 1) tryPush(x, y + 1);
  }
  return mask;
}

// ---------- dialog session ----------

interface Session {
  layerId: string;
  original: ImageData;
  rect: Rect;
  mask: Float32Array | null; // rect-sized
}

let session: Session | null = null;
let token = 0;

/** Start a removal session on the active layer. Returns an error message, or null. */
export function openRemoveBg(): string | null {
  const layer = paintTarget();
  if (!layer) return 'Select an unlocked image layer first';
  const px = getPixels(layer.id)!;
  const rect = contentBounds(px);
  if (!rect) return 'The active layer is empty';
  session = { layerId: layer.id, original: px, rect, mask: null };
  return null;
}

/** (Re)compute the keep-mask. Resolves false if superseded or closed meanwhile. */
export async function computeMask(mode: BgMode, tolerance: number): Promise<boolean> {
  const s = session;
  if (!s) return false;
  const my = ++token;
  const mask = mode === 'subject'
    ? await subjectMask(s.original, s.rect)
    : backdropMask(s.original, s.rect, tolerance);
  if (my !== token || session !== s) return false;
  s.mask = mask;
  return true;
}

function refined(cutoff: number, softness: number): ImageData | null {
  const s = session;
  if (!s?.mask) return null;
  const out = cloneImageData(s.original);
  const { x: rx, y: ry, w, h } = s.rect;
  const lo = cutoff - softness / 2;
  const hi = cutoff + softness / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = s.mask[y * w + x];
      let k: number;
      if (hi - lo < 1e-4) k = m >= cutoff ? 1 : 0;
      else {
        const t = Math.max(0, Math.min(1, (m - lo) / (hi - lo)));
        k = t * t * (3 - 2 * t);
      }
      const o = ((ry + y) * out.width + rx + x) * 4 + 3;
      out.data[o] = Math.round(out.data[o] * k);
    }
  }
  return out;
}

/** Show the refined result on the layer (no history). */
export function previewRemoveBg(cutoff: number, softness: number): void {
  const s = session;
  const out = refined(cutoff, softness);
  if (!s || !out) return;
  setPixels(s.layerId, out);
  bumpLayer(s.layerId);
}

export function applyRemoveBg(cutoff: number, softness: number): void {
  const s = session;
  const out = refined(cutoff, softness);
  session = null;
  token++;
  if (!s) return;
  if (!out || !useStore.getState().doc?.layers.some((l) => l.id === s.layerId)) {
    setPixels(s.layerId, s.original);
    bumpLayer(s.layerId);
    return;
  }
  setPixels(s.layerId, s.original); // commitPixels diffs from the untouched original
  commitPixels(s.layerId, 'Remove Background', s.original, out, s.rect);
  setStatus('Background removed — Ctrl/⌘+Z to undo');
}

export function cancelRemoveBg(): void {
  const s = session;
  session = null;
  token++;
  if (!s) return;
  setPixels(s.layerId, s.original);
  bumpLayer(s.layerId);
}

/** Mask stats for the dialog: fraction of the content kept at the given cutoff. */
export function keptFraction(cutoff: number): number | null {
  const m = session?.mask;
  if (!m) return null;
  let n = 0;
  for (const v of m) if (v >= cutoff) n++;
  return n / m.length;
}
