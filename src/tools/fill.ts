// Eyedropper, Paint Bucket (flood fill) and Gradient (drag, live preview).

import { useStore, paintTarget, commitPixels, bumpLayer, setStatus } from '../store';
import { getCompositor } from '../core/compositor';
import { floodSelect } from '../core/selection';
import {
  getPixels, setPixels, imageDataToCanvas, canvasToImageData, makeCanvas, maskToCanvas,
} from '../core/pixels';
import type { Tool, PointerInfo, ViewInfo } from './framework';

export const eyedropperTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => sample(p),
  onMove: (p, down) => { if (down) sample(p); },
  onUp: () => {},
};

function sample(p: PointerInfo): void {
  const s = useStore.getState();
  if (!s.doc) return;
  const x = Math.floor(p.docX);
  const y = Math.floor(p.docY);
  if (x < 0 || y < 0 || x >= s.doc.width || y >= s.doc.height) return;
  const composite = getCompositor().renderToImageData(s.doc, s.layerVersions);
  const o = (y * s.doc.width + x) * 4;
  const hex = '#' + [composite.data[o], composite.data[o + 1], composite.data[o + 2]]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
  useStore.setState(p.alt ? { bg: hex } : { fg: hex });
  setStatus(`Sampled ${hex}`);
}

export const bucketTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => {
    const s = useStore.getState();
    const layer = paintTarget();
    if (!layer || !s.doc) return;
    const composite = getCompositor().renderToImageData(s.doc, s.layerVersions);
    const region = floodSelect(composite, p.docX, p.docY, s.tolerance);
    // respect active selection: fill only inside selection ∧ flood region
    if (s.doc.selection) {
      for (let i = 0; i < region.length; i++) region[i] = Math.min(region[i], s.doc.selection[i]);
    }
    const before = getPixels(layer.id)!;
    const out = imageDataToCanvas(before);
    const fillC = makeCanvas(s.doc.width, s.doc.height);
    const fctx = fillC.getContext('2d')!;
    fctx.fillStyle = s.fg;
    fctx.fillRect(0, 0, s.doc.width, s.doc.height);
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(maskToCanvas(region, s.doc.width, s.doc.height), 0, 0);
    out.getContext('2d')!.drawImage(fillC, 0, 0);
    commitPixels(layer.id, 'Paint Bucket', before, canvasToImageData(out));
  },
  onMove: () => {},
  onUp: () => {},
};

// ---- gradient ----

let gradAnchor: { x: number; y: number } | null = null;
let gradBackup: ImageData | null = null;
let gradTarget: string | null = null;

function bakeGradient(p: PointerInfo): ImageData | null {
  const s = useStore.getState();
  if (!gradAnchor || !gradBackup || !s.doc) return null;
  const { width: w, height: h } = s.doc;
  const gradC = makeCanvas(w, h);
  const gctx = gradC.getContext('2d')!;
  let grad: CanvasGradient;
  if (s.gradientKind === 'linear') {
    grad = gctx.createLinearGradient(gradAnchor.x, gradAnchor.y, p.docX, p.docY);
  } else {
    const r = Math.max(1, Math.hypot(p.docX - gradAnchor.x, p.docY - gradAnchor.y));
    grad = gctx.createRadialGradient(gradAnchor.x, gradAnchor.y, 0, gradAnchor.x, gradAnchor.y, r);
  }
  grad.addColorStop(0, s.fg);
  grad.addColorStop(1, s.bg);
  gctx.fillStyle = grad;
  gctx.fillRect(0, 0, w, h);
  if (s.doc.selection) {
    gctx.globalCompositeOperation = 'destination-in';
    gctx.drawImage(maskToCanvas(s.doc.selection, w, h), 0, 0);
  }
  const out = imageDataToCanvas(gradBackup);
  out.getContext('2d')!.drawImage(gradC, 0, 0);
  return canvasToImageData(out);
}

export const gradientTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => {
    const layer = paintTarget();
    if (!layer) return;
    gradAnchor = { x: p.docX, y: p.docY };
    gradBackup = getPixels(layer.id)!;
    gradTarget = layer.id;
  },
  onMove: (p, down) => {
    if (!down || !gradTarget) return;
    const baked = bakeGradient(p);
    if (baked) {
      setPixels(gradTarget, baked);
      bumpLayer(gradTarget);
    }
  },
  onUp: (p) => {
    if (!gradTarget || !gradBackup) return;
    const baked = bakeGradient(p);
    if (baked) commitPixels(gradTarget, 'Gradient', gradBackup, baked);
    gradAnchor = null;
    gradBackup = null;
    gradTarget = null;
  },
  drawOverlay: (ctx, view: ViewInfo) => {
    if (!gradAnchor) return;
    const [ax, ay] = view.docToView(gradAnchor.x, gradAnchor.y);
    ctx.save();
    ctx.fillStyle = '#4af';
    ctx.beginPath();
    ctx.arc(ax, ay, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
};
