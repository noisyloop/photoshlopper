// Stamp-based brush engine. Stamps a soft/hard round dab along the pointer
// path at `spacing * size` intervals into an offscreen stroke buffer. The
// buffer is baked over a backup of the layer every frame for live preview and
// once on pointer-up for the final commit -> exactly one undo entry a stroke.

import { makeCanvas, canvasToImageData, imageDataToCanvas, maskToCanvas, unionRect, type Rect } from './pixels';

export type StrokeMode = 'paint' | 'erase' | 'clone';

export interface StrokeOptions {
  size: number;
  hardness: number; // 0..1
  flow: number;     // 0..1 alpha per stamp
  opacity: number;  // 0..1 stroke ceiling, applied at bake
  color: string;
  spacing: number;  // fraction of size between stamps
  mode: StrokeMode;
  pressureSize: boolean;
  /** clone mode: snapshot of the source content + offset from dest to source */
  cloneSource?: HTMLCanvasElement;
  cloneOffset?: { x: number; y: number };
}

export class StrokeEngine {
  private buffer: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private last: { x: number; y: number } | null = null;
  private residual = 0;
  private opts: StrokeOptions;
  dirty: Rect | null = null;

  constructor(width: number, height: number, opts: StrokeOptions) {
    this.buffer = makeCanvas(width, height);
    this.ctx = this.buffer.getContext('2d')!;
    this.opts = opts;
  }

  private stamp(x: number, y: number, pressure: number): void {
    const o = this.opts;
    const size = Math.max(1, o.size * (o.pressureSize ? Math.max(0.15, pressure) : 1));
    const r = size / 2;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = o.flow;
    if (o.mode === 'clone' && o.cloneSource && o.cloneOffset) {
      const stampC = makeCanvas(Math.ceil(size) + 2, Math.ceil(size) + 2);
      const sctx = stampC.getContext('2d')!;
      const g = sctx.createRadialGradient(r + 1, r + 1, Math.max(0, r * o.hardness * 0.99), r + 1, r + 1, r);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, stampC.width, stampC.height);
      sctx.globalCompositeOperation = 'source-in';
      sctx.drawImage(o.cloneSource, o.cloneOffset.x - (x - r - 1), o.cloneOffset.y - (y - r - 1));
      ctx.drawImage(stampC, x - r - 1, y - r - 1);
    } else {
      const g = ctx.createRadialGradient(x, y, Math.max(0, r * o.hardness * 0.99), x, y, r);
      // erase strokes only need alpha coverage; color is irrelevant
      const col = o.mode === 'erase' ? '0,0,0' : hexToRgbStr(o.color);
      g.addColorStop(0, `rgba(${col},1)`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this.dirty = unionRect(this.dirty, { x: x - r - 2, y: y - r - 2, w: size + 4, h: size + 4 });
  }

  begin(x: number, y: number, pressure = 1): void {
    this.last = { x, y };
    this.residual = 0;
    this.stamp(x, y, pressure);
  }

  moveTo(x: number, y: number, pressure = 1): void {
    if (!this.last) {
      this.begin(x, y, pressure);
      return;
    }
    const spacing = Math.max(1, this.opts.size * this.opts.spacing);
    let { x: px, y: py } = this.last;
    const dx = x - px;
    const dy = y - py;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    let t = spacing - this.residual;
    while (t <= dist) {
      this.stamp(px + (dx * t) / dist, py + (dy * t) / dist, pressure);
      t += spacing;
    }
    this.residual = dist - (t - spacing);
    this.last = { x, y };
  }

  /**
   * Composite the stroke over `backup` (layer pixels at stroke start),
   * clipped by the optional selection mask. Returns the new layer pixels.
   */
  bake(backup: ImageData, selection?: Uint8ClampedArray): ImageData {
    const w = backup.width;
    const h = backup.height;
    let stroke: HTMLCanvasElement = this.buffer;
    if (selection) {
      const masked = makeCanvas(w, h);
      const mctx = masked.getContext('2d')!;
      mctx.drawImage(this.buffer, 0, 0);
      mctx.globalCompositeOperation = 'destination-in';
      mctx.drawImage(maskToCanvas(selection, w, h), 0, 0);
      stroke = masked;
    }
    const out = imageDataToCanvas(backup);
    const octx = out.getContext('2d')!;
    octx.globalAlpha = this.opts.opacity;
    octx.globalCompositeOperation = this.opts.mode === 'erase' ? 'destination-out' : 'source-over';
    octx.drawImage(stroke, 0, 0);
    return canvasToImageData(out);
  }
}

function hexToRgbStr(hex: string): string {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  return `${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)}`;
}
