// New Document, Image Size, Canvas Size and Fill dialogs, and the searchable
// shortcut cheatsheet.

import { useState } from 'react';
import { useStore, newDoc, setModal, fillWith, resizeImage, resizeCanvas } from '../store';
import { randomize } from '../core/randomizer';
import { randomSeed } from '../core/rng';
import { SHORTCUTS, formatCombo } from '../keymap';

export function Modal({ title, onClose, children, wide }: {
  title: string; onClose?: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" style={wide ? { width: 'min(860px, 92vw)' } : undefined}>
        <h2>
          {title}
          {onClose && <button className="btn icon" onClick={onClose}>✕</button>}
        </h2>
        {children}
      </div>
    </div>
  );
}

const PRESETS = [
  { label: 'Sticker 512', w: 512, h: 512 },
  { label: 'Square 1024', w: 1024, h: 1024 },
  { label: 'HD 1920×1080', w: 1920, h: 1080 },
  { label: 'Portrait 1080×1350', w: 1080, h: 1350 },
];

export function NewDocDialog() {
  const hasDoc = !!useStore((s) => s.doc);
  const [w, setW] = useState(1024);
  const [h, setH] = useState(1024);
  const [bg, setBg] = useState<'transparent' | 'white' | 'black'>('transparent');
  const background = bg === 'transparent' ? 'transparent' : bg === 'white' ? '#ffffff' : '#000000';
  return (
    <Modal title="New Document" onClose={hasDoc ? () => setModal(null) : undefined}>
      <div className="form-row">
        {PRESETS.map((p) => (
          <button key={p.label} className="btn" onClick={() => { setW(p.w); setH(p.h); }}>{p.label}</button>
        ))}
      </div>
      <div className="form-row">
        <label>Width</label>
        <input type="number" value={w} min={8} max={4096} onChange={(e) => setW(Number(e.target.value))} />
        <label>Height</label>
        <input type="number" value={h} min={8} max={4096} onChange={(e) => setH(Number(e.target.value))} />
      </div>
      <div className="form-row">
        <label>Background</label>
        <select value={bg} onChange={(e) => setBg(e.target.value as typeof bg)}>
          <option value="transparent">Transparent</option>
          <option value="white">White</option>
          <option value="black">Black</option>
        </select>
      </div>
      <div className="footer">
        <button
          className="btn"
          onClick={() => {
            newDoc(clampSize(w), clampSize(h), background);
            randomize(randomSeed());
          }}
        >
          🎲 Create & Randomize
        </button>
        <button className="btn primary" onClick={() => newDoc(clampSize(w), clampSize(h), background)}>Create</button>
      </div>
    </Modal>
  );
}

const clampSize = (v: number) => Math.max(8, Math.min(4096, Math.round(v) || 1024));

export function ImageSizeDialog() {
  const doc = useStore((s) => s.doc)!;
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [lock, setLock] = useState(true);
  const ratio = doc.width / doc.height;
  const setWidth = (v: number) => { setW(v); if (lock) setH(Math.max(1, Math.round(v / ratio))); };
  const setHeight = (v: number) => { setH(v); if (lock) setW(Math.max(1, Math.round(v * ratio))); };
  const pct = (f: number) => { setW(Math.round(doc.width * f)); setH(Math.round(doc.height * f)); };
  return (
    <Modal title="Image Size" onClose={() => setModal(null)}>
      <p style={{ color: 'var(--text-2)', marginTop: 0 }}>
        Resamples every layer to the new size. Currently {doc.width}×{doc.height}px.
      </p>
      <div className="form-row">
        {[0.25, 0.5, 2].map((f) => <button key={f} className="btn" onClick={() => pct(f)}>{f * 100}%</button>)}
      </div>
      <div className="form-row">
        <label>Width</label>
        <input type="number" value={w} min={8} max={4096} onChange={(e) => setWidth(Number(e.target.value))} />
        <button className={`btn icon ${lock ? 'active' : ''}`} title="Constrain proportions" onClick={() => setLock(!lock)}>{lock ? '🔗' : '⛓'}</button>
        <label>Height</label>
        <input type="number" value={h} min={8} max={4096} onChange={(e) => setHeight(Number(e.target.value))} />
      </div>
      <div className="footer">
        <button className="btn" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn primary" onClick={() => { resizeImage(clampSize(w), clampSize(h)); setModal(null); }}>Resize</button>
      </div>
    </Modal>
  );
}

const ANCHORS = [0, 0.5, 1];

export function CanvasSizeDialog() {
  const doc = useStore((s) => s.doc)!;
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [ax, setAx] = useState(0.5);
  const [ay, setAy] = useState(0.5);
  return (
    <Modal title="Canvas Size" onClose={() => setModal(null)}>
      <p style={{ color: 'var(--text-2)', marginTop: 0 }}>
        Adds or trims space around the image without scaling it. Currently {doc.width}×{doc.height}px.
      </p>
      <div className="form-row">
        <label>Width</label>
        <input type="number" value={w} min={8} max={4096} onChange={(e) => setW(Number(e.target.value))} />
        <label>Height</label>
        <input type="number" value={h} min={8} max={4096} onChange={(e) => setH(Number(e.target.value))} />
      </div>
      <div className="form-row">
        <label>Anchor</label>
        <div className="anchor-grid">
          {ANCHORS.map((y) => ANCHORS.map((x) => (
            <button
              key={`${x}-${y}`}
              className={x === ax && y === ay ? 'active' : ''}
              title="Existing image stays pinned here"
              onClick={() => { setAx(x); setAy(y); }}
            />
          )))}
        </div>
      </div>
      <div className="footer">
        <button className="btn" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn primary" onClick={() => { resizeCanvas(clampSize(w), clampSize(h), ax, ay); setModal(null); }}>Apply</button>
      </div>
    </Modal>
  );
}

export function FillDialog() {
  const fgc = useStore((s) => s.fg);
  const bgc = useStore((s) => s.bg);
  const [custom, setCustom] = useState('#808080');
  const doFill = (c: string) => {
    fillWith(c);
    setModal(null);
  };
  return (
    <Modal title="Fill" onClose={() => setModal(null)}>
      <div className="form-row">
        <button className="btn" onClick={() => doFill(fgc)}>Foreground <span style={{ display: 'inline-block', width: 12, height: 12, background: fgc, borderRadius: 3, verticalAlign: -2 }} /></button>
        <button className="btn" onClick={() => doFill(bgc)}>Background <span style={{ display: 'inline-block', width: 12, height: 12, background: bgc, borderRadius: 3, verticalAlign: -2 }} /></button>
        <button className="btn" onClick={() => doFill('#000000')}>Black</button>
        <button className="btn" onClick={() => doFill('#ffffff')}>White</button>
      </div>
      <div className="form-row">
        <label>Custom</label>
        <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn primary" onClick={() => doFill(custom)}>Fill</button>
      </div>
      <p style={{ color: 'var(--text-2)' }}>Fills the active layer, respecting the selection.</p>
    </Modal>
  );
}

export function ShortcutsModal() {
  const [q, setQ] = useState('');
  const query = q.toLowerCase();
  const rows = SHORTCUTS.filter(
    (s) => !query || s.label.toLowerCase().includes(query) || s.category.toLowerCase().includes(query) || formatCombo(s.combo).toLowerCase().includes(query),
  );
  return (
    <Modal title="Keyboard Shortcuts" onClose={() => setModal(null)} wide>
      <input
        className="shortcut-search"
        autoFocus
        placeholder="Search shortcuts…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <table className="shortcut-table">
        <tbody>
          {rows.map((s) => (
            <tr key={s.combo + s.label}>
              <td className="cat">{s.category}</td>
              <td>{s.label}</td>
              <td className="combo">{formatCombo(s.combo)}</td>
            </tr>
          ))}
          <tr>
            <td className="cat">View</td>
            <td>Temporary Hand (pan)</td>
            <td className="combo">hold Space</td>
          </tr>
        </tbody>
      </table>
    </Modal>
  );
}
