// Minimal Photoshop .psd reader/writer — 8-bit RGB, PackBits RLE, no deps.
//
// Export: every layer is baked (transform, mask, procedural render) to a
// doc-sized RGBA raster and written as a full-canvas PSD layer with its
// blend mode, opacity and visibility mapped to the PSD equivalents, plus a
// flattened composite so thumbnailers and strict readers see the image.
// Adjustment layers have no PSD representation — they're baked into the
// composite but skipped in the layer stack.
//
// Import: 8-bit RGB or grayscale PSDs with raw or RLE channels. Layers come
// in as raster layers (group dividers are skipped, layer masks are baked out
// by readers that pre-applied them or ignored otherwise); PSDs without layer
// data fall back to the flattened composite as a single Background layer.
//
// Format reference: Adobe Photoshop File Formats Specification (8BPS v1).

import type { BlendMode, Doc, Layer } from '../types';
import { identityTransform, newId } from '../types';
import { useStore, replaceDoc, setStatus } from '../store';
import { setPixels, download } from '../core/pixels';
import { getCompositor } from '../core/compositor';

// ---------- blend mode mapping ----------

const BLEND_TO_PSD: Record<BlendMode, string> = {
  normal: 'norm', multiply: 'mul ', screen: 'scrn', overlay: 'over',
  darken: 'dark', lighten: 'lite', 'color-dodge': 'div ', 'color-burn': 'idiv',
  'hard-light': 'hLit', 'soft-light': 'sLit', difference: 'diff', exclusion: 'smud',
  hue: 'hue ', saturation: 'sat ', color: 'colr', luminosity: 'lum ',
};

const PSD_TO_BLEND: Record<string, BlendMode> = Object.fromEntries(
  Object.entries(BLEND_TO_PSD).map(([k, v]) => [v, k as BlendMode]),
);
PSD_TO_BLEND['pass'] = 'normal';       // group pass-through
PSD_TO_BLEND['lddg'] = 'color-dodge';  // linear dodge ≈ closest we have
PSD_TO_BLEND['lbrn'] = 'color-burn';   // linear burn ≈ closest we have

// ---------- byte plumbing ----------

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  get length(): number { return this.len; }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  u16(v: number): void { this.ensure(2); this.buf[this.len++] = (v >>> 8) & 0xff; this.buf[this.len++] = v & 0xff; }
  i16(v: number): void { this.u16(v & 0xffff); }
  u32(v: number): void { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); }
  ascii(s: string): void { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  bytes(a: Uint8Array): void { this.ensure(a.length); this.buf.set(a, this.len); this.len += a.length; }
  zeros(n: number): void { this.ensure(n); this.len += n; }

  /** Write a u32 placeholder; patch it later with patchU32. */
  reserveU32(): number { const p = this.len; this.u32(0); return p; }
  patchU32(pos: number, v: number): void {
    this.buf[pos] = (v >>> 24) & 0xff;
    this.buf[pos + 1] = (v >>> 16) & 0xff;
    this.buf[pos + 2] = (v >>> 8) & 0xff;
    this.buf[pos + 3] = v & 0xff;
  }

  toBytes(): Uint8Array { return this.buf.slice(0, this.len); }
}

class ByteReader {
  off = 0;
  constructor(private dv: DataView) {}

  get remaining(): number { return this.dv.byteLength - this.off; }
  u8(): number { const v = this.dv.getUint8(this.off); this.off += 1; return v; }
  u16(): number { const v = this.dv.getUint16(this.off); this.off += 2; return v; }
  i16(): number { const v = this.dv.getInt16(this.off); this.off += 2; return v; }
  u32(): number { const v = this.dv.getUint32(this.off); this.off += 4; return v; }
  i32(): number { const v = this.dv.getInt32(this.off); this.off += 4; return v; }
  skip(n: number): void { this.off += n; }
  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  bytes(n: number): Uint8Array {
    const v = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.off, n);
    this.off += n;
    return v;
  }
}

// ---------- PackBits RLE ----------

function packBitsRow(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && src[i + run] === src[i] && run < 128) run++;
    if (run >= 2) {
      out.push((257 - run) & 0xff, src[i]);
      i += run;
    } else {
      let j = i + 1;
      while (j < n && j - i < 128 && !(j + 1 < n && src[j] === src[j + 1])) j++;
      out.push(j - i - 1);
      for (let k = i; k < j; k++) out.push(src[k]);
      i = j;
    }
  }
  return new Uint8Array(out);
}

function unpackBitsInto(src: Uint8Array, dst: Uint8Array, dstOff: number, expect: number): void {
  let i = 0;
  let o = 0;
  while (i < src.length && o < expect) {
    const n = src[i++];
    if (n === 128) continue; // no-op
    if (n < 128) {
      const cnt = n + 1;
      for (let k = 0; k < cnt && o < expect && i < src.length; k++) dst[dstOff + o++] = src[i++];
    } else {
      const cnt = 257 - n;
      const v = src[i++];
      for (let k = 0; k < cnt && o < expect; k++) dst[dstOff + o++] = v;
    }
  }
}

// ---------- planes ----------

function extractPlanes(px: ImageData): { r: Uint8Array; g: Uint8Array; b: Uint8Array; a: Uint8Array } {
  const n = px.width * px.height;
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n), a = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    r[i] = px.data[o];
    g[i] = px.data[o + 1];
    b[i] = px.data[o + 2];
    a[i] = px.data[o + 3];
  }
  return { r, g, b, a };
}

function rleRows(plane: Uint8Array, w: number, h: number): Uint8Array[] {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < h; y++) rows.push(packBitsRow(plane.subarray(y * w, (y + 1) * w)));
  return rows;
}

/** RLE channel body for a layer channel: row byte-counts then packed rows. */
function encodeRLEBody(plane: Uint8Array, w: number, h: number): Uint8Array {
  const rows = rleRows(plane, w, h);
  const total = rows.reduce((acc, r) => acc + r.length, 0);
  const out = new Uint8Array(h * 2 + total);
  let off = h * 2;
  for (let y = 0; y < h; y++) {
    out[y * 2] = (rows[y].length >>> 8) & 0xff;
    out[y * 2 + 1] = rows[y].length & 0xff;
    out.set(rows[y], off);
    off += rows[y].length;
  }
  return out;
}

// ---------- writer ----------

function writePascalName(w: ByteWriter, name: string): void {
  // Pascal string, ASCII-folded, ≤31 chars, padded (incl. length byte) to 4.
  let ascii = '';
  for (const ch of name) ascii += ch.charCodeAt(0) < 128 ? ch : '_';
  ascii = ascii.slice(0, 31);
  w.u8(ascii.length);
  w.ascii(ascii);
  w.zeros((4 - ((ascii.length + 1) % 4)) % 4);
}

export function writePsd(width: number, height: number, layers: Array<{ layer: Layer; px: ImageData }>, composite: ImageData): Uint8Array {
  const w = new ByteWriter();

  // header: signature, version, reserved, channels (RGBA), h, w, depth, RGB mode
  w.ascii('8BPS');
  w.u16(1);
  w.zeros(6);
  w.u16(4);
  w.u32(height);
  w.u32(width);
  w.u16(8);
  w.u16(3);

  w.u32(0); // color mode data
  w.u32(0); // image resources

  // layer & mask info
  const lmiPos = w.reserveU32();
  const liPos = w.reserveU32();
  // negative count: composite's 4th channel holds transparency
  w.i16(-layers.length);

  const channelBodies: Uint8Array[][] = [];
  const CHANNEL_IDS = [-1, 0, 1, 2]; // alpha, R, G, B

  for (const { layer, px } of layers) {
    const planes = extractPlanes(px);
    const bodies = [planes.a, planes.r, planes.g, planes.b].map((p) => encodeRLEBody(p, width, height));
    channelBodies.push(bodies);

    // rect (full canvas), channel infos
    w.u32(0); w.u32(0); w.u32(height); w.u32(width);
    w.u16(4);
    bodies.forEach((b, i) => {
      w.i16(CHANNEL_IDS[i]);
      w.u32(2 + b.length); // compression marker + body
    });

    w.ascii('8BIM');
    w.ascii(BLEND_TO_PSD[layer.blend] ?? 'norm');
    w.u8(Math.round(layer.opacity * 255));
    w.u8(0); // clipping: base
    w.u8(layer.visible ? 0 : 2); // flags: bit 1 set = hidden
    w.u8(0); // filler

    const extraPos = w.reserveU32();
    w.u32(0); // no layer mask data
    w.u32(0); // no blending ranges
    writePascalName(w, layer.name);
    w.patchU32(extraPos, w.length - extraPos - 4);
  }

  // channel image data, same order as the records
  for (const bodies of channelBodies) {
    for (const b of bodies) {
      w.u16(1); // RLE
      w.bytes(b);
    }
  }

  if ((w.length - liPos - 4) & 1) w.u8(0); // layer info is padded to even
  w.patchU32(liPos, w.length - liPos - 4);
  w.u32(0); // global layer mask info
  w.patchU32(lmiPos, w.length - lmiPos - 4);

  // flattened composite: RLE, planar R,G,B,A with all row counts up front
  w.u16(1);
  const comp = extractPlanes(composite);
  const planeRows = [comp.r, comp.g, comp.b, comp.a].map((p) => rleRows(p, width, height));
  for (const rows of planeRows) for (const row of rows) w.u16(row.length);
  for (const rows of planeRows) for (const row of rows) w.bytes(row);

  return w.toBytes();
}

/** Export the current document as a layered .psd download. */
export async function savePsd(): Promise<void> {
  const s = useStore.getState();
  const doc = s.doc;
  if (!doc) return;
  try {
    const comp = getCompositor();
    const baked: Array<{ layer: Layer; px: ImageData }> = [];
    const skipped: string[] = [];
    for (const layer of doc.layers) {
      if (layer.kind === 'adjustment') {
        // an effect over the layers below has no standalone pixels to export
        skipped.push(layer.name);
        continue;
      }
      const solo = comp.renderToImageData(
        doc, s.layerVersions,
        [{ ...layer, blend: 'normal', opacity: 1, visible: true }],
        'transparent',
      );
      baked.push({ layer, px: solo });
    }
    const composite = comp.renderToImageData(doc, s.layerVersions, doc.layers.filter((l) => l.visible), doc.background);
    const bytes = writePsd(doc.width, doc.height, baked, composite);
    download(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/vnd.adobe.photoshop' }), `photoshlopper-${Date.now().toString(36)}.psd`);
    setStatus(skipped.length
      ? `Exported .psd — adjustment layer(s) baked into the composite only: ${skipped.join(', ')}`
      : `Exported .psd (${baked.length} layer${baked.length === 1 ? '' : 's'})`);
  } catch (e) {
    setStatus(`PSD export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- reader ----------

interface LayerRecord {
  top: number; left: number; bottom: number; right: number;
  chans: Array<{ id: number; len: number }>;
  blend: BlendMode;
  opacity: number;
  visible: boolean;
  name: string;
  divider: boolean;
}

function readLayerRecord(r: ByteReader): LayerRecord {
  const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
  const chanCount = r.u16();
  const chans: Array<{ id: number; len: number }> = [];
  for (let i = 0; i < chanCount; i++) chans.push({ id: r.i16(), len: r.u32() });
  if (r.ascii(4) !== '8BIM') throw new Error('Corrupt PSD: bad layer blend signature');
  const key = r.ascii(4);
  const opacity = r.u8() / 255;
  r.skip(1); // clipping
  const flags = r.u8();
  r.skip(1); // filler
  const extraLen = r.u32();
  const extraEnd = r.off + extraLen;

  r.skip(r.u32()); // layer mask / adjustment data
  r.skip(r.u32()); // blending ranges
  const nameLen = r.u8();
  let name = '';
  for (let i = 0; i < nameLen; i++) name += String.fromCharCode(r.u8());
  r.skip((4 - ((nameLen + 1) % 4)) % 4);

  // additional info blocks: pick up unicode name + group dividers
  let uniName: string | null = null;
  let divider = false;
  while (extraEnd - r.off >= 12) {
    const sig = r.ascii(4);
    if (sig !== '8BIM' && sig !== '8B64') break;
    const bkey = r.ascii(4);
    const blen = r.u32();
    const bend = Math.min(r.off + blen + (blen & 1), extraEnd);
    if (bkey === 'luni' && blen >= 4) {
      const cnt = r.u32();
      let s = '';
      for (let i = 0; i < cnt && r.off + 2 <= bend; i++) s += String.fromCharCode(r.u16());
      uniName = s.replace(/\0+$/, '');
    } else if (bkey === 'lsct' && blen >= 4) {
      const type = r.u32();
      if (type === 1 || type === 2 || type === 3) divider = true; // folder open/closed/end marker
    }
    r.off = bend;
  }
  r.off = extraEnd;

  return {
    top, left, bottom, right, chans,
    blend: PSD_TO_BLEND[key] ?? 'normal',
    opacity,
    visible: (flags & 2) === 0,
    name: uniName || name || 'Layer',
    divider,
  };
}

function readLayerChannels(r: ByteReader, rec: LayerRecord, docW: number, docH: number, mode: number): ImageData {
  const lw = rec.right - rec.left;
  const lh = rec.bottom - rec.top;
  const planes = new Map<number, Uint8Array>();

  for (const ch of rec.chans) {
    const end = r.off + ch.len;
    if (ch.id < -1 || lw <= 0 || lh <= 0 || ch.len < 2) {
      r.off = end; // layer/vector masks and empty layers: skip
      continue;
    }
    const compression = r.u16();
    let plane: Uint8Array;
    if (compression === 0) {
      plane = r.bytes(lw * lh);
    } else if (compression === 1) {
      const counts: number[] = [];
      for (let y = 0; y < lh; y++) counts.push(r.u16());
      plane = new Uint8Array(lw * lh);
      for (let y = 0; y < lh; y++) unpackBitsInto(r.bytes(counts[y]), plane, y * lw, lw);
    } else {
      throw new Error('Unsupported PSD channel compression (ZIP) — re-save with compatibility mode');
    }
    planes.set(ch.id, plane);
    r.off = end;
  }

  const img = new ImageData(docW, docH);
  if (lw > 0 && lh > 0) {
    const rP = planes.get(0);
    const gP = mode === 1 ? planes.get(0) : planes.get(1);
    const bP = mode === 1 ? planes.get(0) : planes.get(2);
    const aP = planes.get(-1);
    for (let y = 0; y < lh; y++) {
      const dy = rec.top + y;
      if (dy < 0 || dy >= docH) continue;
      for (let x = 0; x < lw; x++) {
        const dx = rec.left + x;
        if (dx < 0 || dx >= docW) continue;
        const si = y * lw + x;
        const di = (dy * docW + dx) * 4;
        img.data[di] = rP ? rP[si] : 0;
        img.data[di + 1] = gP ? gP[si] : 0;
        img.data[di + 2] = bP ? bP[si] : 0;
        img.data[di + 3] = aP ? aP[si] : 255;
      }
    }
  }
  return img;
}

function readComposite(r: ByteReader, channels: number, w: number, h: number, mode: number): ImageData {
  const compression = r.u16();
  const planes: Uint8Array[] = [];
  if (compression === 0) {
    for (let c = 0; c < channels; c++) planes.push(r.bytes(w * h));
  } else if (compression === 1) {
    const counts: number[] = [];
    for (let i = 0; i < channels * h; i++) counts.push(r.u16());
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) unpackBitsInto(r.bytes(counts[c * h + y]), plane, y * w, w);
      planes.push(plane);
    }
  } else {
    throw new Error('Unsupported PSD image compression');
  }
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (mode === 1) {
      img.data[o] = img.data[o + 1] = img.data[o + 2] = planes[0][i];
      img.data[o + 3] = planes[1] ? planes[1][i] : 255;
    } else {
      img.data[o] = planes[0][i];
      img.data[o + 1] = planes[1][i];
      img.data[o + 2] = planes[2][i];
      img.data[o + 3] = planes[3] ? planes[3][i] : 255;
    }
  }
  return img;
}

interface ParsedPsd {
  width: number;
  height: number;
  layers: Array<{ name: string; blend: BlendMode; opacity: number; visible: boolean; px: ImageData }>;
}

export function parsePsd(buf: ArrayBuffer): ParsedPsd {
  const r = new ByteReader(new DataView(buf));
  if (r.remaining < 26 || r.ascii(4) !== '8BPS') throw new Error('Not a PSD file');
  const version = r.u16();
  if (version === 2) throw new Error('PSB (large document format) is not supported');
  if (version !== 1) throw new Error(`Unsupported PSD version ${version}`);
  r.skip(6);
  const channels = r.u16();
  const height = r.u32();
  const width = r.u32();
  const depth = r.u16();
  const mode = r.u16();
  if (width < 1 || height < 1 || width > 30000 || height > 30000) throw new Error('Bad PSD dimensions');
  if (depth !== 8) throw new Error(`Only 8-bit/channel PSDs are supported (this one is ${depth}-bit)`);
  if (mode !== 3 && mode !== 1) throw new Error('Only RGB and Grayscale PSDs are supported');

  r.skip(r.u32()); // color mode data
  r.skip(r.u32()); // image resources

  const lmLen = r.u32();
  const lmEnd = r.off + lmLen;
  const layers: ParsedPsd['layers'] = [];

  if (lmLen > 0) {
    const liLen = r.u32();
    if (liLen > 0) {
      const liEnd = r.off + liLen;
      const count = Math.abs(r.i16());
      const recs: LayerRecord[] = [];
      for (let i = 0; i < count; i++) recs.push(readLayerRecord(r));
      for (const rec of recs) {
        const px = readLayerChannels(r, rec, width, height, mode);
        if (!rec.divider) {
          layers.push({ name: rec.name, blend: rec.blend, opacity: rec.opacity, visible: rec.visible, px });
        }
      }
      r.off = liEnd;
    }
  }

  if (layers.length === 0) {
    // no usable layer data — fall back to the flattened composite
    r.off = lmEnd;
    layers.push({ name: 'Background', blend: 'normal', opacity: 1, visible: true, px: readComposite(r, channels, width, height, mode) });
  }

  return { width, height, layers };
}

/** Import a .psd file as a new document (replaces the current one). */
export async function openPsd(file: File): Promise<void> {
  const parsed = parsePsd(await file.arrayBuffer());
  // PSD stores layer records bottom-to-top — same order as doc.layers
  const layers: Layer[] = parsed.layers.map((pl) => {
    const layer: Layer = {
      id: newId(), name: pl.name, kind: 'raster', visible: pl.visible,
      opacity: pl.opacity, blend: pl.blend, locked: false, transform: identityTransform(),
    };
    setPixels(layer.id, pl.px);
    return layer;
  });
  const doc: Doc = {
    width: parsed.width,
    height: parsed.height,
    dpi: 72,
    layers,
    activeLayerId: layers[layers.length - 1].id,
    background: 'transparent',
  };
  replaceDoc(doc);
  setStatus(`Imported ${file.name}: ${layers.length} layer(s), ${parsed.width}×${parsed.height}`);
}

export function promptOpenPsd(onError: (msg: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.psd,image/vnd.adobe.photoshop';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) openPsd(file).catch((e) => onError(e instanceof Error ? e.message : String(e)));
  };
  input.click();
}
