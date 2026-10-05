/**
 * model3.json: import a Live2D model's motions, expressions, physics and display info into an existing
 * Rev2D model as edit ops, and export a Rev2D model's animations, physics and display info as Live2D
 * JSON files plus a partial model3.json listing them.
 *
 * The .moc3 model binary is proprietary and undocumented: it is never read or written. An import keeps
 * the Rev2D model's geometry, deformers and bindings; an export must be merged into the model3.json of
 * a real Live2D model (which provides the .moc3 and the textures).
 */
import { formatModelJson } from '../../core/format.js';
import { suggest } from '../../core/address.js';
import type { Model } from '../../core/types.js';
import type { Op } from '../../ops/index.js';
import type { InteropReport, Live2dExportOptions, Live2dImportOptions, OutputFile } from '../types.js';
import { exportCdi3, importCdi3 } from './cdi3.js';
import { importExp3 } from './exp3.js';
import { exportMotion3, importMotion3 } from './motion3.js';
import { checkStandardRange, STANDARD_PARAM_MAP, toLive2dId } from './params.js';
import { exportPhysics3, importPhysics3 } from './physics3.js';
import { arrayOf, finite, fmt, IMPORTED_MODEL3_MOTION, isObject, type Json, modelInfo, parseJsonInput, q, replacedAnimationIssue, Reporter, sanitizeId, uniqueId } from './util.js';

export interface Model3ImportOptions extends Live2dImportOptions {
  model: Record<string, unknown>;
  /**
   * What to do with the imported physics: "replace" (default) removes the model's physics groups that
   * drive the same parameters as an imported group, "merge" keeps them (later groups win), "skip" does
   * not import physics.
   */
  physics?: 'replace' | 'merge' | 'skip';
  /**
   * Display info (cdi3): "fill" (default) sets parameter descriptions / groups the model lacks,
   * "overwrite" replaces them, "skip" ignores the file.
   */
  displayInfo?: 'fill' | 'overwrite' | 'skip';
  /** Import motions (default true). */
  motions?: boolean;
  /** Import expressions (default true). */
  expressions?: boolean;
}

function stem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(motion3|exp3|physics3|cdi3|model3)\.json$/i, '').replace(/\.json$/i, '');
}

export function importModel3(model3: string | Json, readFile: (relativePath: string) => string | undefined, opts: Model3ImportOptions): { ops: Op[]; report: InteropReport } {
  const r = new Reporter();
  const doc = parseJsonInput(model3, 'model3.json');
  if (!isObject(opts.model)) throw new Error('importLive2dModel3: opts.model (the Rev2D model to import into) is required');
  const info = modelInfo(opts.model)!;
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const checked = new Set<string>();
  if (doc.Version !== 3) r.warn('live2d-version', `Version is ${JSON.stringify(doc.Version)}, expected 3`, 'Version');
  const refs: Json = isObject(doc.FileReferences) ? doc.FileReferences : {};
  if (!isObject(doc.FileReferences)) r.warn('live2d-model3-invalid', 'FileReferences is missing: nothing to import', 'FileReferences');

  const read = (path: string, where: string): string | undefined => {
    let text: string | undefined;
    try {
      text = readFile(path);
    } catch (e) {
      r.warn('live2d-file-missing', `cannot read ${q(path)} (${e instanceof Error ? e.message : String(e)}): skipped`, where);
      return undefined;
    }
    if (text === undefined) r.warn('live2d-file-missing', `file ${q(path)} not found: skipped`, where);
    return text;
  };
  const guarded = <T>(what: string, where: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      r.warn('live2d-file-invalid', `${what}: ${e instanceof Error ? e.message : String(e)}: skipped`, where);
      return undefined;
    }
  };

  // ---- ignored references
  if (typeof refs.Moc === 'string') {
    r.info(
      'live2d-moc-ignored',
      `the model binary ${q(refs.Moc)} is not read (the .moc3 format is proprietary and undocumented)`,
      'FileReferences.Moc',
      'geometry, deformers and bindings stay those of the Rev2D model; motions and physics drive its parameters by id',
    );
  }
  if (Array.isArray(refs.Textures) && refs.Textures.length) r.info('live2d-textures-ignored', `${refs.Textures.length} texture(s) not imported (they belong to the .moc3 meshes)`, 'FileReferences.Textures');
  if (typeof refs.Pose === 'string') r.info('live2d-pose-ignored', `pose file ${q(refs.Pose)} (part switching groups) is not imported`, 'FileReferences.Pose', 'animate part opacity to switch parts');
  if (typeof refs.UserData === 'string') r.info('live2d-userdata-ignored', `art mesh user data ${q(refs.UserData)} is not imported`, 'FileReferences.UserData');
  if (typeof refs.MotionSync === 'string') r.info('live2d-motionsync-ignored', `motion-sync settings ${q(refs.MotionSync)} are not imported`, 'FileReferences.MotionSync');
  if (Array.isArray(doc.HitAreas) && doc.HitAreas.length) r.info('live2d-hitareas-ignored', `${doc.HitAreas.length} hit area(s) are not imported (use rev2d hit / Rig.mapPoint for hit tests)`, 'HitAreas');
  if (isObject(doc.Layout)) r.info('live2d-layout-ignored', 'Layout is not imported (Rev2D canvases use meta.width / height)', 'Layout');

  // ---- groups (EyeBlink / LipSync)
  const groups: Record<string, string[]> = {};
  arrayOf(doc.Groups).forEach((g, i) => {
    if (!isObject(g) || typeof g.Name !== 'string' || !Array.isArray(g.Ids)) {
      r.warn('live2d-model3-invalid', 'group needs a Name and an Ids array: skipped', `Groups[${i}]`);
      return;
    }
    groups[g.Name] = g.Ids.filter((x): x is string => typeof x === 'string');
    if (g.Name === 'EyeBlink' || g.Name === 'LipSync') {
      r.info(
        'live2d-group',
        `${g.Name} group (${groups[g.Name].length ? groups[g.Name].join(', ') : 'no parameters'}): used to apply the motions' Model ${g.Name} curves; automatic ${g.Name === 'EyeBlink' ? 'blinking' : 'lip sync'} of Cubism apps is not reproduced`,
        `Groups[${i}]`,
        g.Name === 'EyeBlink' ? 'layer a blink animation (e.g. hana\'s "blink") at the times you need' : 'animate the mouth parameter from audio yourself',
      );
    } else {
      r.info('live2d-group-ignored', `group ${q(g.Name)} is not used`, `Groups[${i}]`);
    }
  });

  const ops: Op[] = [];

  // ---- display info
  const displayMode = opts.displayInfo ?? 'fill';
  if (typeof refs.DisplayInfo === 'string' && displayMode !== 'skip') {
    const path = refs.DisplayInfo;
    const text = read(path, 'FileReferences.DisplayInfo');
    const res = text === undefined ? undefined : guarded('display info', path, () => importCdi3(text, { paramMap: map, model: opts.model }));
    if (res) {
      r.merge(res.report, path);
      let kept = 0;
      for (const p of res.parameters) {
        const cur = info.params.get(p.id);
        if (!cur) continue;
        const set: Record<string, unknown> = {};
        if (p.name !== undefined && p.name !== cur.description) {
          if (cur.description === undefined || displayMode === 'overwrite') set.description = p.name;
          else kept++;
        }
        if (p.group !== undefined && p.group !== cur.group) {
          if (cur.group === undefined || displayMode === 'overwrite') set.group = p.group;
          else kept++;
        }
        if (Object.keys(set).length) ops.push({ op: 'update', kind: 'parameter', id: p.id, set });
      }
      if (kept) {
        r.info('live2d-cdi-kept', `${kept} existing parameter description(s) / group(s) kept (displayInfo "fill"; use "overwrite" to replace them)`, path);
      }
      let partNames = 0;
      for (const part of res.parts) {
        const cur = info.parts.get(part.id);
        if (!cur || part.name === cur.description) continue;
        if (cur.description === undefined || displayMode === 'overwrite') {
          ops.push({ op: 'update', kind: 'part', id: part.id, set: { description: part.name } });
          partNames++;
        }
      }
      if (partNames) r.count('partDescriptions', partNames);
    }
  } else if (typeof refs.DisplayInfo === 'string') {
    r.info('live2d-skipped', 'display info skipped (displayInfo "skip")', 'FileReferences.DisplayInfo');
  }

  // ---- physics
  const physicsMode = opts.physics ?? 'replace';
  if (typeof refs.Physics === 'string' && physicsMode !== 'skip') {
    const path = refs.Physics;
    const text = read(path, 'FileReferences.Physics');
    const res = text === undefined ? undefined : guarded('physics', path, () => importPhysics3(text, { paramMap: map, model: opts.model }));
    if (res) {
      r.merge(res.report, path);
      const importedOutputs = new Set(res.physics.flatMap((g) => arrayOf(g.outputs).map((o) => (o as Json).param as string)));
      const importedIds = new Set(res.physics.map((g) => g.id as string));
      const removed: string[] = [];
      const conflicts: string[] = [];
      for (const g of info.physics) {
        const overlap = g.outputs.some((o) => importedOutputs.has(o));
        if (importedIds.has(g.id) || (overlap && physicsMode === 'replace')) {
          ops.push({ op: 'remove', kind: 'physics', id: g.id });
          removed.push(g.id);
        } else if (overlap) conflicts.push(g.id);
      }
      if (removed.length) {
        r.warn('live2d-physics-replaced', `existing physics group(s) ${removed.join(', ')} removed: the imported physics drives the same parameters (physics "replace")`, path, 'use physics "merge" to keep them');
      }
      if (conflicts.length) {
        r.warn('live2d-physics-conflict', `existing physics group(s) ${conflicts.join(', ')} drive the same parameters as imported groups; the later group in the list wins`, path);
      }
      for (const g of res.physics) ops.push({ op: 'add', kind: 'physics', value: g });
    }
  } else if (typeof refs.Physics === 'string') {
    r.info('live2d-skipped', 'physics skipped (physics "skip")', 'FileReferences.Physics');
  }

  // ---- expressions and motions -> animations
  const taken = new Set<string>();
  const existing = new Set(info.animationIds);
  const addAnimation = (animation: Json, where: string) => {
    const id = animation.id as string;
    if (existing.has(id)) {
      ops.push({ op: 'remove', kind: 'animation', id });
      // Replacing what an earlier import brought is expected; losing an animation made in Rev2D is a warning.
      r.add(replacedAnimationIssue(id, info.importedAnimationIds.has(id), where));
    }
    ops.push({ op: 'add', kind: 'animation', value: animation });
  };

  if (opts.expressions !== false) {
    arrayOf(refs.Expressions).forEach((e, i) => {
      const where = `FileReferences.Expressions[${i}]`;
      if (!isObject(e) || typeof e.File !== 'string') {
        r.warn('live2d-model3-invalid', 'expression needs a File: skipped', where);
        return;
      }
      const name = typeof e.Name === 'string' && e.Name ? e.Name : stem(e.File);
      const id = uniqueId(`exp_${sanitizeId(name, `expression${i + 1}`)}`, taken);
      const text = read(e.File, where);
      const res = text === undefined ? undefined : guarded('expression', e.File, () => importExp3(text, id, { paramMap: map, model: opts.model, checked }));
      if (!res) return;
      r.merge(res.report, e.File);
      addAnimation(res.animation, where);
      r.count('expressions');
    });
  }

  if (opts.motions !== false) {
    const motions = isObject(refs.Motions) ? refs.Motions : {};
    for (const [group, list] of Object.entries(motions)) {
      arrayOf(list).forEach((m, i) => {
        const where = `FileReferences.Motions.${group}[${i}]`;
        if (!isObject(m) || typeof m.File !== 'string') {
          r.warn('live2d-model3-invalid', 'motion needs a File: skipped', where);
          return;
        }
        const id = uniqueId(sanitizeId(stem(m.File), `${sanitizeId(group, 'motion')}_${i + 1}`), taken);
        const text = read(m.File, where);
        const fadeIn = finite(m.FadeInTime);
        const fadeOut = finite(m.FadeOutTime);
        const extras = [
          fadeIn !== undefined ? `FadeInTime ${fmt(fadeIn)} s` : '',
          fadeOut !== undefined ? `FadeOutTime ${fmt(fadeOut)} s` : '',
        ].filter(Boolean);
        const description = `${IMPORTED_MODEL3_MOTION}${group}" #${i} (${m.File}).`;
        const res = text === undefined ? undefined : guarded('motion', m.File, () => importMotion3(text, id, { paramMap: map, model: opts.model, groups, checked, description }));
        if (!res) return;
        r.merge(res.report, m.File);
        if (extras.length) r.info('live2d-fade-ignored', `motion entry fades (${extras.join(', ')}) are not imported`, where);
        if (typeof m.Sound === 'string') r.info('live2d-sound-ignored', `sound ${q(m.Sound)} is not imported`, where, 'play it next to the animation in your app');
        if (typeof m.MotionSync === 'string') r.info('live2d-motionsync-ignored', `motion-sync ${q(m.MotionSync)} is not imported`, where);
        addAnimation(res.animation, where);
        r.count('motions');
      });
    }
  }

  return { ops, report: r.report('live2d-model3', 'import') };
}

// ----------------------------------------------------------------------------- export

function fileName(s: string): string {
  const out = s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._]+/, '');
  return out || 'model';
}

function writeJson(value: unknown): string {
  return formatModelJson(value, { precision: 6, width: 120 });
}

export function exportAll(model: Model, opts: Live2dExportOptions & { animations?: string[]; name?: string; tolerance?: number } = {}): { files: OutputFile[]; report: InteropReport } {
  const r = new Reporter();
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const name = fileName(opts.name ?? model.meta.name);
  const checked = new Set<string>();
  const files: OutputFile[] = [];
  const ids = opts.animations ?? model.animations.map((a) => a.id);
  for (const id of ids) {
    if (!model.animations.some((a) => a.id === id)) {
      const hint = suggest(id, model.animations.map((a) => a.id));
      throw new Error(`exportLive2d: unknown animation ${q(id)}${hint ? ` (${hint})` : ''}`);
    }
  }
  // Range mismatches are reported once for every parameter, not once per motion.
  for (const p of model.parameters) {
    checkStandardRange({ id: p.id, min: p.min, max: p.max, default: Math.min(p.max, Math.max(p.min, p.default ?? 0)) }, toLive2dId(p.id, map), r, checked, `parameters.${p.id}`);
  }

  const motions: Record<string, Json[]> = {};
  const usedFiles = new Set<string>();
  for (const id of ids) {
    const { motion3, report } = exportMotion3(model, id, { ...opts, checked });
    if (!(motion3.Curves as unknown[]).length && !motion3.UserData) {
      r.merge(report, `animations.${id}`);
      r.warn('live2d-motion-skipped', `animation ${q(id)} has nothing Live2D can play: no file written`, `animations.${id}`);
      continue;
    }
    const file = `motions/${uniqueId(fileName(id), usedFiles)}.motion3.json`;
    r.merge(report, file);
    files.push({ path: file, text: writeJson(motion3) });
    const group = id.toLowerCase() === 'idle' ? 'Idle' : id;
    (motions[group] ??= []).push({ File: file });
    r.count('motions');
  }

  const refs: Json = {};
  if (model.physics.length) {
    const { physics3, report } = exportPhysics3(model, opts);
    r.merge(report, `${name}.physics3.json`);
    files.push({ path: `${name}.physics3.json`, text: writeJson(physics3) });
    refs.Physics = `${name}.physics3.json`;
  }
  const { cdi3, report: cdiReport } = exportCdi3(model, opts);
  r.merge(cdiReport, `${name}.cdi3.json`);
  files.push({ path: `${name}.cdi3.json`, text: writeJson(cdi3) });
  refs.DisplayInfo = `${name}.cdi3.json`;
  if (Object.keys(motions).length) refs.Motions = motions;

  const l2dIds = new Set(model.parameters.map((p) => toLive2dId(p.id, map)));
  const groups: Json[] = [];
  const blink = ['ParamEyeLOpen', 'ParamEyeROpen'].filter((id) => l2dIds.has(id));
  if (blink.length) groups.push({ Target: 'Parameter', Name: 'EyeBlink', Ids: blink });
  if (l2dIds.has('ParamMouthOpenY')) groups.push({ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] });

  const model3: Json = { Version: 3, FileReferences: refs, ...(groups.length ? { Groups: groups } : {}) };
  files.push({ path: `${name}.model3.json`, text: writeJson(model3) });
  r.info(
    'live2d-model3-partial',
    `${name}.model3.json lists only the motions, physics and display info: it has no Moc and no Textures`,
    `${name}.model3.json`,
    'merge its FileReferences (Motions, Physics, DisplayInfo) and Groups into the model3.json of a Live2D model built in Cubism Editor, whose parameter ids match (see the parameter map)',
  );
  if (groups.length) r.info('live2d-groups-written', `Groups written for the standard eye / mouth parameters (${groups.map((g) => g.Name).join(', ')})`, `${name}.model3.json`);
  if (motions.Idle) r.info('live2d-idle-group', 'animation "idle" is listed in the "Idle" motion group (the one Cubism sample apps play automatically); other animations get a group named after their id', `${name}.model3.json`);
  r.count('files', files.length);
  return { files, report: r.report('live2d-model3', 'export') };
}
