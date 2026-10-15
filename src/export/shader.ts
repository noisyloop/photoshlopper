// Shader export: compiles the layer stack into a single fragment shader.
//   - raster/text/shape layers -> sampler2D lookups (textures exported as PNGs)
//   - procedural layers -> their GLSL bodies inlined with params baked
//   - layers composite bottom-to-top with the SAME blend GLSL the compositor
//     uses (src/core/blend.ts)
// Effects sample the composite below them through a per-layer SRC(p) macro
// bound to the previous stack function, so blur/glitch style effects work in
// a single pass. A doc of only procedural layers is fully self-contained.
//
// Known limitation (also surfaced as a warning): per-layer masks are ignored
// in shader export (they would need extra textures).

import type { Doc, Layer } from '../types';
import { BLEND_GLSL, blendModeIndex } from '../core/blend';
import { getProcDef, paramLocalDecls, NOISE_GLSL, COLOR_GLSL } from '../core/procedural';
import { invUvCoeffs, isIdentity } from '../core/transform';
import { getPixels, imageDataToCanvas, canvasToBlob } from '../core/pixels';
import { hexToRgb01 } from '../core/rng';
import { writeZip, type ZipEntry } from './zip';

export type ShaderTarget = 'webgl2' | 'shadertoy' | 'isf';

export interface ShaderTexture {
  name: string;
  canvas: HTMLCanvasElement;
}

export interface ShaderBuild {
  source: string;
  textures: ShaderTexture[];
  warnings: string[];
  error?: string;
}

const fmt = (n: number): string => {
  const s = Number(n.toFixed(6)).toString();
  return s.includes('.') || s.includes('e') || s.includes('E') ? s : s + '.0';
};

/** Layer names go into `//` comments; a newline would end the comment and inject GLSL. */
const commentSafe = (s: string): string => s.replace(/[\u0000-\u001f\u007f\u2028\u2029\\]/g, ' ');

export function buildShaderExport(doc: Doc, target: ShaderTarget, seed: number): ShaderBuild {
  const warnings: string[] = [];
  const layers = doc.layers.filter((l) => l.visible && l.opacity > 0);
  if (layers.length === 0) {
    return { source: '', textures: [], warnings, error: 'No visible layers to export' };
  }

  // collect texture-backed layers in stack order
  const textures: ShaderTexture[] = [];
  const texIndex = new Map<string, number>(); // layerId -> texture idx
  for (const layer of layers) {
    if (layer.procedural) continue;
    const px = getPixels(layer.id);
    if (!px) continue;
    texIndex.set(layer.id, textures.length);
    textures.push({ name: `layer${textures.length}.png`, canvas: imageDataToCanvas(px) });
  }
  if (target === 'shadertoy' && textures.length > 4) {
    return {
      source: '', textures, warnings,
      error: `Shadertoy supports at most 4 texture channels; this doc needs ${textures.length}. Merge raster layers or use procedural layers.`,
    };
  }
  if (layers.some((l) => l.mask)) {
    warnings.push('Layer masks are ignored in shader export.');
  }

  let needsNoise = false;
  let needsColor = false;
  for (const l of layers) {
    if (!l.procedural) continue;
    const def = getProcDef(l.procedural.type);
    needsNoise ||= !!def.needsNoise;
    needsColor ||= !!def.needsColor;
  }

  const bg = doc.background === 'transparent'
    ? 'vec4(0.0)'
    : (() => {
        const [r, g, b] = hexToRgb01(doc.background);
        return `vec4(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, 1.0)`;
      })();

  const chunks: string[] = [];
  chunks.push(BLEND_GLSL);
  if (needsNoise) chunks.push(NOISE_GLSL);
  if (needsColor) chunks.push(COLOR_GLSL);
  chunks.push(`vec4 stack_bg(vec2 uv) { return ${bg}; }`);

  let prevFn = 'stack_bg';
  layers.forEach((layer, i) => {
    const def = layer.procedural ? getProcDef(layer.procedural.type) : null;
    const op = fmt(layer.opacity);
    if (def && def.kind === 'effect') {
      chunks.push(
        `// layer ${i}: "${commentSafe(layer.name)}" (${def.type}, opacity ${op})`,
        `#define SRC(p) ${prevFn}(clamp((p), 0.0, 1.0))`,
        `vec4 fx_${i}(vec2 uv) {`,
        paramLocalDecls(def, layer.procedural!),
        `  vec4 result = vec4(0.0);`,
        `  {`,
        def.body,
        `  }`,
        `  return result;`,
        `}`,
        `#undef SRC`,
        `vec4 stack_${i}(vec2 uv) { return mix(${prevFn}(uv), fx_${i}(uv), ${op}); }`,
      );
    } else if (def && def.kind === 'generator') {
      const t = invUvCoeffs(layer.transform, doc.width, doc.height);
      const luv = isIdentity(layer.transform)
        ? '  vec2 luv = uv;'
        : `  vec2 luv = vec2(${fmt(t.a)} * uv.x + ${fmt(t.b)} * uv.y + ${fmt(t.c)}, ${fmt(t.d)} * uv.x + ${fmt(t.e)} * uv.y + ${fmt(t.f)});\n` +
          `  if (luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0) return vec4(0.0);`;
      chunks.push(
        `// layer ${i}: "${commentSafe(layer.name)}" (${def.type}, blend ${commentSafe(layer.blend)}, opacity ${op})`,
        `vec4 gen_${i}(vec2 uv) {`,
        paramLocalDecls(def, layer.procedural!),
        `  vec4 result = vec4(0.0);`,
        `  {`,
        def.body,
        `  }`,
        `  return result;`,
        `}`,
        `vec4 layer_${i}(vec2 uv) {`,
        luv,
        `  return gen_${i}(luv);`,
        `}`,
        `vec4 stack_${i}(vec2 uv) {`,
        `  vec4 src = layer_${i}(uv);`,
        `  src.a *= ${op};`,
        `  return bl_composite(${prevFn}(uv), src, ${blendModeIndex(layer.blend)});`,
        `}`,
      );
    } else {
      const ti = texIndex.get(layer.id);
      if (ti === undefined) return; // empty layer, skip (prevFn unchanged)
      const t = invUvCoeffs(layer.transform, doc.width, doc.height);
      const luv = isIdentity(layer.transform)
        ? '  vec2 luv = uv;'
        : `  vec2 luv = vec2(${fmt(t.a)} * uv.x + ${fmt(t.b)} * uv.y + ${fmt(t.c)}, ${fmt(t.d)} * uv.x + ${fmt(t.e)} * uv.y + ${fmt(t.f)});`;
      chunks.push(
        `// layer ${i}: "${commentSafe(layer.name)}" (texture ${ti}, blend ${commentSafe(layer.blend)}, opacity ${op})`,
        `vec4 layer_${i}(vec2 uv) {`,
        luv,
        `  if (luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0) return vec4(0.0);`,
        `  return TEX${ti}(luv);`,
        `}`,
        `vec4 stack_${i}(vec2 uv) {`,
        `  vec4 src = layer_${i}(uv);`,
        `  src.a *= ${op};`,
        `  return bl_composite(${prevFn}(uv), src, ${blendModeIndex(layer.blend)});`,
        `}`,
      );
    }
    prevFn = `stack_${i}`;
  });

  const body = chunks.join('\n');
  const headerNote = `// Generated by Photoshlopper (seed ${seed})\n// ${doc.width}x${doc.height}, ${layers.length} layer(s), ${textures.length} texture(s)`;

  let source: string;
  if (target === 'webgl2') {
    const texDecls = textures.map((_, i) => `uniform sampler2D u_tex${i};`).join('\n');
    const texDefs = textures.map((_, i) => `#define TEX${i}(p) texture(u_tex${i}, (p))`).join('\n');
    source = `#version 300 es
${headerNote}
precision highp float;
out vec4 fragColor;
uniform vec2 u_resolution;
uniform float u_time;
${texDecls}
#define RES u_resolution
#define TIME u_time
${texDefs}
${body}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv.y = 1.0 - uv.y;
  vec4 c = ${prevFn}(uv);
  fragColor = vec4(mix(vec3(0.0), c.rgb, c.a), 1.0);
}
`;
  } else if (target === 'shadertoy') {
    const mapping = textures.length
      ? '// iChannel mapping (add each as a texture channel, keep default vflip):\n' +
        textures.map((t, i) => `//   iChannel${i} = ${t.name}`).join('\n')
      : '// Fully self-contained: no texture channels needed.';
    const texDefs = textures.map((t, i) => `#define TEX${i}(p) texture(iChannel${i}, vec2((p).x, 1.0 - (p).y))`).join('\n');
    source = `${headerNote}
${mapping}
#define RES iResolution.xy
#define TIME iTime
${texDefs}
${body}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  uv.y = 1.0 - uv.y;
  vec4 c = ${prevFn}(uv);
  fragColor = vec4(mix(vec3(0.0), c.rgb, c.a), 1.0);
}
`;
  } else {
    const imported = textures.length
      ? `,\n  "IMPORTED": {\n${textures.map((t, i) => `    "tex${i}": { "PATH": "${t.name}" }`).join(',\n')}\n  }`
      : '';
    const texDefs = textures.map((t, i) => `#define TEX${i}(p) IMG_NORM_PIXEL(tex${i}, vec2((p).x, 1.0 - (p).y))`).join('\n');
    source = `/*{
  "DESCRIPTION": "Photoshlopper export (seed ${seed})",
  "CREDIT": "Photoshlopper",
  "ISFVSN": "2",
  "CATEGORIES": ["Generator"],
  "INPUTS": []${imported}
}*/
${headerNote}
#define RES RENDERSIZE
${texDefs}
${body}
void main() {
  vec2 uv = isf_FragNormCoord;
  uv.y = 1.0 - uv.y;
  vec4 c = ${prevFn}(uv);
  gl_FragColor = vec4(mix(vec3(0.0), c.rgb, c.a), 1.0);
}
`;
  }

  return { source, textures, warnings };
}

/**
 * Compile-check a generated shader in a hidden GL context (WebGL2 for
 * webgl2/shadertoy targets, WebGL1 for ISF). Returns null if it compiles,
 * else the compiler error log.
 */
export function validateShader(source: string, target: ShaderTarget, textureCount: number): string | null {
  let fs = source;
  if (target === 'shadertoy') {
    const channels = Array.from({ length: Math.max(textureCount, 1) }, (_, i) => `uniform sampler2D iChannel${i};`).join('\n');
    fs = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int iFrame;
uniform vec4 iMouse;
${channels}
out vec4 _psl_out;
${source}
void main() { mainImage(_psl_out, gl_FragCoord.xy); }
`;
  } else if (target === 'isf') {
    const texDecls = Array.from({ length: textureCount }, (_, i) => `uniform sampler2D tex${i};`).join('\n');
    fs = `precision highp float;
uniform vec2 RENDERSIZE;
uniform float TIME;
varying vec2 isf_FragNormCoord;
${texDecls}
#define IMG_NORM_PIXEL(t, p) texture2D(t, (p))
${source}
`;
  }
  const canvas = document.createElement('canvas');
  const gl = target === 'isf' ? canvas.getContext('webgl') : canvas.getContext('webgl2');
  if (!gl) return 'Could not create a GL context for validation';
  const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(sh, fs);
  gl.compileShader(sh);
  const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean;
  const log = gl.getShaderInfoLog(sh);
  gl.deleteShader(sh);
  return ok ? null : (log || 'Unknown shader compile error');
}

const RUNNER_HTML = (textureNames: string[]) => `<!doctype html>
<!-- Photoshlopper WebGL2 shader runner.
     Serve this folder over HTTP (e.g. python3 -m http.server) so the
     texture PNGs can load; file:// blocks texture uploads. -->
<html>
<head><meta charset="utf-8"><title>Photoshlopper shader</title>
<style>html,body{margin:0;height:100%;background:#111}canvas{width:100vw;height:100vh;display:block}</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
const TEXTURES = ${JSON.stringify(textureNames)};
async function main() {
  const src = await (await fetch('shader.frag')).text();
  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl2');
  if (!gl) { document.body.textContent = 'WebGL2 required'; return; }
  const vs = '#version 300 es\\nvoid main(){vec2 p=vec2(gl_VertexID==1?3.0:-1.0,gl_VertexID==2?3.0:-1.0);gl_Position=vec4(p,0,1);}';
  const compile = (type, s) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, src));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  await Promise.all(TEXTURES.map((name, i) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_tex' + i), i);
      resolve();
    };
    img.onerror = () => reject(new Error('Failed to load ' + name));
    img.src = name;
  })));
  const uRes = gl.getUniformLocation(prog, 'u_resolution');
  const uTime = gl.getUniformLocation(prog, 'u_time');
  const start = performance.now();
  function frame() {
    canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (performance.now() - start) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }
  frame();
}
main().catch(e => { document.body.textContent = e.message; });
</script>
</body>
</html>
`;

/** Assemble downloadable file(s). Single shader file when self-contained; zip otherwise. */
export async function assembleShaderDownload(build: ShaderBuild, target: ShaderTarget): Promise<{ blob: Blob; filename: string }> {
  const ext = target === 'isf' ? 'fs' : 'frag';
  const encoder = new TextEncoder();
  if (target !== 'webgl2' && build.textures.length === 0) {
    return {
      blob: new Blob([build.source], { type: 'text/plain' }),
      filename: `photoshlopper-${target}.${ext}`,
    };
  }
  const entries: ZipEntry[] = [];
  entries.push({ name: target === 'isf' ? `photoshlopper.fs` : 'shader.frag', data: encoder.encode(build.source) });
  if (target === 'webgl2') {
    entries.push({ name: 'index.html', data: encoder.encode(RUNNER_HTML(build.textures.map((t) => t.name))) });
  }
  for (const t of build.textures) {
    const blob = await canvasToBlob(t.canvas, 'image/png');
    entries.push({ name: t.name, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return { blob: writeZip(entries), filename: `photoshlopper-${target}.zip` };
}
