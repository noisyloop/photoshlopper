// Center canvas viewport: checkerboard, GPU composite blit with pan/zoom,
// rulers, selection marching ants, tool overlays, brush cursor, and the
// inline text-editing overlay. Pointer events are converted to doc space and
// routed to the active tool (or the transform session / temp space-pan).

import { useEffect, useRef } from 'react';
import { useStore, fitToScreen, consumeFitRequest, setView, zoomAt, insertLayerWithPixels, commitPixels, setLayerPropsLive } from '../store';
import { getCompositor } from '../core/compositor';
import { getPixels, makeCanvas, canvasToImageData } from '../core/pixels';
import { traceContours, type Point } from '../core/contours';
import { TOOLS } from '../tools';
import { drawBrushCursor } from '../tools/paint';
import { transformActive, transformDown, transformMove, transformUp, drawTransformOverlay } from '../tools/transform';
import type { PointerInfo, ViewInfo } from '../tools/framework';

const RULER = 20;

export function CanvasView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tool = useStore((s) => s.tool);
  const textSession = useStore((s) => s.textSession);
  const zoom = useStore((s) => s.zoom);
  const panX = useStore((s) => s.panX);
  const panY = useStore((s) => s.panY);
  const fontSize = useStore((s) => s.fontSize);
  const fg = useStore((s) => s.fg);

  const spaceHeld = useRef(false);
  const buttonDown = useRef(false);
  const tempPan = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const lastMouse = useRef<{ x: number; y: number } | null>(null);
  const antsCache = useRef<{ sel: Uint8ClampedArray | undefined; polys: Point[][] }>({ sel: undefined, polys: [] });
  const textRef = useRef<HTMLTextAreaElement>(null);

  // ---- render loop ----
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const checker = makeChecker();
    let raf = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      useStore.setState({ viewportW: w, viewportH: h });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = useStore.getState();
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const vw = canvas.width / dpr;
      const vh = canvas.height / dpr;
      ctx.fillStyle = '#141519';
      ctx.fillRect(0, 0, vw, vh);
      if (!s.doc) {
        ctx.fillStyle = '#6f747e';
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('No document — File ▸ New, or hit the Ransomiser', vw / 2, vh / 2);
        return;
      }
      if (consumeFitRequest()) fitToScreen();
      const { doc } = s;
      const dw = doc.width * s.zoom;
      const dh = doc.height * s.zoom;

      // checkerboard under the doc
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.panX, s.panY, dw, dh);
      ctx.clip();
      ctx.fillStyle = ctx.createPattern(checker, 'repeat')!;
      ctx.fillRect(s.panX, s.panY, dw, dh);
      ctx.restore();

      // GPU composite
      const glCanvas = getCompositor().render(doc, s.layerVersions);
      ctx.imageSmoothingEnabled = s.zoom < 2;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(glCanvas, s.panX, s.panY, dw, dh);
      ctx.imageSmoothingEnabled = true;

      const view: ViewInfo = {
        zoom: s.zoom, panX: s.panX, panY: s.panY,
        docToView: (x, y) => [s.panX + x * s.zoom, s.panY + y * s.zoom],
      };

      // selection ants
      if (doc.selection) {
        if (antsCache.current.sel !== doc.selection) {
          antsCache.current = { sel: doc.selection, polys: traceContours(doc.selection, doc.width, doc.height) };
        }
        ctx.save();
        ctx.lineWidth = 1;
        const offset = (performance.now() / 60) % 8;
        for (const pass of [
          { color: 'rgba(0,0,0,0.9)', dashOffset: offset },
          { color: 'rgba(255,255,255,0.95)', dashOffset: offset + 4 },
        ]) {
          ctx.strokeStyle = pass.color;
          ctx.setLineDash([4, 4]);
          ctx.lineDashOffset = pass.dashOffset;
          ctx.beginPath();
          for (const poly of antsCache.current.polys) {
            if (!poly.length) continue;
            const [x0, y0] = view.docToView(poly[0][0], poly[0][1]);
            ctx.moveTo(x0, y0);
            for (let i = 1; i < poly.length; i++) {
              const [x, y] = view.docToView(poly[i][0], poly[i][1]);
              ctx.lineTo(x, y);
            }
            ctx.closePath();
          }
          ctx.stroke();
        }
        ctx.restore();
      } else {
        antsCache.current = { sel: undefined, polys: [] };
      }

      // tool overlay + transform box
      TOOLS[s.tool].drawOverlay?.(ctx, view);
      if (s.transformSession) drawTransformOverlay(ctx, view);

      // brush cursor
      if (lastMouse.current && !spaceHeld.current && ['brush', 'eraser', 'clone'].includes(s.tool)) {
        drawBrushCursor(ctx, lastMouse.current.x, lastMouse.current.y, s.zoom);
      }

      drawRulers(ctx, vw, vh, s.panX, s.panY, s.zoom);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // ---- space = temp hand; wheel = zoom ----
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.code === 'Space') {
        spaceHeld.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    const canvas = canvasRef.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }, []);

  const toInfo = (e: React.PointerEvent): PointerInfo => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const s = useStore.getState();
    return {
      viewX: vx, viewY: vy,
      docX: (vx - s.panX) / s.zoom,
      docY: (vy - s.panY) / s.zoom,
      pressure: e.pressure > 0 ? e.pressure : 1,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey,
    };
  };

  const viewInfo = (): ViewInfo => {
    const s = useStore.getState();
    return { zoom: s.zoom, panX: s.panX, panY: s.panY, docToView: (x, y) => [s.panX + x * s.zoom, s.panY + y * s.zoom] };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    canvasRef.current!.setPointerCapture(e.pointerId);
    buttonDown.current = true;
    const info = toInfo(e);
    const s = useStore.getState();
    if (spaceHeld.current || e.button === 1) {
      tempPan.current = { px: s.panX, py: s.panY, x: info.viewX, y: info.viewY };
      return;
    }
    if (e.button !== 0) return;
    if (transformActive()) {
      transformDown(info, viewInfo());
      return;
    }
    TOOLS[s.tool].onDown(info);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const info = toInfo(e);
    lastMouse.current = { x: info.viewX, y: info.viewY };
    if (tempPan.current) {
      const s = useStore.getState();
      setView(s.zoom, tempPan.current.px + (info.viewX - tempPan.current.x), tempPan.current.py + (info.viewY - tempPan.current.y));
      return;
    }
    if (transformActive()) {
      if (buttonDown.current) transformMove(info);
      return;
    }
    TOOLS[useStore.getState().tool].onMove(info, buttonDown.current);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasDown = buttonDown.current;
    buttonDown.current = false;
    if (tempPan.current) {
      tempPan.current = null;
      return;
    }
    if (!wasDown) return;
    if (transformActive()) {
      transformUp();
      return;
    }
    TOOLS[useStore.getState().tool].onUp(toInfo(e));
  };

  // ---- text overlay ----
  useEffect(() => {
    if (textSession) setTimeout(() => textRef.current?.focus(), 30);
  }, [textSession]);

  const commitText = (cancel: boolean) => {
    const s = useStore.getState();
    const session = s.textSession;
    if (!session || !s.doc) return;
    const text = textRef.current?.value ?? '';
    useStore.setState({ textSession: null });
    if (cancel || !text.trim()) return;
    const c = makeCanvas(s.doc.width, s.doc.height);
    const ctx = c.getContext('2d')!;
    ctx.font = `${s.fontSize}px ${s.fontFamily}`;
    ctx.fillStyle = s.fg;
    ctx.textBaseline = 'top';
    text.split('\n').forEach((line, i) => ctx.fillText(line, session.x, session.y + i * s.fontSize * 1.25));
    const pixels = canvasToImageData(c);
    const meta = { text, x: session.x, y: session.y, size: s.fontSize, font: s.fontFamily, color: s.fg };
    if (session.layerId) {
      const before = getPixels(session.layerId);
      if (before) {
        commitPixels(session.layerId, 'Edit Text', before, pixels);
        setLayerPropsLive(session.layerId, { meta });
      }
    } else {
      insertLayerWithPixels(text.split('\n')[0].slice(0, 24) || 'Text', 'text', pixels, meta, 'New Text Layer');
    }
  };

  const cursor = spaceHeld.current ? 'grab' : transformActive() ? 'move' : TOOLS[tool].cursor;

  return (
    <div className="viewport" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="view"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      {textSession && (
        <textarea
          ref={textRef}
          className="text-overlay"
          defaultValue={textSession.text}
          style={{
            left: panX + textSession.x * zoom,
            top: panY + textSession.y * zoom,
            fontSize: fontSize * zoom,
            color: fg,
            fontFamily: useStore.getState().fontFamily,
            width: Math.max(120, 300 * zoom),
            height: Math.max(40, fontSize * zoom * 2.6),
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitText(false);
            } else if (e.key === 'Escape') {
              commitText(true);
            }
          }}
          onBlur={() => commitText(false)}
        />
      )}
    </div>
  );
}

function makeChecker(): HTMLCanvasElement {
  const c = makeCanvas(16, 16);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3a3d44';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = '#2b2d33';
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillRect(8, 8, 8, 8);
  return c;
}

function drawRulers(ctx: CanvasRenderingContext2D, vw: number, vh: number, panX: number, panY: number, zoom: number): void {
  const steps = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];
  const step = steps.find((st) => st * zoom >= 46) ?? 5000;
  ctx.save();
  ctx.fillStyle = '#1c1e23';
  ctx.fillRect(0, 0, vw, RULER);
  ctx.fillRect(0, 0, RULER, vh);
  ctx.strokeStyle = '#34373f';
  ctx.beginPath();
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(vw, RULER + 0.5);
  ctx.moveTo(RULER + 0.5, 0);
  ctx.lineTo(RULER + 0.5, vh);
  ctx.stroke();
  ctx.fillStyle = '#6f747e';
  ctx.strokeStyle = '#4a4e57';
  ctx.font = '9px monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const startX = Math.floor(-panX / zoom / step) * step;
  for (let x = startX; ; x += step) {
    const vx = panX + x * zoom;
    if (vx > vw) break;
    if (vx < RULER) continue;
    ctx.beginPath();
    ctx.moveTo(vx + 0.5, RULER - 6);
    ctx.lineTo(vx + 0.5, RULER);
    ctx.stroke();
    ctx.fillText(String(x), vx + 3, 3);
  }
  const startY = Math.floor(-panY / zoom / step) * step;
  for (let y = startY; ; y += step) {
    const vy = panY + y * zoom;
    if (vy > vh) break;
    if (vy < RULER) continue;
    ctx.beginPath();
    ctx.moveTo(RULER - 6, vy + 0.5);
    ctx.lineTo(RULER, vy + 0.5);
    ctx.stroke();
    ctx.save();
    ctx.translate(3, vy + 3);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'right';
    ctx.fillText(String(y), 0, 0);
    ctx.restore();
  }
  ctx.fillStyle = '#1c1e23';
  ctx.fillRect(0, 0, RULER, RULER);
  ctx.restore();
}
