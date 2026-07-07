// Marquee (rect/ellipse), Lasso (freehand) and Magic Wand.
// Shift = add to selection, Alt = subtract.

import { useStore, setSelection, deselect } from '../store';
import { rectMask, ellipseMask, polygonMask, floodSelect, combineMasks, type CombineMode } from '../core/selection';
import { getCompositor } from '../core/compositor';
import type { Tool, PointerInfo, ViewInfo } from './framework';

let anchor: { x: number; y: number } | null = null;
let current: { x: number; y: number } | null = null;
let combine: CombineMode = 'replace';
let lassoPoints: Array<[number, number]> = [];

const modeFrom = (p: PointerInfo): CombineMode => (p.shift ? 'add' : p.alt ? 'subtract' : 'replace');

export const marqueeTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => {
    anchor = { x: p.docX, y: p.docY };
    current = anchor;
    combine = modeFrom(p);
  },
  onMove: (p, down) => {
    if (down && anchor) current = { x: p.docX, y: p.docY };
  },
  onUp: (p) => {
    const s = useStore.getState();
    if (!anchor || !s.doc) return;
    const x0 = Math.min(anchor.x, p.docX);
    const y0 = Math.min(anchor.y, p.docY);
    const w = Math.abs(p.docX - anchor.x);
    const h = Math.abs(p.docY - anchor.y);
    anchor = null;
    current = null;
    if (w < 2 && h < 2) {
      deselect();
      return;
    }
    const mask = s.marqueeKind === 'rect'
      ? rectMask(s.doc.width, s.doc.height, x0, y0, w, h)
      : ellipseMask(s.doc.width, s.doc.height, x0 + w / 2, y0 + h / 2, w / 2, h / 2);
    setSelection(combineMasks(s.doc.selection, mask, combine), 'Marquee Select');
  },
  drawOverlay: (ctx, view) => {
    if (!anchor || !current) return;
    const s = useStore.getState();
    const [ax, ay] = view.docToView(anchor.x, anchor.y);
    const [cx, cy] = view.docToView(current.x, current.y);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    if (s.marqueeKind === 'rect') {
      ctx.strokeRect(Math.min(ax, cx), Math.min(ay, cy), Math.abs(cx - ax), Math.abs(cy - ay));
    } else {
      ctx.beginPath();
      ctx.ellipse((ax + cx) / 2, (ay + cy) / 2, Math.abs(cx - ax) / 2, Math.abs(cy - ay) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  },
};

export const lassoTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => {
    lassoPoints = [[p.docX, p.docY]];
    combine = modeFrom(p);
  },
  onMove: (p, down) => {
    if (!down || lassoPoints.length === 0) return;
    const last = lassoPoints[lassoPoints.length - 1];
    if (Math.hypot(p.docX - last[0], p.docY - last[1]) > 1.5) lassoPoints.push([p.docX, p.docY]);
  },
  onUp: () => {
    const s = useStore.getState();
    if (!s.doc || lassoPoints.length < 3) {
      lassoPoints = [];
      deselect();
      return;
    }
    const mask = polygonMask(s.doc.width, s.doc.height, lassoPoints);
    lassoPoints = [];
    setSelection(combineMasks(s.doc.selection, mask, combine), 'Lasso Select');
  },
  drawOverlay: (ctx, view: ViewInfo) => {
    if (lassoPoints.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    const [sx, sy] = view.docToView(lassoPoints[0][0], lassoPoints[0][1]);
    ctx.moveTo(sx, sy);
    for (const [x, y] of lassoPoints) {
      const [vx, vy] = view.docToView(x, y);
      ctx.lineTo(vx, vy);
    }
    ctx.stroke();
    ctx.restore();
  },
};

export const wandTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => {
    const s = useStore.getState();
    if (!s.doc) return;
    const composite = getCompositor().renderToImageData(s.doc, s.layerVersions);
    const mask = floodSelect(composite, p.docX, p.docY, s.tolerance);
    setSelection(combineMasks(s.doc.selection, mask, modeFrom(p)), 'Magic Wand');
  },
  onMove: () => {},
  onUp: () => {},
};
