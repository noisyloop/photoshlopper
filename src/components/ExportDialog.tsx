// Unified Export dialog: Raster / 3D / Shader / Project tabs.
// Everything runs client-side; downloads via Blob + object URL.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, setModal, activeLayer, setStatus } from '../store';
import { download } from '../core/pixels';
import { exportRaster, renderExportImage, type RasterExportOptions } from '../export/raster';
import { buildShaderExport, validateShader, assembleShaderDownload, type ShaderTarget } from '../export/shader';
import {
  buildStickerMesh, buildHeightfieldMesh, exportMeshFile, createMeshPreview,
  type BuiltMesh, type MeshFormat, type MeshPreview,
} from '../export/mesh';
import { savePslop, promptOpenPslop } from '../export/pslop';
import { savePsd, promptOpenPsd } from '../export/psd';
import { Modal } from './Dialogs';

type Tab = 'raster' | 'mesh' | 'shader' | 'project';

export function ExportDialog() {
  const [tab, setTab] = useState<Tab>('raster');
  const doc = useStore((s) => s.doc);
  if (!doc) return null;
  return (
    <Modal title="Export" onClose={() => setModal(null)} wide>
      <div className="tabs">
        <button className={tab === 'raster' ? 'active' : ''} onClick={() => setTab('raster')}>Raster</button>
        <button className={tab === 'mesh' ? 'active' : ''} onClick={() => setTab('mesh')}>3D Object</button>
        <button className={tab === 'shader' ? 'active' : ''} onClick={() => setTab('shader')}>Shader</button>
        <button className={tab === 'project' ? 'active' : ''} onClick={() => setTab('project')}>Project</button>
      </div>
      {tab === 'raster' && <RasterTab />}
      {tab === 'mesh' && <MeshTab />}
      {tab === 'shader' && <ShaderTab />}
      {tab === 'project' && <ProjectTab />}
    </Modal>
  );
}

// ---------- Raster ----------

function RasterTab() {
  const [opts, setOpts] = useState<RasterExportOptions>({ format: 'png', quality: 0.9, scope: 'doc', trim: false, scale: 1 });
  const [preview, setPreview] = useState<{ url: string; w: number; h: number; kb: number } | null>(null);
  const set = (p: Partial<RasterExportOptions>) => setOpts((o) => ({ ...o, ...p }));

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const t = setTimeout(async () => {
      const s = useStore.getState();
      if (!s.doc) return;
      try {
        const res = await exportRaster(s.doc, s.layerVersions, activeLayer(), opts);
        if (cancelled) return;
        url = URL.createObjectURL(res.blob);
        setPreview({ url, w: res.width, h: res.height, kb: Math.round(res.blob.size / 1024) });
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
      if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000);
    };
  }, [opts]);

  return (
    <div className="export-grid">
      <div>
        <div className="form-row">
          <label>Format</label>
          <select value={opts.format} onChange={(e) => set({ format: e.target.value as RasterExportOptions['format'] })}>
            <option value="png">PNG (alpha — stickers)</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
        </div>
        {opts.format !== 'png' && (
          <div className="form-row">
            <label>Quality</label>
            <input type="range" min={0.1} max={1} step={0.05} value={opts.quality} onChange={(e) => set({ quality: Number(e.target.value) })} />
            <span>{Math.round(opts.quality * 100)}%</span>
          </div>
        )}
        <div className="form-row">
          <label>Scope</label>
          <select value={opts.scope} onChange={(e) => set({ scope: e.target.value as 'doc' | 'layer' })}>
            <option value="doc">Whole document</option>
            <option value="layer">Active layer only</option>
          </select>
        </div>
        <div className="form-row">
          <label>Trim</label>
          <label><input type="checkbox" checked={opts.trim} onChange={(e) => set({ trim: e.target.checked })} /> Crop to non-transparent bounds (sticker cutout)</label>
        </div>
        <div className="form-row">
          <label>Scale</label>
          {[1, 2, 4].map((s) => (
            <button key={s} className={`btn ${opts.scale === s ? 'primary' : ''}`} onClick={() => set({ scale: s as 1 | 2 | 4 })}>{s}×</button>
          ))}
        </div>
        <div className="footer">
          <button
            className="btn primary"
            onClick={async () => {
              const s = useStore.getState();
              const res = await exportRaster(s.doc!, s.layerVersions, activeLayer(), opts);
              download(res.blob, res.filename);
            }}
          >
            Download
          </button>
        </div>
      </div>
      <div className="export-preview">
        {preview && <img src={preview.url} alt="export preview" />}
        {preview && <span className="meta">{preview.w}×{preview.h} · ~{preview.kb} KB</span>}
      </div>
    </div>
  );
}

// ---------- 3D ----------

function MeshTab() {
  const [mode, setMode] = useState<'sticker' | 'heightfield'>('sticker');
  const [scope, setScope] = useState<'doc' | 'layer'>('doc');
  const [depth, setDepth] = useState(0.06);
  const [simplify, setSimplify] = useState(2);
  const [border, setBorder] = useState(12);
  const [amplitude, setAmplitude] = useState(0.35);
  const [segments, setSegments] = useState(160);
  const [format, setFormat] = useState<MeshFormat>('glb');
  const [stats, setStats] = useState('');
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<MeshPreview | null>(null);
  const builtRef = useRef<BuiltMesh | null>(null);

  useEffect(() => {
    previewRef.current = createMeshPreview(canvasRef.current!);
    return () => previewRef.current?.dispose();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const s = useStore.getState();
      if (!s.doc) return;
      try {
        const img = renderExportImage(s.doc, s.layerVersions, scope, activeLayer());
        const built = mode === 'sticker'
          ? buildStickerMesh(img, { depth, simplify, border, alphaThreshold: 32 })
          : buildHeightfieldMesh(img, { amplitude, segments });
        builtRef.current = built;
        previewRef.current?.setMesh(built.mesh);
        setStats(built.stats);
        setError('');
      } catch (e) {
        builtRef.current = null;
        previewRef.current?.setMesh(null);
        setStats('');
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 250);
    return () => clearTimeout(t);
  }, [mode, scope, depth, simplify, border, amplitude, segments]);

  return (
    <div className="export-grid">
      <div>
        <div className="form-row">
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="sticker">Die-cut sticker mesh</option>
            <option value="heightfield">Luminance heightfield</option>
          </select>
        </div>
        <div className="form-row">
          <label>Source</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="doc">Flattened composite</option>
            <option value="layer">Active layer only</option>
          </select>
        </div>
        {mode === 'sticker' ? (
          <>
            <div className="form-row">
              <label>Thickness</label>
              <input type="range" min={0.01} max={0.3} step={0.005} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
              <span>{depth.toFixed(3)}</span>
            </div>
            <div className="form-row">
              <label>Simplify</label>
              <input type="range" min={0.5} max={12} step={0.5} value={simplify} onChange={(e) => setSimplify(Number(e.target.value))} />
              <span>{simplify}px</span>
            </div>
            <div className="form-row">
              <label>White border</label>
              <input type="range" min={0} max={48} step={1} value={border} onChange={(e) => setBorder(Number(e.target.value))} />
              <span>{border}px</span>
            </div>
          </>
        ) : (
          <>
            <div className="form-row">
              <label>Amplitude</label>
              <input type="range" min={0.02} max={1} step={0.01} value={amplitude} onChange={(e) => setAmplitude(Number(e.target.value))} />
              <span>{amplitude.toFixed(2)}</span>
            </div>
            <div className="form-row">
              <label>Resolution</label>
              <input type="range" min={32} max={400} step={8} value={segments} onChange={(e) => setSegments(Number(e.target.value))} />
              <span>{segments}</span>
            </div>
          </>
        )}
        <div className="form-row">
          <label>Format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value as MeshFormat)}>
            <option value="glb">.glb (binary glTF)</option>
            <option value="gltf">.gltf (JSON, embedded)</option>
            <option value="obj">.obj (+ .mtl + PNG, zipped)</option>
          </select>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="footer">
          <button
            className="btn primary"
            disabled={!!error}
            onClick={async () => {
              if (!builtRef.current) return;
              try {
                const res = await exportMeshFile(builtRef.current, format);
                download(res.blob, res.filename);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Download
          </button>
        </div>
      </div>
      <div className="export-preview">
        <canvas ref={canvasRef} />
        {stats && <span className="meta">{stats}</span>}
      </div>
    </div>
  );
}

// ---------- Shader ----------

function ShaderTab() {
  const [target, setTarget] = useState<ShaderTarget>('shadertoy');
  const doc = useStore((s) => s.doc)!;
  const renderVersion = useStore((s) => s.renderVersion);
  const seed = useStore((s) => s.seed);

  const build = useMemo(() => buildShaderExport(doc, target, seed), [doc, target, seed, renderVersion]);
  const compileError = useMemo(
    () => (build.error ? null : validateShader(build.source, target, build.textures.length)),
    [build, target],
  );

  return (
    <div className="export-grid" style={{ gridTemplateColumns: '240px 1fr' }}>
      <div>
        <div className="form-row">
          <label>Target</label>
          <select value={target} onChange={(e) => setTarget(e.target.value as ShaderTarget)}>
            <option value="shadertoy">Shadertoy (mainImage)</option>
            <option value="webgl2">Raw WebGL2 (+ runner html)</option>
            <option value="isf">ISF (VDMX / CoGe / TD)</option>
          </select>
        </div>
        <p style={{ color: 'var(--text-1)', lineHeight: 1.5 }}>
          Raster layers become textures (exported alongside); procedural layers
          inline their GLSL. A doc of only procedural layers is fully
          self-contained — ideal for Shadertoy.
        </p>
        {build.error && <div className="error">{build.error}</div>}
        {!build.error && compileError && <div className="error">Compile check FAILED:{'\n'}{compileError}</div>}
        {!build.error && !compileError && <p className="ok">✓ Compiles in a live {target === 'isf' ? 'WebGL1' : 'WebGL2'} context</p>}
        {build.warnings.map((w) => <p key={w} className="warn">⚠ {w}</p>)}
        {build.textures.length > 0 && (
          <p style={{ color: 'var(--text-2)' }}>{build.textures.length} texture(s) will be bundled: {build.textures.map((t) => t.name).join(', ')}</p>
        )}
        <div className="footer">
          <button
            className="btn"
            disabled={!!build.error}
            onClick={() => { navigator.clipboard.writeText(build.source).then(() => setStatus('Shader copied to clipboard')); }}
          >
            Copy code
          </button>
          <button
            className="btn primary"
            disabled={!!build.error}
            onClick={async () => {
              const res = await assembleShaderDownload(build, target);
              download(res.blob, res.filename);
            }}
          >
            Download
          </button>
        </div>
      </div>
      <div className="code-preview">{build.error ? '// nothing to export' : build.source}</div>
    </div>
  );
}

// ---------- Project ----------

function ProjectTab() {
  return (
    <div>
      <p style={{ color: 'var(--text-1)', lineHeight: 1.6, maxWidth: 560 }}>
        <b>.pslop</b> is Photoshlopper's native project format: a zip with a JSON
        manifest (doc, layers, transforms, procedural graphs, seed) plus a PNG
        per raster layer and raw mask data. Saving and re-opening restores your
        session exactly — undo history is not persisted.
      </p>
      <div className="footer" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" onClick={() => void savePslop()}>Save .pslop</button>
        <button className="btn" onClick={() => { promptOpenPslop(setStatus); setModal(null); }}>Open .pslop…</button>
      </div>
      <p style={{ color: 'var(--text-1)', lineHeight: 1.6, maxWidth: 560, borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 18 }}>
        <b>.psd</b> interop for Photoshop, GIMP, Krita, Affinity &amp; co. Export
        writes a layered 8-bit RGB PSD — every layer baked to pixels with its
        blend mode, opacity and visibility preserved, plus a flattened
        composite (procedural effect layers only appear in the composite).
        Import reads 8-bit RGB/grayscale PSDs as raster layers.
      </p>
      <div className="footer" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" onClick={() => void savePsd()}>Export .psd</button>
        <button className="btn" onClick={() => { promptOpenPsd(setStatus); setModal(null); }}>Import .psd…</button>
      </div>
    </div>
  );
}
