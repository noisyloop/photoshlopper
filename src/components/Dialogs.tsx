// New Document, Image Size, Canvas Size, Remove Background and Fill dialogs,
// and the searchable
// shortcut cheatsheet.

import { useEffect, useRef, useState } from 'react';
import { useStore, newDoc, setModal, fillWith, resizeImage, resizeCanvas, setStatus } from '../store';
import { openRemoveBg, computeMask, previewRemoveBg, applyRemoveBg, cancelRemoveBg, keptFraction, type BgMode } from '../core/removeBg';
import { randomize } from '../core/randomizer';
import { randomSeed } from '../core/rng';
import { SHORTCUTS, formatCombo } from '../keymap';

export function Modal({ title, onClose, children, wide, side }: {
  title: string; onClose?: () => void; children: React.ReactNode; wide?: boolean;
  /** float at the side over an undimmed canvas (for live previews) */
  side?: boolean;
}) {
  return (
    <div className={`modal-backdrop ${side ? 'side' : ''}`} onPointerDown={(e) => { if (!side && e.target === e.currentTarget) onClose?.(); }}>
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

export function RemoveBgDialog() {
  const [mode, setMode] = useState<BgMode>('subject');
  const [tolerance, setTolerance] = useState(40);
  const [cutoff, setCutoff] = useState(0.5);
  const [softness, setSoftness] = useState(0.3);
  const [state, setState] = useState<'working' | 'ready' | 'error'>('working');
  const [message, setMessage] = useState('');
  // bumps per computed mask: a fast recompute can collapse working→ready into
  // "no state change", and the readout below reads the mask outside React
  const [, setMaskRev] = useState(0);
  const opened = useRef(false);

  // open once per dialog; cancel (restore the layer) when it goes away unapplied
  useEffect(() => {
    const err = openRemoveBg();
    if (err) {
      setStatus(err);
      setModal(null);
      return;
    }
    opened.current = true;
    return () => cancelRemoveBg();
  }, []);

  useEffect(() => {
    if (!opened.current) return;
    let live = true;
    setState('working');
    setMessage(mode === 'subject' ? 'Finding the subject… (first run loads a 4.5 MB model)' : 'Finding the backdrop…');
    computeMask(mode, tolerance).then(
      (ok) => {
        if (!live || !ok) return;
        setState('ready');
        setMessage('');
        setMaskRev((r) => r + 1);
        previewRemoveBg(cutoff, softness);
      },
      (e) => {
        if (!live) return;
        setState('error');
        setMessage(`Couldn't run background removal: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return () => { live = false; };
    // cutoff/softness only re-preview (below); they don't need a new mask
  }, [mode, tolerance]);

  useEffect(() => {
    if (state === 'ready') previewRemoveBg(cutoff, softness);
  }, [cutoff, softness, state]);

  const close = () => setModal(null); // unmount cleanup cancels
  const kept = state === 'ready' ? keptFraction(cutoff) : null;
  return (
    <Modal title="Remove Background" onClose={close} side>
      <div className="form-row">
        <label>Find</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as BgMode)}>
          <option value="subject">Main subject (AI)</option>
          <option value="backdrop">Plain backdrop color</option>
        </select>
      </div>
      <p className="hint-text">
        {mode === 'subject'
          ? 'Keeps the main object (a car, a person, a pet) and removes everything behind it — runs on your device.'
          : 'Removes the solid/plain color touching the image edges. Best for product shots on white.'}
      </p>
      {mode === 'backdrop' && (
        <div className="prop-row">
          <label>Tolerance</label>
          <input type="range" min={2} max={160} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
          <span className="val">{tolerance}</span>
        </div>
      )}
      <div className="prop-row">
        <label title="Higher removes more">Edge cutoff</label>
        <input type="range" min={0.05} max={0.95} step={0.01} value={cutoff} onChange={(e) => setCutoff(Number(e.target.value))} />
        <span className="val">{cutoff.toFixed(2)}</span>
      </div>
      <div className="prop-row">
        <label title="0 = hard cut-out edge">Edge softness</label>
        <input type="range" min={0} max={0.8} step={0.01} value={softness} onChange={(e) => setSoftness(Number(e.target.value))} />
        <span className="val">{softness.toFixed(2)}</span>
      </div>
      <p className={`hint-text ${state === 'error' ? 'error' : ''}`}>
        {state === 'ready' && kept !== null ? `Keeping ${Math.round(kept * 100)}% of the image — preview is on the canvas.` : message}
      </p>
      <div className="footer">
        <button className="btn" onClick={close}>Cancel</button>
        <button
          className="btn primary"
          disabled={state !== 'ready'}
          onClick={() => { applyRemoveBg(cutoff, softness); setModal(null); }}
        >
          Apply
        </button>
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
