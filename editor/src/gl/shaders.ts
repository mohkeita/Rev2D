/**
 * GLSL ES 3.00 programs of the viewport renderer. All colors are PREMULTIPLIED from the vertex stage
 * on; textures are uploaded premultiplied, so every blend mode is a plain premultiplied blend.
 */

/** Interleaved vertex: x, y (model space), r, g, b, a (straight, 0..1), u, v. */
export const FLOATS_PER_VERTEX = 8;

const MESH_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_color;
layout(location = 2) in vec2 a_uv;
// clip = model * u_view.xy + u_view.zw
uniform vec4 u_view;
out vec4 v_color;
out vec2 v_uv;
void main() {
  vec4 c = clamp(a_color, 0.0, 1.0);
  v_color = vec4(c.rgb * c.a, c.a);
  v_uv = a_uv;
  gl_Position = vec4(a_pos * u_view.xy + u_view.zw, 0.0, 1.0);
}
`;

/** Draw items: vertex color x texture, optionally clipped by the mask coverage texture. */
const MESH_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform bool u_useTex;
// 0 = no mask, 1 = inside the mask coverage, 2 = outside (maskInvert)
uniform int u_maskMode;
out vec4 outColor;
void main() {
  vec4 c = v_color;
  if (u_useTex) c *= texture(u_tex, v_uv);
  if (u_maskMode != 0) {
    float k = texelFetch(u_mask, ivec2(gl_FragCoord.xy), 0).r;
    c *= (u_maskMode == 2) ? 1.0 - k : k;
  }
  outColor = c;
}
`;

/**
 * Mask coverage pass: writes alpha coverage (vertex alpha x texel alpha) into an R8 target with
 * blendFunc(ONE, ONE_MINUS_SRC_ALPHA), i.e. the union c = c + a - c * a (same as the software renderer).
 */
const COVERAGE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform bool u_useTex;
out vec4 outColor;
void main() {
  float a = v_color.a;
  if (u_useTex) a *= texture(u_tex, v_uv).a;
  outColor = vec4(a, 0.0, 0.0, a);
}
`;

const BACKDROP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform vec4 u_view;
void main() {
  gl_Position = vec4(a_pos * u_view.xy + u_view.zw, 0.0, 1.0);
}
`;

/** Canvas backdrop: solid premultiplied color, or a screen-aligned checkerboard. */
const BACKDROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform bool u_checker;
uniform vec4 u_colorA;
uniform vec4 u_colorB;
uniform float u_cell;
out vec4 outColor;
void main() {
  if (u_checker) {
    ivec2 cell = ivec2(floor(gl_FragCoord.xy / u_cell));
    outColor = ((cell.x + cell.y) & 1) == 0 ? u_colorA : u_colorB;
  } else {
    outColor = u_colorA;
  }
}
`;

export interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`WebGL: cannot create ${label} shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL: ${label} shader failed to compile: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, label: string, uniforms: string[]): ProgramInfo {
  const program = gl.createProgram();
  if (!program) throw new Error(`WebGL: cannot create ${label} program`);
  const v = compile(gl, gl.VERTEX_SHADER, vs, `${label} vertex`);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs, `${label} fragment`);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`WebGL: ${label} program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return { program, uniforms: Object.fromEntries(uniforms.map((u) => [u, gl.getUniformLocation(program, u)])) };
}

export function createPrograms(gl: WebGL2RenderingContext): { mesh: ProgramInfo; coverage: ProgramInfo; backdrop: ProgramInfo } {
  return {
    mesh: link(gl, MESH_VERTEX, MESH_FRAGMENT, 'mesh', ['u_view', 'u_tex', 'u_mask', 'u_useTex', 'u_maskMode']),
    coverage: link(gl, MESH_VERTEX, COVERAGE_FRAGMENT, 'coverage', ['u_view', 'u_tex', 'u_useTex']),
    backdrop: link(gl, BACKDROP_VERTEX, BACKDROP_FRAGMENT, 'backdrop', ['u_view', 'u_checker', 'u_colorA', 'u_colorB', 'u_cell']),
  };
}
