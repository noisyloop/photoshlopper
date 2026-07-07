// Raster export: PNG (alpha — the sticker path), JPEG, WebP.
// Scope: whole doc / active layer / trim-to-content; scale 1x/2x/4x.

import type { Doc, Layer } from '../types';
import { getCompositor } from '../core/compositor';
import { contentBounds, cropImageData, imageDataToCanvas, makeCanvas } from '../core/pixels';
import { canvasToBlob } from '../core/pixels';

export interface RasterExportOptions {
  format: 'png' | 'jpeg' | 'webp';
  quality: number; // 0..1, jpeg/webp only
  scope: 'doc' | 'layer';
  trim: boolean;
  scale: 1 | 2 | 4;
}

export interface RasterExportResult {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
}

export function renderExportImage(doc: Doc, versions: Record<string, number>, scope: 'doc' | 'layer', activeLayer: Layer | null): ImageData {
  const compositor = getCompositor();
  if (scope === 'layer' && activeLayer) {
    return compositor.renderToImageData(doc, versions, [{ ...activeLayer, visible: true }], 'transparent');
  }
  return compositor.renderToImageData(doc, versions);
}

export async function exportRaster(
  doc: Doc,
  versions: Record<string, number>,
  activeLayer: Layer | null,
  opts: RasterExportOptions,
): Promise<RasterExportResult> {
  let image = renderExportImage(doc, versions, opts.scope, activeLayer);
  if (opts.trim) {
    const bounds = contentBounds(image);
    if (bounds) image = cropImageData(image, bounds);
  }
  let canvas = imageDataToCanvas(image);
  if (opts.scale !== 1) {
    const scaled = makeCanvas(canvas.width * opts.scale, canvas.height * opts.scale);
    const ctx = scaled.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    canvas = scaled;
  }
  if (opts.format === 'jpeg') {
    // jpeg has no alpha: flatten over white
    const flat = makeCanvas(canvas.width, canvas.height);
    const ctx = flat.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    canvas = flat;
  }
  const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[opts.format];
  const blob = await canvasToBlob(canvas, mime, opts.format === 'png' ? undefined : opts.quality);
  return {
    blob,
    filename: `photoshlopper-${opts.scope}${opts.trim ? '-trimmed' : ''}@${opts.scale}x.${opts.format === 'jpeg' ? 'jpg' : opts.format}`,
    width: canvas.width,
    height: canvas.height,
  };
}
