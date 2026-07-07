// 3D export. Two derivation modes, both textured with the flattened
// composite (or active layer):
//   - Die-cut sticker: alpha silhouette -> marching-squares contours ->
//     Douglas-Peucker simplify -> ExtrudeGeometry with real thickness.
//     Optional white border = silhouette dilation (both mesh and texture).
//   - Luminance heightfield: subdivided plane displaced by pixel luminance.
// Exported via GLTFExporter (.glb / .gltf) and OBJExporter (.obj + .mtl +
// texture PNG, zipped).

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { traceContours, simplifyDP, polygonArea, pointInPolygon, type Point } from '../core/contours';
import { imageDataToCanvas, makeCanvas, canvasToBlob } from '../core/pixels';
import { writeZip, type ZipEntry } from './zip';

export interface StickerOptions {
  depth: number;          // extrusion depth in world units (mesh is ~2 units wide)
  simplify: number;       // Douglas-Peucker epsilon in px
  border: number;         // white border in px (0 = none)
  alphaThreshold: number; // 0..255
}

export interface HeightfieldOptions {
  amplitude: number; // world units
  segments: number;  // grid resolution along the longer axis
}

function alphaMask(img: ImageData, threshold: number): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0; i < mask.length; i++) mask[i] = img.data[i * 4 + 3] >= threshold ? 255 : 0;
  return mask;
}

/** Dilate an alpha silhouette by `radius` px using offset draws (16 directions x 2 rings). */
function dilateCanvas(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const ctx = out.getContext('2d')!;
  for (const r of [radius, radius * 0.6]) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctx.drawImage(src, Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  ctx.drawImage(src, 0, 0);
  return out;
}

/** Build the sticker texture: white dilated silhouette underlay + the art on top. */
function buildStickerTexture(img: ImageData, border: number): HTMLCanvasElement {
  const art = imageDataToCanvas(img);
  if (border <= 0) return art;
  const silhouette = makeCanvas(img.width, img.height);
  const sctx = silhouette.getContext('2d')!;
  sctx.drawImage(art, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#ffffff';
  sctx.fillRect(0, 0, img.width, img.height);
  const dilated = dilateCanvas(silhouette, border);
  const out = makeCanvas(img.width, img.height);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(dilated, 0, 0);
  ctx.drawImage(art, 0, 0);
  return out;
}

export interface BuiltMesh {
  mesh: THREE.Mesh;
  textureCanvas: HTMLCanvasElement;
  stats: string;
}

export function buildStickerMesh(img: ImageData, opts: StickerOptions): BuiltMesh {
  const { width: w, height: h } = img;
  const textureCanvas = buildStickerTexture(img, opts.border);
  // silhouette (dilated if bordered) drives the mesh outline
  let mask: Uint8ClampedArray;
  if (opts.border > 0) {
    const texCtx = textureCanvas.getContext('2d', { willReadFrequently: true })!;
    mask = alphaMask(texCtx.getImageData(0, 0, w, h), opts.alphaThreshold);
  } else {
    mask = alphaMask(img, opts.alphaThreshold);
  }

  const raw = traceContours(mask, w, h);
  const minArea = Math.max(16, (w * h) * 0.0002);
  const contours = raw
    .map((c) => simplifyDP(c, Math.max(0.5, opts.simplify)))
    .filter((c) => c.length >= 3 && Math.abs(polygonArea(c)) >= minArea)
    .sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));

  if (contours.length === 0) {
    throw new Error('No opaque silhouette found — the image is fully transparent (or fully below the alpha threshold).');
  }

  const scale = 2 / Math.max(w, h);
  const toWorld = ([x, y]: Point): [number, number] => [(x - w / 2) * scale, (h / 2 - y) * scale];

  // classify contours: even containment depth = outer shape, odd = hole
  const depthOf = (c: Point[]): number => {
    let d = 0;
    for (const other of contours) {
      if (other === c) continue;
      if (Math.abs(polygonArea(other)) <= Math.abs(polygonArea(c))) continue;
      if (pointInPolygon(c[0], other)) d++;
    }
    return d;
  };
  const outers: Array<{ shape: THREE.Shape; contour: Point[] }> = [];
  const holes: Point[][] = [];
  for (const c of contours) {
    if (depthOf(c) % 2 === 0) {
      const shape = new THREE.Shape(c.map((p) => new THREE.Vector2(...toWorld(p))));
      outers.push({ shape, contour: c });
    } else {
      holes.push(c);
    }
  }
  for (const hole of holes) {
    // attach to the smallest outer that contains it
    let best: { shape: THREE.Shape; contour: Point[] } | null = null;
    for (const o of outers) {
      if (pointInPolygon(hole[0], o.contour)) {
        if (!best || Math.abs(polygonArea(o.contour)) < Math.abs(polygonArea(best.contour))) best = o;
      }
    }
    best?.shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(...toWorld(p)))));
  }

  const geometry = new THREE.ExtrudeGeometry(outers.map((o) => o.shape), {
    depth: opts.depth,
    bevelEnabled: false,
  });
  remapUVsFromWorld(geometry, w, h, scale);
  geometry.computeVertexNormals();
  geometry.translate(0, 0, -opts.depth / 2);

  const mesh = new THREE.Mesh(geometry, buildMaterials(textureCanvas));
  const tris = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
  return {
    mesh,
    textureCanvas,
    stats: `${outers.length} island(s), ${holes.length} hole(s), ${Math.round(tris)} triangles`,
  };
}

export function buildHeightfieldMesh(img: ImageData, opts: HeightfieldOptions): BuiltMesh {
  const { width: w, height: h } = img;
  const aspect = w / h;
  const worldW = aspect >= 1 ? 2 : 2 * aspect;
  const worldH = aspect >= 1 ? 2 / aspect : 2;
  const segX = Math.max(2, Math.round(aspect >= 1 ? opts.segments : opts.segments * aspect));
  const segY = Math.max(2, Math.round(aspect >= 1 ? opts.segments / aspect : opts.segments));
  const geometry = new THREE.PlaneGeometry(worldW, worldH, segX, segY);
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / worldW + 0.5;
    const v = 0.5 - pos.getY(i) / worldH; // v=0 at top, matching flipY=false textures
    uv.setXY(i, u, v);
    const px = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
    const py = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
    const o = (py * w + px) * 4;
    const lum = (0.3 * img.data[o] + 0.59 * img.data[o + 1] + 0.11 * img.data[o + 2]) / 255;
    const alpha = img.data[o + 3] / 255;
    pos.setZ(i, lum * alpha * opts.amplitude);
  }
  geometry.computeVertexNormals();
  const textureCanvas = imageDataToCanvas(img);
  const mesh = new THREE.Mesh(geometry, buildMaterials(textureCanvas)[0]);
  return {
    mesh,
    textureCanvas,
    stats: `${segX}x${segY} grid, ${segX * segY * 2} triangles`,
  };
}

function buildMaterials(textureCanvas: HTMLCanvasElement): THREE.MeshStandardMaterial[] {
  const tex = new THREE.CanvasTexture(textureCanvas);
  tex.flipY = false; // glTF convention; UVs are generated to match
  tex.colorSpace = THREE.SRGBColorSpace;
  const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0, transparent: false });
  const side = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });
  return [front, side]; // ExtrudeGeometry: group 0 = caps, group 1 = sides
}

function remapUVsFromWorld(geometry: THREE.BufferGeometry, w: number, h: number, scale: number): void {
  const pos = geometry.attributes.position;
  const uvArr = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const docX = pos.getX(i) / scale + w / 2;
    const docY = h / 2 - pos.getY(i) / scale;
    uvArr[i * 2] = docX / w;
    uvArr[i * 2 + 1] = docY / h; // v=0 at top with flipY=false
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
}

// ---- file export ----

export type MeshFormat = 'glb' | 'gltf' | 'obj';

export async function exportMeshFile(built: BuiltMesh, format: MeshFormat): Promise<{ blob: Blob; filename: string }> {
  const scene = new THREE.Scene();
  scene.add(built.mesh.clone());
  if (format === 'glb' || format === 'gltf') {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(scene, { binary: format === 'glb' });
    if (format === 'glb') {
      return { blob: new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), filename: 'photoshlopper.glb' };
    }
    return {
      blob: new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' }),
      filename: 'photoshlopper.gltf',
    };
  }
  // OBJ: geometry from OBJExporter + hand-written MTL + texture png, zipped
  const objExporter = new OBJExporter();
  const obj = 'mtllib photoshlopper.mtl\nusemtl sticker\n' + objExporter.parse(scene);
  const mtl = `newmtl sticker
Ka 1.0 1.0 1.0
Kd 1.0 1.0 1.0
Ks 0.05 0.05 0.05
d 1.0
illum 2
map_Kd texture.png
`;
  const texBlob = await canvasToBlob(built.textureCanvas, 'image/png');
  const entries: ZipEntry[] = [
    { name: 'photoshlopper.obj', data: new TextEncoder().encode(obj) },
    { name: 'photoshlopper.mtl', data: new TextEncoder().encode(mtl) },
    { name: 'texture.png', data: new Uint8Array(await texBlob.arrayBuffer()) },
  ];
  return { blob: writeZip(entries), filename: 'photoshlopper-obj.zip' };
}

// ---- live rotating preview ----

export interface MeshPreview {
  setMesh(mesh: THREE.Mesh | null): void;
  dispose(): void;
}

export function createMeshPreview(canvas: HTMLCanvasElement): MeshPreview {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  camera.position.set(0, 0.8, 3.2);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 3, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.6);
  rim.position.set(-3, -1, -2);
  scene.add(rim);
  const pivot = new THREE.Group();
  scene.add(pivot);
  let raf = 0;
  let disposed = false;
  const loop = () => {
    if (disposed) return;
    const size = canvas.clientWidth || 300;
    if (canvas.width !== size * renderer.getPixelRatio()) {
      renderer.setSize(size, size, false);
      camera.aspect = 1;
      camera.updateProjectionMatrix();
    }
    pivot.rotation.y += 0.012;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();
  return {
    setMesh(mesh) {
      pivot.clear();
      if (mesh) pivot.add(mesh);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      renderer.dispose();
    },
  };
}
