// Text rendering with effects. A text layer's meta holds everything needed to
// re-render it (TextMeta), so the Type tool can re-edit it and the Text panel
// can restyle it non-destructively. Effects are composited in this order,
// bottom to top: outer glow, drop shadow, 3D extrude, stroke, fill.

import { makeCanvas, canvasToImageData } from './pixels';
import { ensureFont } from './fonts';
import { isHexColor } from './rng';

export interface TextStyle {
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing: number; // px
  lineHeight: number;    // multiple of font size
  // fill
  gradientOn: boolean;
  gradientColor: string; // fill color -> this, top to bottom
  // stroke (outline, drawn outside the fill)
  strokeOn: boolean;
  strokeWidth: number;
  strokeColor: string;
  // drop shadow
  shadowOn: boolean;
  shadowColor: string;
  shadowOpacity: number; // 0..1
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  // outer glow
  glowOn: boolean;
  glowColor: string;
  glowSize: number;
  // 3D extrude
  extrudeOn: boolean;
  extrudeDepth: number;
  extrudeColor: string;
  extrudeAngle: number; // degrees, direction the extrusion goes
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  bold: false,
  italic: false,
  align: 'left',
  letterSpacing: 0,
  lineHeight: 1.25,
  gradientOn: false,
  gradientColor: '#ff5f8f',
  strokeOn: false,
  strokeWidth: 4,
  strokeColor: '#000000',
  shadowOn: false,
  shadowColor: '#000000',
  shadowOpacity: 0.6,
  shadowBlur: 8,
  shadowX: 6,
  shadowY: 6,
  glowOn: false,
  glowColor: '#5fd7ff',
  glowSize: 18,
  extrudeOn: false,
  extrudeDepth: 10,
  extrudeColor: '#5a2d82',
  extrudeAngle: 45,
};

export interface TextMeta {
  text: string;
  x: number;
  y: number;
  size: number;
  font: string;
  color: string;
  style: TextStyle;
}

/** Read a text layer's meta, filling in defaults for older documents. */
export function readTextMeta(meta: Record<string, unknown> | undefined): TextMeta | null {
  if (!meta || typeof meta.text !== 'string') return null;
  return {
    text: meta.text,
    x: Number(meta.x) || 0,
    y: Number(meta.y) || 0,
    size: Number(meta.size) || 48,
    font: typeof meta.font === 'string' ? meta.font : 'system-ui, sans-serif',
    color: isHexColor(meta.color) ? meta.color : '#000000',
    style: readTextStyle(meta.style),
  };
}

/**
 * Merge a stored style over the defaults, keeping only known keys whose value
 * has the default's type. Meta comes from project files, so colors must be
 * plain hex — they end up in CSS (e.g. `background: url(...)` would fetch).
 */
function readTextStyle(raw: unknown): TextStyle {
  const style: TextStyle = { ...DEFAULT_TEXT_STYLE };
  if (!raw || typeof raw !== 'object') return style;
  const src = raw as Record<string, unknown>;
  const out = style as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_TEXT_STYLE) as Array<keyof TextStyle>) {
    const v = src[key];
    const d = DEFAULT_TEXT_STYLE[key];
    if (typeof v !== typeof d) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    if (key === 'align' && v !== 'left' && v !== 'center' && v !== 'right') continue;
    if (typeof v === 'string' && key !== 'align' && !isHexColor(v)) continue;
    out[key] = v;
  }
  return style;
}

export const TEXT_PRESETS: Array<{ name: string; font?: string; color?: string; style: Partial<TextStyle> }> = [
  { name: 'Plain', style: {} },
  {
    name: 'Meme', font: "Impact, 'Anton', 'Arial Black', sans-serif", color: '#ffffff',
    style: { strokeOn: true, strokeWidth: 6, strokeColor: '#000000', align: 'center' },
  },
  {
    name: 'Neon', color: '#ffffff',
    style: { glowOn: true, glowColor: '#ff3fd8', glowSize: 24, strokeOn: true, strokeWidth: 2, strokeColor: '#ff3fd8' },
  },
  {
    name: 'Retro 3D', font: "'Bungee', cursive", color: '#ffd75f',
    style: { extrudeOn: true, extrudeDepth: 12, extrudeColor: '#c2185b', extrudeAngle: 45, strokeOn: true, strokeWidth: 3, strokeColor: '#2a0a3a' },
  },
  {
    name: 'Sunset', color: '#ffd75f',
    style: { gradientOn: true, gradientColor: '#ff3f7f', shadowOn: true, shadowColor: '#000000', shadowOpacity: 0.5, shadowBlur: 10, shadowX: 4, shadowY: 6, bold: true },
  },
  {
    name: 'Shadow', color: '#ffffff',
    style: { shadowOn: true, shadowColor: '#000000', shadowOpacity: 0.75, shadowBlur: 0, shadowX: 6, shadowY: 6, bold: true },
  },
];

export function fontString(m: Pick<TextMeta, 'size' | 'font' | 'style'>): string {
  return `${m.style.italic ? 'italic ' : ''}${m.style.bold ? 'bold ' : ''}${m.size}px ${m.font}`;
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Fill silhouette of every pixel in `src` with a flat color. */
function tint(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Draw only the shadow of `src` (the image itself lands off-canvas). */
function drawShadowOnly(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, color: string, blur: number, dx: number, dy: number): void {
  const far = src.width * 2 + 1000;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = far + dx;
  ctx.shadowOffsetY = dy;
  ctx.drawImage(src, -far, 0);
  ctx.restore();
}

/** Synchronous render — assumes the font is already loaded (see renderTextAsync). */
export function renderText(m: TextMeta, w: number, h: number): ImageData {
  const st = m.style;
  const lines = m.text.split('\n');
  const lh = m.size * st.lineHeight;

  // 1) the text body: stroke underneath, fill on top
  const body = makeCanvas(w, h);
  const bctx = body.getContext('2d')!;
  bctx.font = fontString(m);
  bctx.textBaseline = 'top';
  bctx.textAlign = st.align;
  (bctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${st.letterSpacing}px`;
  bctx.lineJoin = 'round';
  bctx.miterLimit = 2;
  if (st.strokeOn && st.strokeWidth > 0) {
    bctx.strokeStyle = st.strokeColor;
    bctx.lineWidth = st.strokeWidth * 2; // half of it is hidden under the fill
    lines.forEach((line, i) => bctx.strokeText(line, m.x, m.y + i * lh));
  }
  if (st.gradientOn) {
    const g = bctx.createLinearGradient(0, m.y, 0, m.y + Math.max(1, (lines.length - 1) * lh + m.size));
    g.addColorStop(0, m.color);
    g.addColorStop(1, st.gradientColor);
    bctx.fillStyle = g;
  } else {
    bctx.fillStyle = m.color;
  }
  lines.forEach((line, i) => bctx.fillText(line, m.x, m.y + i * lh));

  // 2) solid = extrusion stack + body
  let solid = body;
  if (st.extrudeOn && st.extrudeDepth > 0) {
    solid = makeCanvas(w, h);
    const sctx = solid.getContext('2d')!;
    const side = tint(body, st.extrudeColor);
    const a = (st.extrudeAngle * Math.PI) / 180;
    const depth = Math.round(st.extrudeDepth);
    for (let i = depth; i >= 1; i--) sctx.drawImage(side, Math.cos(a) * i, Math.sin(a) * i);
    sctx.drawImage(body, 0, 0);
  }

  // 3) composite effects
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  if (st.glowOn && st.glowSize > 0) {
    for (let i = 0; i < 2; i++) drawShadowOnly(ctx, solid, st.glowColor, st.glowSize, 0, 0);
  }
  if (st.shadowOn) {
    drawShadowOnly(ctx, solid, withAlpha(st.shadowColor, st.shadowOpacity), st.shadowBlur, st.shadowX, st.shadowY);
  }
  ctx.drawImage(solid, 0, 0);
  return canvasToImageData(out);
}

export async function renderTextAsync(m: TextMeta, w: number, h: number): Promise<ImageData> {
  await ensureFont(m.font, m.size);
  return renderText(m, w, h);
}

/** CSS approximation of the style for the live text-editing overlay. */
export function textStyleCss(m: Pick<TextMeta, 'color' | 'style'>, zoom: number): React.CSSProperties {
  const st = m.style;
  const shadows: string[] = [];
  if (st.glowOn) shadows.push(`0 0 ${st.glowSize * zoom}px ${st.glowColor}`);
  if (st.extrudeOn) {
    const a = (st.extrudeAngle * Math.PI) / 180;
    for (let i = 1; i <= Math.min(30, st.extrudeDepth); i++) {
      shadows.push(`${Math.cos(a) * i * zoom}px ${Math.sin(a) * i * zoom}px 0 ${st.extrudeColor}`);
    }
  }
  if (st.shadowOn) shadows.push(`${st.shadowX * zoom}px ${st.shadowY * zoom}px ${st.shadowBlur * zoom}px ${withAlpha(st.shadowColor, st.shadowOpacity)}`);
  return {
    color: m.color,
    fontWeight: st.bold ? 700 : 400,
    fontStyle: st.italic ? 'italic' : 'normal',
    letterSpacing: st.letterSpacing * zoom,
    lineHeight: st.lineHeight,
    textAlign: st.align,
    WebkitTextStroke: st.strokeOn ? `${st.strokeWidth * zoom}px ${st.strokeColor}` : undefined,
    paintOrder: 'stroke fill',
    textShadow: shadows.length ? shadows.join(', ') : undefined,
  };
}
