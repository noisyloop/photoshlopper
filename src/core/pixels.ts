// Pixel registry: per-layer ImageData buffers live here, outside the Zustand
// store, keyed by layer id. All layer buffers are document-sized. The store
// bumps `layerVersions[id]` whenever pixels change; the compositor and
// thumbnails watch that to re-upload.

const registry = new Map<string, ImageData>();

export function getPixels(id: string): ImageData | undefined {
  return registry.get(id);
}

export function setPixels(id: string, data: ImageData): void {
  registry.set(id, data);
}

export function deletePixels(id: string): void {
  registry.delete(id);
}

export function clearAllPixels(): void {
  registry.clear();
}

export function listPixelIds(): string[] {
  return [...registry.keys()];
}

// ---- ImageData helpers ----

export function makeImageData(w: number, h: number): ImageData {
  return new ImageData(w, h);
}

export function cloneImageData(src: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  const c = makeCanvas(data.width, data.height);
  c.getContext('2d')!.putImageData(data, 0, 0);
  return c;
}

export function canvasToImageData(c: HTMLCanvasElement): ImageData {
  return c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality);
  });
}

export async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Bounds of non-transparent pixels; null if fully transparent. */
export function contentBounds(data: ImageData, alphaThreshold = 1): Rect | null {
  const { width: w, height: h, data: px } = data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] >= alphaThreshold) {
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

/** Copy a sub-rect of an ImageData (clamped to bounds). */
export function cropImageData(src: ImageData, r: Rect): ImageData {
  const c = imageDataToCanvas(src);
  const out = makeCanvas(Math.max(1, r.w), Math.max(1, r.h));
  out.getContext('2d')!.drawImage(c, -r.x, -r.y);
  return canvasToImageData(out);
}

/** Snapshot of a rect region, for compact undo entries. */
export interface RegionSnapshot { rect: Rect; data: ImageData }

export function snapshotRegion(src: ImageData, rect: Rect): RegionSnapshot {
  const r = clampRect(rect, src.width, src.height);
  return { rect: r, data: cropImageData(src, r) };
}

export function restoreRegion(dst: ImageData, snap: RegionSnapshot): void {
  const { rect, data } = snap;
  for (let y = 0; y < rect.h; y++) {
    const srcOff = y * rect.w * 4;
    const dstOff = ((rect.y + y) * dst.width + rect.x) * 4;
    dst.data.set(data.data.subarray(srcOff, srcOff + rect.w * 4), dstOff);
  }
}

export function clampRect(r: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(w, Math.ceil(r.x + r.w));
  const y2 = Math.min(h, Math.ceil(r.y + r.h));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export function fullRect(data: ImageData): Rect {
  return { x: 0, y: 0, w: data.width, h: data.height };
}

/** Union of two rects (either may be null). */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Render a doc-sized alpha mask (1 byte/px) into a canvas (white where selected). */
export function maskToCanvas(mask: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const img = new ImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
    img.data[o + 3] = mask[i];
  }
  return imageDataToCanvas(img);
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
