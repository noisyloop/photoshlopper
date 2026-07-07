// Hand (pan), Zoom, Move (layer / selection contents) and Crop.

import {
  useStore, setView, zoomAt, activeLayer, setLayerTransform, setStatus,
  paintTarget, commitPixels, bumpLayer, cropDoc, setSelection,
} from '../store';
import {
  getPixels, setPixels, imageDataToCanvas, canvasToImageData, makeCanvas, maskToCanvas, cloneImageData,
} from '../core/pixels';
import type { Transform } from '../types';
import type { Tool, PointerInfo, ViewInfo } from './framework';

// ---- hand ----

let panStart: { px: number; py: number; x: number; y: number } | null = null;

export const handTool: Tool = {
  cursor: 'grab',
  onDown: (p) => {
    const s = useStore.getState();
    panStart = { px: s.panX, py: s.panY, x: p.viewX, y: p.viewY };
  },
  onMove: (p, down) => {
    if (!down || !panStart) return;
    const s = useStore.getState();
    setView(s.zoom, panStart.px + (p.viewX - panStart.x), panStart.py + (p.viewY - panStart.y));
  },
  onUp: () => { panStart = null; },
};

// ---- zoom ----

export const zoomTool: Tool = {
  cursor: 'zoom-in',
  onDown: (p) => zoomAt(p.alt ? 1 / 1.5 : 1.5, p.viewX, p.viewY),
  onMove: () => {},
  onUp: () => {},
};

// ---- move ----

interface FloatSession {
  layerId: string;
  backup: ImageData;      // layer before lift
  cleared: HTMLCanvasElement; // layer minus selection contents
  floating: HTMLCanvasElement; // lifted selection contents
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  selection: Uint8ClampedArray;
}

let moveStart: { layerId: string; t: Transform; x: number; y: number } | null = null;
let floatSession: FloatSession | null = null;

function bakeFloat(): void {
  if (!floatSession) return;
  const f = floatSession;
  const out = makeCanvas(f.backup.width, f.backup.height);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(f.cleared, 0, 0);
  ctx.drawImage(f.floating, Math.round(f.dx), Math.round(f.dy));
  setPixels(f.layerId, canvasToImageData(out));
  bumpLayer(f.layerId);
}

export const moveTool: Tool = {
  cursor: 'move',
  onDown: (p) => {
    const s = useStore.getState();
    const layer = activeLayer();
    if (!layer || !s.doc) return;
    if (layer.locked) {
      setStatus('Layer is locked');
      return;
    }
    // with a selection on a pixel layer: lift + float the selected pixels
    if (s.doc.selection && getPixels(layer.id)) {
      const target = paintTarget();
      if (!target) return;
      const backup = getPixels(layer.id)!;
      const { width: w, height: h } = backup;
      const selCanvas = maskToCanvas(s.doc.selection, w, h);
      const floating = makeCanvas(w, h);
      const fctx = floating.getContext('2d')!;
      fctx.drawImage(imageDataToCanvas(backup), 0, 0);
      fctx.globalCompositeOperation = 'destination-in';
      fctx.drawImage(selCanvas, 0, 0);
      const cleared = makeCanvas(w, h);
      const cctx = cleared.getContext('2d')!;
      cctx.drawImage(imageDataToCanvas(backup), 0, 0);
      cctx.globalCompositeOperation = 'destination-out';
      cctx.drawImage(selCanvas, 0, 0);
      floatSession = {
        layerId: layer.id, backup, cleared, floating,
        startX: p.docX, startY: p.docY, dx: 0, dy: 0,
        selection: s.doc.selection,
      };
      return;
    }
    moveStart = { layerId: layer.id, t: { ...layer.transform }, x: p.docX, y: p.docY };
  },
  onMove: (p, down) => {
    if (!down) return;
    if (floatSession) {
      floatSession.dx = p.docX - floatSession.startX;
      floatSession.dy = p.docY - floatSession.startY;
      bakeFloat();
      return;
    }
    if (moveStart) {
      setLayerTransform(moveStart.layerId, {
        ...moveStart.t,
        x: moveStart.t.x + (p.docX - moveStart.x),
        y: moveStart.t.y + (p.docY - moveStart.y),
      });
    }
  },
  onUp: () => {
    if (floatSession) {
      const f = floatSession;
      floatSession = null;
      bakeFloat();
      const after = getPixels(f.layerId)!;
      commitPixels(f.layerId, 'Move Selection', f.backup, cloneImageData(after));
      // move the selection mask along with its contents
      const w = f.backup.width, h = f.backup.height;
      const moved = new Uint8ClampedArray(w * h);
      const dx = Math.round(f.dx), dy = Math.round(f.dy);
      for (let y = 0; y < h; y++) {
        const sy = y - dy;
        if (sy < 0 || sy >= h) continue;
        for (let x = 0; x < w; x++) {
          const sx = x - dx;
          if (sx < 0 || sx >= w) continue;
          moved[y * w + x] = f.selection[sy * w + sx];
        }
      }
      setSelection(moved, 'Move Selection');
      return;
    }
    if (moveStart) {
      const s = useStore.getState();
      const layer = s.doc?.layers.find((l) => l.id === moveStart!.layerId);
      if (layer && (layer.transform.x !== moveStart.t.x || layer.transform.y !== moveStart.t.y)) {
        setLayerTransform(moveStart.layerId, layer.transform, true, moveStart.t);
      }
      moveStart = null;
    }
  },
};

// ---- crop ----

let cropAnchor: { x: number; y: number } | null = null;
let cropRect: { x: number; y: number; w: number; h: number } | null = null;

export const cropTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => {
    cropAnchor = { x: p.docX, y: p.docY };
    cropRect = null;
  },
  onMove: (p, down) => {
    if (!down || !cropAnchor) return;
    cropRect = {
      x: Math.min(cropAnchor.x, p.docX),
      y: Math.min(cropAnchor.y, p.docY),
      w: Math.abs(p.docX - cropAnchor.x),
      h: Math.abs(p.docY - cropAnchor.y),
    };
  },
  onUp: () => {
    cropAnchor = null;
    if (cropRect && (cropRect.w < 4 || cropRect.h < 4)) cropRect = null;
    if (cropRect) setStatus('Crop: press Enter to apply, Esc to cancel');
  },
  drawOverlay: (ctx, view: ViewInfo) => {
    if (!cropRect) return;
    const s = useStore.getState();
    if (!s.doc) return;
    const [x0, y0] = view.docToView(cropRect.x, cropRect.y);
    const [x1, y1] = view.docToView(cropRect.x + cropRect.w, cropRect.y + cropRect.h);
    ctx.save();
    // darken everything outside the crop rect
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const [dx0, dy0] = view.docToView(0, 0);
    const [dx1, dy1] = view.docToView(s.doc.width, s.doc.height);
    ctx.beginPath();
    ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  },
};

export function applyCrop(): boolean {
  if (!cropRect) return false;
  cropDoc(cropRect);
  cropRect = null;
  setStatus('Cropped');
  return true;
}

export function cancelCrop(): boolean {
  if (!cropRect) return false;
  cropRect = null;
  setStatus('Crop cancelled');
  return true;
}
