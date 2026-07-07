// Shape tool (rect / ellipse / line; Shift constrains) and the Type tool
// (opens a text overlay; commit rasterizes into a text layer whose meta keeps
// the source text so it can be re-edited with the Type tool).

import { useStore, insertLayerWithPixels, setStatus, activeLayer } from '../store';
import { makeCanvas, canvasToImageData } from '../core/pixels';
import type { Tool, PointerInfo, ViewInfo } from './framework';

let anchor: { x: number; y: number } | null = null;
let current: { x: number; y: number } | null = null;
let constrain = false;

function snapTo45(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len };
}

function shapeRect(p: { x: number; y: number }, q: { x: number; y: number }) {
  let w = q.x - p.x;
  let h = q.y - p.y;
  if (constrain) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m;
    h = Math.sign(h || 1) * m;
  }
  return { x: w < 0 ? p.x + w : p.x, y: h < 0 ? p.y + h : p.y, w: Math.abs(w), h: Math.abs(h), x2: p.x + w, y2: p.y + h };
}

export const shapeTool: Tool = {
  cursor: 'crosshair',
  onDown: (p) => {
    anchor = { x: p.docX, y: p.docY };
    current = anchor;
    constrain = p.shift;
  },
  onMove: (p, down) => {
    if (!down || !anchor) return;
    current = { x: p.docX, y: p.docY };
    constrain = p.shift;
  },
  onUp: (p) => {
    const s = useStore.getState();
    if (!anchor || !s.doc) return;
    const a = anchor;
    const end = constrain && s.shapeKind === 'line'
      ? snapTo45(a, { x: p.docX, y: p.docY })
      : { x: p.docX, y: p.docY };
    const r = shapeRect(a, end);
    anchor = null;
    current = null;
    if (r.w < 2 && r.h < 2) return;
    const c = makeCanvas(s.doc.width, s.doc.height);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = s.fg;
    ctx.strokeStyle = s.fg;
    ctx.lineWidth = s.shapeStrokeWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (s.shapeKind === 'line') {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    } else {
      if (s.shapeKind === 'rect') ctx.rect(r.x, r.y, r.w, r.h);
      else ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      if (s.shapeFill) ctx.fill();
      else ctx.stroke();
    }
    insertLayerWithPixels(`${s.shapeKind} shape`, 'shape', canvasToImageData(c), { shape: s.shapeKind }, 'New Shape');
  },
  drawOverlay: (ctx, view: ViewInfo) => {
    if (!anchor || !current) return;
    const s = useStore.getState();
    const r = shapeRect(anchor, current);
    const [x0, y0] = view.docToView(r.x, r.y);
    const [x1, y1] = view.docToView(r.x + r.w, r.y + r.h);
    ctx.save();
    ctx.strokeStyle = '#4af';
    ctx.setLineDash([4, 4]);
    if (s.shapeKind === 'rect') ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    else if (s.shapeKind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const [ax, ay] = view.docToView(anchor.x, anchor.y);
      const [cx, cy] = view.docToView(current.x, current.y);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(cx, cy);
      ctx.stroke();
    }
    ctx.restore();
  },
};

export const typeTool: Tool = {
  cursor: 'text',
  onDown: (p: PointerInfo) => {
    const s = useStore.getState();
    if (!s.doc || s.textSession) return;
    const layer = activeLayer();
    // clicking with the type tool while a text layer is active re-edits it
    if (layer && layer.kind === 'text' && layer.meta?.text) {
      useStore.setState({
        textSession: {
          layerId: layer.id,
          x: (layer.meta.x as number) ?? p.docX,
          y: (layer.meta.y as number) ?? p.docY,
          text: String(layer.meta.text),
        },
      });
      return;
    }
    useStore.setState({ textSession: { layerId: null, x: p.docX, y: p.docY, text: '' } });
    setStatus('Type text. Enter commits, Shift+Enter for a new line, Esc cancels.');
  },
  onMove: () => {},
  onUp: () => {},
};
