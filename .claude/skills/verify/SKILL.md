---
name: verify
description: Build, launch and drive Photoshlopper to verify changes at the UI surface.
---

# Verifying Photoshlopper

Browser raster editor (React + Vite + WebGL2 compositor). No test suite —
verification means driving the real UI.

## Build / launch

```bash
npm ci                                   # fresh container
npm run build                            # tsc --noEmit && vite build
npx vite --port 5199 --strictPort &      # dev server for driving
```

## Drive (headless)

Playwright + the preinstalled Chromium works well:
`chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })`
(install `playwright-core` in the scratchpad, not the repo).

Flow gotchas:

- The app opens on the **New document modal**. Click the `Create` button
  with `exact: true` — "🎲 Create & Randomize" also matches `name: 'Create'`.
- Paint by dragging on `canvas.view` with `page.mouse` (down → many small
  moves → up). One stroke = one history entry.
- The status bar (`.statusbar .left`) is where errors/results surface —
  read it after imports/exports instead of waiting for dialogs.
- File menu: `.menu > button` with `hasText`, then menu items are buttons.
- Downloads (.psd/.pslop/raster) work headless via Playwright's
  `page.waitForEvent('download')`; imports via `filechooser`.

## Node-testable units

`src/export/psd.ts` (writePsd/parsePsd) and `src/export/zip.ts` are pure and
can be bundled with esbuild for node tests — shim `globalThis.ImageData`
first. `ag-psd` (npm) is a good independent cross-validator for PSD output.
Everything touching the compositor/store needs the browser.
