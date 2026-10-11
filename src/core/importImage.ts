// Image import: File ▸ Import Image… and drag-and-drop onto the canvas or the
// Layers panel. Each image becomes a new raster layer (one undo step each),
// scaled down to fit the document if it's bigger and centered on the drop
// point. With no document open, the first image sets the document size.
// Dropped .pslop / .psd files are opened instead.

import { useStore, newDoc, insertLayerWithPixels, setLayerPropsLive, bumpLayer, setStatus } from '../store';
import { makeCanvas, canvasToImageData, setPixels } from './pixels';
import { openPslop } from '../export/pslop';
import { openPsd } from '../export/psd';

const MAX_SIDE = 4096;
const MAX_FILES = 20;
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/svg+xml';

const isImage = (f: File) => f.type.startsWith('image/') && f.type !== 'image/vnd.adobe.photoshop';
const ext = (f: File) => f.name.toLowerCase().split('.').pop() ?? '';

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').slice(0, 32) || 'Image';
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // SVGs (and some browsers' formats) need an <img> round trip
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Draw `bmp` into a doc-sized buffer, fit inside the doc and centered on (cx, cy). */
function placeIntoDoc(bmp: ImageBitmap, dw: number, dh: number, cx: number, cy: number): ImageData {
  const scale = Math.min(1, dw / bmp.width, dh / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  const x = Math.round(Math.max(0, Math.min(dw - w, cx - w / 2)));
  const y = Math.round(Math.max(0, Math.min(dh - h, cy - h / 2)));
  const c = makeCanvas(dw, dh);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, x, y, w, h);
  return canvasToImageData(c);
}

/**
 * Import files. `at` is the drop point in doc coordinates (defaults to the
 * doc center). Returns once every file is placed.
 */
export async function importFiles(files: File[], at?: { x: number; y: number }): Promise<void> {
  const project = files.find((f) => ext(f) === 'pslop' || ext(f) === 'psd');
  if (project) {
    try {
      await (ext(project) === 'pslop' ? openPslop(project) : openPsd(project));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  const images = files.filter(isImage);
  if (!images.length) {
    setStatus('Nothing to import — drop PNG, JPEG, WebP, GIF, BMP, AVIF or SVG images');
    return;
  }
  if (images.length > MAX_FILES) setStatus(`Importing the first ${MAX_FILES} of ${images.length} images`);
  let placed = 0;
  for (const file of images.slice(0, MAX_FILES)) {
    let bmp: ImageBitmap;
    try {
      bmp = await decode(file);
    } catch {
      setStatus(`Couldn't read "${file.name}" as an image`);
      continue;
    }
    try {
      if (!useStore.getState().doc) {
        // first image defines the document
        const scale = Math.min(1, MAX_SIDE / bmp.width, MAX_SIDE / bmp.height);
        const w = Math.max(8, Math.round(bmp.width * scale));
        const h = Math.max(8, Math.round(bmp.height * scale));
        newDoc(w, h, 'transparent');
        const doc = useStore.getState().doc!;
        const layerId = doc.layers[0].id;
        setPixels(layerId, placeIntoDoc(bmp, w, h, w / 2, h / 2));
        setLayerPropsLive(layerId, { name: baseName(file.name) });
        bumpLayer(layerId);
      } else {
        const doc = useStore.getState().doc!;
        const px = placeIntoDoc(bmp, doc.width, doc.height, at?.x ?? doc.width / 2, at?.y ?? doc.height / 2);
        insertLayerWithPixels(baseName(file.name), 'raster', px, undefined, 'Import Image');
      }
      placed++;
    } finally {
      bmp.close();
    }
  }
  if (placed) setStatus(`Imported ${placed} image${placed > 1 ? 's' : ''} as new layer${placed > 1 ? 's' : ''}`);
}

export function promptImportImage(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = IMAGE_ACCEPT;
  input.multiple = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    if (files.length) void importFiles(files);
  };
  input.click();
}

/** True if a drag carries files from the OS (vs. an internal layer drag). */
export function dragHasFiles(e: DragEvent | React.DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}
