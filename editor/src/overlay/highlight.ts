/**
 * Rig items a selection stands for in the viewport beyond itself (pure): an IK constraint is shown
 * as its bone chain and target bone, a physics group as the bones and warps its output parameters
 * move (through bindings). Selected bones and warps are included, so callers draw one set.
 */
import type { Model } from '../../../src/core/index.js';
import type { EntityRef } from '../state/doc.js';

export interface RigHighlight {
  /** Bones drawn as selected. */
  bones: Set<string>;
  /** IK target bones (drawn as goals). */
  targets: Set<string>;
  /** Warps whose lattice is drawn highlighted. */
  warps: Set<string>;
  /** IK goal lines: from the chain's last bone (its tip) to the target bone. */
  links: Array<{ from: string; to: string }>;
}

/** "bone:<id>.<prop>" / "warp:<id>.<prop>" binding targets -> [kind, id]. */
function boundItem(target: string): ['bone' | 'warp', string] | null {
  const m = /^(bone|warp):([^.]+)\./.exec(target);
  return m ? [m[1] as 'bone' | 'warp', m[2]] : null;
}

export function rigHighlight(model: Model, selection: readonly EntityRef[]): RigHighlight {
  const out: RigHighlight = { bones: new Set(), targets: new Set(), warps: new Set(), links: [] };
  for (const ref of selection) {
    switch (ref.kind) {
      case 'bone':
        out.bones.add(ref.id);
        break;
      case 'warp':
        out.warps.add(ref.id);
        break;
      case 'ik': {
        const ik = model.ik.find((k) => k.id === ref.id);
        if (!ik) break;
        for (const b of ik.bones) out.bones.add(b);
        out.targets.add(ik.target);
        out.links.push({ from: ik.bones[ik.bones.length - 1], to: ik.target });
        break;
      }
      case 'physics': {
        const group = model.physics.find((g) => g.id === ref.id);
        if (!group) break;
        const outputs = new Set(group.outputs.map((o) => o.param));
        for (const b of model.bindings) {
          if (!b.params.some((p) => outputs.has(p))) continue;
          const item = boundItem(b.target);
          if (item?.[0] === 'bone') out.bones.add(item[1]);
          else if (item?.[0] === 'warp') out.warps.add(item[1]);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}
