// Brush, Eraser and Clone Stamp — all built on the stamp StrokeEngine.
// Live preview bakes the stroke over a backup of the layer every move;
// pointer-up commits one history entry for the whole stroke.

import { StrokeEngine, type StrokeMode } from '../core/brush';
import { getPixels, imageDataToCanvas } from '../core/pixels';
import { useStore, paintTarget, commitPixels, bumpLayer, setStatus } from '../store';
import { setPixels } from '../core/pixels';
import type { Tool, PointerInfo } from './framework';

let engine: StrokeEngine | null = null;
let backup: ImageData | null = null;
let targetId: string | null = null;
let cloneSourcePoint: { x: number; y: number } | null = null;

function beginStroke(mode: StrokeMode, p: PointerInfo): void {
  const s = useStore.getState();
  const layer = paintTarget();
  if (!layer || !s.doc) return;
  if (mode === 'clone' && !cloneSourcePoint) {
    setStatus('Clone Stamp: Alt+click to set the source point first');
    return;
  }
  backup = getPixels(layer.id)!;
  targetId = layer.id;
  engine = new StrokeEngine(s.doc.width, s.doc.height, {
    size: s.brush.size,
    hardness: s.brush.hardness,
    flow: s.brush.flow,
    opacity: s.brush.opacity,
    color: mode === 'erase' ? '#000000' : s.fg,
    spacing: s.brush.spacing,
    mode,
    pressureSize: true,
    cloneSource: mode === 'clone' ? imageDataToCanvas(backup) : undefined,
    cloneOffset: mode === 'clone' && cloneSourcePoint
      ? { x: cloneSourcePoint.x - p.docX, y: cloneSourcePoint.y - p.docY }
      : undefined,
  });
  engine.begin(p.docX, p.docY, p.pressure);
  bakeLive();
}

function bakeLive(): void {
  if (!engine || !backup || !targetId) return;
  const sel = useStore.getState().doc?.selection;
  setPixels(targetId, engine.bake(backup, sel));
  bumpLayer(targetId);
}

function moveStroke(p: PointerInfo, down: boolean): void {
  if (!down || !engine) return;
  engine.moveTo(p.docX, p.docY, p.pressure);
  bakeLive();
}

function endStroke(label: string): void {
  if (!engine || !backup || !targetId) return;
  const sel = useStore.getState().doc?.selection;
  const after = engine.bake(backup, sel);
  commitPixels(targetId, label, backup, after, engine.dirty ?? undefined);
  engine = null;
  backup = null;
  targetId = null;
}

export const brushTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => beginStroke('paint', p),
  onMove: moveStroke,
  onUp: () => endStroke('Brush Stroke'),
};

export const eraserTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => beginStroke('erase', p),
  onMove: moveStroke,
  onUp: () => endStroke('Eraser Stroke'),
};

export const cloneTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => {
    if (p.alt) {
      cloneSourcePoint = { x: p.docX, y: p.docY };
      setStatus(`Clone source set at ${Math.round(p.docX)}, ${Math.round(p.docY)}`);
      return;
    }
    beginStroke('clone', p);
  },
  onMove: moveStroke,
  onUp: () => endStroke('Clone Stamp'),
};

/** Draw the round brush size cursor (used by Canvas for brush/eraser/clone). */
export function drawBrushCursor(ctx: CanvasRenderingContext2D, vx: number, vy: number, zoom: number): void {
  const s = useStore.getState();
  const r = (s.brush.size / 2) * zoom;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(vx, vy, Math.max(1, r), 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.arc(vx, vy, Math.max(1, r) + 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
