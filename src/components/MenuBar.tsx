import { useEffect, useState } from 'react';
import {
  useStore, undo, redo, setModal, cutSelection, copySelection, paste, fillWith,
  selectAll, deselect, invertSelection, addLayer, duplicateLayer, deleteLayer,
  mergeDown, mergeVisible, flattenImage, addLayerMask, removeLayerMask, rasterizeLayer,
  activeLayer, addProceduralLayer, fitToScreen, zoom100, cycleScreenMode, togglePanels,
  cropDoc, setStatus, beginTransform,
} from '../store';
import { savePslop, promptOpenPslop } from '../export/pslop';
import { savePsd, promptOpenPsd } from '../export/psd';
import { promptImportImage } from '../core/importImage';
import { applyFloydSteinberg } from '../core/filters';
import { PROC_DEFS } from '../core/procedural';
import { maskBounds } from '../core/selection';
import { formatCombo, MOD_LABEL } from '../keymap';

interface Item {
  label: string;
  combo?: string;
  action?: () => void;
  separator?: boolean;
  section?: string;
  disabled?: boolean;
}

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const doc = useStore((s) => s.doc);
  const layer = activeLayer();

  useEffect(() => {
    if (open === null) return;
    const close = () => setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const catLabel: Record<string, string> = {
    adjust: 'Adjustments', blur: 'Blur', stylize: 'Stylize', distort: 'Distort', generate: 'Generators',
  };
  const filterItems: Item[] = [];
  for (const cat of ['adjust', 'blur', 'stylize', 'distort', 'generate']) {
    filterItems.push({ label: catLabel[cat], section: cat });
    for (const def of PROC_DEFS.filter((d) => d.category === cat)) {
      filterItems.push({
        label: `${def.label}${def.kind === 'generator' ? ' (layer)' : ''}`,
        action: () => addProceduralLayer(def.type),
        disabled: !doc,
      });
    }
  }
  filterItems.push({ label: '', separator: true });
  filterItems.push({ label: 'Floyd–Steinberg Dither (destructive)', action: () => applyFloydSteinberg(2), disabled: !doc });

  const menus: Array<{ title: string; items: Item[] }> = [
    {
      title: 'File',
      items: [
        { label: 'New…', combo: 'mod+n', action: () => setModal('newdoc') },
        { label: 'Open .pslop…', combo: 'mod+o', action: () => promptOpenPslop(setStatus) },
        { label: 'Import .psd…', action: () => promptOpenPsd(setStatus) },
        { label: 'Import Image as Layer…', combo: 'mod+shift+o', action: promptImportImage },
        { label: '', separator: true },
        { label: 'Save .pslop', combo: 'mod+s', action: () => void savePslop(), disabled: !doc },
        { label: 'Export .psd (layered)', action: () => void savePsd(), disabled: !doc },
        { label: 'Export…', combo: 'mod+shift+s', action: () => setModal('export'), disabled: !doc },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Undo', combo: 'mod+z', action: undo },
        { label: 'Redo', combo: 'mod+shift+z', action: redo },
        { label: '', separator: true },
        { label: 'Cut', combo: 'mod+x', action: cutSelection, disabled: !doc },
        { label: 'Copy', combo: 'mod+c', action: copySelection, disabled: !doc },
        { label: 'Paste', combo: 'mod+v', action: paste, disabled: !doc },
        { label: '', separator: true },
        { label: 'Fill with Foreground', combo: 'alt+backspace', action: () => fillWith(useStore.getState().fg), disabled: !doc },
        { label: 'Fill with Background', combo: 'mod+backspace', action: () => fillWith(useStore.getState().bg), disabled: !doc },
        { label: 'Fill…', combo: 'shift+backspace', action: () => setModal('fill'), disabled: !doc },
        { label: '', separator: true },
        { label: 'Free Transform', combo: 'mod+t', action: beginTransform, disabled: !doc },
      ],
    },
    {
      title: 'Image',
      items: [
        { label: 'Image Size…', combo: 'mod+alt+i', action: () => setModal('imagesize'), disabled: !doc },
        { label: 'Canvas Size…', combo: 'mod+alt+c', action: () => setModal('canvassize'), disabled: !doc },
        { label: 'Remove Background…', combo: 'mod+alt+b', action: () => setModal('removebg'), disabled: !layer },
        { label: '', separator: true },
        {
          label: 'Crop to Selection',
          action: () => {
            const d = useStore.getState().doc;
            if (!d?.selection) return setStatus('No selection to crop to');
            const b = maskBounds(d.selection, d.width, d.height);
            if (b) cropDoc(b);
          },
          disabled: !doc?.selection,
        },
        { label: 'Flatten Image', action: flattenImage, disabled: !doc },
      ],
    },
    {
      title: 'Layer',
      items: [
        { label: 'New Layer', combo: 'mod+shift+n', action: () => void addLayer(), disabled: !doc },
        { label: 'Duplicate Layer', combo: 'mod+j', action: () => layer && duplicateLayer(layer.id), disabled: !layer },
        { label: 'Delete Layer', action: () => layer && deleteLayer(layer.id), disabled: !layer },
        { label: '', separator: true },
        { label: 'Add Layer Mask (from selection)', action: () => layer && addLayerMask(layer.id), disabled: !layer || !!layer?.mask },
        { label: 'Remove Layer Mask', action: () => layer && removeLayerMask(layer.id), disabled: !layer?.mask },
        { label: 'Rasterize Layer', action: () => layer && rasterizeLayer(layer.id), disabled: !layer || !layer.procedural },
        { label: 'Remove Background…', combo: 'mod+alt+b', action: () => setModal('removebg'), disabled: !layer },
        { label: '', separator: true },
        { label: 'Merge Down', combo: 'mod+e', action: () => layer && mergeDown(layer.id), disabled: !layer },
        { label: 'Merge Visible', combo: 'mod+shift+e', action: mergeVisible, disabled: !doc },
        { label: 'Flatten Image', action: flattenImage, disabled: !doc },
      ],
    },
    {
      title: 'Select',
      items: [
        { label: 'All', combo: 'mod+a', action: selectAll, disabled: !doc },
        { label: 'Deselect', combo: 'mod+d', action: deselect, disabled: !doc?.selection },
        { label: 'Inverse', combo: 'mod+shift+i', action: invertSelection, disabled: !doc },
      ],
    },
    { title: 'Filter', items: filterItems },
    {
      title: 'View',
      items: [
        { label: 'Fit on Screen', combo: 'mod+0', action: fitToScreen, disabled: !doc },
        { label: '100%', combo: 'mod+1', action: zoom100, disabled: !doc },
        { label: 'Cycle Screen Modes', combo: 'f', action: cycleScreenMode },
        { label: 'Toggle Panels', combo: 'tab', action: togglePanels },
      ],
    },
    {
      title: 'Help',
      items: [
        { label: 'Keyboard Shortcuts', combo: '?', action: () => setModal('shortcuts') },
        { label: `Photoshlopper — ${MOD_LABEL}⇧R makes art`, action: () => setStatus('Photoshlopper: a browser raster editor that exports stickers, meshes and shaders.') },
      ],
    },
  ];

  return (
    <div className="menubar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="brand">PHOTOSHLOPPER</span>
      {menus.map((m, i) => (
        <div key={m.title} className={`menu ${open === i ? 'open' : ''}`}>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.title}
          </button>
          {open === i && (
            <div className="menu-items">
              {m.items.map((item, j) =>
                item.separator ? (
                  <hr key={j} />
                ) : item.section ? (
                  <div key={j} className="section">{item.label}</div>
                ) : (
                  <button
                    key={j}
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.action?.();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.combo && <span className="shortcut">{formatCombo(item.combo)}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
