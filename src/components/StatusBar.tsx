import { useStore } from '../store';

export function StatusBar() {
  const status = useStore((s) => s.status);
  const doc = useStore((s) => s.doc);
  const zoom = useStore((s) => s.zoom);
  const tool = useStore((s) => s.tool);
  return (
    <div className="statusbar">
      <span className="left">{status}</span>
      <span className="right">
        <span>{tool}</span>
        {doc && <span>{doc.width}×{doc.height}</span>}
        {doc && <span>{Math.round(zoom * 100)}%</span>}
      </span>
    </div>
  );
}
