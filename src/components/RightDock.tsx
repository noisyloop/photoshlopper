// Right dock: Randomize card, Brushes, Color/Swatches, Text (effects for the
// Type tool / active text layer), Layers, Properties (procedural params of the
// active layer), History, and the Export button.

import { useEffect, useRef, useState } from 'react';
import {
  useStore, setModal, setActiveLayer, setLayerProps, setLayerPropsLive,
  addLayer, duplicateLayer, deleteLayer, mergeDown, addLayerMask, reorderLayer,
  activeLayer, jumpToHistory, updateProceduralParamLive, commitProceduralParam,
  swapColors, resetColors, applyBrushPreset, MAX_ROLLS, type BrushSettings,
} from '../store';
import { getPixels } from '../core/pixels';
import { BLEND_MODES } from '../core/blend';
import { getProcDef } from '../core/procedural';
import { randomize } from '../core/randomizer';
import { randomSeed, rgbToHex, hexToRgb01 } from '../core/rng';
import { BRUSH_PRESETS, renderBrushPreview } from '../core/brushPresets';
import { FONTS, FONT_GROUPS, ensureFont } from '../core/fonts';
import { DEFAULT_TEXT_STYLE, TEXT_PRESETS, readTextMeta, type TextStyle } from '../core/text';
import { restyleText, loadTextSettings, type TextPatch } from '../core/textLayer';
import { importFiles, dragHasFiles } from '../core/importImage';
import type { Layer, BlendMode, ParamValue } from '../types';

export function RightDock() {
  return (
    <div className="dock">
      <RandomizerPanel />
      <div className="panel">
        <button className="btn primary" style={{ width: '100%' }} onClick={() => setModal('export')}>
          ⬇ Export…
        </button>
      </div>
      <BrushesPanel />
      <ColorPanel />
      <TextPanel />
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

// ---------- Randomizer ----------

function RandomizerPanel() {
  const seed = useStore((s) => s.seed);
  const rollsUsed = useStore((s) => s.rollsUsed);
  const ideas = useStore((s) => s.ideas);
  const left = MAX_ROLLS - rollsUsed;
  return (
    <div className="panel">
      <button
        className="randomizer-btn"
        title={left > 0 ? 'Generate a new random canvas (replaces the previous roll)' : 'Roll limit reached for this document'}
        disabled={left <= 0}
        onClick={() => randomize(randomSeed())}
      >
        🎲 RANDOMIZE
      </button>
      <div className="roll-meter" title={`${left} roll${left === 1 ? '' : 's'} left on this document`}>
        <div className="bar"><div style={{ width: `${(rollsUsed / MAX_ROLLS) * 100}%` }} /></div>
        <span>{rollsUsed}/{MAX_ROLLS}</span>
      </div>
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
        <button
          className="btn icon"
          title="Generate with this exact seed (reproducible)"
          onClick={() => { const sd = useStore.getState().seed; randomize(sd, { restore: true }); }}
        >
          ↻
        </button>
      </div>
      {ideas.length > 0 && (
        <div className="ideas" title="Ideas rolled on this document — click to bring one back (free)">
          {ideas.map((sd, i) => (
            <button
              key={sd}
              className={sd === seed ? 'current' : ''}
              title={`Idea ${i + 1} · seed ${sd}`}
              onClick={() => randomize(sd, { restore: true })}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
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

// ---------- Text ----------

function TextSlider({ label, value, min, max, step = 1, patch }: {
  label: string; value: number; min: number; max: number; step?: number;
  patch: (v: number) => TextPatch;
}) {
  return (
    <div className="prop-row">
      <label>{label}</label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => void restyleText(patch(Number(e.target.value)), false)}
        onPointerUp={(e) => void restyleText(patch(Number((e.target as HTMLInputElement).value)), true)}
        onKeyUp={(e) => void restyleText(patch(Number((e.target as HTMLInputElement).value)), true)}
      />
      <span className="val">{Number(value.toFixed(2))}</span>
    </div>
  );
}

function TextColor({ value, patch }: { value: string; patch: (v: string) => TextPatch }) {
  return (
    <input
      type="color"
      value={value}
      onChange={(e) => void restyleText(patch(e.target.value), false)}
      onBlur={(e) => void restyleText(patch(e.target.value), true)}
    />
  );
}

function EffectSection({ label, on, onKey, children }: {
  label: string; on: boolean; onKey: keyof TextStyle; children: React.ReactNode;
}) {
  return (
    <div className={`fx-section ${on ? 'on' : ''}`}>
      <label className="fx-head">
        <input type="checkbox" checked={on} onChange={(e) => void restyleText({ style: { [onKey]: e.target.checked } }, true)} />
        {label}
      </label>
      {on && <div className="fx-body">{children}</div>}
    </div>
  );
}

function TextPanel() {
  const tool = useStore((s) => s.tool);
  const st = useStore((s) => s.textStyle);
  const font = useStore((s) => s.fontFamily);
  const size = useStore((s) => s.fontSize);
  const fg = useStore((s) => s.fg);
  const activeText = useStore((s) => {
    const l = s.doc?.layers.find((x) => x.id === s.doc?.activeLayerId);
    return l && l.kind === 'text' ? l : null;
  });
  const activeTextId = activeText?.id ?? null;

  // selecting a text layer pulls its look into the panel
  useEffect(() => {
    const meta = readTextMeta(activeText?.meta);
    if (meta) loadTextSettings(meta);
  }, [activeTextId]);

  if (tool !== 'type' && !activeText) return null;
  const style = (p: Partial<TextStyle>): TextPatch => ({ style: p });

  return (
    <div className="panel text-panel">
      <h3>
        Text
        <span className="brush-readout">{activeText ? `editing "${activeText.name}"` : 'for new text'}</span>
      </h3>
      <div className="text-presets">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.name}
            className="btn"
            onClick={() => void restyleText({ font: p.font, color: p.color, style: { ...DEFAULT_TEXT_STYLE, ...p.style } }, true)}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="prop-row">
        <label>Font</label>
        <select
          value={font}
          style={{ fontFamily: font }}
          onChange={(e) => { void ensureFont(e.target.value); void restyleText({ font: e.target.value }, true); }}
        >
          {!FONTS.some((f) => f.family === font) && <option value={font}>{font}</option>}
          {FONT_GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {FONTS.filter((f) => f.group === g).map((f) => <option key={f.id} value={f.family}>{f.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="text-row">
        <input
          type="number" min={6} max={400} value={size} title="Font size (px)"
          onChange={(e) => { const v = Number(e.target.value); if (v >= 6 && v <= 400) void restyleText({ size: v }, true); }}
        />
        <TextColor value={fg} patch={(v) => ({ color: v })} />
        <button className={`btn icon ${st.bold ? 'active' : ''}`} title="Bold" onClick={() => void restyleText(style({ bold: !st.bold }), true)}><b>B</b></button>
        <button className={`btn icon ${st.italic ? 'active' : ''}`} title="Italic" onClick={() => void restyleText(style({ italic: !st.italic }), true)}><i>I</i></button>
        {(['left', 'center', 'right'] as const).map((a) => (
          <button key={a} className={`btn icon ${st.align === a ? 'active' : ''}`} title={`Align ${a}`} onClick={() => void restyleText(style({ align: a }), true)}>
            {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
          </button>
        ))}
      </div>
      <TextSlider label="Spacing" value={st.letterSpacing} min={-10} max={60} patch={(v) => style({ letterSpacing: v })} />
      <TextSlider label="Line height" value={st.lineHeight} min={0.7} max={3} step={0.05} patch={(v) => style({ lineHeight: v })} />

      <EffectSection label="Stroke" on={st.strokeOn} onKey="strokeOn">
        <TextSlider label="Width" value={st.strokeWidth} min={1} max={40} patch={(v) => style({ strokeWidth: v })} />
        <div className="prop-row"><label>Color</label><TextColor value={st.strokeColor} patch={(v) => style({ strokeColor: v })} /></div>
      </EffectSection>
      <EffectSection label="Drop shadow" on={st.shadowOn} onKey="shadowOn">
        <div className="prop-row"><label>Color</label><TextColor value={st.shadowColor} patch={(v) => style({ shadowColor: v })} /></div>
        <TextSlider label="Opacity" value={st.shadowOpacity} min={0} max={1} step={0.01} patch={(v) => style({ shadowOpacity: v })} />
        <TextSlider label="Blur" value={st.shadowBlur} min={0} max={60} patch={(v) => style({ shadowBlur: v })} />
        <TextSlider label="Offset X" value={st.shadowX} min={-60} max={60} patch={(v) => style({ shadowX: v })} />
        <TextSlider label="Offset Y" value={st.shadowY} min={-60} max={60} patch={(v) => style({ shadowY: v })} />
      </EffectSection>
      <EffectSection label="Outer glow" on={st.glowOn} onKey="glowOn">
        <div className="prop-row"><label>Color</label><TextColor value={st.glowColor} patch={(v) => style({ glowColor: v })} /></div>
        <TextSlider label="Size" value={st.glowSize} min={1} max={80} patch={(v) => style({ glowSize: v })} />
      </EffectSection>
      <EffectSection label="Gradient fill" on={st.gradientOn} onKey="gradientOn">
        <div className="prop-row"><label>To color</label><TextColor value={st.gradientColor} patch={(v) => style({ gradientColor: v })} /></div>
      </EffectSection>
      <EffectSection label="3D extrude" on={st.extrudeOn} onKey="extrudeOn">
        <div className="prop-row"><label>Color</label><TextColor value={st.extrudeColor} patch={(v) => style({ extrudeColor: v })} /></div>
        <TextSlider label="Depth" value={st.extrudeDepth} min={1} max={60} patch={(v) => style({ extrudeDepth: v })} />
        <TextSlider label="Angle" value={st.extrudeAngle} min={0} max={360} patch={(v) => style({ extrudeAngle: v })} />
      </EffectSection>
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
  const [fileOver, setFileOver] = useState(false);
  if (!doc) return null;
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  return (
    <div
      className={`panel ${fileOver ? 'file-over' : ''}`}
      onDragOver={(e) => { if (dragHasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setFileOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false); }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setFileOver(false);
        void importFiles([...e.dataTransfer.files]);
      }}
    >
      <h3>Layers <span className="brush-readout">drop images here</span></h3>
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
        <button className="btn icon" title="Remove background (Ctrl+Alt+B)" onClick={() => setModal('removebg')}>✂</button>
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
