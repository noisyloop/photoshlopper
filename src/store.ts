// Zustand editor store. Normalized & serializable: pixel buffers live in the
// pixel registry (core/pixels.ts); `layerVersions` ties the two together.
// History is a command stack: every op mutates state first, then pushes an
// entry with undo/redo closures over compact snapshots (region snapshots for
// pixel edits, doc snapshots for structural edits). Cap 50, strokes coalesce
// into a single entry each.

import { create } from 'zustand';
import type { BlendMode, Doc, Layer, LayerKind, ParamValue, ToolId, Transform } from './types';
import { identityTransform, newId } from './types';
import {
  cloneImageData, deletePixels, getPixels, makeImageData, setPixels,
  snapshotRegion, restoreRegion, fullRect, type RegionSnapshot, imageDataToCanvas,
  canvasToImageData, makeCanvas, maskToCanvas,
} from './core/pixels';
import { getCompositor } from './core/compositor';
import { makeNode, getProcDef } from './core/procedural';
import { randomSeed } from './core/rng';
import { DEFAULT_TEXT_STYLE, readTextMeta, type TextStyle } from './core/text';

/** Max Randomize rolls per document (each roll is a full-canvas generate). */
export const MAX_ROLLS = 50;

export interface HistoryEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

const HISTORY_CAP = 50;

export interface BrushSettings {
  size: number;
  hardness: number; // 0..1
  opacity: number;  // 0..1
  flow: number;     // 0..1
  spacing: number;  // fraction of size
}

export interface TransformSession {
  layerId: string;
  original: Transform;
}

export interface TextSession {
  layerId: string | null; // editing existing text layer vs creating new
  x: number;
  y: number;
  text: string;
}

interface EditorState {
  doc: Doc | null;
  layerVersions: Record<string, number>;
  renderVersion: number;
  tool: ToolId;
  fg: string;
  bg: string;
  brush: BrushSettings;
  /** id of the brush preset the current settings came from; null = custom */
  brushPresetId: string | null;
  tolerance: number;
  gradientKind: 'linear' | 'radial';
  marqueeKind: 'rect' | 'ellipse';
  shapeKind: 'rect' | 'ellipse' | 'line';
  shapeFill: boolean;
  shapeStrokeWidth: number;
  fontSize: number;
  fontFamily: string;
  textStyle: TextStyle;
  seed: number;
  /** Randomize rolls used on the current document (capped at MAX_ROLLS) */
  rollsUsed: number;
  /** seeds rolled on the current document, newest last — the "ideas" strip */
  ideas: number[];
  zoom: number;
  panX: number;
  panY: number;
  viewportW: number;
  viewportH: number;
  screenMode: number; // 0 normal, 1 no menu, 2 canvas only
  panelsHidden: boolean;
  modal: null | 'export' | 'newdoc' | 'shortcuts' | 'fill' | 'imagesize' | 'canvassize' | 'removebg';
  status: string;
  past: HistoryEntry[];
  future: HistoryEntry[];
  transformSession: TransformSession | null;
  textSession: TextSession | null;
}

export const useStore = create<EditorState>(() => ({
  doc: null,
  layerVersions: {},
  renderVersion: 0,
  tool: 'brush',
  fg: '#000000',
  bg: '#ffffff',
  brush: { size: 24, hardness: 0.8, opacity: 1, flow: 0.85, spacing: 0.15 },
  brushPresetId: 'round',
  tolerance: 32,
  gradientKind: 'linear',
  marqueeKind: 'rect',
  shapeKind: 'rect',
  shapeFill: true,
  shapeStrokeWidth: 4,
  fontSize: 48,
  fontFamily: 'system-ui, sans-serif',
  textStyle: { ...DEFAULT_TEXT_STYLE },
  seed: randomSeed(),
  rollsUsed: 0,
  ideas: [],
  zoom: 1,
  panX: 0,
  panY: 0,
  viewportW: 800,
  viewportH: 600,
  screenMode: 0,
  panelsHidden: false,
  modal: 'newdoc',
  status: 'Welcome to Photoshlopper. Press ? for shortcuts.',
  past: [],
  future: [],
  transformSession: null,
  textSession: null,
}));

const set = useStore.setState;
const get = useStore.getState;

// module-level internal clipboard
let clipboard: ImageData | null = null;

// ---------- helpers ----------

function cloneDoc(doc: Doc): Doc {
  return {
    ...doc,
    layers: doc.layers.map((l) => ({
      ...l,
      transform: { ...l.transform },
      procedural: l.procedural ? { type: l.procedural.type, params: { ...l.procedural.params } } : undefined,
      meta: l.meta ? { ...l.meta } : undefined,
    })),
  };
}

export function bumpLayer(id: string): void {
  set((s) => ({
    layerVersions: { ...s.layerVersions, [id]: (s.layerVersions[id] ?? 0) + 1 },
    renderVersion: s.renderVersion + 1,
  }));
}

export function touch(): void {
  set((s) => ({ renderVersion: s.renderVersion + 1 }));
}

export function setStatus(status: string): void {
  set({ status });
}

export function pushHistory(entry: HistoryEntry): void {
  set((s) => {
    const past = [...s.past, entry];
    if (past.length > HISTORY_CAP) past.shift();
    return { past, future: [] };
  });
}

export function undo(): void {
  const s = get();
  const entry = s.past[s.past.length - 1];
  if (!entry) {
    setStatus('Nothing to undo');
    return;
  }
  entry.undo();
  set((st) => ({ past: st.past.slice(0, -1), future: [entry, ...st.future], status: `Undo: ${entry.label}` }));
  touch();
}

export function redo(): void {
  const s = get();
  const entry = s.future[0];
  if (!entry) {
    setStatus('Nothing to redo');
    return;
  }
  entry.redo();
  set((st) => ({ future: st.future.slice(1), past: [...st.past, entry], status: `Redo: ${entry.label}` }));
  touch();
}

export function activeLayer(): Layer | null {
  const doc = get().doc;
  if (!doc) return null;
  return doc.layers.find((l) => l.id === doc.activeLayerId) ?? null;
}

/** Active layer if it's a paintable raster-ish unlocked layer; else status + null. */
export function paintTarget(): Layer | null {
  const layer = activeLayer();
  if (!layer) {
    setStatus('No active layer');
    return null;
  }
  if (layer.locked) {
    setStatus(`Layer "${layer.name}" is locked`);
    return null;
  }
  if (!getPixels(layer.id)) {
    setStatus(`Cannot paint on ${layer.kind} layer — rasterize it first (Layer menu)`);
    return null;
  }
  return layer;
}

function updateDoc(mutate: (doc: Doc) => Doc): void {
  set((s) => (s.doc ? { doc: mutate(s.doc), renderVersion: s.renderVersion + 1 } : {}));
}

/** Structural doc change with history (captures full doc snapshots; pixels via extras). */
function docCommand(label: string, apply: (doc: Doc) => Doc, opts?: {
  savePixels?: string[]; // layer ids whose pixels must be restorable on undo
}): void {
  const before = cloneDoc(get().doc!);
  const savedPixels = new Map<string, ImageData>();
  for (const id of opts?.savePixels ?? []) {
    const px = getPixels(id);
    if (px) savedPixels.set(id, px);
  }
  updateDoc(apply);
  const after = cloneDoc(get().doc!);
  const afterPixels = new Map<string, ImageData>();
  for (const l of after.layers) {
    const px = getPixels(l.id);
    if (px) afterPixels.set(l.id, px);
  }
  pushHistory({
    label,
    undo: () => {
      for (const [id, px] of savedPixels) setPixels(id, px);
      set({ doc: cloneDoc(before) });
      for (const l of before.layers) bumpLayer(l.id);
    },
    redo: () => {
      for (const [id, px] of afterPixels) setPixels(id, px);
      set({ doc: cloneDoc(after) });
      for (const l of after.layers) bumpLayer(l.id);
    },
  });
}

// ---------- document ----------

export function newDoc(width: number, height: number, background: Doc['background'] = 'transparent'): void {
  const layer = makeRasterLayer('Layer 1', width, height);
  const doc: Doc = { width, height, dpi: 72, layers: [layer], activeLayerId: layer.id, background };
  set({ doc, past: [], future: [], modal: null, layerVersions: { [layer.id]: 1 }, transformSession: null, textSession: null, rollsUsed: 0, ideas: [] });
  touch();
  requestFit();
}

/** Replace the whole doc (used by .pslop open). Caller must have populated the pixel registry. */
export function replaceDoc(doc: Doc): void {
  const versions: Record<string, number> = {};
  for (const l of doc.layers) versions[l.id] = 1;
  set({ doc, past: [], future: [], modal: null, layerVersions: versions, transformSession: null, textSession: null, rollsUsed: 0, ideas: [] });
  touch();
  requestFit();
}

function makeRasterLayer(name: string, w: number, h: number, kind: LayerKind = 'raster'): Layer {
  const layer: Layer = {
    id: newId(), name, kind, visible: true, opacity: 1, blend: 'normal',
    locked: false, transform: identityTransform(),
  };
  setPixels(layer.id, makeImageData(w, h));
  return layer;
}

// ---------- layers ----------

export function addLayer(name?: string, atIndex?: number): Layer {
  const doc = get().doc!;
  const layer = makeRasterLayer(name ?? `Layer ${doc.layers.length + 1}`, doc.width, doc.height);
  const idx = atIndex ?? doc.layers.findIndex((l) => l.id === doc.activeLayerId) + 1;
  docCommand('New Layer', (d) => {
    const layers = [...d.layers];
    layers.splice(idx, 0, layer);
    return { ...d, layers, activeLayerId: layer.id };
  });
  bumpLayer(layer.id);
  return layer;
}

export function addProceduralLayer(type: string): void {
  const doc = get().doc!;
  const def = getProcDef(type);
  const layer: Layer = {
    id: newId(), name: def.label, kind: def.kind === 'effect' ? 'adjustment' : 'procedural',
    visible: true, opacity: 1, blend: 'normal', locked: false,
    transform: identityTransform(), procedural: makeNode(type),
  };
  const idx = doc.layers.findIndex((l) => l.id === doc.activeLayerId) + 1;
  docCommand(`Add ${def.label}`, (d) => {
    const layers = [...d.layers];
    layers.splice(idx, 0, layer);
    return { ...d, layers, activeLayerId: layer.id };
  });
}

export function deleteLayer(id: string): void {
  const doc = get().doc!;
  if (doc.layers.length <= 1) {
    setStatus('Cannot delete the last layer');
    return;
  }
  const idx = doc.layers.findIndex((l) => l.id === id);
  docCommand('Delete Layer', (d) => {
    const layers = d.layers.filter((l) => l.id !== id);
    const active = d.activeLayerId === id ? layers[Math.max(0, idx - 1)].id : d.activeLayerId;
    return { ...d, layers, activeLayerId: active };
  }, { savePixels: [id] });
}

export function duplicateLayer(id: string): void {
  const doc = get().doc!;
  const src = doc.layers.find((l) => l.id === id);
  if (!src) return;
  const copy: Layer = {
    ...src, id: newId(), name: `${src.name} copy`,
    transform: { ...src.transform },
    mask: src.mask ? new Uint8ClampedArray(src.mask) : undefined,
    procedural: src.procedural ? { type: src.procedural.type, params: { ...src.procedural.params } } : undefined,
    meta: src.meta ? { ...src.meta, randomizer: undefined } : undefined, // a copy is the user's, not a re-rollable roll
  };
  const px = getPixels(id);
  if (px) setPixels(copy.id, cloneImageData(px));
  const idx = doc.layers.findIndex((l) => l.id === id) + 1;
  docCommand('Duplicate Layer', (d) => {
    const layers = [...d.layers];
    layers.splice(idx, 0, copy);
    return { ...d, layers, activeLayerId: copy.id };
  });
  bumpLayer(copy.id);
}

export function setLayerProps(id: string, patch: Partial<Pick<Layer, 'name' | 'visible' | 'opacity' | 'blend' | 'locked'>>, label?: string): void {
  docCommand(label ?? 'Layer Properties', (d) => ({
    ...d,
    layers: d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
  }));
}

/** Live (no-history) layer patch, e.g. while dragging the opacity slider. */
export function setLayerPropsLive(id: string, patch: Partial<Layer>): void {
  updateDoc((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
}

export function setActiveLayer(id: string): void {
  updateDoc((d) => ({ ...d, activeLayerId: id }));
}

export function reorderLayer(id: string, toIndex: number): void {
  docCommand('Reorder Layer', (d) => {
    const layers = [...d.layers];
    const from = layers.findIndex((l) => l.id === id);
    if (from < 0) return d;
    const [layer] = layers.splice(from, 1);
    layers.splice(Math.max(0, Math.min(layers.length, toIndex)), 0, layer);
    return { ...d, layers };
  });
}

export function mergeDown(id: string): void {
  const s = get();
  const doc = s.doc!;
  const idx = doc.layers.findIndex((l) => l.id === id);
  if (idx <= 0) {
    setStatus('No layer below to merge into');
    return;
  }
  const below = doc.layers[idx - 1];
  const merged = getCompositor().renderToImageData(doc, s.layerVersions, [
    { ...below, blend: 'normal', opacity: below.opacity },
    doc.layers[idx],
  ], 'transparent');
  const newLayer: Layer = {
    id: newId(), name: below.name, kind: 'raster', visible: true, opacity: 1,
    blend: below.blend, locked: false, transform: identityTransform(),
  };
  setPixels(newLayer.id, merged);
  docCommand('Merge Down', (d) => {
    const layers = [...d.layers];
    layers.splice(idx - 1, 2, newLayer);
    return { ...d, layers, activeLayerId: newLayer.id };
  }, { savePixels: [below.id, id] });
  bumpLayer(newLayer.id);
}

export function mergeVisible(): void {
  flattenInternal('Merge Visible', true);
}

export function flattenImage(): void {
  flattenInternal('Flatten Image', false);
}

function flattenInternal(label: string, visibleOnly: boolean): void {
  const s = get();
  const doc = s.doc!;
  const layers = visibleOnly ? doc.layers.filter((l) => l.visible) : doc.layers;
  if (layers.length === 0) return;
  const merged = getCompositor().renderToImageData(doc, s.layerVersions, layers, visibleOnly ? 'transparent' : doc.background);
  const newLayer: Layer = {
    id: newId(), name: visibleOnly ? 'Merged' : 'Background', kind: 'raster', visible: true,
    opacity: 1, blend: 'normal', locked: false, transform: identityTransform(),
  };
  setPixels(newLayer.id, merged);
  docCommand(label, (d) => {
    const kept = visibleOnly ? d.layers.filter((l) => !l.visible) : [];
    return { ...d, layers: [...kept, newLayer], activeLayerId: newLayer.id };
  }, { savePixels: doc.layers.map((l) => l.id) });
  bumpLayer(newLayer.id);
}

export function addLayerMask(id: string): void {
  const doc = get().doc!;
  const layer = doc.layers.find((l) => l.id === id);
  if (!layer || layer.mask) return;
  const mask = doc.selection
    ? new Uint8ClampedArray(doc.selection)
    : new Uint8ClampedArray(doc.width * doc.height).fill(255);
  docCommand('Add Layer Mask', (d) => ({
    ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, mask } : l)),
  }));
}

export function removeLayerMask(id: string): void {
  docCommand('Remove Layer Mask', (d) => ({
    ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, mask: undefined } : l)),
  }));
}

export function rasterizeLayer(id: string): void {
  const s = get();
  const doc = s.doc!;
  const layer = doc.layers.find((l) => l.id === id);
  if (!layer || (layer.kind === 'raster' && getPixels(id))) return;
  const solo = getCompositor().renderToImageData(doc, s.layerVersions, [{ ...layer, blend: 'normal', opacity: 1 }], 'transparent');
  const newLayer: Layer = {
    ...layer, id: newId(), kind: 'raster', transform: identityTransform(),
    procedural: undefined, meta: undefined,
  };
  setPixels(newLayer.id, solo);
  docCommand('Rasterize Layer', (d) => ({
    ...d,
    layers: d.layers.map((l) => (l.id === id ? newLayer : l)),
    activeLayerId: d.activeLayerId === id ? newLayer.id : d.activeLayerId,
  }), { savePixels: [id] });
  bumpLayer(newLayer.id);
}

export function updateProceduralParamLive(id: string, key: string, value: ParamValue): void {
  updateDoc((d) => ({
    ...d,
    layers: d.layers.map((l) =>
      l.id === id && l.procedural
        ? { ...l, procedural: { ...l.procedural, params: { ...l.procedural.params, [key]: value } } }
        : l,
    ),
  }));
}

export function commitProceduralParam(id: string, key: string, before: ParamValue, after: ParamValue): void {
  pushHistory({
    label: 'Adjust Effect',
    undo: () => updateProceduralParamLive(id, key, before),
    redo: () => updateProceduralParamLive(id, key, after),
  });
}

export function setLayerTransform(id: string, t: Transform, withHistory = false, before?: Transform): void {
  updateDoc((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, transform: { ...t } } : l)) }));
  if (withHistory && before) {
    const b = { ...before };
    const a = { ...t };
    pushHistory({
      label: 'Transform',
      undo: () => updateDoc((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, transform: { ...b } } : l)) })),
      redo: () => updateDoc((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, transform: { ...a } } : l)) })),
    });
  }
}

// ---------- pixel edits ----------

/**
 * Commit new pixels for a layer with a compact region-snapshot history entry.
 * `before` is the layer's ImageData prior to the edit, `after` the new one.
 */
export function commitPixels(layerId: string, label: string, before: ImageData, after: ImageData, dirty?: { x: number; y: number; w: number; h: number }): void {
  const rect = dirty ?? fullRect(before);
  const beforeSnap: RegionSnapshot = snapshotRegion(before, rect);
  const afterSnap: RegionSnapshot = snapshotRegion(after, rect);
  setPixels(layerId, after);
  bumpLayer(layerId);
  // painting on a Randomize layer makes it the user's: the next roll keeps it
  if (get().doc?.layers.some((l) => l.id === layerId && l.meta?.randomizer)) {
    updateDoc((d) => ({
      ...d,
      layers: d.layers.map((l) => (l.id === layerId ? { ...l, meta: { ...l.meta, randomizer: undefined } } : l)),
    }));
  }
  pushHistory({
    label,
    undo: () => {
      const cur = getPixels(layerId);
      if (!cur) return;
      const next = cloneImageData(cur);
      restoreRegion(next, beforeSnap);
      setPixels(layerId, next);
      bumpLayer(layerId);
    },
    redo: () => {
      const cur = getPixels(layerId);
      if (!cur) return;
      const next = cloneImageData(cur);
      restoreRegion(next, afterSnap);
      setPixels(layerId, next);
      bumpLayer(layerId);
    },
  });
}

/** Fill selection (or whole layer) with a color, respecting the selection mask. */
export function fillWith(color: string): void {
  const layer = paintTarget();
  const doc = get().doc;
  if (!layer || !doc) return;
  const before = getPixels(layer.id)!;
  const canvas = imageDataToCanvas(before);
  const ctx = canvas.getContext('2d')!;
  if (doc.selection) {
    const sel = maskToCanvas(doc.selection, doc.width, doc.height);
    const fillC = makeCanvas(doc.width, doc.height);
    const fctx = fillC.getContext('2d')!;
    fctx.fillStyle = color;
    fctx.fillRect(0, 0, doc.width, doc.height);
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(sel, 0, 0);
    ctx.drawImage(fillC, 0, 0);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  commitPixels(layer.id, 'Fill', before, canvasToImageData(canvas));
}

// ---------- selection ----------

function isEmptyMask(mask: Uint8ClampedArray): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0) return false;
  return true;
}

export function setSelection(mask: Uint8ClampedArray | undefined, label = 'Select'): void {
  const doc = get().doc;
  if (!doc) return;
  const next = mask && !isEmptyMask(mask) ? mask : undefined;
  const before = doc.selection;
  updateDoc((d) => ({ ...d, selection: next }));
  pushHistory({
    label,
    undo: () => updateDoc((d) => ({ ...d, selection: before })),
    redo: () => updateDoc((d) => ({ ...d, selection: next })),
  });
}

export function selectAll(): void {
  const doc = get().doc;
  if (!doc) return;
  setSelection(new Uint8ClampedArray(doc.width * doc.height).fill(255), 'Select All');
}

export function deselect(): void {
  const doc = get().doc;
  if (!doc?.selection) return;
  setSelection(undefined, 'Deselect');
}

export function invertSelection(): void {
  const doc = get().doc;
  if (!doc) return;
  const cur = doc.selection ?? new Uint8ClampedArray(doc.width * doc.height);
  const next = new Uint8ClampedArray(cur.length);
  for (let i = 0; i < cur.length; i++) next[i] = 255 - cur[i];
  setSelection(next, 'Inverse Selection');
}

// ---------- clipboard ----------

export function copySelection(): void {
  const doc = get().doc;
  const layer = activeLayer();
  if (!doc || !layer) return;
  const px = getPixels(layer.id);
  if (!px) {
    setStatus('Active layer has no pixels to copy');
    return;
  }
  const data = cloneImageData(px);
  if (doc.selection) {
    for (let i = 0; i < doc.selection.length; i++) {
      data.data[i * 4 + 3] = (data.data[i * 4 + 3] * doc.selection[i]) / 255;
    }
  }
  clipboard = data;
  setStatus('Copied');
}

export function cutSelection(): void {
  const doc = get().doc;
  const layer = paintTarget();
  if (!doc || !layer) return;
  copySelection();
  const before = getPixels(layer.id)!;
  const after = cloneImageData(before);
  const sel = doc.selection;
  for (let i = 0; i < after.data.length / 4; i++) {
    const keep = sel ? 1 - sel[i] / 255 : 0;
    after.data[i * 4 + 3] = after.data[i * 4 + 3] * keep;
  }
  commitPixels(layer.id, 'Cut', before, after);
}

/** Insert a new layer with given pixels above the active layer — one history entry. */
export function insertLayerWithPixels(
  name: string,
  kind: LayerKind,
  pixels: ImageData,
  meta?: Record<string, unknown>,
  label = 'New Layer',
): Layer {
  const doc = get().doc!;
  const layer: Layer = {
    id: newId(), name, kind, visible: true, opacity: 1, blend: 'normal',
    locked: false, transform: identityTransform(), meta,
  };
  setPixels(layer.id, pixels);
  const idx = doc.layers.findIndex((l) => l.id === doc.activeLayerId) + 1;
  docCommand(label, (d) => {
    const layers = [...d.layers];
    layers.splice(idx, 0, layer);
    return { ...d, layers, activeLayerId: layer.id };
  });
  bumpLayer(layer.id);
  return layer;
}

export function paste(): void {
  const doc = get().doc;
  if (!doc || !clipboard) {
    setStatus('Clipboard is empty');
    return;
  }
  const layer = makeRasterLayer(`Pasted`, doc.width, doc.height);
  const target = getPixels(layer.id)!;
  const c = imageDataToCanvas(target);
  c.getContext('2d')!.drawImage(imageDataToCanvas(clipboard), 0, 0);
  setPixels(layer.id, canvasToImageData(c));
  const idx = doc.layers.findIndex((l) => l.id === doc.activeLayerId) + 1;
  docCommand('Paste', (d) => {
    const layers = [...d.layers];
    layers.splice(idx, 0, layer);
    return { ...d, layers, activeLayerId: layer.id };
  });
  bumpLayer(layer.id);
}

/** Delete key: clear the selected pixels on the active layer. */
export function clearSelectionArea(): void {
  const doc = get().doc;
  const layer = paintTarget();
  if (!doc || !layer) return;
  if (!doc.selection) {
    setStatus('No selection to clear');
    return;
  }
  const before = getPixels(layer.id)!;
  const after = cloneImageData(before);
  const sel = doc.selection;
  for (let i = 0; i < sel.length; i++) {
    after.data[i * 4 + 3] = after.data[i * 4 + 3] * (1 - sel[i] / 255);
  }
  commitPixels(layer.id, 'Clear', before, after);
}

// ---------- view ----------

let fitRequested = false;
export function requestFit(): void {
  fitRequested = true;
}
export function consumeFitRequest(): boolean {
  const r = fitRequested;
  fitRequested = false;
  return r;
}

export function setView(zoom: number, panX: number, panY: number): void {
  set({ zoom: Math.max(0.03, Math.min(64, zoom)), panX, panY });
}

export function zoomAt(factor: number, vx: number, vy: number): void {
  const s = get();
  const z = Math.max(0.03, Math.min(64, s.zoom * factor));
  const scale = z / s.zoom;
  set({ zoom: z, panX: vx - (vx - s.panX) * scale, panY: vy - (vy - s.panY) * scale });
}

export function fitToScreen(): void {
  const s = get();
  if (!s.doc) return;
  const pad = 48;
  const z = Math.min((s.viewportW - pad) / s.doc.width, (s.viewportH - pad) / s.doc.height, 8);
  set({
    zoom: z,
    panX: (s.viewportW - s.doc.width * z) / 2,
    panY: (s.viewportH - s.doc.height * z) / 2,
  });
}

export function zoom100(): void {
  const s = get();
  if (!s.doc) return;
  set({ zoom: 1, panX: (s.viewportW - s.doc.width) / 2, panY: (s.viewportH - s.doc.height) / 2 });
}

// ---------- misc UI ----------

export function setTool(tool: ToolId): void {
  set({ tool, status: `Tool: ${tool}` });
}

/** Tweak brush settings by hand — marks the brush as "custom" (no preset). */
export function setBrushSettings(patch: Partial<BrushSettings>): void {
  set((s) => ({ brush: { ...s.brush, ...patch }, brushPresetId: null }));
}

/** Apply a named preset; switches to the Brush tool if no paint tool is active. */
export function applyBrushPreset(preset: { id: string; name: string; settings: BrushSettings }): void {
  const patch: Partial<EditorState> = {
    brush: { ...preset.settings },
    brushPresetId: preset.id,
    status: `Brush: ${preset.name}`,
  };
  const tool = get().tool;
  if (tool !== 'brush' && tool !== 'eraser' && tool !== 'clone') patch.tool = 'brush';
  set(patch);
}

export function setModal(modal: EditorState['modal']): void {
  set({ modal });
}

export function swapColors(): void {
  set((s) => ({ fg: s.bg, bg: s.fg }));
}

export function resetColors(): void {
  set({ fg: '#000000', bg: '#ffffff' });
}

export function cycleScreenMode(): void {
  set((s) => ({ screenMode: (s.screenMode + 1) % 3 }));
}

export function togglePanels(): void {
  set((s) => ({ panelsHidden: !s.panelsHidden }));
}

// ---------- crop / canvas size / image size ----------

const MAX_DOC_SIDE = 4096;

/**
 * Change the doc's geometry for every layer at once, as one history entry.
 * `mapPixels` rebuilds a layer buffer at the new size, `mapMask` a doc-sized
 * mask (`fill` = value for newly exposed area), `mapLayer` patches transforms
 * and text meta so re-editing stays aligned.
 */
function geometryCommand(label: string, w: number, h: number, ops: {
  mapPixels: (src: HTMLCanvasElement) => HTMLCanvasElement;
  mapMask: (m: Uint8ClampedArray, fill: number) => Uint8ClampedArray;
  mapLayer: (l: Layer) => Layer;
}): void {
  const doc = get().doc;
  if (!doc) return;
  const savedPixels = new Map<string, ImageData>();
  for (const l of doc.layers) {
    const px = getPixels(l.id);
    if (px) savedPixels.set(l.id, px);
  }
  const before = cloneDoc(doc);
  for (const [id, px] of savedPixels) setPixels(id, canvasToImageData(ops.mapPixels(imageDataToCanvas(px))));
  const after: Doc = {
    ...cloneDoc(doc),
    width: w,
    height: h,
    selection: doc.selection ? ops.mapMask(doc.selection, 0) : undefined,
    layers: doc.layers.map((l) => ops.mapLayer({
      ...l,
      transform: { ...l.transform },
      mask: l.mask ? ops.mapMask(l.mask, 255) : undefined,
      procedural: l.procedural ? { type: l.procedural.type, params: { ...l.procedural.params } } : undefined,
      meta: l.meta ? { ...l.meta } : undefined,
    })),
  };
  set({ doc: after });
  const afterPixels = new Map<string, ImageData>();
  for (const l of after.layers) {
    const px = getPixels(l.id);
    if (px) afterPixels.set(l.id, px);
  }
  pushHistory({
    label,
    undo: () => {
      for (const [id, px] of savedPixels) setPixels(id, px);
      set({ doc: cloneDoc(before) });
      for (const l of before.layers) bumpLayer(l.id);
      requestFit();
    },
    redo: () => {
      for (const [id, px] of afterPixels) setPixels(id, px);
      set({ doc: cloneDoc(after) });
      for (const l of after.layers) bumpLayer(l.id);
      requestFit();
    },
  });
  for (const l of after.layers) bumpLayer(l.id);
  requestFit();
}

/**
 * Re-frame the doc to w×h with existing content offset by (ox, oy) — no
 * resampling. Used by Crop (negative offsets) and Canvas Size (anchoring).
 */
export function reframeDoc(label: string, w: number, h: number, ox: number, oy: number): void {
  const doc = get().doc;
  if (!doc) return;
  w = Math.round(w);
  h = Math.round(h);
  ox = Math.round(ox);
  oy = Math.round(oy);
  if (w < 1 || h < 1 || w > MAX_DOC_SIDE || h > MAX_DOC_SIDE) {
    setStatus(`Size must be between 1 and ${MAX_DOC_SIDE}px`);
    return;
  }
  const ow = doc.width;
  const oh = doc.height;
  // keep transformed layers visually in place even though the pivot (doc center) moves
  const dX = ow / 2 + ox - w / 2;
  const dY = oh / 2 + oy - h / 2;
  geometryCommand(label, w, h, {
    mapPixels: (src) => {
      const c = makeCanvas(w, h);
      c.getContext('2d')!.drawImage(src, ox, oy);
      return c;
    },
    mapMask: (m, fill) => {
      const out = new Uint8ClampedArray(w * h).fill(fill);
      const x0 = Math.max(0, ox);
      const x1 = Math.min(w, ox + ow);
      if (x1 <= x0) return out;
      for (let y = Math.max(0, oy); y < Math.min(h, oy + oh); y++) {
        const sy = y - oy;
        out.set(m.subarray(sy * ow + (x0 - ox), sy * ow + (x1 - ox)), y * w + x0);
      }
      return out;
    },
    mapLayer: (l) => {
      const t = l.transform;
      const cos = Math.cos(t.rotation);
      const sin = Math.sin(t.rotation);
      const rx = (dX * t.scaleX) * cos - (dY * t.scaleY) * sin;
      const ry = (dX * t.scaleX) * sin + (dY * t.scaleY) * cos;
      const next = { ...l, transform: { ...t, x: t.x + dX - rx, y: t.y + dY - ry } };
      if (next.meta && readTextMeta(next.meta)) {
        next.meta = { ...next.meta, x: Number(next.meta.x) + ox, y: Number(next.meta.y) + oy };
      }
      return next;
    },
  });
}

export function cropDoc(rect: { x: number; y: number; w: number; h: number }): void {
  const doc = get().doc;
  if (!doc) return;
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(doc.width - x, Math.round(rect.w));
  const h = Math.min(doc.height - y, Math.round(rect.h));
  if (w < 1 || h < 1) return;
  reframeDoc('Crop', w, h, -x, -y);
}

/** Canvas Size: anchor 0 / 0.5 / 1 on each axis = left/center/right, top/middle/bottom. */
export function resizeCanvas(w: number, h: number, anchorX: number, anchorY: number): void {
  const doc = get().doc;
  if (!doc) return;
  reframeDoc('Canvas Size', w, h, (w - doc.width) * anchorX, (h - doc.height) * anchorY);
}

/** Image Size: resample every layer (and masks/selection) to w×h. */
export function resizeImage(w: number, h: number): void {
  const doc = get().doc;
  if (!doc) return;
  w = Math.round(w);
  h = Math.round(h);
  if (w < 1 || h < 1 || w > MAX_DOC_SIDE || h > MAX_DOC_SIDE) {
    setStatus(`Size must be between 1 and ${MAX_DOC_SIDE}px`);
    return;
  }
  const ow = doc.width;
  const oh = doc.height;
  const sx = w / ow;
  const sy = h / oh;
  const sAvg = (sx + sy) / 2;
  const resample = (src: HTMLCanvasElement) => {
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return c;
  };
  geometryCommand('Image Size', w, h, {
    mapPixels: resample,
    mapMask: (m) => {
      const img = canvasToImageData(resample(maskToCanvas(m, ow, oh)));
      const out = new Uint8ClampedArray(w * h);
      for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4 + 3];
      return out;
    },
    mapLayer: (l) => {
      const next = { ...l, transform: { ...l.transform, x: l.transform.x * sx, y: l.transform.y * sy } };
      const tm = readTextMeta(next.meta);
      if (tm && next.meta) {
        const st = tm.style;
        next.meta = {
          ...next.meta,
          x: tm.x * sx,
          y: tm.y * sy,
          size: Math.max(1, Math.round(tm.size * sAvg)),
          style: {
            ...st,
            letterSpacing: st.letterSpacing * sAvg,
            strokeWidth: st.strokeWidth * sAvg,
            shadowBlur: st.shadowBlur * sAvg,
            shadowX: st.shadowX * sx,
            shadowY: st.shadowY * sy,
            glowSize: st.glowSize * sAvg,
            extrudeDepth: st.extrudeDepth * sAvg,
          },
        };
      }
      return next;
    },
  });
}

// ---------- history jump (History panel) ----------

export function jumpToHistory(targetPastLength: number): void {
  let s = get();
  while (s.past.length > targetPastLength && s.past.length > 0) {
    undo();
    s = get();
  }
  while (s.past.length < targetPastLength && s.future.length > 0) {
    redo();
    s = get();
  }
}

// cleanup pixels for layers that no longer exist anywhere (called occasionally)
export function gcPixels(): void {
  // Deliberately conservative: history closures may still reference ImageData
  // for undo, and those hold their own references, so deleting from the
  // registry here is safe only for ids absent from the current doc.
  const doc = get().doc;
  if (!doc) return;
  const live = new Set(doc.layers.map((l) => l.id));
  const compositor = getCompositor();
  for (const id of Object.keys(get().layerVersions)) {
    if (!live.has(id)) compositor.invalidateLayer(id);
  }
}

export function beginTransform(): void {
  const layer = activeLayer();
  if (!layer) return;
  if (layer.locked) {
    setStatus('Layer is locked');
    return;
  }
  set({ transformSession: { layerId: layer.id, original: { ...layer.transform } } });
  setStatus('Free Transform: drag to move, handles to scale, Alt+drag corner to rotate. Enter commits, Esc cancels.');
}

export function commitTransform(): void {
  const s = get();
  if (!s.transformSession || !s.doc) return;
  const { layerId, original } = s.transformSession;
  const layer = s.doc.layers.find((l) => l.id === layerId);
  set({ transformSession: null });
  if (layer) setLayerTransform(layerId, layer.transform, true, original);
  setStatus('Transform applied');
}

export function cancelTransform(): void {
  const s = get();
  if (!s.transformSession) return;
  const { layerId, original } = s.transformSession;
  set({ transformSession: null });
  setLayerTransform(layerId, original);
  setStatus('Transform cancelled');
}

export { getPixels, deletePixels };
