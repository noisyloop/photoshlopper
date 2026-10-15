// .pslop — the native project format. A stored zip containing:
//   manifest.json  doc + layers (transforms, blend, procedural graphs) + seed
//   layers/<id>.png   pixel buffers for raster/text/shape layers
//   masks/<id>.bin    raw layer masks (doc-sized, 1 byte/px)
//   selection.bin     raw selection mask, if any
// Round-trips losslessly: save -> open restores the session exactly
// (except undo history, which is not persisted).
//
// versioned: bump FORMAT_VERSION on breaking changes and keep readers tolerant.

import type { BlendMode, Doc, Layer, LayerKind, ParamValue, ProceduralNode, Transform } from '../types';
import { useStore, replaceDoc } from '../store';
import { BLEND_MODES } from '../core/blend';
import { getProcDef } from '../core/procedural';
import { isHexColor } from '../core/rng';
import { getPixels, setPixels, canvasToBlob, imageDataToCanvas, blobToImageData, download } from '../core/pixels';
import { writeZip, readZip, type ZipEntry } from './zip';

const FORMAT_VERSION = 1;

interface ManifestLayer extends Omit<Layer, 'mask'> {
  pixelsFile?: string;
  maskFile?: string;
}

interface Manifest {
  app: 'photoshlopper';
  version: number;
  seed: number;
  doc: {
    width: number;
    height: number;
    dpi: number;
    background: Doc['background'];
    activeLayerId: string;
    selectionFile?: string;
    layers: ManifestLayer[];
  };
}

export async function savePslop(): Promise<void> {
  const s = useStore.getState();
  const doc = s.doc;
  if (!doc) return;
  const entries: ZipEntry[] = [];
  const layers: ManifestLayer[] = [];
  for (const layer of doc.layers) {
    const { mask, ...rest } = layer;
    const m: ManifestLayer = { ...rest };
    const px = getPixels(layer.id);
    if (px) {
      const blob = await canvasToBlob(imageDataToCanvas(px), 'image/png');
      m.pixelsFile = `layers/${layer.id}.png`;
      entries.push({ name: m.pixelsFile, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    if (mask) {
      m.maskFile = `masks/${layer.id}.bin`;
      entries.push({ name: m.maskFile, data: new Uint8Array(mask.buffer.slice(0)) });
    }
    layers.push(m);
  }
  const manifest: Manifest = {
    app: 'photoshlopper',
    version: FORMAT_VERSION,
    seed: s.seed,
    doc: {
      width: doc.width,
      height: doc.height,
      dpi: doc.dpi,
      background: doc.background,
      activeLayerId: doc.activeLayerId,
      selectionFile: doc.selection ? 'selection.bin' : undefined,
      layers,
    },
  };
  if (doc.selection) entries.push({ name: 'selection.bin', data: new Uint8Array(doc.selection.buffer.slice(0)) });
  entries.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  download(writeZip(entries), `photoshlopper-${Date.now().toString(36)}.pslop`);
}

export async function openPslop(file: File): Promise<void> {
  const files = readZip(await file.arrayBuffer());
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('Not a .pslop file: missing manifest.json');
  const manifest = readManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
  const { width, height } = manifest.doc;
  const maskSize = width * height;
  const layers: Layer[] = [];
  for (const m of manifest.doc.layers) {
    const { pixelsFile, maskFile, ...rest } = m;
    const layer: Layer = { ...rest };
    if (pixelsFile) {
      const data = files.get(pixelsFile);
      if (!data) throw new Error(`.pslop is missing ${pixelsFile}`);
      setPixels(layer.id, await blobToImageData(new Blob([data.slice()], { type: 'image/png' })));
    }
    if (maskFile) {
      const data = files.get(maskFile);
      if (data && data.length === maskSize) layer.mask = new Uint8ClampedArray(data.slice());
    }
    layers.push(layer);
  }
  const selBytes = manifest.doc.selectionFile ? files.get(manifest.doc.selectionFile) : undefined;
  const doc: Doc = {
    width,
    height,
    dpi: manifest.doc.dpi,
    background: manifest.doc.background,
    activeLayerId: manifest.doc.activeLayerId,
    selection: selBytes && selBytes.length === maskSize ? new Uint8ClampedArray(selBytes.slice()) : undefined,
    layers,
  };
  useStore.setState({ seed: manifest.seed });
  replaceDoc(doc);
}

// ---------- manifest validation ----------
// A .pslop is an untrusted file: every field is checked and rebuilt here so
// nothing unexpected (CSS in a color, unknown kinds/blends, absurd sizes,
// non-numeric params) reaches the store, the DOM or the GL code.

const LAYER_KINDS: LayerKind[] = ['raster', 'text', 'shape', 'adjustment', 'procedural'];
const MAX_LAYERS = 1000;
// same cap as the .psd reader: a PSD import can produce docs this big, and they must re-open
const MAX_SIDE = 30000;

const bad = (what: string): never => { throw new Error(`Corrupt .pslop: ${what}`); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, fallback: number): number => (isNum(v) ? v : fallback);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function readManifest(raw: unknown): Manifest {
  if (!isObj(raw) || raw.app !== 'photoshlopper') throw new Error('Not a .pslop file');
  const version = num(raw.version, 0);
  if (version > FORMAT_VERSION) {
    throw new Error(`This .pslop was saved by a newer Photoshlopper (format v${version})`);
  }
  const d = raw.doc;
  if (!isObj(d)) return bad('missing doc');
  const { width, height } = d;
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || (width as number) < 1 || (height as number) < 1
    || (width as number) > MAX_SIDE || (height as number) > MAX_SIDE) {
    return bad(`document size must be 1–${MAX_SIDE}px`);
  }
  if (!Array.isArray(d.layers) || d.layers.length === 0 || d.layers.length > MAX_LAYERS) return bad('bad layer list');
  const ids = new Set<string>();
  const layers = d.layers.map((l, i) => {
    const layer = readLayer(l, i);
    if (ids.has(layer.id)) bad(`duplicate layer id ${layer.id}`);
    ids.add(layer.id);
    return layer;
  });
  const activeLayerId = typeof d.activeLayerId === 'string' && ids.has(d.activeLayerId)
    ? d.activeLayerId
    : layers[layers.length - 1].id;
  return {
    app: 'photoshlopper',
    version,
    seed: num(raw.seed, 0) >>> 0,
    doc: {
      width: width as number,
      height: height as number,
      dpi: Math.min(10000, Math.max(1, num(d.dpi, 72))),
      background: d.background === 'transparent' || isHexColor(d.background) ? d.background : 'transparent',
      activeLayerId,
      selectionFile: optStr(d.selectionFile),
      layers,
    },
  };
}

function readLayer(raw: unknown, i: number): ManifestLayer {
  if (!isObj(raw)) return bad(`layer ${i} is not an object`);
  if (typeof raw.id !== 'string' || !raw.id) return bad(`layer ${i} has no id`);
  const kind = raw.kind as LayerKind;
  if (!LAYER_KINDS.includes(kind)) return bad(`layer ${i} has unknown kind`);
  const layer: ManifestLayer = {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 256) : 'Layer',
    kind,
    visible: raw.visible !== false,
    opacity: Math.min(1, Math.max(0, num(raw.opacity, 1))),
    blend: BLEND_MODES.includes(raw.blend as BlendMode) ? (raw.blend as BlendMode) : 'normal',
    locked: raw.locked === true,
    transform: readTransform(raw.transform),
    pixelsFile: optStr(raw.pixelsFile),
    maskFile: optStr(raw.maskFile),
  };
  if (raw.procedural !== undefined) layer.procedural = readNode(raw.procedural, i);
  if (isObj(raw.meta)) layer.meta = raw.meta; // free-form; readers (e.g. readTextMeta) validate their own fields
  return layer;
}

function readTransform(raw: unknown): Transform {
  const t = isObj(raw) ? raw : {};
  return {
    x: num(t.x, 0),
    y: num(t.y, 0),
    scaleX: num(t.scaleX, 1),
    scaleY: num(t.scaleY, 1),
    rotation: num(t.rotation, 0),
  };
}

function readNode(raw: unknown, i: number): ProceduralNode {
  if (!isObj(raw) || typeof raw.type !== 'string') return bad(`layer ${i} has a bad effect`);
  let def;
  try {
    def = getProcDef(raw.type);
  } catch {
    return bad(`layer ${i} uses an unknown effect "${raw.type.slice(0, 64)}"`);
  }
  const src = isObj(raw.params) ? raw.params : {};
  const params: Record<string, ParamValue> = {};
  for (const p of def.params) {
    const v = src[p.key];
    if (p.type === 'color') {
      params[p.key] = Array.isArray(v) && v.length === 3 && v.every(isNum)
        ? [v[0], v[1], v[2]]
        : p.def;
    } else {
      params[p.key] = isNum(v) ? v : p.def;
    }
  }
  return { type: def.type, params };
}

export function promptOpenPslop(onError: (msg: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pslop,application/zip';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) openPslop(file).catch((e) => onError(e instanceof Error ? e.message : String(e)));
  };
  input.click();
}
