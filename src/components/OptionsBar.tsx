import { useStore } from '../store';
import { applyCrop, cancelCrop } from '../tools/nav';

function Slider({ label, value, min, max, step = 1, onChange, format }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <span className="opt">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span>{format ? format(value) : Math.round(value)}</span>
    </span>
  );
}

export function OptionsBar() {
  const s = useStore();
  const setBrush = (patch: Partial<typeof s.brush>) =>
    useStore.setState((st) => ({ brush: { ...st.brush, ...patch } }));

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  let controls: React.ReactNode = null;
  switch (s.tool) {
    case 'brush':
    case 'eraser':
    case 'clone':
      controls = (
        <>
          <Slider label="Size" value={s.brush.size} min={1} max={300} onChange={(v) => setBrush({ size: v })} />
          <Slider label="Hardness" value={s.brush.hardness} min={0} max={1} step={0.01} onChange={(v) => setBrush({ hardness: v })} format={pct} />
          <Slider label="Opacity" value={s.brush.opacity} min={0.01} max={1} step={0.01} onChange={(v) => setBrush({ opacity: v })} format={pct} />
          <Slider label="Flow" value={s.brush.flow} min={0.01} max={1} step={0.01} onChange={(v) => setBrush({ flow: v })} format={pct} />
          {s.tool === 'clone' && <span className="hint">Alt+click sets the clone source</span>}
        </>
      );
      break;
    case 'marquee':
      controls = (
        <span className="opt">
          <span>Shape</span>
          <select value={s.marqueeKind} onChange={(e) => useStore.setState({ marqueeKind: e.target.value as 'rect' | 'ellipse' })}>
            <option value="rect">Rectangle</option>
            <option value="ellipse">Ellipse</option>
          </select>
          <span className="hint">Shift adds · Alt subtracts</span>
        </span>
      );
      break;
    case 'lasso':
      controls = <span className="hint">Drag a freehand loop · Shift adds · Alt subtracts</span>;
      break;
    case 'wand':
    case 'bucket':
      controls = (
        <>
          <Slider label="Tolerance" value={s.tolerance} min={0} max={255} onChange={(v) => useStore.setState({ tolerance: v })} />
          {s.tool === 'wand' && <span className="hint">Shift adds · Alt subtracts</span>}
        </>
      );
      break;
    case 'gradient':
      controls = (
        <span className="opt">
          <span>Type</span>
          <select value={s.gradientKind} onChange={(e) => useStore.setState({ gradientKind: e.target.value as 'linear' | 'radial' })}>
            <option value="linear">Linear</option>
            <option value="radial">Radial</option>
          </select>
          <span className="hint">Drags FG → BG</span>
        </span>
      );
      break;
    case 'shape':
      controls = (
        <>
          <span className="opt">
            <span>Shape</span>
            <select value={s.shapeKind} onChange={(e) => useStore.setState({ shapeKind: e.target.value as 'rect' | 'ellipse' | 'line' })}>
              <option value="rect">Rectangle</option>
              <option value="ellipse">Ellipse</option>
              <option value="line">Line</option>
            </select>
          </span>
          <span className="opt">
            <label><input type="checkbox" checked={s.shapeFill} onChange={(e) => useStore.setState({ shapeFill: e.target.checked })} /> Fill</label>
          </span>
          <Slider label="Stroke" value={s.shapeStrokeWidth} min={1} max={64} onChange={(v) => useStore.setState({ shapeStrokeWidth: v })} />
        </>
      );
      break;
    case 'type':
      controls = (
        <>
          <span className="opt">
            <span>Size</span>
            <input type="number" value={s.fontSize} min={6} max={400} onChange={(e) => useStore.setState({ fontSize: Number(e.target.value) || 48 })} />
          </span>
          <span className="opt">
            <span>Font</span>
            <select value={s.fontFamily} onChange={(e) => useStore.setState({ fontFamily: e.target.value })}>
              <option value="system-ui, sans-serif">Sans</option>
              <option value="Georgia, serif">Serif</option>
              <option value="'Courier New', monospace">Mono</option>
              <option value="'Comic Sans MS', cursive">Comic</option>
            </select>
          </span>
          <span className="hint">Click canvas to type · Enter commits · click a text layer to re-edit</span>
        </>
      );
      break;
    case 'crop':
      controls = (
        <>
          <span className="hint">Drag a crop rectangle, then</span>
          <button className="btn" onClick={() => applyCrop()}>Apply (Enter)</button>
          <button className="btn" onClick={() => cancelCrop()}>Cancel (Esc)</button>
        </>
      );
      break;
    case 'move':
      controls = <span className="hint">Drags the layer (non-destructive) — or the selected pixels when a selection exists</span>;
      break;
    case 'eyedropper':
      controls = <span className="hint">Click samples foreground · Alt+click samples background</span>;
      break;
    case 'hand':
      controls = <span className="hint">Drag to pan (hold Space with any tool)</span>;
      break;
    case 'zoom':
      controls = <span className="hint">Click zooms in · Alt+click zooms out · mouse wheel works anywhere</span>;
      break;
  }

  return <div className="optionsbar">{controls}</div>;
}
