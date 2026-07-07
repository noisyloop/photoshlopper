// Core data model. Layer pixel buffers (ImageData) intentionally do NOT live
// here — they live in the pixel registry (core/pixels.ts) keyed by layer id so
// the Zustand store stays serializable. `layerVersions` in the store is bumped
// whenever a layer's pixels change so the compositor/thumbnails re-upload.

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export type LayerKind = 'raster' | 'text' | 'shape' | 'adjustment' | 'procedural';

export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number; // radians
}

export type ParamValue = number | [number, number, number];

export interface ProceduralNode {
  /** key into the procedural registry (core/procedural.ts) */
  type: string;
  params: Record<string, ParamValue>;
}

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number; // 0..1
  blend: BlendMode;
  locked: boolean;
  transform: Transform;
  /** optional per-layer alpha mask, doc-sized, one byte per pixel */
  mask?: Uint8ClampedArray;
  /** for procedural/adjustment layers: the effect-graph node (drives shader export) */
  procedural?: ProceduralNode;
  meta?: Record<string, unknown>;
}

export interface Doc {
  width: number;
  height: number;
  dpi: number;
  layers: Layer[]; // index 0 = bottom
  activeLayerId: string;
  /** selection = an alpha mask over the doc (doc-sized, one byte per pixel) */
  selection?: Uint8ClampedArray;
  background: 'transparent' | string;
}

export const identityTransform = (): Transform => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });

export type ToolId =
  | 'move' | 'marquee' | 'lasso' | 'wand' | 'crop' | 'eyedropper'
  | 'brush' | 'eraser' | 'bucket' | 'gradient' | 'clone'
  | 'type' | 'shape' | 'hand' | 'zoom';

let idCounter = 0;
export function newId(prefix = 'layer'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}
