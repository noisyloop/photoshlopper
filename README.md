# Photoshlopper 🎨

A browser-based raster image editor — a small, honest Photoshop clone aimed at
stickers, generative art and shareable graphics. Everything runs client-side;
there is no backend. Its two party tricks:

- **The Randomiser** — one click seeds the canvas with reproducible generative
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

**60-second tour:** open the app → *Create* (or *Create & Randomize*) → hit the
big **🎲 RANDOMIZE** button (or `Ctrl/⌘+Shift+R`) → paint over it with the
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
- **Type & text effects** — 28 fonts: 6 system stacks plus 22 self-hosted
  display/script/retro faces (bundled via `@fontsource`, latin subset, loaded
  lazily on first use — no font-CDN requests). The **Text panel** (shown with
  the Type tool or a text layer selected) has bold/italic, alignment, letter
  spacing, line height and stackable effects: **stroke**, **drop shadow**,
  **outer glow**, **gradient fill** and **3D extrude**, plus one-click
  presets (Meme, Neon, Retro 3D, Sunset, Shadow). Effects are stored in the
  layer's meta, so a text layer stays re-editable and restylable; each
  restyle is one undo step.
- **Image size & import** — *Image ▸ Image Size…* (`Ctrl/⌘+Alt+I`) resamples
  every layer, mask and the selection; *Image ▸ Canvas Size…*
  (`Ctrl/⌘+Alt+C`) adds or trims space around a 3×3 anchor. Both keep
  transforms and text layers aligned and are a single undo step. *File ▸
  Import Image as Layer…* (`Ctrl/⌘+Shift+O`) or **drag & drop** images onto
  the canvas (placed at the drop point) or the Layers panel to add them as
  new layers — big images scale down to fit; with no document open the first
  image sets the size. Dropping a `.pslop` / `.psd` opens it.
- **Brush engine** — stamp-based with size/hardness/opacity/flow + spacing,
  pointer-pressure size, strokes buffered offscreen and committed as **one
  undo entry per stroke**, respects selections and layer locks. A **Brushes
  panel** in the dock shows named presets (Round, Soft/Hard Round, Pencil,
  Inker, Marker, Airbrush, Stipple) as live stroke previews rendered through
  the actual engine — click to apply; hand-tweaking any slider flips the
  options-bar picker to "Custom".
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
- **Randomize** — seeded (mulberry32, seed shown + re-roll), weighted base
  pick (gradient / simplex noise field / voronoi / wave interference as
  procedural layers; flow field / scattered shapes as CPU-rendered raster),
  harmonious palette (analogous/triad/complementary), 1–2 moderate effect
  layers, inserted at the bottom of the stack as a single undo entry. Every
  click **replaces the previous roll** in place, so you can keep clicking
  for new ideas — up to **50 rolls per document** (with a short cooldown
  against click/key-repeat spam). Each rolled seed lands in the numbered
  *ideas* strip; clicking one brings it back for free. Painting on or
  duplicating a rolled layer makes it yours, and later rolls leave it alone.
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
  glitch work in one pass. A doc made only of Randomize/procedural layers is
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
- **`.psd` import/export** — a dependency-free 8-bit RGB PSD codec
  (`src/export/psd.ts`, PackBits RLE). Export bakes every layer (transform,
  mask, procedural render) to doc-sized pixels and writes a layered PSD with
  blend mode / opacity / visibility mapped to the PSD equivalents, plus the
  flattened composite; adjustment layers only appear in the composite.
  Import reads 8-bit RGB/grayscale PSDs (raw or RLE) as raster layers,
  skipping group dividers, and falls back to the flattened composite for
  files without layer data. 16/32-bit, PSB and ZIP-compressed channels are
  rejected with a clear error.

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
