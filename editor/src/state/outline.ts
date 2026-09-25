/**
 * Outliner data (pure): the rig hierarchy (bones with their child bones, warps and parts; warps with
 * their children) and search filtering.
 */
import type { Model } from '../../../src/core/index.js';
import type { EntityKind } from './doc.js';

export interface TreeNode {
  /** "kind:id" selection key ("group:model-space" for the synthetic root of unparented items). */
  key: string;
  kind: EntityKind | 'group';
  id: string;
  /** Extra marker shown next to the label, e.g. "skin" for skinned parts. */
  badge?: string;
  children: TreeNode[];
}

/**
 * Bones tree. Parts parented to a bone or warp appear under it; skinned parts under their first
 * skin bone (badge "skin"). Unparented warps/parts go into a "Model space" group after the roots.
 */
export function buildRigTree(model: Model): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const boneNode = (id: string): TreeNode => ({ key: `bone:${id}`, kind: 'bone', id, children: [] });
  const warpNode = (id: string): TreeNode => ({ key: `warp:${id}`, kind: 'warp', id, children: [] });
  for (const b of model.bones) nodes.set(`bone:${b.id}`, boneNode(b.id));
  for (const w of model.warps) nodes.set(`warp:${w.id}`, warpNode(w.id));
  const parentKey = (id: string | null | undefined): string | null => {
    if (!id) return null;
    if (nodes.has(`bone:${id}`)) return `bone:${id}`;
    if (nodes.has(`warp:${id}`)) return `warp:${id}`;
    return null;
  };
  const roots: TreeNode[] = [];
  const loose: TreeNode[] = [];
  for (const b of model.bones) {
    const p = parentKey(b.parent);
    (p ? nodes.get(p)!.children : roots).push(nodes.get(`bone:${b.id}`)!);
  }
  for (const w of model.warps) {
    const p = parentKey(w.parent);
    (p ? nodes.get(p)!.children : loose).push(nodes.get(`warp:${w.id}`)!);
  }
  for (const part of model.parts) {
    const node: TreeNode = { key: `part:${part.id}`, kind: 'part', id: part.id, children: [] };
    const skinBone = part.skin?.bones[0];
    const p = parentKey(part.parent) ?? (skinBone ? parentKey(skinBone) : null);
    if (skinBone && !part.parent) node.badge = 'skin';
    (p ? nodes.get(p)!.children : loose).push(node);
  }
  if (loose.length) roots.push({ key: 'group:model-space', kind: 'group', id: 'Model space', children: loose });
  return roots;
}

/** Case-insensitive substring match on the id. */
export function matches(id: string, query: string): boolean {
  return query === '' || id.toLowerCase().includes(query.toLowerCase());
}

/** Keep nodes that match or have matching descendants (children filtered recursively). */
export function filterTree(nodes: readonly TreeNode[], query: string): TreeNode[] {
  if (!query) return [...nodes];
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const children = filterTree(n.children, query);
    if (children.length || (n.kind !== 'group' && matches(n.id, query))) out.push({ ...n, children });
  }
  return out;
}
