// WebGL2 layer compositor. Composites the layer stack bottom-to-top with
// ping-pong framebuffers:
//   - raster/text/shape layers: texture upload -> blend pass (16 blend modes)
//   - procedural generators: rendered to a scratch texture -> blend pass
//   - procedural effects/adjustments: full-screen pass over the accumulated
//     composite below, mixed back by opacity/mask
// The blend math and effect bodies are the exact GLSL snippets the shader
// exporter emits, so exports match the canvas.

import type { Doc, Layer, Transform } from '../types';
import { BLEND_GLSL, blendModeIndex } from './blend';
import { getPixels } from './pixels';
import { getProcDef, paramUniformDecls, NOISE_GLSL, COLOR_GLSL, type ProcDef } from './procedural';
import { hexToRgb01 } from './rng';
import { invUvCoeffs } from './transform';

const VS = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const BLEND_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform bool u_hasMask;
uniform float u_opacity;
uniform int u_mode;
uniform mat3 u_srcMat;
${BLEND_GLSL}
void main() {
  vec4 dst = texture(u_dst, v_uv);
  vec3 sp = u_srcMat * vec3(v_uv, 1.0);
  vec2 suv = sp.xy;
  vec4 src = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
    ? vec4(0.0) : texture(u_src, suv);
  if (u_hasMask) src.a *= texture(u_mask, v_uv).r;
  src.a *= u_opacity;
  outColor = bl_composite(dst, src, u_mode);
}`;

// present to the canvas: flip Y + premultiply (browser expects premultiplied)
const PRESENT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
void main() {
  vec4 c = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y));
  outColor = vec4(c.rgb * c.a, c.a);
}`;

function effectFS(def: ProcDef): string {
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragOut;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform bool u_hasMask;
uniform float u_opacity;
uniform vec2 u_res;
${paramUniformDecls(def)}
#define RES u_res
#define TIME 0.0
#define SRC(p) texture(u_src, clamp((p), 0.0, 1.0))
${def.needsNoise ? NOISE_GLSL : ''}
${def.needsColor ? COLOR_GLSL : ''}
void main() {
  vec2 uv = v_uv;
  vec4 result = vec4(0.0);
  {
${def.body}
  }
  vec4 base = texture(u_src, v_uv);
  float m = u_opacity * (u_hasMask ? texture(u_mask, v_uv).r : 1.0);
  fragOut = mix(base, result, m);
}`;
}

function generatorFS(def: ProcDef): string {
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragOut;
uniform vec2 u_res;
${paramUniformDecls(def)}
#define RES u_res
#define TIME 0.0
${def.needsNoise ? NOISE_GLSL : ''}
${def.needsColor ? COLOR_GLSL : ''}
void main() {
  vec2 uv = v_uv;
  vec4 result = vec4(0.0);
  {
${def.body}
  }
  fragOut = result;
}`;
}

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer }

export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private width = 0;
  private height = 0;
  private blendProg: WebGLProgram;
  private presentProg: WebGLProgram;
  private procProgs = new Map<string, WebGLProgram>();
  private ping!: Target;
  private pong!: Target;
  private scratch!: Target;
  private layerTex = new Map<string, { tex: WebGLTexture; version: number }>();
  private maskTex = new Map<string, { tex: WebGLTexture; ref: Uint8ClampedArray }>();

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // fullscreen triangle-strip quad at location 0
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.blendProg = this.compileProgram(VS, BLEND_FS);
    this.presentProg = this.compileProgram(VS, PRESENT_FS);
  }

  private compileProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh) + '\n---\n' + src);
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  private ensureSize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    if (this.ping) {
      for (const t of [this.ping, this.pong, this.scratch]) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
    }
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ping = this.makeTarget(w, h);
    this.pong = this.makeTarget(w, h);
    this.scratch = this.makeTarget(w, h);
  }

  invalidateLayer(id: string): void {
    const gl = this.gl;
    const entry = this.layerTex.get(id);
    if (entry) {
      gl.deleteTexture(entry.tex);
      this.layerTex.delete(id);
    }
    const m = this.maskTex.get(id);
    if (m) {
      gl.deleteTexture(m.tex);
      this.maskTex.delete(id);
    }
  }

  private getLayerTexture(layer: Layer, version: number): WebGLTexture | null {
    const gl = this.gl;
    const pixels = getPixels(layer.id);
    if (!pixels) return null;
    let entry = this.layerTex.get(layer.id);
    if (!entry || entry.version !== version) {
      const tex = entry?.tex ?? gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      entry = { tex, version };
      this.layerTex.set(layer.id, entry);
    }
    return entry.tex;
  }

  private getMaskTexture(layer: Layer): WebGLTexture | null {
    if (!layer.mask) return null;
    const gl = this.gl;
    let entry = this.maskTex.get(layer.id);
    if (!entry || entry.ref !== layer.mask) {
      const tex = entry?.tex ?? gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.width, this.height, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(layer.mask.buffer.slice(0)));
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      entry = { tex, ref: layer.mask };
      this.maskTex.set(layer.id, entry);
    }
    return entry.tex;
  }

  private getProcProgram(def: ProcDef): WebGLProgram {
    let prog = this.procProgs.get(def.type);
    if (!prog) {
      prog = this.compileProgram(VS, def.kind === 'effect' ? effectFS(def) : generatorFS(def));
      this.procProgs.set(def.type, prog);
    }
    return prog;
  }

  /** doc-uv -> layer-uv inverse transform matrix (column-major mat3). */
  private srcMatrix(t: Transform): Float32Array {
    const { a, b, c, d, e, f } = invUvCoeffs(t, this.width, this.height);
    return new Float32Array([a, d, 0, b, e, 0, c, f, 1]);
  }

  private setParamUniforms(prog: WebGLProgram, def: ProcDef, layer: Layer): void {
    const gl = this.gl;
    for (const p of def.params) {
      const loc = gl.getUniformLocation(prog, `p_${p.key}`);
      if (!loc) continue;
      const v = layer.procedural?.params[p.key] ?? p.def;
      if (p.type === 'color') gl.uniform3fv(loc, v as [number, number, number]);
      else gl.uniform1f(loc, v as number);
    }
  }

  private drawQuad(): void {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  private swap(): void {
    const t = this.ping;
    this.ping = this.pong;
    this.pong = t;
  }

  /**
   * Composite `layers` (bottom to top) into the internal target.
   * Returns after leaving the result in `this.ping.tex`.
   */
  private composite(doc: Doc, layers: Layer[], versions: Record<string, number>, background: Doc['background']): void {
    const gl = this.gl;
    this.ensureSize(doc.width, doc.height);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    // clear accumulator with background
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ping.fbo);
    if (background === 'transparent') gl.clearColor(0, 0, 0, 0);
    else {
      const [r, g, b] = hexToRgb01(background);
      gl.clearColor(r, g, b, 1);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (const layer of layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const def = layer.procedural ? getProcDef(layer.procedural.type) : null;
      if (def && def.kind === 'effect') {
        this.runEffectPass(layer, def);
      } else if (def && def.kind === 'generator') {
        this.runGeneratorPass(layer, def);
        this.runBlendPass(layer, this.scratch.tex);
      } else {
        const tex = this.getLayerTexture(layer, versions[layer.id] ?? 0);
        if (!tex) continue;
        this.runBlendPass(layer, tex);
      }
    }
  }

  private runBlendPass(layer: Layer, srcTex: WebGLTexture): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pong.fbo);
    gl.useProgram(this.blendProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ping.tex);
    gl.uniform1i(gl.getUniformLocation(this.blendProg, 'u_dst'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(this.blendProg, 'u_src'), 1);
    const mask = this.getMaskTexture(layer);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, mask ?? srcTex);
    gl.uniform1i(gl.getUniformLocation(this.blendProg, 'u_mask'), 2);
    gl.uniform1i(gl.getUniformLocation(this.blendProg, 'u_hasMask'), mask ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.blendProg, 'u_opacity'), layer.opacity);
    gl.uniform1i(gl.getUniformLocation(this.blendProg, 'u_mode'), blendModeIndex(layer.blend));
    gl.uniformMatrix3fv(gl.getUniformLocation(this.blendProg, 'u_srcMat'), false, this.srcMatrix(layer.transform));
    this.drawQuad();
    this.swap();
  }

  private runEffectPass(layer: Layer, def: ProcDef): void {
    const gl = this.gl;
    const prog = this.getProcProgram(def);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pong.fbo);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ping.tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_src'), 0);
    const mask = this.getMaskTexture(layer);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mask ?? this.ping.tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_mask'), 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_hasMask'), mask ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_opacity'), layer.opacity);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_res'), this.width, this.height);
    this.setParamUniforms(prog, def, layer);
    this.drawQuad();
    this.swap();
  }

  private runGeneratorPass(layer: Layer, def: ProcDef): void {
    const gl = this.gl;
    const prog = this.getProcProgram(def);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratch.fbo);
    gl.useProgram(prog);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_res'), this.width, this.height);
    this.setParamUniforms(prog, def, layer);
    this.drawQuad();
  }

  /** Render the doc to the compositor's canvas (for on-screen drawImage). */
  render(doc: Doc, versions: Record<string, number>): HTMLCanvasElement {
    const gl = this.gl;
    this.composite(doc, doc.layers, versions, doc.background);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.presentProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ping.tex);
    gl.uniform1i(gl.getUniformLocation(this.presentProg, 'u_tex'), 0);
    this.drawQuad();
    return this.canvas;
  }

  /** Composite (optionally a subset of layers / background override) and read back pixels. */
  renderToImageData(doc: Doc, versions: Record<string, number>, layers?: Layer[], background?: Doc['background']): ImageData {
    const gl = this.gl;
    this.composite(doc, layers ?? doc.layers, versions, background ?? doc.background);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ping.fbo);
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer));
    return new ImageData(out, this.width, this.height);
  }
}

let shared: Compositor | null = null;
export function getCompositor(): Compositor {
  if (!shared) shared = new Compositor();
  return shared;
}
