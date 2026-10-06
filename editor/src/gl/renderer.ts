/**
 * WebGL2 viewport renderer for core RenderLists.
 *
 * - Premultiplied pipeline: vertex colors are premultiplied in the vertex shader, textures are
 *   uploaded as premultiplied ImageBitmaps. Blend modes (premultiplied source S, destination D):
 *     normal   S + D(1 - Sa)
 *     add      S + D
 *     multiply S*D + D(1 - Sa)        (exact for an opaque destination, which the viewport always is)
 *     screen   S + D(1 - S)
 * - Masks: the union alpha coverage of the mask items is rendered into an R8 texture the size of the
 *   drawing buffer; the masked item multiplies by coverage (or 1 - coverage for maskInvert), read
 *   with texelFetch at gl_FragCoord. Consecutive items sharing a mask list reuse the coverage. A
 *   present but empty mask list is zero coverage (nothing drawn; with maskInvert: drawn unmasked).
 * - No culling (the core does not guarantee winding). MSAA via the default framebuffer.
 * - The workspace, the transparency checkerboard and the fixed backdrops take their colours from the
 *   design tokens (`RenderInput.colors`), so the viewport follows the light / dark appearance.
 */
import type { DrawItem, RenderList, RGBA } from '../../../src/core/index.js';
import type { CanvasColors } from '../overlay/theme.js';
import type { BackgroundMode } from '../state/app.js';
import { clipTransform, type Camera, type ViewportSize } from '../view/camera.js';
import { FramePacker, maskModeOf, type PackedRange } from './pack.js';
import { createPrograms, FLOATS_PER_VERTEX, type ProgramInfo } from './shaders.js';

export interface RenderInput {
  list: RenderList | null;
  camera: Camera;
  /** CSS pixel size of the viewport. */
  viewport: ViewportSize;
  dpr: number;
  background: BackgroundMode;
  hidden: ReadonlySet<string>;
  /** Workspace, checkerboard and backdrop colours of the appearance in effect (overlay/theme.ts). */
  colors: CanvasColors;
}

export interface RenderStats {
  draws: number;
  triangles: number;
}

export interface TextureSource {
  bitmap: ImageBitmap;
}

/** Side of one checkerboard square in CSS px (the design system's Checkerboard uses the same). */
const CHECKER_CELL_CSS = 8;

interface GlState {
  gl: WebGL2RenderingContext;
  programs: ReturnType<typeof createPrograms>;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  backdropVao: WebGLVertexArrayObject;
  backdropVbo: WebGLBuffer;
  white: WebGLTexture;
  missing: WebGLTexture;
  coverage: { tex: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number } | null;
  textures: Map<string, WebGLTexture>;
}

export class GlRenderer {
  private state: GlState | null = null;
  private readonly packer = new FramePacker();
  /** Version of the uploaded texture set; -1 forces an upload (initially and after a context restore). */
  private textureVersion = -1;
  private lost = false;

  /** Throws when WebGL2 is unavailable. `onRestore` is called after a lost context came back (textures re-upload on the next render). */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onRestore: () => void,
  ) {
    canvas.addEventListener('webglcontextlost', this.handleLost);
    canvas.addEventListener('webglcontextrestored', this.handleRestored);
    this.init();
  }

  private handleLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
    this.state = null;
  };

  private handleRestored = (): void => {
    this.lost = false;
    this.init();
    this.textureVersion = -1;
    this.onRestore();
  };

  private init(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser (the viewport needs it).');
    const programs = createPrograms(gl);
    const vao = must(gl.createVertexArray(), 'vertex array');
    const vbo = must(gl.createBuffer(), 'buffer');
    const ibo = must(gl.createBuffer(), 'buffer');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    const backdropVao = must(gl.createVertexArray(), 'vertex array');
    const backdropVbo = must(gl.createBuffer(), 'buffer');
    gl.bindVertexArray(backdropVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, backdropVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);

    for (const p of [programs.mesh, programs.coverage]) {
      gl.useProgram(p.program);
      gl.uniform1i(p.uniforms.u_tex, 0);
    }
    gl.useProgram(programs.mesh.program);
    gl.uniform1i(programs.mesh.uniforms.u_mask, 1);

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    this.state = {
      gl,
      programs,
      vao,
      vbo,
      ibo,
      backdropVao,
      backdropVbo,
      white: solidTexture(gl, [255, 255, 255, 255]),
      missing: solidTexture(gl, [255, 0, 255, 255]),
      coverage: null,
      textures: new Map(),
    };
  }

  /** Replace the texture set when `version` changed (uploads premultiplied bitmaps with mipmaps). */
  setTextures(sources: ReadonlyMap<string, TextureSource>, version: number): void {
    const st = this.state;
    if (!st || version === this.textureVersion) return;
    this.textureVersion = version;
    const { gl } = st;
    for (const t of st.textures.values()) gl.deleteTexture(t);
    st.textures.clear();
    for (const [id, src] of sources) {
      const tex = must(gl.createTexture(), 'texture');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src.bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      st.textures.set(id, tex);
    }
  }

  render(input: RenderInput): RenderStats {
    const st = this.state;
    if (!st || this.lost) return { draws: 0, triangles: 0 };
    const { gl } = st;
    const width = Math.max(1, Math.round(input.viewport.width * input.dpr));
    const height = Math.max(1, Math.round(input.viewport.height * input.dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const view = clipTransform(input.camera, input.viewport);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    const workspace = input.colors.workspace;
    gl.clearColor(workspace[0], workspace[1], workspace[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!input.list) return { draws: 0, triangles: 0 };

    this.drawBackdrop(st, input, view);

    const frame = this.packer.pack(input.list.draws, input.hidden);
    gl.bindVertexArray(st.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, st.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, frame.vertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, st.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, frame.indices, gl.DYNAMIC_DRAW);

    const mesh = st.programs.mesh;
    gl.useProgram(mesh.program);
    gl.uniform4f(mesh.uniforms.u_view, view[0], view[1], view[2], view[3]);
    gl.enable(gl.BLEND);
    let coverageFor: DrawItem[] | null = null;
    let calls = 0;
    for (const { item, range } of frame.draws) {
      // An empty mask list means zero coverage: the packer already dropped non-inverted ones
      // ('skip'), and an inverted one is fully uncovered, i.e. drawn unmasked ('none').
      const mode = maskModeOf(item);
      if (mode === 'skip') continue;
      let maskMode = 0;
      if (item.masks && (mode === 'mask' || mode === 'invert')) {
        if (coverageFor !== item.masks) {
          this.renderCoverage(st, item.masks, frame.masks, view, width, height);
          coverageFor = item.masks;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(mesh.program);
        }
        maskMode = mode === 'invert' ? 2 : 1;
      }
      gl.uniform1i(mesh.uniforms.u_maskMode, maskMode);
      this.bindItemTexture(st, item, mesh);
      setBlend(gl, item.blend);
      if (range.count > 0) {
        gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.first * 4);
        calls++;
      }
    }
    gl.bindVertexArray(null);
    return { draws: calls, triangles: frame.triangles };
  }

  /** Canvas rectangle backdrop: checkerboard for transparency, then the chosen fill. */
  private drawBackdrop(st: GlState, input: RenderInput, view: [number, number, number, number]): void {
    const { gl } = st;
    const list = input.list!;
    const w = list.width;
    const h = list.height;
    gl.bindVertexArray(st.backdropVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, st.backdropVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, w, 0, w, h, 0, 0, w, h, 0, h]), gl.DYNAMIC_DRAW);
    const p = st.programs.backdrop;
    gl.useProgram(p.program);
    gl.uniform4f(p.uniforms.u_view, view[0], view[1], view[2], view[3]);
    const solid = (c: RGBA): void => {
      gl.uniform1i(p.uniforms.u_checker, 0);
      gl.uniform4f(p.uniforms.u_colorA, c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const mode = input.background;
    if (mode === 'dark' || mode === 'light') {
      gl.disable(gl.BLEND);
      solid(mode === 'dark' ? input.colors.darkBackdrop : input.colors.lightBackdrop);
      return;
    }
    gl.disable(gl.BLEND);
    gl.uniform1i(p.uniforms.u_checker, 1);
    gl.uniform4f(p.uniforms.u_colorA, ...input.colors.checkA);
    gl.uniform4f(p.uniforms.u_colorB, ...input.colors.checkB);
    gl.uniform1f(p.uniforms.u_cell, Math.max(1, Math.round(CHECKER_CELL_CSS * input.dpr)));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (mode === 'model' && list.background[3] > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      solid(list.background);
    }
  }

  private bindItemTexture(st: GlState, item: DrawItem, program: ProgramInfo): void {
    const { gl } = st;
    gl.activeTexture(gl.TEXTURE0);
    if (item.texture === undefined) {
      gl.bindTexture(gl.TEXTURE_2D, st.white);
      gl.uniform1i(program.uniforms.u_useTex, 0);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, st.textures.get(item.texture) ?? st.missing);
      gl.uniform1i(program.uniforms.u_useTex, 1);
    }
  }

  private renderCoverage(
    st: GlState,
    masks: readonly DrawItem[],
    ranges: ReadonlyMap<DrawItem, PackedRange>,
    view: [number, number, number, number],
    width: number,
    height: number,
  ): void {
    const { gl } = st;
    const cov = this.coverageTarget(st, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, cov.fbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const p = st.programs.coverage;
    gl.useProgram(p.program);
    gl.uniform4f(p.uniforms.u_view, view[0], view[1], view[2], view[3]);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const m of masks) {
      const range = ranges.get(m);
      if (!range || range.count === 0) continue;
      this.bindItemTexture(st, m, p);
      gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.first * 4);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, cov.tex);
    gl.activeTexture(gl.TEXTURE0);
  }

  private coverageTarget(st: GlState, width: number, height: number): NonNullable<GlState['coverage']> {
    const { gl } = st;
    if (st.coverage && st.coverage.width === width && st.coverage.height === height) return st.coverage;
    if (st.coverage) {
      gl.deleteFramebuffer(st.coverage.fbo);
      gl.deleteTexture(st.coverage.tex);
    }
    const tex = must(gl.createTexture(), 'texture');
    // Allocate on unit 1 (the mask unit) and leave it unbound until the coverage pass is complete.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    const fbo = must(gl.createFramebuffer(), 'framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    st.coverage = { tex, fbo, width, height };
    return st.coverage;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestored);
    const st = this.state;
    if (!st) return;
    const { gl } = st;
    for (const t of st.textures.values()) gl.deleteTexture(t);
    gl.deleteTexture(st.white);
    gl.deleteTexture(st.missing);
    if (st.coverage) {
      gl.deleteFramebuffer(st.coverage.fbo);
      gl.deleteTexture(st.coverage.tex);
    }
    gl.deleteBuffer(st.vbo);
    gl.deleteBuffer(st.ibo);
    gl.deleteBuffer(st.backdropVbo);
    gl.deleteVertexArray(st.vao);
    gl.deleteVertexArray(st.backdropVao);
    for (const p of Object.values(st.programs)) gl.deleteProgram(p.program);
    this.state = null;
  }
}

function setBlend(gl: WebGL2RenderingContext, mode: DrawItem['blend']): void {
  gl.blendEquation(gl.FUNC_ADD);
  switch (mode) {
    case 'add':
      gl.blendFunc(gl.ONE, gl.ONE);
      return;
    case 'multiply':
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      return;
    case 'screen':
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      return;
    default:
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}

function solidTexture(gl: WebGL2RenderingContext, rgba: [number, number, number, number]): WebGLTexture {
  const tex = must(gl.createTexture(), 'texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return tex;
}

function must<T>(v: T | null, what: string): T {
  if (v === null) throw new Error(`WebGL: cannot create ${what}`);
  return v;
}
