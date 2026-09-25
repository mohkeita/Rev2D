/** Read-only model commands: validate, info, inspect, analyze, hit. */
import { existsSync, globSync } from 'node:fs';
import type { Diagnostic } from '../../core/types.js';
import { formatDiagnostics } from '../../core/validate.js';
import { loadModelFile } from '../../node/load.js';
import {
  analyzeAnimation,
  formatAnalysis,
  formatInfo,
  hitTest,
  inspectPose,
  inspectSeries,
  modelInfo,
  parsePointSpec,
  parseTrackColumns,
  planSamples,
  trackSeries,
  TRACK_COLUMN_FORMS,
  type InspectResult,
  type TrackCell,
  type TrackResult,
} from '../../api/index.js';
import { UsageError } from '../args.js';
import type { Command } from '../command.js';
import type { Ctx } from '../context.js';
import { checkAnimations, idHint, parseTimesFlag, poseInput, sampledAnimation, usage } from '../flags.js';
import { num, pair, plural, rect, table, valueSummary } from '../text.js';

// ----------------------------------------------------------------------------- validate

const WILDCARD = /[*?[\]{}]/;

/**
 * Expand a wildcard argument ("models/*.r2d.json"): cmd.exe and PowerShell pass them to native
 * programs literally. Existing files are taken as-is. A pattern without matches stays as a
 * 'file-not-found' diagnostic instead of a path.
 */
function expandArgument(ctx: Ctx, arg: string): Array<string | Diagnostic> {
  if (!WILDCARD.test(arg) || existsSync(ctx.resolve(arg))) return [arg];
  const pattern = process.platform === 'win32' ? arg.replace(/\\/g, '/') : arg;
  const matches = globSync(pattern, { cwd: ctx.cwd }).sort();
  if (matches.length) return matches;
  return [{ severity: 'error', code: 'file-not-found', message: `no file matches "${arg}"`, path: '', hint: `patterns are relative to ${ctx.cwd}` }];
}

export const validate: Command = {
  name: 'validate',
  group: 'check',
  summary: 'check model files: schema, references, bindings, textures, rig compile',
  usage: 'validate <model...> [--strict] [--json]',
  args: ['<model...>'],
  flags: [{ name: 'strict', type: 'boolean', description: 'also fail (exit 1) on warnings' }],
  json: true,
  description: [
    'Every diagnostic has a severity, a stable code, a JSON pointer into the file and usually a hint (did-you-mean, expected shape).',
    'Wildcards ("models/*.r2d.json") are expanded by rev2d itself, so they also work in cmd.exe and PowerShell; a pattern that matches nothing is reported as a failed entry.',
    'Exit 1 when any file has errors (or warnings with --strict).',
  ],
  examples: ['rev2d validate hero.r2d.json', 'rev2d validate a.r2d.json b.r2d.json --strict', 'rev2d validate "models/*.r2d.json" --json'],
  async run(ctx) {
    const strict = ctx.args.bool('strict') === true;
    const reports = [];
    for (const arg of ctx.args.positionals) {
      for (const entry of expandArgument(ctx, arg)) {
        const shown = typeof entry === 'string' ? ctx.display(entry) : arg;
        const diagnostics = typeof entry === 'string' ? (await loadModelFile(ctx.resolve(entry))).diagnostics : [entry];
        const errors = diagnostics.filter((d) => d.severity === 'error').length;
        const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
        const ok = errors === 0 && (!strict || warnings === 0);
        reports.push({ file: ctx.resolve(typeof entry === 'string' ? entry : arg), ok, errors, warnings, diagnostics });
        if (ctx.json) continue;
        if (diagnostics.length === 0) ctx.out(`ok    ${shown}  (0 errors, 0 warnings)`);
        else ctx.out(`${ok ? 'ok  ' : 'FAIL'}  ${shown}`, ...formatDiagnostics(diagnostics).split('\n').map((l) => `  ${l}`));
      }
    }
    const failed = reports.filter((r) => !r.ok).length;
    if (ctx.json) ctx.printJson(reports);
    else if (reports.length > 1) ctx.out(`${plural(reports.length, 'file')}: ${reports.length - failed} ok, ${failed} failed`);
    return failed ? 1 : 0;
  },
};

// ----------------------------------------------------------------------------- info

export const info: Command = {
  name: 'info',
  group: 'check',
  summary: 'structure overview: parameters (what they drive), bone tree, warps, parts, bindings, animations',
  usage: 'info <model> [--json]',
  args: ['<model>'],
  flags: [],
  json: true,
  description: ['The first thing to read about an unfamiliar model. --json prints the ModelInfo object (see docs/CLI.md).'],
  examples: ['rev2d info hero.r2d.json', 'rev2d info hero.r2d.json --json'],
  async run(ctx) {
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const i = modelInfo(m.model);
    if (ctx.json) ctx.printJson(i);
    else ctx.out(formatInfo(i));
    return 0;
  },
};

// ----------------------------------------------------------------------------- inspect

function checkIds(requested: string[], available: string[], kind: string, flag: string): void {
  for (const id of requested) {
    if (!available.includes(id)) throw new UsageError(`unknown ${kind} "${id}" in ${flag}`, idHint(id, available, `${kind}s`));
  }
}

/**
 * Focus: with any of --bone/--part/--warp only the selected kinds (and their properties) remain;
 * params, drawOrder, events, ik, physics and points are always kept.
 */
function focusInspect(r: InspectResult, bones: string[], parts: string[], warps: string[]): Partial<InspectResult> {
  if (!bones.length && !parts.length && !warps.length) return r;
  const prefixes = [...bones.map((id) => `bone:${id}.`), ...parts.map((id) => `part:${id}.`), ...warps.map((id) => `warp:${id}.`)];
  const out: Partial<InspectResult> = {
    time: r.time,
    params: r.params,
    drawOrder: r.drawOrder,
    properties: Object.fromEntries(Object.entries(r.properties).filter(([k]) => prefixes.some((p) => k.startsWith(p)))),
    events: r.events,
    ik: r.ik,
    physics: r.physics,
    ...(r.points ? { points: r.points } : {}),
  };
  if (bones.length) out.bones = r.bones.filter((b) => bones.includes(b.id));
  if (parts.length) out.parts = r.parts.filter((p) => parts.includes(p.id));
  if (warps.length) out.warps = r.warps.filter((w) => warps.includes(w.id));
  return out;
}

export const inspect: Command = {
  name: 'inspect',
  group: 'check',
  summary: 'exact numbers for a pose (or a series of times): parameters, bones, parts, IK reach, physics outputs, mapped points, tracked columns',
  usage:
    'inspect <model> [pose flags] [--bone id]... [--part id]... [--warp id]... [--point x,y[@parent]]... [--times a:b:n|t1,t2,... | --frames n] [--track col,col,...] [--json]',
  args: ['<model>'],
  flags: [
    { name: 'bone', type: 'string', repeat: true, arg: 'id', description: 'only show these bones (repeatable, or comma-separated)' },
    { name: 'part', type: 'string', repeat: true, arg: 'id', description: 'only show these parts' },
    { name: 'warp', type: 'string', repeat: true, arg: 'id', description: 'only show these warps (deformed lattice points)' },
    { name: 'point', type: 'string', repeat: true, arg: 'x,y[@parent]', description: 'where a setup-space point ends up in the pose: attached to a bone, warp or part ("120,80@head"; a skinned part blends its bones like its own vertices; "part:id" etc. when ids are shared), or model space ("120,80"); repeatable' },
    { name: 'times', type: 'string', arg: 'a:b:n|t1,...', description: 'a series: one result per time (n evenly spaced from a to b, or a list); replaces --time' },
    { name: 'frames', type: 'int', min: 1, arg: 'n', description: 'a series of n frames over the first --anim (like sheet/gif sampling)' },
    { name: 'track', type: 'string', repeat: true, arg: 'cols', description: `compact table, one row per time; columns: ${TRACK_COLUMN_FORMS}` },
  ],
  flagGroups: ['pose'],
  json: true,
  description: [
    'Verify geometry without looking at pixels: bone joints/tips and part bounds are in canvas pixels (+y down, clockwise degrees). IK: extension = distance / max reach (>= 1 out of reach, > 0.98 risks visible snapping), error = px between chain tip and target. PHYSICS: raw output before clamping to the parameter range.',
    'With --bone/--part/--warp only the selected kinds are reported (other kinds are omitted, not empty) and properties are limited to them. --point maps setup-space points through the pose with exactly the deformation the vertices of a part attached there receive: a bone (rigid), a warp (lattice), or a part (a skinned part blends its skin bones with the weights the point would get as one of its vertices; a part with a parent maps like that parent). A bare id is looked up among bones and warps first, then parts; "bone:id", "warp:id" or "part:id" picks the kind.',
    'Series (--times, or --frames n with --anim): one result per time; ascending times play like a game loop (incremental physics; events = those since the previous time). --track prints only the chosen columns, one row per time (a single row at --time without a series).',
  ],
  examples: [
    'rev2d inspect hero.r2d.json',
    'rev2d inspect hero.r2d.json --param AngleX=30 --bone head --part mouth --json',
    'rev2d inspect hero.r2d.json --anim idle --time 0.5 --point 256,180@head',
    'rev2d inspect hero.r2d.json --param ArmBend=1 --point 150,300@part:sleeve',
    'rev2d inspect robot.r2d.json --anim reach --times 0:4:9 --track ik:armIk,bone:hand.tip,param:ReachX',
    'rev2d inspect hero.r2d.json --anim idle --frames 8 --track physics:hair.HairSway,part:tail.center --json',
  ],
  async run(ctx) {
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const model = m.model;
    const bones = ctx.args.csv('bone');
    const parts = ctx.args.csv('part');
    const warps = ctx.args.csv('warp');
    checkIds(bones, model.bones.map((b) => b.id), 'bone', '--bone');
    checkIds(parts, model.parts.map((p) => p.id), 'part', '--part');
    checkIds(warps, model.warps.map((w) => w.id), 'warp', '--warp');
    const points = ctx.args.list('point').map((p) => usage(() => parsePointSpec(model, p), '--point: '));
    const notes: string[] = [];
    const pose = poseInput(ctx.args, model, notes);
    const timesRaw = ctx.args.str('times');
    const frames = ctx.args.num('frames');
    if (timesRaw !== undefined && frames !== undefined) throw new UsageError('give --times or --frames, not both', '--times lists the times; --frames n spreads n frames over the first --anim');
    const series = timesRaw !== undefined || frames !== undefined;
    if (series && pose.time !== undefined) throw new UsageError('--time sets one time; a series (--times/--frames) sets them all', 'drop --time');
    if (frames !== undefined && !pose.animations?.length) throw new UsageError('--frames samples the first --anim, but no --anim is given', `e.g. --anim ${model.animations[0]?.id ?? 'idle'} --frames 8`);
    const seriesInput = { ...pose, ...(timesRaw !== undefined ? { times: parseTimesFlag(timesRaw) } : {}), ...(frames !== undefined ? { frames } : {}) };
    const trackCols = ctx.args.list('track');
    ctx.notes(notes);

    if (trackCols.length) {
      if (bones.length || parts.length || warps.length || points.length) {
        throw new UsageError('--track prints only its columns; --bone/--part/--warp/--point do not apply', 'add them as columns instead, e.g. --track bone:head,part:mouth.center,point:120,80@head');
      }
      const columns = usage(() => parseTrackColumns(trackCols));
      const input = series ? seriesInput : { ...pose, time: undefined, times: [pose.time ?? 0] };
      const t = usage(() => trackSeries(m, { ...input, columns }), '--track: ');
      if (ctx.json) {
        ctx.printJson(t);
        return 0;
      }
      printTrack(ctx, t);
      return 0;
    }
    if (series) {
      const s = inspectSeries(m, { ...seriesInput, ...(points.length ? { points } : {}) });
      const results = s.results.map((r) => focusInspect(r, bones, parts, warps));
      if (ctx.json) {
        ctx.printJson({ times: s.times, results });
        return 0;
      }
      results.forEach((r, i) => {
        if (i) ctx.out('');
        ctx.out(`=== t=${num(s.times[i])}s (${i + 1} of ${s.times.length}) ===`);
        printInspect(ctx, r, model.parameters);
      });
      return 0;
    }
    const r = focusInspect(inspectPose(m, { ...pose, ...(points.length ? { points } : {}) }), bones, parts, warps);
    if (ctx.json) {
      ctx.printJson(r);
      return 0;
    }
    printInspect(ctx, r, model.parameters);
    return 0;
  },
};

function cellText(v: TrackCell): string {
  if (v === null) return '-';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string') return valueSummary(v);
  return v.length <= 4 ? v.map((x) => num(x, 2)).join(', ') : valueSummary(v);
}

function printTrack(ctx: Ctx, t: TrackResult): void {
  const header = ['t', ...t.columns.map((c) => (t.fields[c] ? `${c} (${t.fields[c].join(', ')})` : c))];
  ctx.out(...table([header, ...t.rows.map((row, i) => [num(t.times[i]), ...row.map(cellText)])], ''));
}

function printInspect(ctx: Ctx, r: Partial<InspectResult>, parameters: Array<{ id: string; min: number; max: number }>): void {
  const lines: string[] = [`pose at t=${num(r.time ?? 0)}s`];
  if (parameters.length) {
    lines.push('', 'PARAMETERS');
    lines.push(...table([['id', 'value', 'range'], ...parameters.map((p) => [p.id, num(r.params?.[p.id] ?? 0), `[${num(p.min)}..${num(p.max)}]`])]));
  }
  if (r.bones?.length) {
    lines.push('', 'BONES (world: joint x,y  rotation  scale  tip; local after bindings/IK)');
    lines.push(
      ...table([
        ['id', 'parent', 'x', 'y', 'rot', 'scale', 'tip', 'local x,y rot'],
        ...r.bones.map((b) => [
          b.id,
          b.parent ?? '-',
          num(b.x, 2),
          num(b.y, 2),
          `${num(b.rotation, 2)}°`,
          `${num(b.scaleX)},${num(b.scaleY)}`,
          pair(b.tip, 2),
          `${num(b.local.x, 2)},${num(b.local.y, 2)} ${num(b.local.rotation, 2)}°`,
        ]),
      ]),
    );
  }
  if (r.parts?.length) {
    lines.push('', 'PARTS (bounds [x, y, w, h] in canvas px)');
    lines.push(
      ...table([
        ['id', 'visible', 'opacity', 'z', 'bounds', 'center'],
        ...r.parts.map((p) => [p.id, p.visible ? 'yes' : 'no', num(p.opacity), num(p.z), rect(p.bounds), pair(p.center)]),
      ]),
    );
  }
  if (r.warps?.length) {
    lines.push('', 'WARPS (deformed lattice points, row-major)');
    for (const w of r.warps) {
      lines.push(`  ${w.id} ${w.cols}x${w.rows}`);
      for (let row = 0; row <= w.rows; row++) {
        const pts = w.points.slice(row * (w.cols + 1), (row + 1) * (w.cols + 1));
        lines.push(`    row ${row}: ${pts.map((p) => pair(p)).join(' ')}`);
      }
    }
  }
  if (r.ik?.length) {
    lines.push(
      '',
      'IK (extension = distance / max reach: >= 1 out of reach, > 0.98 snap risk; error = tip-to-target px;',
      '    reached: yes | NO (target out of reach) | soft (within reach; softness lets the tip trail) | aim (one bone: points at the target))',
    );
    lines.push(
      ...table([
        ['id', 'bones', 'reached', 'extension', 'error', 'distance', 'maxReach', 'bend', 'stretch'],
        ...r.ik.map((k) => [
          k.id,
          k.bones.join('>'),
          k.reached ? 'yes' : k.bones.length === 1 && k.stretch === undefined ? 'aim' : k.extension <= 1 ? 'soft' : 'NO',
          `${num(k.extension)}${k.extension > 0.98 && k.bones.length === 2 ? ' !' : ''}`,
          num(k.error, 2),
          num(k.distance, 2),
          num(k.maxReach, 2),
          k.bend !== undefined ? `${num(k.bend, 1)}°` : '-',
          k.stretch !== undefined ? num(k.stretch) : '-',
        ]),
      ]),
    );
  }
  if (r.physics?.length) {
    lines.push('', 'PHYSICS (raw output before clamping; value = written to the parameter)');
    const rows = r.physics.flatMap((g) =>
      g.outputs.map((o) => [g.id, o.param, num(o.raw), num(o.value), o.clamped ? 'CLAMPED' : '-', o.overridden ? 'explicit value wins' : '-']),
    );
    lines.push(...table([['group', 'param', 'raw', 'value', 'clamped', 'overridden'], ...rows]));
  }
  if (r.points?.length) {
    lines.push('', 'POINTS (setup-space point -> posed position)');
    lines.push(...table(r.points.map((p) => [p.spec, `${pair(p.setup, 2)} -> ${pair(p.posed, 2)}`])));
  }
  lines.push('', `DRAW ORDER (back to front): ${r.drawOrder?.length ? r.drawOrder.join(', ') : '(nothing visible)'}`);
  const props = Object.entries(r.properties ?? {});
  if (props.length) {
    lines.push('', 'BOUND / ANIMATED PROPERTIES');
    lines.push(...table(props.map(([k, v]) => [k, valueSummary(v)])));
  }
  if (r.events?.length) {
    lines.push('', 'EVENTS');
    for (const e of r.events) lines.push(`  ${e.animation}@${num(e.t)}s ${e.name}${e.data !== undefined ? ` ${JSON.stringify(e.data)}` : ''}`);
  }
  ctx.out(...lines);
}

// ----------------------------------------------------------------------------- analyze

export const analyze: Command = {
  name: 'analyze',
  group: 'check',
  summary: 'sample an animation and report parameter ranges, physics clamping, IK reach, events, the loop seam and parts leaving the canvas',
  usage: 'analyze <model> --anim <id> [--anim layer]... [--frames n | --fps f] [--warmup s] [--no-pixels] [pose flags] [--json]',
  args: ['<model>'],
  flags: [
    { name: 'frames', type: 'int', min: 1, arg: 'n', description: 'exact frame count over the animation (default: 60 fps of animation time)' },
    { name: 'fps', type: 'number', greaterThan: 0, arg: 'n', description: 'sampling rate in frames per second of animation time (default 60: physics runs at 60 Hz)' },
    { name: 'warmup', type: 'number', min: 0, arg: 'seconds', description: 'looping animations: run whole cycles for at least this long first, so physics is analyzed in its steady state' },
    { name: 'pixels', type: 'boolean', description: 'loop seam: also compare the rendered first frame with the frame one loop later (default on; --no-pixels skips it)' },
  ],
  flagGroups: ['sequencePose'],
  json: true,
  description: [
    'The first --anim is sampled densely (default 60 fps) with incremental physics; more --anim flags play as layers on top ("talk@0.8,add"). Reports: per-parameter min..max (and whether the range ends are reached), per physics output the share of frames clamped and the peak raw value vs the range, per IK constraint the max extension, frames out of reach / nearly straight and the max error, events with their times, and parts leaving the canvas.',
    'Looping animations also get a loop seam check: parameter values and bone world transforms at the end of the loop (extrapolated to t = duration from the last two 1/60 s steps) are compared with t = 0, and the rendered first frame with the frame one loop later (physics keeps running). With physics, use --warmup (e.g. 10) so the seam and clamping are measured in the steady state instead of from rest.',
  ],
  examples: [
    'rev2d analyze hero.r2d.json --anim idle',
    'rev2d analyze hero.r2d.json --anim look_around --anim talk,add --warmup 10',
    'rev2d analyze robot.r2d.json --anim reach --fps 120 --json',
  ],
  async run(ctx) {
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const model = m.model;
    const anims = checkAnimations(ctx.args.list('anim'), model);
    if (!anims.length) {
      throw new UsageError('missing --anim <id>', `e.g. rev2d analyze model.r2d.json --anim ${model.animations[0]?.id ?? 'idle'}${model.animations.length ? ` (animations: ${model.animations.map((a) => a.id).join(', ')})` : ''}`);
    }
    if (ctx.args.has('time')) throw new UsageError('--time does not apply to analyze (it samples the whole animation)', 'use --frames or --fps for the sampling density, --warmup to skip the physics settling');
    if (ctx.args.has('frames') && ctx.args.has('fps')) throw new UsageError('give --frames or --fps, not both');
    const animation = sampledAnimation(anims[0], model, false);
    const notes: string[] = [];
    const pose = poseInput(ctx.args, model, notes);
    const input = {
      ...pose,
      animation,
      animations: anims.slice(1),
      ...(ctx.args.num('frames') !== undefined ? { frames: ctx.args.num('frames') } : {}),
      ...(ctx.args.num('fps') !== undefined ? { fps: ctx.args.num('fps') } : {}),
      ...(ctx.args.num('warmup') !== undefined ? { warmup: ctx.args.num('warmup') } : {}),
      pixels: ctx.args.bool('pixels') !== false,
    };
    usage(() => planSamples(model, input));
    const r = analyzeAnimation(m, input);
    r.notes.unshift(...notes);
    if (ctx.json) {
      ctx.printJson(r);
      return 0;
    }
    ctx.out(formatAnalysis(r));
    return 0;
  },
};

// ----------------------------------------------------------------------------- hit

function coordinate(raw: string, axis: string): number {
  const v = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(v)) throw new UsageError(`${axis} must be a number, got "${raw}"`, 'coordinates are canvas pixels, e.g. rev2d hit model.r2d.json 256 200');
  return v;
}

export const hit: Command = {
  name: 'hit',
  group: 'check',
  summary: 'which parts cover a canvas point (top-most first)',
  usage: 'hit <model> <x> <y> [pose flags] [--json]',
  args: ['<model>', '<x>', '<y>'],
  flags: [],
  flagGroups: ['pose'],
  json: true,
  description: ['Tests the deformed triangles of visible parts at canvas pixel (x, y). Masks and texture alpha are ignored.'],
  examples: ['rev2d hit hero.r2d.json 256 180', 'rev2d hit hero.r2d.json 256 180 --param AngleX=30 --json'],
  async run(ctx) {
    const [file, rx, ry] = ctx.args.positionals;
    const x = coordinate(rx, 'x');
    const y = coordinate(ry, 'y');
    const m = await ctx.loadRig(file);
    const notes: string[] = [];
    const hits = hitTest(m, { ...poseInput(ctx.args, m.model, notes), x, y });
    ctx.notes(notes);
    if (ctx.json) {
      ctx.printJson({ x, y, hits });
      return 0;
    }
    if (!hits.length) {
      ctx.out(`no part at (${num(x)}, ${num(y)})`);
      return 0;
    }
    ctx.out(`parts at (${num(x)}, ${num(y)}), top-most first:`, ...hits.map((h, i) => `  ${i + 1}. ${h.partId} (${h.kind})`));
    return 0;
  },
};
