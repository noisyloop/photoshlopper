// Free Transform (Ctrl/Cmd+T) — a pseudo-tool that takes over pointer input
// while a transform session is active. Drag inside to move, drag corner
// handles to scale (Shift = uniform), Alt+drag a handle to rotate.
// Enter commits (history entry), Esc cancels. Non-destructive: only the
// layer's transform changes; the compositor applies it when sampling.

import { useStore, setLayerTransform } from '../store';
import type { Transform } from '../types';
import type { PointerInfo, ViewInfo } from './framework';

type DragMode = 'move' | 'scale' | 'rotate' | null;

let drag: {
  mode: DragMode;
  start: PointerInfo;
  startT: Transform;
  handle: number; // corner index 0..3
  center: { x: number; y: number };
} | null = null;

function session() {
  return useStore.getState().transformSession;
}

function currentTransform(): Transform | null {
  const s = useStore.getState();
  const sess = s.transformSession;
  if (!sess || !s.doc) return null;
  const layer = s.doc.layers.find((l) => l.id === sess.layerId);
  return layer ? layer.transform : null;
}

/** Doc-space corners of the transformed layer bounds. */
function corners(): Array<[number, number]> | null {
  const s = useStore.getState();
  const t = currentTransform();
  if (!t || !s.doc) return null;
  const w = s.doc.width;
  const h = s.doc.height;
  const cx = w / 2;
  const cy = h / 2;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const pts: Array<[number, number]> = [[0, 0], [w, 0], [w, h], [0, h]];
  return pts.map(([x, y]) => {
    const lx = (x - cx) * t.scaleX;
    const ly = (y - cy) * t.scaleY;
    return [lx * cos - ly * sin + cx + t.x, lx * sin + ly * cos + cy + t.y];
  });
}

const HANDLE_HIT = 10; // view px

export function transformActive(): boolean {
  return !!session();
}

export function transformDown(p: PointerInfo, view: ViewInfo): void {
  const t = currentTransform();
  const pts = corners();
  if (!t || !pts) return;
  const s = useStore.getState();
  const center = { x: s.doc!.width / 2 + t.x, y: s.doc!.height / 2 + t.y };
  // hit-test handles in view space
  let handle = -1;
  for (let i = 0; i < 4; i++) {
    const [vx, vy] = view.docToView(pts[i][0], pts[i][1]);
    if (Math.hypot(vx - p.viewX, vy - p.viewY) <= HANDLE_HIT) {
      handle = i;
      break;
    }
  }
  drag = {
    mode: handle >= 0 ? (p.alt ? 'rotate' : 'scale') : 'move',
    start: p,
    startT: { ...t },
    handle,
    center,
  };
}

export function transformMove(p: PointerInfo): void {
  if (!drag) return;
  const sess = session();
  if (!sess) return;
  const { start, startT, center } = drag;
  if (drag.mode === 'move') {
    setLayerTransform(sess.layerId, {
      ...startT,
      x: startT.x + (p.docX - start.docX),
      y: startT.y + (p.docY - start.docY),
    });
  } else if (drag.mode === 'scale') {
    const d0 = Math.max(1e-3, Math.hypot(start.docX - center.x, start.docY - center.y));
    const d1 = Math.hypot(p.docX - center.x, p.docY - center.y);
    const f = d1 / d0;
    if (p.shift) {
      setLayerTransform(sess.layerId, { ...startT, scaleX: startT.scaleX * f, scaleY: startT.scaleY * f });
    } else {
      // scale each axis by pointer movement relative to center, in layer space
      const cos = Math.cos(startT.rotation);
      const sin = Math.sin(startT.rotation);
      const unrot = (x: number, y: number): [number, number] => [x * cos + y * sin, -x * sin + y * cos];
      const [sx0, sy0] = unrot(start.docX - center.x, start.docY - center.y);
      const [sx1, sy1] = unrot(p.docX - center.x, p.docY - center.y);
      const fx = Math.abs(sx0) < 2 ? 1 : sx1 / sx0;
      const fy = Math.abs(sy0) < 2 ? 1 : sy1 / sy0;
      setLayerTransform(sess.layerId, { ...startT, scaleX: startT.scaleX * fx, scaleY: startT.scaleY * fy });
    }
  } else if (drag.mode === 'rotate') {
    const a0 = Math.atan2(start.docY - center.y, start.docX - center.x);
    const a1 = Math.atan2(p.docY - center.y, p.docX - center.x);
    setLayerTransform(sess.layerId, { ...startT, rotation: startT.rotation + (a1 - a0) });
  }
}

export function transformUp(): void {
  drag = null;
}

export function drawTransformOverlay(ctx: CanvasRenderingContext2D, view: ViewInfo): void {
  const pts = corners();
  if (!pts) return;
  ctx.save();
  ctx.strokeStyle = '#4af';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const vpts = pts.map(([x, y]) => view.docToView(x, y));
  ctx.moveTo(vpts[0][0], vpts[0][1]);
  for (let i = 1; i <= 4; i++) ctx.lineTo(vpts[i % 4][0], vpts[i % 4][1]);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const [vx, vy] of vpts) {
    ctx.beginPath();
    ctx.rect(vx - 4, vy - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
