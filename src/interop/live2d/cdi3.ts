/**
 * cdi3.json (Cubism display info: parameter names, parameter groups, part names) <-> Rev2D parameter
 * descriptions and groups.
 */
import type { Model } from '../../core/types.js';
import type { InteropReport, Live2dExportOptions, Live2dImportOptions } from '../types.js';
import { LegacyIds, LIVE2D_STANDARD_PARAMS, resolveLive2dParam, STANDARD_PARAM_MAP, toLive2dId } from './params.js';
import { arrayOf, isObject, type Json, modelInfo, parseJsonInput, q, Reporter } from './util.js';

export interface DisplayInfo {
  parameters: Array<{ id: string; name?: string; group?: string }>;
  /** Part display names (Live2D part ids; Rev2D parts with the same id may use them). */
  parts: Array<{ id: string; name: string }>;
}

export function importCdi3(json: string | Json, opts: Live2dImportOptions = {}): DisplayInfo & { report: InteropReport } {
  const r = new Reporter();
  const doc = parseJsonInput(json, 'cdi3.json');
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const model = modelInfo(opts.model);
  const groups = new Map<string, string>();
  arrayOf(doc.ParameterGroups).forEach((g, i) => {
    if (isObject(g) && typeof g.Id === 'string') groups.set(g.Id, typeof g.Name === 'string' && g.Name ? g.Name : g.Id);
    else r.warn('live2d-cdi-invalid', 'parameter group needs an Id string: skipped', `ParameterGroups[${i}]`);
  });
  const nested = arrayOf(doc.ParameterGroups).filter((g) => isObject(g) && typeof g.GroupId === 'string' && g.GroupId !== '').length;
  if (nested) r.info('live2d-cdi-nested-groups', `${nested} parameter group(s) are nested in other groups; Rev2D groups are flat labels, so each parameter gets its own group's name`, 'ParameterGroups');

  const parameters: DisplayInfo['parameters'] = [];
  let unknown = 0;
  const legacy = new LegacyIds();
  arrayOf(doc.Parameters).forEach((p, i) => {
    const where = `Parameters[${i}]`;
    if (!isObject(p) || typeof p.Id !== 'string') {
      r.warn('live2d-cdi-invalid', 'parameter needs an Id string: skipped', where);
      return;
    }
    const res = resolveLive2dParam(p.Id, map, model);
    legacy.add(res, p.Id);
    if (!res.ok) {
      unknown++;
      return;
    }
    const groupId = typeof p.GroupId === 'string' ? p.GroupId : '';
    let group: string | undefined;
    if (groupId) {
      group = groups.get(groupId);
      if (group === undefined) {
        r.warn('live2d-cdi-unknown-group', `GroupId ${q(groupId)} is not in ParameterGroups: its id is used as the group name`, `${where} (${p.Id})`);
        group = groupId;
      }
    }
    parameters.push({ id: res.id, ...(typeof p.Name === 'string' && p.Name ? { name: p.Name } : {}), ...(group !== undefined ? { group } : {}) });
  });
  legacy.report(r, 'Parameters');
  if (unknown) r.info('live2d-cdi-unknown-parameters', `${unknown} parameter(s) of the display info are not in the target model: ignored`, 'Parameters');
  const parts = arrayOf(doc.Parts).flatMap((p) => (isObject(p) && typeof p.Id === 'string' ? [{ id: p.Id, name: typeof p.Name === 'string' ? p.Name : p.Id }] : []));
  if (Array.isArray(doc.CombinedParameters) && doc.CombinedParameters.length) {
    r.info('live2d-cdi-combined-ignored', `${doc.CombinedParameters.length} CombinedParameters pair(s) (2D sliders in Cubism tools) have no Rev2D equivalent: ignored`, 'CombinedParameters');
  }
  r.count('parameters', parameters.length);
  r.count('parameterGroups', groups.size);
  r.count('parts', parts.length);
  return { parameters, parts, report: r.report('live2d-cdi3', 'import') };
}

/** "ParamGroup" + the letters and digits of the label (unique per label). */
function groupIdFor(label: string, taken: Map<string, string>): string {
  const existing = taken.get(label);
  if (existing) return existing;
  const core = label.replace(/[^A-Za-z0-9]+/g, '');
  const base = `ParamGroup${core || 'Group'}`;
  let id = base;
  const used = new Set(taken.values());
  for (let n = 2; used.has(id); n++) id = `${base}${n}`;
  taken.set(label, id);
  return id;
}

export function exportCdi3(model: Model, opts: Live2dExportOptions = {}): { cdi3: Json; report: InteropReport } {
  const r = new Reporter();
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const groupIds = new Map<string, string>();
  let described = 0;
  const parameters = model.parameters.map((p) => {
    const id = toLive2dId(p.id, map);
    if (p.description) described++;
    const name = LIVE2D_STANDARD_PARAMS[id]?.name ?? p.id;
    return { Id: id, GroupId: p.group ? groupIdFor(p.group, groupIds) : '', Name: name };
  });
  const parameterGroups = [...groupIds].map(([label, id]) => ({ Id: id, GroupId: '', Name: label }));
  if (described) {
    r.info(
      'live2d-cdi-descriptions',
      `${described} parameter description(s) are not exported: cdi3.json holds only display names (the Live2D standard name, else the Rev2D id)`,
      'parameters',
    );
  }
  r.count('parameters', parameters.length);
  r.count('parameterGroups', parameterGroups.length);
  return { cdi3: { Version: 3, Parameters: parameters, ParameterGroups: parameterGroups, Parts: [] }, report: r.report('live2d-cdi3', 'export') };
}
