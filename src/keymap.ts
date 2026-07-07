// Central keymap with Photoshop-parity shortcuts. `mod` = ⌘ on macOS,
// Ctrl elsewhere. The same table drives the searchable cheatsheet (?).
// Suppressed while typing in inputs/textareas/contenteditable.

import {
  useStore, undo, redo, setTool, setModal, swapColors, resetColors,
  selectAll, deselect, invertSelection, cutSelection, copySelection, paste,
  addLayer, duplicateLayer, mergeDown, mergeVisible, fillWith,
  zoomAt, fitToScreen, zoom100, cycleScreenMode, togglePanels,
  beginTransform, commitTransform, cancelTransform, setStatus,
  clearSelectionArea, activeLayer,
} from './store';
import { ransomise } from './core/randomiser';
import { savePslop, promptOpenPslop } from './export/pslop';
import { applyCrop, cancelCrop } from './tools/nav';
import { randomSeed } from './core/rng';

export interface Shortcut {
  combo: string;      // e.g. 'mod+shift+z', 'b', '['
  label: string;
  category: string;
  action: () => void;
  /** don't trigger browser default even if we can't fully act */
  prevent?: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

function setBrush(patch: (b: { size: number; hardness: number }) => Partial<{ size: number; hardness: number }>): void {
  useStore.setState((s) => {
    const p = patch(s.brush);
    const next = { ...s.brush, ...p };
    return { brush: next, status: `Brush: size ${Math.round(next.size)}px, hardness ${Math.round(next.hardness * 100)}%` };
  });
}

export const SHORTCUTS: Shortcut[] = [
  // tools
  { combo: 'v', label: 'Move tool', category: 'Tools', action: () => setTool('move') },
  { combo: 'm', label: 'Marquee tool', category: 'Tools', action: () => setTool('marquee') },
  { combo: 'l', label: 'Lasso tool', category: 'Tools', action: () => setTool('lasso') },
  { combo: 'w', label: 'Magic Wand tool', category: 'Tools', action: () => setTool('wand') },
  { combo: 'c', label: 'Crop tool', category: 'Tools', action: () => setTool('crop') },
  { combo: 'i', label: 'Eyedropper tool', category: 'Tools', action: () => setTool('eyedropper') },
  { combo: 'b', label: 'Brush tool', category: 'Tools', action: () => setTool('brush') },
  { combo: 'e', label: 'Eraser tool', category: 'Tools', action: () => setTool('eraser') },
  {
    combo: 'g', label: 'Bucket / Gradient (cycles)', category: 'Tools',
    action: () => setTool(useStore.getState().tool === 'bucket' ? 'gradient' : 'bucket'),
  },
  { combo: 's', label: 'Clone Stamp tool', category: 'Tools', action: () => setTool('clone') },
  { combo: 'p', label: 'Pen tool', category: 'Tools', action: () => setStatus('Pen tool is not implemented (see README)') },
  { combo: 't', label: 'Type tool', category: 'Tools', action: () => setTool('type') },
  { combo: 'u', label: 'Shape tool', category: 'Tools', action: () => setTool('shape') },
  { combo: 'h', label: 'Hand tool (or hold Space)', category: 'Tools', action: () => setTool('hand') },
  { combo: 'z', label: 'Zoom tool', category: 'Tools', action: () => setTool('zoom') },
  // brush
  { combo: '[', label: 'Decrease brush size', category: 'Brush', action: () => setBrush((b) => ({ size: Math.max(1, b.size / 1.15 - 1) })) },
  { combo: ']', label: 'Increase brush size', category: 'Brush', action: () => setBrush((b) => ({ size: Math.min(500, b.size * 1.15 + 1) })) },
  { combo: '{', label: 'Decrease brush hardness', category: 'Brush', action: () => setBrush((b) => ({ hardness: Math.max(0, b.hardness - 0.1) })) },
  { combo: '}', label: 'Increase brush hardness', category: 'Brush', action: () => setBrush((b) => ({ hardness: Math.min(1, b.hardness + 0.1) })) },
  // colors
  { combo: 'd', label: 'Default colors (black/white)', category: 'Color', action: resetColors },
  { combo: 'x', label: 'Swap FG/BG colors', category: 'Color', action: swapColors },
  // edit
  { combo: 'mod+z', label: 'Undo', category: 'Edit', action: undo, prevent: true },
  { combo: 'mod+shift+z', label: 'Redo', category: 'Edit', action: redo, prevent: true },
  { combo: 'mod+x', label: 'Cut', category: 'Edit', action: cutSelection, prevent: true },
  { combo: 'mod+c', label: 'Copy', category: 'Edit', action: copySelection, prevent: true },
  { combo: 'mod+v', label: 'Paste', category: 'Edit', action: paste, prevent: true },
  { combo: 'alt+backspace', label: 'Fill with foreground color', category: 'Edit', action: () => fillWith(useStore.getState().fg), prevent: true },
  { combo: 'mod+backspace', label: 'Fill with background color', category: 'Edit', action: () => fillWith(useStore.getState().bg), prevent: true },
  { combo: 'shift+backspace', label: 'Fill dialog', category: 'Edit', action: () => setModal('fill'), prevent: true },
  { combo: 'delete', label: 'Clear selection contents', category: 'Edit', action: clearSelectionArea },
  // file
  { combo: 'mod+n', label: 'New document (browser may reserve this)', category: 'File', action: () => setModal('newdoc'), prevent: true },
  { combo: 'mod+o', label: 'Open .pslop project', category: 'File', action: () => promptOpenPslop(setStatus), prevent: true },
  { combo: 'mod+s', label: 'Save .pslop project', category: 'File', action: () => void savePslop(), prevent: true },
  { combo: 'mod+shift+s', label: 'Save As (export dialog)', category: 'File', action: () => setModal('export'), prevent: true },
  // select
  { combo: 'mod+a', label: 'Select All', category: 'Select', action: selectAll, prevent: true },
  { combo: 'mod+d', label: 'Deselect', category: 'Select', action: deselect, prevent: true },
  { combo: 'mod+shift+i', label: 'Inverse selection', category: 'Select', action: invertSelection, prevent: true },
  // layers
  { combo: 'mod+t', label: 'Free Transform', category: 'Layer', action: beginTransform, prevent: true },
  { combo: 'mod+shift+n', label: 'New layer', category: 'Layer', action: () => void addLayer(), prevent: true },
  { combo: 'mod+j', label: 'Duplicate layer', category: 'Layer', action: () => { const l = activeLayer(); if (l) duplicateLayer(l.id); }, prevent: true },
  { combo: 'mod+e', label: 'Merge down', category: 'Layer', action: () => { const l = activeLayer(); if (l) mergeDown(l.id); }, prevent: true },
  { combo: 'mod+shift+e', label: 'Merge visible', category: 'Layer', action: mergeVisible, prevent: true },
  { combo: 'mod+g', label: 'Group layers', category: 'Layer', action: () => setStatus('Layer groups are not implemented (see README)'), prevent: true },
  // view
  { combo: 'mod+=', label: 'Zoom in', category: 'View', action: () => zoomCentered(1.25), prevent: true },
  { combo: 'mod+-', label: 'Zoom out', category: 'View', action: () => zoomCentered(1 / 1.25), prevent: true },
  { combo: 'mod+0', label: 'Fit on screen', category: 'View', action: fitToScreen, prevent: true },
  { combo: 'mod+1', label: '100% zoom', category: 'View', action: zoom100, prevent: true },
  { combo: 'f', label: 'Cycle screen modes', category: 'View', action: cycleScreenMode },
  { combo: 'tab', label: 'Toggle panels', category: 'View', action: togglePanels, prevent: true },
  // the star
  {
    combo: 'mod+shift+r', label: 'Ransomiser! (randomise a starting canvas)', category: 'Ransomiser',
    action: () => {
      const seed = randomSeed();
      useStore.setState({ seed });
      ransomise(seed);
    },
    prevent: true,
  },
  { combo: '?', label: 'Shortcut cheatsheet', category: 'Help', action: () => setModal('shortcuts') },
];

function zoomCentered(f: number): void {
  const s = useStore.getState();
  zoomAt(f, s.viewportW / 2, s.viewportH / 2);
}

function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  let key = e.key.toLowerCase();
  // shift is part of the printed character for symbols; only include it for letters/specials
  const symbolKeys = new Set(['{', '}', '?', '+', '_']);
  if (e.shiftKey && !symbolKeys.has(e.key)) parts.push('shift');
  if (key === ' ') key = 'space';
  if (key === '+') key = '=';
  parts.push(key);
  return parts.join('+');
}

export function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => {
      if (p === 'mod') return MOD_LABEL;
      if (p === 'shift') return 'Shift';
      if (p === 'alt') return 'Alt';
      if (p === 'backspace') return '⌫';
      if (p === 'delete') return 'Del';
      if (p === 'tab') return 'Tab';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(isMac ? '' : '+');
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

const byCombo = new Map(SHORTCUTS.map((s) => [s.combo, s]));

export function initKeymap(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const s = useStore.getState();
    if (isTyping(e)) return;
    // Enter/Escape drive pending crop & transform sessions
    if (e.key === 'Enter') {
      if (s.transformSession) { commitTransform(); e.preventDefault(); return; }
      if (applyCrop()) { e.preventDefault(); return; }
    }
    if (e.key === 'Escape') {
      if (s.transformSession) { cancelTransform(); e.preventDefault(); return; }
      if (cancelCrop()) { e.preventDefault(); return; }
      if (s.modal) { useStore.setState({ modal: null }); return; }
      if (s.doc?.selection) { deselect(); return; }
    }
    if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      clearSelectionArea();
      e.preventDefault();
      return;
    }
    const combo = comboFromEvent(e);
    const shortcut = byCombo.get(combo);
    if (!shortcut) return;
    if (s.modal && shortcut.combo !== '?' && shortcut.combo !== 'tab') return;
    if (shortcut.prevent) e.preventDefault();
    shortcut.action();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
