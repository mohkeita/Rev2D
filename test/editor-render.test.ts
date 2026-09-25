import { describe, expect, it } from 'vitest';
import { FramePacker, maskModeOf } from '../editor/src/gl/pack.js';
import { FLOATS_PER_VERTEX } from '../editor/src/gl/shaders.js';
import { buildRigTree, filterTree } from '../editor/src/state/outline.js';
import { Rig, buildRenderList, validateModel, type DrawItem, type Model } from '../src/core/index.js';
import { blankModel } from '../src/api/templates.js';

function tri(partId: string, x: number, opts: Partial<DrawItem> = {}): DrawItem {
  return {
    partId,
    kind: 'fill',
    positions: new Float32Array([x, 0, x + 10, 0, x, 10]),
    colors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5]),
    indices: new Uint32Array([0, 1, 2]),
    blend: 'normal',
    ...opts,
  };
}

describe('editor frame packer', () => {
  it('interleaves vertices and rebases indices per item', () => {
    const packer = new FramePacker();
    const a = tri('a', 0);
    const b = tri('b', 100, { uvs: new Float32Array([0, 0, 1, 0, 0, 1]), texture: 't' });
    const f = packer.pack([a, b], new Set());
    expect(f.vertices.length).toBe(6 * FLOATS_PER_VERTEX);
    expect([...f.indices]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(f.draws.map((d) => [d.item.partId, d.range.first, d.range.count])).toEqual([
      ['a', 0, 3],
      ['b', 3, 3],
    ]);
    // Vertex 4 = b's second vertex: x, y, r, g, b, a, u, v.
    expect([...f.vertices.subarray(4 * FLOATS_PER_VERTEX, 5 * FLOATS_PER_VERTEX)]).toEqual([110, 0, 0, 1, 0, 1, 1, 0]);
    // Untextured items get zero uvs.
    expect(f.vertices[6]).toBe(0);
    expect(f.triangles).toBe(2);
  });

  it('skips preview-hidden parts but still packs their geometry when used as masks', () => {
    const mask = tri('maskPart', 50);
    const clipped = tri('clipped', 0, { masks: [mask] });
    const clipped2 = tri('clipped', 0, { kind: 'stroke', masks: [mask] });
    const f = new FramePacker().pack([mask, clipped, clipped2], new Set(['maskPart']));
    expect(f.draws.map((d) => d.item.partId)).toEqual(['clipped', 'clipped']);
    // The shared mask item is packed once, after the draws.
    expect(f.masks.size).toBe(1);
    expect(f.masks.get(mask)).toEqual({ first: 6, count: 3 });
    expect(f.indices.length).toBe(9);
  });

  it('draws nothing for an empty mask list (zero coverage) and everything when it is inverted', () => {
    const mask = tri('maskPart', 50);
    expect(maskModeOf(tri('a', 0))).toBe('none');
    expect(maskModeOf(tri('a', 0, { masks: [mask] }))).toBe('mask');
    expect(maskModeOf(tri('a', 0, { masks: [mask], maskInvert: true }))).toBe('invert');
    expect(maskModeOf(tri('a', 0, { masks: [] }))).toBe('skip');
    expect(maskModeOf(tri('a', 0, { masks: [], maskInvert: true }))).toBe('none');
    const f = new FramePacker().pack([tri('gone', 0, { masks: [] }), tri('shown', 0, { masks: [], maskInvert: true })], new Set());
    expect(f.draws.map((d) => d.item.partId)).toEqual(['shown']);
    expect(f.masks.size).toBe(0);
  });

  it('drops items whose indices point past their vertices', () => {
    const bad = tri('bad', 0, { indices: new Uint32Array([0, 1, 7]) });
    const f = new FramePacker().pack([bad, tri('ok', 0)], new Set());
    expect(f.draws.map((d) => d.item.partId)).toEqual(['ok']);
  });

  it('packs a real render list and reuses its buffers between frames', () => {
    const model = validateModel(blankModel()).model!;
    const rig = new Rig(model);
    const list = buildRenderList(rig, rig.pose());
    const packer = new FramePacker();
    const first = packer.pack(list.draws, new Set());
    const vertexCount = list.draws.reduce((n, d) => n + d.positions.length / 2, 0);
    expect(first.vertices.length).toBe(vertexCount * FLOATS_PER_VERTEX);
    expect(Math.max(...first.indices)).toBe(vertexCount - 1);
    const second = packer.pack(list.draws, new Set());
    expect(second.vertices.buffer).toBe(first.vertices.buffer);
  });
});

describe('editor outliner tree', () => {
  const raw = blankModel() as { bones: unknown[]; parts: unknown[]; warps: unknown[] };
  raw.bones.push({ id: 'arm', parent: 'root', length: 30 });
  raw.parts.push({ id: 'sleeve', skin: { bones: ['arm', 'root'] }, shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 } });
  raw.parts.push({ id: 'floor', shape: { type: 'rect', x: 0, y: 500, w: 512, h: 12 } });
  raw.warps.push({ id: 'free', rect: [0, 0, 10, 10] });
  const model: Model = validateModel(raw).model!;

  it('nests bones, warps and parts, skinned parts under their first bone, loose items in a group', () => {
    const tree = buildRigTree(model);
    const shape = (nodes: ReturnType<typeof buildRigTree>): unknown =>
      nodes.map((n) => (n.children.length ? { [n.key]: shape(n.children) } : n.badge ? `${n.key} (${n.badge})` : n.key));
    expect(shape(tree)).toEqual([
      { 'bone:root': [{ 'bone:arm': ['part:sleeve (skin)'] }, { 'warp:bodyWarp': ['part:body', 'part:eye'] }] },
      { 'group:model-space': ['warp:free', 'part:floor'] },
    ]);
  });

  it('filters by id, keeping ancestors of matches', () => {
    const tree = filterTree(buildRigTree(model), 'EY');
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe('bone:root');
    expect(tree[0].children.map((c) => c.key)).toEqual(['warp:bodyWarp']);
    expect(tree[0].children[0].children.map((c) => c.key)).toEqual(['part:eye']);
    expect(filterTree(buildRigTree(model), 'zzz')).toEqual([]);
  });
});
