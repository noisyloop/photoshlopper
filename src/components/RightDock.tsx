// Right dock: Ransomiser card, Brushes, Color/Swatches, Layers, Properties
// (procedural params of the active layer), History, and the Export button.

import { useEffect, useRef, useState } from 'react';
import {
  useStore, setModal, setActiveLayer, setLayerProps, setLayerPropsLive,
  addLayer, duplicateLayer, deleteLayer, mergeDown, addLayerMask, reorderLayer,
  activeLayer, jumpToHistory, updateProceduralParamLive, commitProceduralParam,
  swapColors, resetColors, applyBrushPreset, type BrushSettings,
} from '../store';
import { getPixels } from '../core/pixels';
import { BLEND_MODES } from '../core/blend';
import { getProcDef } from '../core/procedural';
import { ransomise } from '../core/randomiser';
import { randomSeed, rgbToHex, hexToRgb01 } from '../core/rng';
import { BRUSH_PRESETS, renderBrushPreview } from '../core/brushPresets';
import type { Layer, BlendMode, ParamValue } from '../types';

export function RightDock() {
  return (
    <div className="dock">
      <RansomiserPanel />
      <div className="panel">
        <button className="btn primary" style={{ width: '100%' }} onClick={() => setModal('export')}>
          ⬇ Export…
        </button>
      </div>
      <BrushesPanel />
      <ColorPanel />
      <LayersPanel />
      <PropertiesPanel />
      <HistoryPanel />
    </div>
  );
}

// ---------- Brushes ----------

const PREVIEW_INK = '#dfe3ec';

function BrushStrokePreview({ settings, w, h }: { settings: BrushSettings; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(renderBrushPreview(settings, w, h, PREVIEW_INK), 0, 0);
  }, [settings, w, h]);
  return <canvas ref={ref} width={w} height={h} />;
}

function BrushesPanel() {
  const brush = useStore((s) => s.brush);
  const presetId = useStore((s) => s.brushPresetId);
  return (
    <div className="panel">
      <h3>
        Brushes
        <span className="brush-readout">{Math.round(brush.size)}px · {Math.round(brush.hardness * 100)}% hard</span>
      </h3>
      <div className="brush-current" title="Your current brush — tweak size/hardness/opacity/flow in the bar above the canvas">
        <BrushStrokePreview settings={brush} w={496} h={76} />
      </div>
      <div className="brush-grid">
        {BRUSH_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`brush-tile ${presetId === p.id ? 'active' : ''}`}
            title={`${p.name} — ${p.hint}`}
            onClick={() => applyBrushPreset(p)}
          >
            <BrushStrokePreview settings={p.settings} w={240} h={56} />
            <span>{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- Ransomiser ----------

function RansomiserPanel() {
  const seed = useStore((s) => s.seed);
  return (
    <div className="panel">
      <button
        className="ransomiser-btn"
        title="Randomise a starting canvas"
        onClick={() => {
          const s = randomSeed();
          useStore.setState({ seed: s });
          ransomise(s);
        }}
      >
        🎲 RANSOMISER
      </button>
      <div className="seed-row">
        <span style={{ color: 'var(--text-2)' }}>seed</span>
        <input
          type="text"
          value={seed}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) useStore.setState({ seed: v >>> 0 });
          }}
        />
        <button className="btn icon" title="Re-roll with this exact seed (reproducible)" onClick={() => ransomise(useStore.getState().seed)}>
          ↻
        </button>
      </div>
    </div>
  );
}

// ---------- Color ----------

const PRESETS = [
  '#000000', '#ffffff', '#ff4757', '#ff7f50', '#ffd166', '#9ccc3d', '#2ed573', '#1abc9c', '#45aaf2', '#5f6cff',
  '#a55eea', '#fd79a8', '#8b4513', '#57606f', '#2f3542', '#dfe4ea', '#f8c291', '#78e08f', '#60a3bc', '#e55039',
];

function ColorPanel() {
  const fg = useStore((s) => s.fg);
  const bg = useStore((s) => s.bg);
  return (
    <div className="panel color-panel">
      <h3>
        Color
        <span className="actions">
          <button className="btn icon" title="Swap (X)" onClick={swapColors}>⇄</button>
          <button className="btn icon" title="Defaults (D)" onClick={resetColors}>◐</button>
        </span>
      </h3>
      <div className="swatch-big">
        <input type="color" value={fg} title="Foreground" onChange={(e) => useStore.setState({ fg: e.target.value })} />
        <input className="hex" type="text" value={fg} onChange={(e) => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) useStore.setState({ fg: e.target.value }); }} />
        <input type="color" value={bg} title="Background" onChange={(e) => useStore.setState({ bg: e.target.value })} />
      </div>
      <div className="preset-swatches">
        {PRESETS.map((c) => (
          <button key={c} style={{ background: c }} title={c} onClick={() => useStore.setState({ fg: c })} />
        ))}
      </div>
    </div>
  );
}

// ---------- Layers ----------

function LayerThumb({ layer }: { layer: Layer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = useStore((s) => s.layerVersions[layer.id] ?? 0);
  const isProc = !!layer.procedural;
  useEffect(() => {
    if (isProc) return;
    const px = getPixels(layer.id);
    const c = ref.current;
    if (!px || !c) return;
    c.width = 40;
    c.height = 30;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 40, 30);
    const scale = Math.min(40 / px.width, 30 / px.height);
    const tmp = document.createElement('canvas');
    tmp.width = px.width;
    tmp.height = px.height;
    tmp.getContext('2d')!.putImageData(px, 0, 0);
    ctx.drawImage(tmp, (40 - px.width * scale) / 2, (30 - px.height * scale) / 2, px.width * scale, px.height * scale);
  }, [layer.id, version, isProc]);
  if (isProc) return <div className="thumb" title={layer.procedural!.type}>{layer.kind === 'adjustment' ? 'ƒx' : '✨'}</div>;
  return <div className="thumb"><canvas ref={ref} /></div>;
}

function LayerRow({ layer, isActive }: { layer: Layer; isActive: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      className={`layer-row ${isActive ? 'active' : ''} ${dragOver ? 'drag-over' : ''}`}
      onClick={() => setActiveLayer(layer.id)}
      draggable={!renaming}
      onDragStart={(e) => e.dataTransfer.setData('text/layer-id', layer.id)}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const dragId = e.dataTransfer.getData('text/layer-id');
        if (!dragId || dragId === layer.id) return;
        const layers = useStore.getState().doc!.layers;
        const rest = layers.filter((l) => l.id !== dragId);
        const ti = rest.findIndex((l) => l.id === layer.id);
        reorderLayer(dragId, ti + 1); // drop = place above this row
      }}
    >
      <button
        className={`mini ${layer.visible ? 'on' : ''}`}
        title="Toggle visibility"
        onClick={(e) => { e.stopPropagation(); setLayerProps(layer.id, { visible: !layer.visible }, layer.visible ? 'Hide Layer' : 'Show Layer'); }}
      >
        {layer.visible ? '👁' : '·'}
      </button>
      <LayerThumb layer={layer} />
      <span className="name" onDoubleClick={() => setRenaming(true)}>
        {renaming ? (
          <input
            autoFocus
            defaultValue={layer.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { setRenaming(false); if (e.target.value.trim()) setLayerProps(layer.id, { name: e.target.value.trim() }, 'Rename Layer'); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); }}
          />
        ) : (
          <>{layer.name}{layer.mask ? ' ▣' : ''}</>
        )}
      </span>
      <button
        className={`mini ${layer.locked ? 'on' : ''}`}
        title="Lock layer"
        onClick={(e) => { e.stopPropagation(); setLayerProps(layer.id, { locked: !layer.locked }, layer.locked ? 'Unlock Layer' : 'Lock Layer'); }}
      >
        {layer.locked ? '🔒' : '🔓'}
      </button>
    </div>
  );
}

function LayersPanel() {
  const doc = useStore((s) => s.doc);
  const opacityBefore = useRef(1);
  if (!doc) return null;
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  return (
    <div className="panel">
      <h3>Layers</h3>
      {active && (
        <div className="blend-row">
          <select
            value={active.blend}
            onChange={(e) => setLayerProps(active.id, { blend: e.target.value as BlendMode }, 'Blend Mode')}
          >
            {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={active.opacity}
            title={`Opacity ${Math.round(active.opacity * 100)}%`}
            onPointerDown={() => { opacityBefore.current = active.opacity; }}
            onChange={(e) => setLayerPropsLive(active.id, { opacity: Number(e.target.value) })}
            onPointerUp={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              setLayerPropsLive(active.id, { opacity: opacityBefore.current });
              setLayerProps(active.id, { opacity: v }, 'Layer Opacity');
            }}
          />
        </div>
      )}
      <div>
        {[...doc.layers].reverse().map((layer) => (
          <LayerRow key={layer.id} layer={layer} isActive={layer.id === doc.activeLayerId} />
        ))}
      </div>
      <div className="layers-toolbar">
        <button className="btn icon" title="New layer (Ctrl+Shift+N)" onClick={() => void addLayer()}>＋</button>
        <button className="btn icon" title="Duplicate layer (Ctrl+J)" onClick={() => active && duplicateLayer(active.id)}>⧉</button>
        <button className="btn icon" title="Add layer mask from selection" onClick={() => active && addLayerMask(active.id)}>▣</button>
        <button className="btn icon" title="Merge down (Ctrl+E)" onClick={() => active && mergeDown(active.id)}>⤵</button>
        <button className="btn icon" title="Delete layer" onClick={() => active && deleteLayer(active.id)}>🗑</button>
      </div>
    </div>
  );
}

// ---------- Properties (procedural params) ----------

function PropertiesPanel() {
  const doc = useStore((s) => s.doc);
  const befores = useRef<Record<string, ParamValue>>({});
  if (!doc) return null;
  const layer = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (!layer?.procedural) return null;
  const def = getProcDef(layer.procedural.type);
  const node = layer.procedural;
  return (
    <div className="panel">
      <h3>{def.label}</h3>
      {def.params.map((p) => {
        const value = node.params[p.key] ?? p.def;
        if (p.type === 'color') {
          const hex = rgbToHex(value as [number, number, number]);
          return (
            <div className="prop-row" key={p.key}>
              <label>{p.label}</label>
              <input
                type="color"
                value={hex}
                onFocus={() => { befores.current[p.key] = value; }}
                onChange={(e) => updateProceduralParamLive(layer.id, p.key, hexToRgb01(e.target.value))}
                onBlur={(e) => {
                  const before = befores.current[p.key];
                  if (before !== undefined) commitProceduralParam(layer.id, p.key, before, hexToRgb01(e.target.value));
                  delete befores.current[p.key];
                }}
              />
              <span className="val">{hex}</span>
            </div>
          );
        }
        const v = value as number;
        return (
          <div className="prop-row" key={p.key}>
            <label>{p.label}</label>
            <input
              type="range"
              min={p.min}
              max={p.max}
              step={p.step ?? 0.01}
              value={v}
              onPointerDown={() => { befores.current[p.key] = v; }}
              onChange={(e) => updateProceduralParamLive(layer.id, p.key, Number(e.target.value))}
              onPointerUp={(e) => {
                const before = befores.current[p.key];
                const after = Number((e.target as HTMLInputElement).value);
                if (before !== undefined && before !== after) commitProceduralParam(layer.id, p.key, before, after);
                delete befores.current[p.key];
              }}
            />
            <span className="val">{Number(v.toFixed(3))}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- History ----------

function HistoryPanel() {
  const past = useStore((s) => s.past);
  const future = useStore((s) => s.future);
  return (
    <div className="panel">
      <h3>History</h3>
      <div className="history-list">
        <button className={past.length === 0 ? 'current' : ''} onClick={() => jumpToHistory(0)}>⌂ Open</button>
        {past.map((h, i) => (
          <button key={i} className={i === past.length - 1 ? 'current' : ''} onClick={() => jumpToHistory(i + 1)}>
            {h.label}
          </button>
        ))}
        {future.map((h, i) => (
          <button key={`f${i}`} className="future" onClick={() => jumpToHistory(past.length + i + 1)}>
            {h.label}
          </button>
        ))}
      </div>
    </div>
  );
}
