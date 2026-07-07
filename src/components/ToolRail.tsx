import { useStore, setTool, swapColors } from '../store';
import { TOOL_INFO } from '../tools';

export function ToolRail() {
  const tool = useStore((s) => s.tool);
  const fg = useStore((s) => s.fg);
  const bg = useStore((s) => s.bg);
  return (
    <div className="toolrail">
      {TOOL_INFO.map((t) => (
        <button
          key={t.id}
          className={tool === t.id ? 'active' : ''}
          title={`${t.label} (${t.key})`}
          onClick={() => setTool(t.id)}
        >
          {t.icon}
        </button>
      ))}
      <div className="swatches" title="Foreground / background (X swaps, D resets)" onClick={swapColors}>
        <div className="fg" style={{ background: fg }} />
        <div className="bg" style={{ background: bg }} />
      </div>
    </div>
  );
}
