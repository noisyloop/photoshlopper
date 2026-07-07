# Photoshlopper 🎨

A browser-based raster image editor — a small, honest Photoshop clone aimed at
stickers, generative art and shareable graphics. Everything runs client-side;
there is no backend. Its two party tricks:

- **The Ransomiser** — one click seeds the canvas with reproducible generative
  art (visible seed, mulberry32) plus a couple of random effects.
- **An export system that goes past pixels** — die-cut 3D sticker meshes and
  heightfields (GLB/GLTF/OBJ), and real fragment shaders (raw WebGL2,
  Shadertoy, ISF) compiled from the layer stack, alongside PNG/JPEG/WebP and a
  native `.pslop` project format.

## Run it

```bash
npm install
npm run dev        # dev server
npm run build      # tsc --noEmit + production bundle in dist/
```

Requires a browser with WebGL2 (any current Chrome/Firefox/Safari).

**60-second tour:** open the app → *Create* (or *Create & Ransomise*) → hit the
big **🎲 RANSOMISER** button (or `Ctrl/⌘+Shift+R`) → paint over it with the
Brush (`B`) → add a layer (`Ctrl/⌘+Shift+N`) → **Export…** → PNG with
*trim to content* for a sticker, the **3D Object** tab for a `.glb` sticker
mesh, or the **Shader** tab for a Shadertoy-ready shader. Press `?` for the
searchable shortcut cheatsheet.

## What works

- **Documents & rendering** — WebGL2 compositor; per-layer pixel storage as
  `ImageData`; all **16 Photoshop blend modes** implemented once as GLSL
  (W3C compositing spec formulas) and shared verbatim between the live
  compositor and the shader exporter. Checkerboard transparency, rulers,
  zoom/pan (wheel, `Z`, `H`, Space-drag, `Ctrl+0/1/+/−`).
- **Tools** — Move (layer transform, or floats selected pixels), Marquee
  (rect/ellipse, Shift add / Alt subtract), Lasso (freehand), Magic Wand,
  Crop (Enter applies), Eyedropper, Brush, Eraser, Clone Stamp (Alt-click
  source), Paint Bucket, Gradient (linear/radial, FG→BG), Type (click to add,
  re-click a text layer to re-edit), Shape (rect/ellipse/line), Hand, Zoom.
- **Brush engine** — stamp-based with size/hardness/opacity/flow + spacing,
  pointer-pressure size, strokes buffered offscreen and committed as **one
  undo entry per stroke**, respects selections and layer locks.
- **Layers** — thumbnails, rename (double-click), visibility, opacity, blend
  mode, lock, drag-reorder, duplicate, delete, merge down / merge visible /
  flatten, layer masks (from selection). Selections and masks are the same
  primitive: a doc-sized alpha mask.
- **Non-destructive effects** — adjustment/procedural layers with live GLSL:
  brightness/contrast, hue/saturation, levels, invert, posterize, threshold,
  grayscale, gaussian/box/motion blur, glitch, chromatic aberration, pixelate,
  Bayer dither, halftone, noise grain, vignette, bloom, wave, ripple,
  kaleidoscope — each defined **once** with param metadata, edited in the
  Properties panel, and inlined by the shader exporter. Floyd–Steinberg dither
  ships as a destructive CPU filter (error diffusion is inherently sequential).
- **Ransomiser** — seeded (mulberry32, seed shown + re-roll), weighted base
  pick (gradient / simplex noise field / voronoi / wave interference as
  procedural layers; flow field / scattered shapes as CPU-rendered raster),
  harmonious palette (analogous/triad/complementary), 1–2 moderate effect
  layers, inserted at the bottom of the stack as a single undo entry.
- **History** — command-pattern undo/redo, capped at 50 entries, pixel edits
  stored as dirty-rect region snapshots, History panel with click-to-jump.
- **Keyboard** — Photoshop-parity keymap (see `?`); suppressed while typing.

## Export system (how outputs are actually derived)

- **Raster** — the WebGL2 composite is read back and encoded via canvas
  `toBlob`. Options: whole doc / active layer, *trim to content* (crop to the
  alpha bounding box — the sticker cutout), 1×/2×/4× scale, JPEG/WebP quality.
- **3D sticker mesh** — the composite's alpha is thresholded, the silhouette
  traced with a marching-squares border follower, simplified with
  Ramer–Douglas–Peucker, classified into outer contours + holes
  (containment parity), and extruded with `THREE.ExtrudeGeometry`. UVs are
  recomputed from doc space so the art maps 1:1 onto the front/back caps;
  sides get a plain white material. The optional white border dilates the
  silhouette (both mesh outline and texture underlay). Fully-opaque documents
  therefore yield a rectangle — that's the correct silhouette, not a bug.
- **3D heightfield** — a subdivided `PlaneGeometry` displaced by
  luminance × alpha × amplitude, normals recomputed, textured with the
  composite.
- **3D file formats** — `.glb` / `.gltf` via three's `GLTFExporter` (textures
  embedded), `.obj` via `OBJExporter` plus a hand-written `.mtl` and the
  texture PNG, zipped. A live rotating preview renders in the dialog first.
- **Shaders** — the layer stack compiles to a single fragment shader:
  raster/text/shape layers become `sampler2D` lookups (PNGs exported
  alongside), procedural layers inline their GLSL with params baked as
  constants, and layers composite bottom-to-top through the same blend GLSL
  the editor uses. Effects sample the composite below them through a
  per-layer `SRC(p)` macro bound to the previous stack function, so blur and
  glitch work in one pass. A doc made only of Ransomiser/procedural layers is
  fully self-contained (no textures) — ideal for Shadertoy. Targets:
  - **Raw WebGL2** — `#version 300 es` + `main()`, zipped with a minimal
    `index.html` runner (serve the folder over HTTP so textures load).
  - **Shadertoy** — `mainImage(out vec4, in vec2)` with an
    `iChannel0..3` mapping comment (max 4 texture layers). Time-based effects
    (glitch, wave, ripple) animate via `iTime`; the editor renders them at
    `TIME = 0`.
  - **ISF** — JSON header + GLSL body using `RENDERSIZE` /
    `IMG_NORM_PIXEL`, textures via `IMPORTED`.

  Every generated shader is **compile-checked on export** in a hidden WebGL2
  (WebGL1 for ISF) context, and errors surface in the dialog instead of
  shipping broken files.
- **`.pslop`** — a stored (uncompressed) zip: `manifest.json` (doc, layers,
  transforms, procedural graphs, seed, format version) + one PNG per pixel
  layer + raw mask/selection bytes. Round-trips losslessly; undo history is
  not persisted. The zip reader only supports archives Photoshlopper wrote.

## What's stubbed / not implemented (honestly)

- **Pen tool** (`P`) — not implemented; the shortcut says so in the status bar.
- **Layer groups** (`Ctrl+G`) — not implemented (same treatment).
- **Curves** adjustment — not implemented (needs an LUT editor); Levels is.
- **Polygonal lasso** — lasso is freehand-only.
- Layer **masks are ignored in shader export** (they'd need extra textures);
  the export dialog warns when this applies.
- Layer content outside the canvas is clipped when moving (buffers are
  doc-sized), unlike Photoshop's infinite layer bounds.
- Text layers rasterize on commit; the source text lives in layer meta so the
  Type tool can re-edit it, but undo of a text edit restores pixels only.
- Cut/Copy/Paste use an internal clipboard, not the OS clipboard.
- `Ctrl/⌘+N` is usually reserved by the browser — use File ▸ New.
- WGSL export (stretch goal) — not attempted.

## Repo notes

- Vite + React 18 + TypeScript (strict), Zustand for state, three.js for 3D
  export. The only non-listed dependency decision: **no zip library** — a
  ~150-line stored-zip writer/reader lives in `src/export/zip.ts`.
- Pixel buffers deliberately live outside the store (`src/core/pixels.ts`)
  keyed by layer id, keeping the store serializable; `layerVersions` ties the
  two together for GPU re-upload.
- Blend modes: `src/core/blend.ts`. Procedural node registry (params + GLSL
  bodies): `src/core/procedural.ts`. Compositor: `src/core/compositor.ts`.
  Shader codegen: `src/export/shader.ts`.

## License

MIT — see [LICENSE](LICENSE).
