// Named brush presets + tile previews. Every preset drives the same round
// stamp engine (core/brush.ts) — the character comes entirely from the
// size/hardness/flow/opacity/spacing combination. Previews stroke a
// pressure-tapered S-curve through the actual StrokeEngine, so a tile looks
// exactly like the paint it produces.

import { StrokeEngine } from './brush';
import { imageDataToCanvas } from './pixels';
import type { BrushSettings } from '../store';

export interface BrushPreset {
  id: string;
  name: string;
  hint: string;
  settings: BrushSettings;
}

export const BRUSH_PRESETS: BrushPreset[] = [
  { id: 'round', name: 'Round', hint: 'the all-rounder default', settings: { size: 24, hardness: 0.8, opacity: 1, flow: 0.85, spacing: 0.15 } },
  { id: 'soft-round', name: 'Soft Round', hint: 'feathered edges for shading', settings: { size: 44, hardness: 0.15, opacity: 1, flow: 0.7, spacing: 0.12 } },
  { id: 'hard-round', name: 'Hard Round', hint: 'crisp opaque stroke', settings: { size: 24, hardness: 1, opacity: 1, flow: 1, spacing: 0.1 } },
  { id: 'pencil', name: 'Pencil', hint: 'thin hard line', settings: { size: 3, hardness: 1, opacity: 1, flow: 1, spacing: 0.08 } },
  { id: 'inker', name: 'Inker', hint: 'bold pressure-sensitive line', settings: { size: 10, hardness: 0.9, opacity: 1, flow: 1, spacing: 0.05 } },
  { id: 'marker', name: 'Marker', hint: 'translucent, builds up where strokes overlap', settings: { size: 28, hardness: 0.8, opacity: 0.55, flow: 0.65, spacing: 0.1 } },
  { id: 'airbrush', name: 'Airbrush', hint: 'huge soft glow, low flow', settings: { size: 110, hardness: 0, opacity: 0.9, flow: 0.1, spacing: 0.06 } },
  { id: 'stipple', name: 'Stipple', hint: 'spaced dots', settings: { size: 14, hardness: 0.9, opacity: 1, flow: 1, spacing: 1.5 } },
];

/**
 * Render a tapered S-curve stroke with the given settings into a fresh
 * canvas. Size is clamped so big brushes still fit the tile; hardness, flow,
 * opacity and spacing are used as-is so each preset keeps its character.
 */
export function renderBrushPreview(settings: BrushSettings, w: number, h: number, color: string): HTMLCanvasElement {
  const size = Math.max(2, Math.min(settings.size, h * 0.8));
  const engine = new StrokeEngine(w, h, {
    size,
    hardness: settings.hardness,
    flow: settings.flow,
    opacity: settings.opacity,
    color,
    spacing: settings.spacing,
    mode: 'paint',
    pressureSize: true,
  });
  const pad = Math.max(6, size * 0.45);
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = pad + t * (w - pad * 2);
    const y = h / 2 - Math.sin(t * Math.PI * 2) * h * 0.16;
    const pressure = 0.25 + 0.75 * Math.sin(t * Math.PI);
    if (i === 0) engine.begin(x, y, pressure);
    else engine.moveTo(x, y, pressure);
  }
  return imageDataToCanvas(engine.bake(new ImageData(w, h)));
}
