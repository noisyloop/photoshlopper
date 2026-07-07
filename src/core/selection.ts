// Selection utilities. A selection is just a doc-sized alpha mask
// (Uint8ClampedArray, one byte per pixel) — the same primitive as layer masks.

import { makeCanvas } from './pixels';

export type CombineMode = 'replace' | 'add' | 'subtract';

export function combineMasks(
  base: Uint8ClampedArray | undefined,
  next: Uint8ClampedArray,
  mode: CombineMode,
): Uint8ClampedArray {
  if (mode === 'replace' || !base) {
    return mode === 'subtract' && !base ? new Uint8ClampedArray(next.length) : next;
  }
  const out = new Uint8ClampedArray(base);
  if (mode === 'add') {
    for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], next[i]);
  } else {
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, out[i] - next[i]);
  }
  return out;
}

/** Rasterize a path-drawing callback into a mask via canvas alpha. */
function rasterizeToMask(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Uint8ClampedArray {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  draw(ctx);
  const img = ctx.getImageData(0, 0, w, h);
  const mask = new Uint8ClampedArray(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = img.data[i * 4 + 3];
  return mask;
}

export function rectMask(w: number, h: number, x: number, y: number, rw: number, rh: number): Uint8ClampedArray {
  return rasterizeToMask(w, h, (ctx) => ctx.fillRect(x, y, rw, rh));
}

export function ellipseMask(w: number, h: number, cx: number, cy: number, rx: number, ry: number): Uint8ClampedArray {
  return rasterizeToMask(w, h, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

export function polygonMask(w: number, h: number, points: Array<[number, number]>): Uint8ClampedArray {
  return rasterizeToMask(w, h, (ctx) => {
    if (points.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    ctx.fill();
  });
}

/**
 * Contiguous flood select (scanline BFS) on `source` starting at (sx, sy),
 * selecting pixels whose RGBA distance from the start pixel is <= tolerance.
 * Used by both the Magic Wand (returns the mask) and the Paint Bucket.
 */
export function floodSelect(source: ImageData, sx: number, sy: number, tolerance: number): Uint8ClampedArray {
  const { width: w, height: h, data } = source;
  const mask = new Uint8ClampedArray(w * h);
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const start = (sy * w + sx) * 4;
  const r0 = data[start], g0 = data[start + 1], b0 = data[start + 2], a0 = data[start + 3];
  const tolSq = tolerance * tolerance * 4; // 4 channels
  const matches = (i: number): boolean => {
    const o = i * 4;
    const dr = data[o] - r0, dg = data[o + 1] - g0, db = data[o + 2] - b0, da = data[o + 3] - a0;
    return dr * dr + dg * dg + db * db + da * da <= tolSq;
  };
  const stack: number[] = [sy * w + sx];
  while (stack.length) {
    const idx = stack.pop()!;
    if (mask[idx]) continue;
    const y = Math.floor(idx / w);
    let x = idx % w;
    // walk left
    while (x > 0 && !mask[y * w + x - 1] && matches(y * w + x - 1)) x--;
    let spanUp = false;
    let spanDown = false;
    let i = y * w + x;
    while (x < w && !mask[i] && matches(i)) {
      mask[i] = 255;
      if (y > 0) {
        const up = i - w;
        if (!mask[up] && matches(up)) {
          if (!spanUp) { stack.push(up); spanUp = true; }
        } else spanUp = false;
      }
      if (y < h - 1) {
        const down = i + w;
        if (!mask[down] && matches(down)) {
          if (!spanDown) { stack.push(down); spanDown = true; }
        } else spanDown = false;
      }
      x++;
      i++;
    }
  }
  return mask;
}

export function maskBounds(mask: Uint8ClampedArray, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
