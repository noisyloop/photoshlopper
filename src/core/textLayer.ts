// Text layer commit + live restyle. The Text panel edits the active text
// layer non-destructively: live re-renders while a slider is dragged, then a
// single history entry on commit (pointer up / blur / discrete change).

import { useStore, pushHistory, bumpLayer, setLayerPropsLive, insertLayerWithPixels, activeLayer, setStatus } from '../store';
import { getPixels, setPixels } from './pixels';
import { readTextMeta, renderTextAsync, type TextMeta, type TextStyle } from './text';

export interface TextPatch {
  style?: Partial<TextStyle>;
  font?: string;
  size?: number;
  color?: string;
}

/** The text layer the panel is bound to, if the active layer is one. */
export function activeTextLayer() {
  const layer = activeLayer();
  return layer && layer.kind === 'text' && readTextMeta(layer.meta) ? layer : null;
}

/** Copy a text layer's look into the tool settings (so new text matches it). */
export function loadTextSettings(meta: TextMeta): void {
  useStore.setState({ fontFamily: meta.font, fontSize: meta.size, textStyle: { ...meta.style }, fg: meta.color });
}

/** Text meta for new text from the current tool settings. */
export function currentTextMeta(text: string, x: number, y: number): TextMeta {
  const s = useStore.getState();
  return { text, x, y, size: s.fontSize, font: s.fontFamily, color: s.fg, style: { ...s.textStyle } };
}

let pending: { layerId: string; beforePx: ImageData; beforeMeta: Record<string, unknown> | undefined } | null = null;
let token = 0;
let commitRequested = false;

/**
 * Apply a style patch to the tool settings and, if a text layer is active,
 * re-render it. `commit` closes the edit into one undo step.
 */
export async function restyleText(patch: TextPatch, commit: boolean): Promise<void> {
  useStore.setState((s) => ({
    textStyle: patch.style ? { ...s.textStyle, ...patch.style } : s.textStyle,
    fontFamily: patch.font ?? s.fontFamily,
    fontSize: patch.size ?? s.fontSize,
    fg: patch.color ?? s.fg,
  }));
  const s = useStore.getState();
  const layer = activeTextLayer();
  if (!layer || !s.doc || s.textSession) return;
  if (layer.locked) {
    setStatus(`Layer "${layer.name}" is locked`);
    return;
  }
  const cur = readTextMeta(layer.meta)!;
  const next: TextMeta = {
    ...cur,
    font: patch.font ?? cur.font,
    size: patch.size ?? cur.size,
    color: patch.color ?? cur.color,
    style: { ...cur.style, ...(patch.style ?? {}) },
  };
  if (!pending || pending.layerId !== layer.id) {
    if (pending) commitPending();
    const px = getPixels(layer.id);
    if (!px) return;
    pending = { layerId: layer.id, beforePx: px, beforeMeta: layer.meta };
  }
  const my = ++token;
  if (commit) commitRequested = true;
  const meta = { ...layer.meta, ...next };
  // set meta first so rapid successive patches build on each other
  setLayerPropsLive(layer.id, { meta });
  const { width, height } = s.doc;
  const px = await renderTextAsync(next, width, height);
  if (my !== token) return; // a newer render superseded this one (and inherits any commit)
  setPixels(layer.id, px);
  bumpLayer(layer.id);
  if (commitRequested) {
    commitRequested = false;
    commitPending();
  }
}

/** Close an in-progress live restyle into a single history entry. */
export function commitPending(): void {
  const p = pending;
  pending = null;
  if (!p) return;
  const layer = useStore.getState().doc?.layers.find((l) => l.id === p.layerId);
  const afterPx = getPixels(p.layerId);
  if (!layer || !afterPx || afterPx === p.beforePx) return;
  const afterMeta = layer.meta;
  const { layerId, beforePx, beforeMeta } = p;
  pushHistory({
    label: 'Text Style',
    undo: () => {
      setPixels(layerId, beforePx);
      setLayerPropsLive(layerId, { meta: beforeMeta });
      bumpLayer(layerId);
    },
    redo: () => {
      setPixels(layerId, afterPx);
      setLayerPropsLive(layerId, { meta: afterMeta });
      bumpLayer(layerId);
    },
  });
}

/** Commit the Type tool's overlay: re-render an existing text layer or add a new one. */
export async function commitTextSession(text: string): Promise<void> {
  const s = useStore.getState();
  const session = s.textSession;
  if (!session || !s.doc) return;
  useStore.setState({ textSession: null });
  if (!text.trim()) return;
  const meta = currentTextMeta(text, session.x, session.y);
  const { width, height } = s.doc;
  const pixels = await renderTextAsync(meta, width, height);
  if (session.layerId) {
    const before = getPixels(session.layerId);
    const layer = useStore.getState().doc?.layers.find((l) => l.id === session.layerId);
    if (!before || !layer) return;
    const beforeMeta = layer.meta;
    const afterMeta = { ...layer.meta, ...meta };
    const id = session.layerId;
    setPixels(id, pixels);
    setLayerPropsLive(id, { meta: afterMeta });
    bumpLayer(id);
    pushHistory({
      label: 'Edit Text',
      undo: () => { setPixels(id, before); setLayerPropsLive(id, { meta: beforeMeta }); bumpLayer(id); },
      redo: () => { setPixels(id, pixels); setLayerPropsLive(id, { meta: afterMeta }); bumpLayer(id); },
    });
  } else {
    insertLayerWithPixels(text.split('\n')[0].slice(0, 24) || 'Text', 'text', pixels, { ...meta }, 'New Text Layer');
  }
}
