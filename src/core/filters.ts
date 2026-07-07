// Destructive CPU filters — for algorithms that can't run as single-pass
// GLSL procedural nodes. Currently just Floyd–Steinberg dithering, which is
// inherently sequential (error diffusion). Applied to the active layer's
// pixels with a normal undo entry.

import { useStore, paintTarget, commitPixels } from '../store';
import { getPixels, cloneImageData } from './pixels';

export function applyFloydSteinberg(levels = 2): void {
  const layer = paintTarget();
  const doc = useStore.getState().doc;
  if (!layer || !doc) return;
  const before = getPixels(layer.id)!;
  const after = cloneImageData(before);
  const { width: w, height: h, data } = after;
  const n = Math.max(2, levels) - 1;
  const sel = doc.selection;
  // work in float error buffers per channel
  const err = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (sel && sel[i] === 0) continue;
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        const old = data[o + c] + err[i * 3 + c];
        const q = Math.round((Math.max(0, Math.min(255, old)) / 255) * n) * (255 / n);
        data[o + c] = q;
        const e = old - q;
        if (x + 1 < w) err[(i + 1) * 3 + c] += (e * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) err[(i + w - 1) * 3 + c] += (e * 3) / 16;
          err[(i + w) * 3 + c] += (e * 5) / 16;
          if (x + 1 < w) err[(i + w + 1) * 3 + c] += (e * 1) / 16;
        }
      }
    }
  }
  commitPixels(layer.id, 'Floyd–Steinberg Dither', before, after);
}
