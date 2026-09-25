/**
 * Structural summary of a model: what exists, how it is connected and what drives what.
 * Designed to be the first thing an AI agent reads about an unfamiliar model.
 */
import type { Model } from '../core/types.js';
import { parseAddress, paramDefault } from '../core/address.js';

export interface BoneNode {
  id: string;
  x: number;
  y: number;
  rotation: number;
  length: number;
  children: BoneNode[];
  /** Warps and parts attached directly to this bone. */
  attached: string[];
  /** Parts skinned to this bone (among others): "skin:<part id>". */
  skinned: string[];
}

export interface ModelInfo {
  name: string;
  size: [number, number];
  counts: Record<'parameters' | 'textures' | 'bones' | 'warps' | 'parts' | 'bindings' | 'ik' | 'physics' | 'animations', number>;
  parameters: Array<{ id: string; min: number; max: number; default: number; group?: string; drives: string[]; drivenBy: string[] }>;
  bones: BoneNode[];
  warps: Array<{ id: string; parent: string | null; rect: [number, number, number, number]; grid: string; children: string[] }>;
  parts: Array<{ id: string; shape: string; parent: string | null; skin: string[] | null; z: number; mask: string[] | null; tags: string[] }>;
  bindings: Array<{ target: string; params: string[]; keys: number }>;
  animations: Array<{ id: string; duration: number; loop: boolean; targets: string[]; events: number }>;
  ik: Array<{ id: string; bones: string[]; target: string; mix: number; bendPositive: boolean; stretch: boolean; softness: number }>;
  physics: Array<{ id: string; inputs: string[]; outputs: string[] }>;
}

export function modelInfo(model: Model): ModelInfo {
  const attached = new Map<string, string[]>();
  const attach = (parent: string | undefined | null, label: string) => {
    if (!parent) return;
    if (!attached.has(parent)) attached.set(parent, []);
    attached.get(parent)!.push(label);
  };
  for (const w of model.warps) attach(w.parent, `warp:${w.id}`);
  for (const p of model.parts) attach(p.parent, `part:${p.id}`);
  const skinned = new Map<string, string[]>();
  for (const p of model.parts) {
    for (const b of p.skin?.bones ?? []) {
      if (!skinned.has(b)) skinned.set(b, []);
      skinned.get(b)!.push(`skin:${p.id}`);
    }
  }

  const byParent = new Map<string | null, typeof model.bones>();
  for (const b of model.bones) {
    const k = b.parent ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(b);
  }
  const build = (parent: string | null, seen: Set<string>): BoneNode[] =>
    (byParent.get(parent) ?? [])
      .filter((b) => !seen.has(b.id))
      .map((b) => {
        seen.add(b.id);
        return {
          id: b.id,
          x: b.x,
          y: b.y,
          rotation: b.rotation,
          length: b.length,
          children: build(b.id, seen),
          attached: attached.get(b.id) ?? [],
          skinned: skinned.get(b.id) ?? [],
        };
      });

  const drives = new Map<string, Set<string>>();
  const drivenBy = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(v);
  };
  for (const b of model.bindings) for (const p of b.params) add(drives, p, b.target);
  for (const ph of model.physics) {
    for (const o of ph.outputs) add(drivenBy, o.param, `physics:${ph.id}`);
    for (const i of ph.inputs) add(drives, i.param, `physics:${ph.id}`);
  }
  for (const a of model.animations) {
    for (const t of a.tracks) {
      try {
        const addr = parseAddress(t.target);
        if (addr.kind === 'param') add(drivenBy, addr.id, `animation:${a.id}`);
      } catch {
        // invalid targets are reported by validation
      }
    }
  }

  return {
    name: model.meta.name,
    size: [model.meta.width, model.meta.height],
    counts: {
      parameters: model.parameters.length,
      textures: model.textures.length,
      bones: model.bones.length,
      warps: model.warps.length,
      parts: model.parts.length,
      bindings: model.bindings.length,
      ik: model.ik.length,
      physics: model.physics.length,
      animations: model.animations.length,
    },
    parameters: model.parameters.map((p) => ({
      id: p.id,
      min: p.min,
      max: p.max,
      default: paramDefault(p),
      group: p.group,
      drives: [...(drives.get(p.id) ?? [])],
      drivenBy: [...(drivenBy.get(p.id) ?? [])],
    })),
    bones: build(null, new Set()),
    warps: model.warps.map((w) => ({
      id: w.id,
      parent: w.parent ?? null,
      rect: w.rect,
      grid: `${w.cols}x${w.rows}`,
      children: attached.get(w.id) ?? [],
    })),
    parts: model.parts.map((p) => ({
      id: p.id,
      shape: p.shape.type,
      parent: p.parent ?? null,
      skin: p.skin?.bones ?? null,
      z: p.z,
      mask: p.mask ?? null,
      tags: p.tags ?? [],
    })),
    bindings: model.bindings.map((b) => ({ target: b.target, params: b.params, keys: b.keys.length })),
    animations: model.animations.map((a) => ({
      id: a.id,
      duration: a.duration,
      loop: a.loop,
      targets: a.tracks.map((t) => t.target),
      events: a.events?.length ?? 0,
    })),
    ik: model.ik.map((k) => ({ id: k.id, bones: k.bones, target: k.target, mix: k.mix, bendPositive: k.bendPositive, stretch: k.stretch ?? false, softness: k.softness ?? 0 })),
    physics: model.physics.map((p) => ({
      id: p.id,
      inputs: p.inputs.map((i) => `${i.param}(${i.type})`),
      outputs: p.outputs.map((o) => `${o.param}(${o.type})`),
    })),
  };
}

/** Human/AI-readable text rendering of ModelInfo. */
export function formatInfo(info: ModelInfo): string {
  const out: string[] = [];
  const c = info.counts;
  out.push(`${info.name}  ${info.size[0]}x${info.size[1]}`);
  out.push(
    `  ${c.parameters} parameters, ${c.bones} bones, ${c.warps} warps, ${c.parts} parts, ${c.bindings} bindings, ${c.animations} animations, ${c.ik} ik, ${c.physics} physics, ${c.textures} textures`,
  );
  if (info.parameters.length) {
    out.push('', 'PARAMETERS');
    for (const p of info.parameters) {
      const extra = [
        p.group ? `group=${p.group}` : '',
        p.drivenBy.length ? `driven by ${p.drivenBy.join(', ')}` : '',
        p.drives.length ? `-> ${p.drives.join(', ')}` : '(unused)',
      ]
        .filter(Boolean)
        .join('  ');
      out.push(`  ${p.id} [${p.min}..${p.max}] default ${p.default}  ${extra}`);
    }
  }
  if (info.bones.length) {
    out.push('', 'BONES (local x,y rotation length)');
    const walk = (nodes: BoneNode[], prefix: string) => {
      nodes.forEach((n, i) => {
        const last = i === nodes.length - 1;
        const all = [...n.attached, ...(n.skinned ?? [])];
        const att = all.length ? `  <- ${all.join(', ')}` : '';
        out.push(`${prefix}${last ? '└─ ' : '├─ '}${n.id} (${n.x}, ${n.y}) ${n.rotation}° len ${n.length}${att}`);
        walk(n.children, prefix + (last ? '   ' : '│  '));
      });
    };
    walk(info.bones, '  ');
  }
  if (info.warps.length) {
    out.push('', 'WARPS');
    for (const w of info.warps) {
      out.push(`  ${w.id} ${w.grid} rect [${w.rect.join(', ')}] parent ${w.parent ?? '-'}${w.children.length ? `  <- ${w.children.join(', ')}` : ''}`);
    }
  }
  if (info.parts.length) {
    out.push('', 'PARTS (draw order = z, then list order)');
    for (const p of info.parts) {
      const rel = p.skin ? `skin ${p.skin.join('+')}` : `parent ${p.parent ?? '-'}`;
      out.push(`  ${p.id} ${p.shape} z=${p.z} ${rel}${p.mask ? ` mask ${p.mask.join('+')}` : ''}${p.tags.length ? ` #${p.tags.join(' #')}` : ''}`);
    }
  }
  if (info.bindings.length) {
    out.push('', 'BINDINGS');
    for (const b of info.bindings) out.push(`  ${b.target} <- ${b.params.join(' x ')} (${b.keys} keys)`);
  }
  if (info.ik.length) {
    out.push('', 'IK');
    for (const k of info.ik) {
      const opts = [`mix ${k.mix}`, k.bones.length === 2 ? `bendPositive ${k.bendPositive}` : '', `stretch ${k.stretch}`, k.bones.length === 2 ? `softness ${k.softness}` : ''].filter(Boolean);
      out.push(`  ${k.id}: ${k.bones.join(' -> ')} reaching ${k.target} (${opts.join(', ')})`);
    }
  }
  if (info.physics.length) {
    out.push('', 'PHYSICS');
    for (const p of info.physics) out.push(`  ${p.id}: ${p.inputs.join(', ')} => ${p.outputs.join(', ')}`);
  }
  if (info.animations.length) {
    out.push('', 'ANIMATIONS');
    for (const a of info.animations) {
      out.push(`  ${a.id} ${a.duration}s${a.loop ? ' loop' : ''}: ${a.targets.join(', ')}${a.events ? ` (+${a.events} events)` : ''}`);
    }
  }
  return out.join('\n');
}
