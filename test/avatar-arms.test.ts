import { ARM_VALIDATION_CASES } from './fixtures/avatar-arms.js';
import { describe, it, expect } from 'vitest';
import { figureFixture, fullFigureAvatarDoc } from './fixtures/studio.js';
import { parseAvatarSpec, buildAvatarLayers, compileAvatar } from '../src/avatar/index.js';
import { validateModel } from '../src/core/validate.js';
import { Rig, buildRenderList } from '../src/core/rig.js';
import { renderImage } from '../src/render/browser.js';
import { findFolds } from '../src/avatar/folds.js';
import { avatarOverlay } from '../src/avatar/tools/overlay.js';
import { describeAvatarParts, resolveShape } from '../src/avatar/parts.js';
import { layerInputsHash } from '../src/avatar/hash.js';

const fixture = figureFixture('standing'),
  doc = fullFigureAvatarDoc();
const parsed = parseAvatarSpec(doc);
if (!parsed.spec) throw new Error(JSON.stringify(parsed.diagnostics));
const spec = parsed.spec,
  layers = buildAvatarLayers(spec, fixture.image),
  compiled = compileAvatar(spec, layers.meta),
  validated = validateModel(compiled.doc);
if (!validated.model) throw new Error(JSON.stringify(validated.diagnostics));
const model = validated.model,
  rig = new Rig(model),
  textures = Object.fromEntries(layers.meta.layers.map((l) => [l.id, layers.images[l.file]]));
const render = (params: Record<string, number> = {}) =>
  renderImage(buildRenderList(rig, rig.pose({ params, physics: false })), textures, { supersample: 1 });

describe('authored full-body arms', () => {
  it('validates geometry and diagnoses detached, short, crossing or missing landmarks', () => {
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    for (const c of ARM_VALIDATION_CASES) {
      const raw = structuredClone(doc);
      c.mutate(raw);
      const d = parseAvatarSpec(raw).diagnostics.find((d) => d.code === c.code && d.path === c.path);
      expect(d, c.code).toBeDefined();
      expect(d!.severity).toBe('error');
      expect(d!.hint).toBeTruthy();
    }
  });
  it('preserves rest illustration within two channel levels on at least 99% of pixels', () => {
    const actual = render();
    let bad = 0,
      max = 0;
    for (let i = 0; i < actual.data.length; i += 4) {
      if (actual.data[i + 3] === 0 && fixture.image.data[i + 3] === 0) continue;
      const error = Math.max(
        ...[0, 1, 2, 3].map((c) => Math.abs(actual.data[i + c] - fixture.image.data[i + c])),
      );
      if (error > 2) bad++;
      max = Math.max(max, error);
    }
    expect({ share: bad / (actual.width * actual.height), bad, max }).toMatchObject({
      share: expect.any(Number),
    });
    expect(bad / (actual.width * actual.height), JSON.stringify({ bad, max })).toBeLessThanOrEqual(0.01);
  });
  it('places the wrist within three pixels of analytic shoulder rotation', () => {
    const a = spec.arms![0],
      angle = Math.PI / 4,
      dx = a.wrist[0] - a.shoulder[0],
      dy = a.wrist[1] - a.shoulder[1];
    const expected = [
      a.shoulder[0] + dx * Math.cos(angle) - dy * Math.sin(angle),
      a.shoulder[1] + dx * Math.sin(angle) + dy * Math.cos(angle),
    ];
    const point = rig.mapPoint(
      rig.pose({ params: { ArmRA: 45 }, physics: false }),
      'bone:armRHand',
      ...a.wrist,
    );
    expect(Math.hypot(point[0] - expected[0], point[1] - expected[1])).toBeLessThan(3);
  });
  it('leaves no alpha hole in the exposed torso after raising either arm', () => {
    const image = render({ ArmRA: 110, ArmLA: -110, ArmRB: 55, ArmLB: -55 });
    for (let y = 210; y < 315; y++)
      for (let x = 145; x < 216; x++)
        expect(image.data[(y * image.width + x) * 4 + 3], `torso (${x},${y})`).toBe(255);
  });
  it('keeps feet anchored during full-body lean, bounce and breath', () => {
    const pose = rig.pose({
      params: { BodyAngleZ: 15, BodyY: 8, BodyAngleX: 10, Breath: 1 },
      physics: false,
    });
    for (const point of spec.legs!.feet) {
      const moved = rig.mapPoint(pose, 'avatarWarp', ...point);
      expect(Math.hypot(moved[0] - point[0], moved[1] - point[1])).toBeLessThan(0.01);
    }
  });
  it('has no folded cells at every parameter extreme and the head/body combinations', () => {
    expect(compiled.folds.poses).toContainEqual({ ArmRA: 170, AngleX: 30, BodyAngleX: 10 });
    const folds = findFolds(model, compiled.folds);
    expect(folds.slice(0, 8)).toEqual([]);
  });
  it('invalidates cuts when arm geometry changes but keeps old bust fingerprints stable', () => {
    const changed = structuredClone(spec);
    changed.arms![0].elbow[0]--;
    expect(layerInputsHash(changed)).not.toBe(layerInputsHash(spec));
    const front = structuredClone(spec);
    front.arms![0].front = false;
    expect(layerInputsHash(front)).toBe(layerInputsHash(spec));
  });
});

it('exposes and draws the full-body arm/leg handles, including nested outline points', () => {
  const raw = {
    ...doc,
    arms: doc.arms.map((a, i) =>
      i
        ? a
        : {
            ...a,
            outline: [
              [100, 200],
              [150, 200],
              [150, 330],
              [95, 330],
            ],
          },
    ),
  };
  const groups = describeAvatarParts(raw);
  for (const id of ['arms', 'legs']) {
    const group = groups.find((g) => g.id === id)!;
    expect(group.present).toBe(true);
    const overlay = avatarOverlay(fixture.image, raw, { part: id });
    const color = group.color
      .slice(1)
      .match(/../g)!
      .map((c) => parseInt(c, 16));
    let count = 0;
    for (let i = 0; i < overlay.image.data.length; i += 4)
      if (color.every((c, k) => overlay.image.data[i + k] === c)) count++;
    expect(count, id).toBeGreaterThan(30);
  }
  const outline = groups.find((g) => g.id === 'arms')!.items.find((i) => i.id === 'arms.armR.outline')!;
  expect(resolveShape(raw, outline.shape)).toEqual({
    type: 'polygon',
    points: [100, 200, 150, 200, 150, 330, 95, 330],
  });
});

it('preserves sleeve and forearm lengths while bending the elbow and hides the shoulder behind the torso', () => {
  const rest = rig.pose({ physics: false });
  for (const id of ['armRMesh', 'armRForeMesh']) {
    const original = rest.parts[id].fill!;
    for (const bend of [-150, -90, 55, 150]) {
      const pose = rig.pose({ params: { ArmRA: 120, ArmRB: bend }, physics: false }),
        points = pose.parts[id].fill!;
      expect(points.length).toBe(original.length);
      for (let a = 0; a < points.length; a += 2)
        for (let b = a + 2; b < points.length; b += 2) {
          const before = Math.hypot(original[a] - original[b], original[a + 1] - original[b + 1]),
            after = Math.hypot(points[a] - points[b], points[a + 1] - points[b + 1]);
          expect(Math.abs(before - after)).toBeLessThan(0.002);
        }
    }
  }
  expect(rest.parts.armRMesh.z).toBeLessThan(rest.parts.base.z);
});
