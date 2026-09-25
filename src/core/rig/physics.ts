/**
 * Pendulum physics (SPEC §8): fixed 60 Hz Verlet chains hanging from a pivot driven by parameters.
 * Step k happens at time k/60. A simulation starts at rest at some step (0, or the start of the 60 s
 * window before the frame) and each step re-evaluates the input parameters at the step time.
 * Explicit parameter values are re-applied after every output write, so they always win.
 */
import { DEG } from '../math.js';
import type { PhysicsPose } from '../types.js';
import type { CompiledPhysics, CompiledRig } from './compiled.js';
import { applyOverrides, evaluateParams, type FrameInputs } from './sampling.js';

export const PHYSICS_HZ = 60;
const DT = 1 / PHYSICS_HZ;
/** Longest stretch simulated for one frame: 60 s. Older inputs are forgotten (the chain restarts at rest). */
export const PHYSICS_WINDOW_STEPS = 60 * PHYSICS_HZ;

/**
 * Number of physics steps completed at time `t` (a small epsilon absorbs float error in t·60). Always
 * finite: t·60 overflowing to Infinity saturates at Number.MAX_VALUE.
 */
export function stepIndex(t: number): number {
  return Math.min(Number.MAX_VALUE, Math.max(0, Math.floor(t * PHYSICS_HZ + 1e-9)));
}

/**
 * Physics state at the frame's step. `state` (a Player's) is advanced incrementally; without one, or when
 * the frame lies before it or more than PHYSICS_WINDOW_STEPS after it, a fresh rest state is created at
 * step max(0, n - PHYSICS_WINDOW_STEPS) and simulated up to the frame's step n. So a stateless pose costs
 * at most 3600 steps whatever its time, and a Player that jumps far ahead matches the stateless pose.
 */
export function physicsAt(c: CompiledRig, state: PhysicsState | null, inputs: FrameInputs): PhysicsState {
  const target = stepIndex(inputs.time);
  if (!state || target < state.step || target - state.step > PHYSICS_WINDOW_STEPS) {
    state = createPhysicsState(c, inputs, Math.max(0, target - PHYSICS_WINDOW_STEPS));
  }
  advancePhysics(c, state, inputs, target);
  return state;
}

interface ChainState {
  /** Particle positions [pivot, p1, ..., pn] as x,y pairs. */
  pos: Float64Array;
  /** Previous positions (Verlet). */
  prev: Float64Array;
  /** Pivot angle in degrees (sum of angle inputs). */
  angle: number;
}

export interface PhysicsState {
  /** Last completed step. */
  step: number;
  chains: ChainState[];
}

/**
 * Rest state at `step`: every chain hangs straight along its rest direction from the pivot given by the
 * inputs at that step's time.
 */
function createPhysicsState(c: CompiledRig, inputs: FrameInputs, step: number): PhysicsState {
  const params = new Float64Array(c.params.ids.length);
  evaluateParams(c, inputs, step / PHYSICS_HZ, params, null);
  const chains = c.physics.map((g) => {
    const n = g.lengths.length;
    const chain: ChainState = { pos: new Float64Array((n + 1) * 2), prev: new Float64Array((n + 1) * 2), angle: 0 };
    const [px, py, angle] = pivot(g, params);
    chain.angle = angle;
    const rx = -Math.sin(angle * DEG);
    const ry = Math.cos(angle * DEG);
    let along = 0;
    for (let i = 0; i <= n; i++) {
      if (i > 0) along += g.lengths[i - 1];
      chain.pos[i * 2] = px + rx * along;
      chain.pos[i * 2 + 1] = py + ry * along;
    }
    chain.prev.set(chain.pos);
    // Later groups may read this group's outputs as inputs (explicit values still win).
    writeGroupOutputs(c, g, chain, params);
    applyOverrides(inputs, params);
    return chain;
  });
  return { step, chains };
}

/**
 * Simulate steps state.step+1 .. target (no-op when already there); physicsAt keeps the gap within
 * PHYSICS_WINDOW_STEPS. The loop counts steps instead of comparing k with target: beyond 2^53 steps
 * (|time| > ~1.5e14 s) k + 1 === k, and float rounding of the window start may overshoot the gap, so
 * the count is bounded too. At such magnitudes step times repeat, but evaluation stays finite.
 */
function advancePhysics(c: CompiledRig, state: PhysicsState, inputs: FrameInputs, target: number): void {
  if (!(target > state.step)) return;
  const count = Math.min(target - state.step, PHYSICS_WINDOW_STEPS);
  const params = new Float64Array(c.params.ids.length);
  for (let i = 1; i <= count; i++) {
    evaluateParams(c, inputs, (state.step + i) / PHYSICS_HZ, params, null);
    c.physics.forEach((g, gi) => {
      stepChain(g, state.chains[gi], params);
      writeGroupOutputs(c, g, state.chains[gi], params);
      applyOverrides(inputs, params);
    });
  }
  state.step = target;
}

/**
 * Overwrite every physics output parameter from the current state (groups in array order), then
 * re-apply the explicit parameter values, which always win. Returns the per-group diagnostics
 * (raw = output before clamping, value = what the parameter ends up with from this output).
 */
export function writePhysicsOutputs(
  c: CompiledRig,
  state: PhysicsState,
  inputs: FrameInputs,
  params: Float64Array,
): Record<string, PhysicsPose> {
  const raws = c.physics.map((g, gi) => writeGroupOutputs(c, g, state.chains[gi], params));
  applyOverrides(inputs, params);
  const explicit = new Map(inputs.overrides);
  const out: Record<string, PhysicsPose> = {};
  c.physics.forEach((g, gi) => {
    out[g.id] = {
      outputs: g.outputs.map((o, k) => {
        const raw = raws[gi][k];
        const lo = c.params.min[o.param];
        const hi = c.params.max[o.param];
        const given = explicit.get(o.param);
        return {
          param: c.params.ids[o.param],
          raw,
          value: given ?? (raw < lo ? lo : raw > hi ? hi : raw),
          clamped: raw < lo || raw > hi,
          overridden: given !== undefined,
        };
      }),
    };
  });
  return out;
}

/** Pivot position (Σ x / y inputs) and angle (Σ angle inputs), each input scaled by its weight. */
function pivot(g: CompiledPhysics, params: Float64Array): [number, number, number] {
  let x = 0;
  let y = 0;
  let angle = 0;
  for (const inp of g.inputs) {
    const v = params[inp.param] * inp.weight;
    if (inp.type === 'x') x += v;
    else if (inp.type === 'y') y += v;
    else angle += v;
  }
  return [x, y, angle];
}

function stepChain(g: CompiledPhysics, s: ChainState, params: Float64Array): void {
  const [px, py, angle] = pivot(g, params);
  s.angle = angle;
  const rx = -Math.sin(angle * DEG);
  const ry = Math.cos(angle * DEG);
  const { pos, prev } = s;
  const n = g.lengths.length;
  pos[0] = prev[0] = px;
  pos[1] = prev[1] = py;
  const keep = 1 - g.damping;
  const dt2 = DT * DT;
  // Verlet integration; the spring pulls each particle toward its rest position on the straight chain.
  let along = 0;
  for (let i = 1; i <= n; i++) {
    along += g.lengths[i - 1];
    const x = pos[i * 2];
    const y = pos[i * 2 + 1];
    let ax = 0;
    let ay = g.gravity;
    if (g.stiffness !== 0) {
      const k = g.stiffness / g.masses[i - 1];
      ax += k * (px + rx * along - x);
      ay += k * (py + ry * along - y);
    }
    pos[i * 2] = x + (x - prev[i * 2]) * keep + ax * dt2;
    pos[i * 2 + 1] = y + (y - prev[i * 2 + 1]) * keep + ay * dt2;
    prev[i * 2] = x;
    prev[i * 2 + 1] = y;
  }
  // Fixed segment lengths, from the pivot outward.
  for (let i = 1; i <= n; i++) {
    let dx = pos[i * 2] - pos[i * 2 - 2];
    let dy = pos[i * 2 + 1] - pos[i * 2 - 1];
    let len = Math.hypot(dx, dy);
    if (len < 1e-12) {
      dx = rx;
      dy = ry;
      len = 1;
    }
    const f = g.lengths[i - 1] / len;
    pos[i * 2] = pos[i * 2 - 2] + dx * f;
    pos[i * 2 + 1] = pos[i * 2 - 1] + dy * f;
  }
}

/** Write a group's outputs (clamped) into `params`; returns the unclamped values (value · scale). */
function writeGroupOutputs(c: CompiledRig, g: CompiledPhysics, s: ChainState, params: Float64Array): number[] {
  const { pos } = s;
  const raws: number[] = [];
  const rx = -Math.sin(s.angle * DEG);
  const ry = Math.cos(s.angle * DEG);
  for (const out of g.outputs) {
    const a = out.segment * 2;
    const b = a + 2;
    let value: number;
    if (out.type === 'angle') {
      // Signed angle from the rest direction to the segment; positive = clockwise on screen (y down).
      const sx = pos[b] - pos[a];
      const sy = pos[b + 1] - pos[a + 1];
      value = Math.atan2(rx * sy - ry * sx, rx * sx + ry * sy) / DEG;
    } else {
      let along = 0;
      for (let i = 0; i <= out.segment; i++) along += g.lengths[i];
      value = out.type === 'x' ? pos[b] - (pos[0] + rx * along) : pos[b + 1] - (pos[1] + ry * along);
    }
    const v = value * out.scale || 0; // report 0 rather than -0 (atan2(-0, x))
    const lo = c.params.min[out.param];
    const hi = c.params.max[out.param];
    params[out.param] = v < lo ? lo : v > hi ? hi : v;
    raws.push(v);
  }
  return raws;
}
