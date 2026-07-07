// .pslop — the native project format. A stored zip containing:
//   manifest.json  doc + layers (transforms, blend, procedural graphs) + seed
//   layers/<id>.png   pixel buffers for raster/text/shape layers
//   masks/<id>.bin    raw layer masks (doc-sized, 1 byte/px)
//   selection.bin     raw selection mask, if any
// Round-trips losslessly: save -> open restores the session exactly
// (except undo history, which is not persisted).
//
// versioned: bump FORMAT_VERSION on breaking changes and keep readers tolerant.

import type { Doc, Layer } from '../types';
import { useStore, replaceDoc } from '../store';
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
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  if (manifest.app !== 'photoshlopper') throw new Error('Not a .pslop file');
  if (manifest.version > FORMAT_VERSION) {
    throw new Error(`This .pslop was saved by a newer Photoshlopper (format v${manifest.version})`);
  }
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
      if (data) layer.mask = new Uint8ClampedArray(data.slice());
    }
    layers.push(layer);
  }
  const selBytes = manifest.doc.selectionFile ? files.get(manifest.doc.selectionFile) : undefined;
  const doc: Doc = {
    width: manifest.doc.width,
    height: manifest.doc.height,
    dpi: manifest.doc.dpi,
    background: manifest.doc.background,
    activeLayerId: manifest.doc.activeLayerId,
    selection: selBytes ? new Uint8ClampedArray(selBytes.slice()) : undefined,
    layers,
  };
  useStore.setState({ seed: manifest.seed });
  replaceDoc(doc);
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
