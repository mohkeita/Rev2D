/** docs/OPS.md must stay truthful: its worked example runs, its op examples are well-formed. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rig } from '../../core/rig.js';
import { formatDiagnostics, validateModel } from '../../core/validate.js';
import { describeOps, type Op } from '../index.js';
import { applyOk } from './fixtures.js';

// Normalized: checkouts with core.autocrlf turn the file into CRLF.
const OPS_MD = readFileSync(new URL('../../../docs/OPS.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function markedBlock(name: string): unknown {
  const match = new RegExp(`<!-- ${name}:start -->\\s*\`\`\`json\\n([\\s\\S]*?)\`\`\`\\s*<!-- ${name}:end -->`).exec(OPS_MD);
  if (!match) throw new Error(`docs/OPS.md has no ${name} block`);
  return JSON.parse(match[1]);
}

describe('docs/OPS.md', () => {
  it('worked example builds a valid rig from the minimal model, with the messages the text quotes', () => {
    const start = markedBlock('worked-example-doc');
    const ops = markedBlock('worked-example') as Op[];
    const { doc, result, messages } = applyOk(start, ops);
    expect(result.diagnostics).toEqual([]);
    expect(messages).toContain('added bone "neck" as /bones/1 under "body" at local (0, -140) (world 256, 330)');
    expect(messages).toContain('set part:head.fill = "#f5d0a9" (was "#f2c9a0")');
    expect(messages.find((m) => m.startsWith('renamed parameter "Breath"'))).toBe(
      'renamed parameter "Breath" → "BodyBreath"; updated 2 references: /bindings/4/params/0, /animations/0/tracks/0/target',
    );
    expect(doc.bindings.map((b: any) => b.target)).toEqual([
      'warp:headWarp.offsets',
      'warp:faceWarp.offsets',
      'bone:neck.rotation',
      'part:mouth.shape.ry',
      'bone:body.scaleY',
    ]);
    expect(doc.animations[0].tracks.map((t: any) => t.target)).toEqual(['param:BodyBreath', 'param:AngleX']);
  });

  it('every JSON block parses, and every op example uses known ops and fields', () => {
    const catalogue = new Map(describeOps().map((d) => [d.op, Object.keys(d.fields)]));
    const blocks = [...OPS_MD.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(20);
    for (const text of blocks) {
      const value = JSON.parse(text);
      // Ops only: skip JSON Patch entries (they have "path") and result examples (they have "ok").
      const ops = (Array.isArray(value) ? value : [value]).filter((v: any) => v && typeof v === 'object' && typeof v.op === 'string' && !('path' in v) && !('ok' in v));
      for (const op of ops) {
        expect(catalogue.has(op.op), `unknown op ${op.op}`).toBe(true);
        for (const key of Object.keys(op)) if (key !== 'op') expect(catalogue.get(op.op), `${op.op}.${key}`).toContain(key);
      }
    }
  });

  it('documents every op', () => {
    for (const { op } of describeOps()) expect(OPS_MD).toContain(`### ${op}\n`);
  });

  it('follow: the hat example on the recipe 1 hero gives the quoted message and the quoted distances', () => {
    const start = applyOk(heroStarter(), recipeOps('head-turn')).doc;
    const { doc, result, messages } = applyOk(start, markedBlock('follow-example') as Op[]);
    expect(result.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    const quoted = /<!-- follow-example-message:start -->\s*`([^`]*)`\s*<!-- follow-example-message:end -->/.exec(OPS_MD);
    expect(messages[messages.length - 1]).toBe(quoted![1]);
    // "both land on (275.4, 115)"; the brim ends are 4.4 and 6.4 px off at AngleX=30.
    const rig = rigOf(doc);
    const at = (params: Record<string, number>, parent: string, x: number, y: number) => rig.mapPoint(rig.pose({ params, physics: false }), parent, x, y);
    for (const parent of ['headWarp', 'hatWarp']) {
      const [x, y] = at({ AngleX: 30, AngleY: 30 }, parent, 256, 121);
      expect([Number(x.toFixed(1)), Number(y.toFixed(1))]).toEqual([275.4, 115]);
    }
    const off = (d: Raw, params: Record<string, number>, x: number, y: number) => {
      const r = rigOf(d);
      const pose = r.pose({ params, physics: false });
      const [a, b] = [r.mapPoint(pose, 'headWarp', x, y), r.mapPoint(pose, 'hatWarp', x, y)];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
    expect(off(doc, { AngleX: 30 }, 190, 124)).toBeCloseTo(4.4, 1);
    expect(off(doc, { AngleX: 30 }, 322, 124)).toBeCloseTo(6.4, 1);
    // With a small yaw first, follow corrects on top of it: the brim ends stay within about 1 px.
    const perspective = applyOk(doc, markedBlock('follow-perspective') as Op[]);
    expect(perspective.messages[1]).toContain("kept 1 other binding on the accessory's targets (warp:hatWarp.offsets ← [AngleX])");
    for (const params of [{ AngleX: 30 }, { AngleX: -30 }, { AngleX: 30, AngleY: 30 }, { AngleX: -30, AngleY: -30 }, { AngleX: 15, AngleY: -15 }] as Array<Record<string, number>>) {
      for (const [x, y] of [[190, 124], [322, 124]]) expect(off(perspective.doc, params, x, y), `${JSON.stringify(params)} (${x}, ${y})`).toBeLessThan(1.1);
      expect(off(perspective.doc, params, 256, 121)).toBeLessThan(1e-3);
    }
  });
});

type Raw = Record<string, any>;

// The hero model of docs/RECIPES.md (read only): its starter model and ops blocks.
const RECIPES_MD = readFileSync(new URL('../../../docs/RECIPES.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function recipeBlock(kind: string, name?: string): string {
  const re = /<!-- check:(\w+)([^>]*?)-->[ \t]*\n```\w+\n([\s\S]*?)\n```/g;
  for (const m of RECIPES_MD.matchAll(re)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S*)/g)].map((a) => [a[1], a[2]]));
    if (m[1] === kind && (name === undefined || attrs.name === name)) return m[3];
  }
  throw new Error(`docs/RECIPES.md has no check:${kind}${name ? ` name=${name}` : ''} block`);
}

function heroStarter(): unknown {
  return JSON.parse(recipeBlock('starter'));
}

function recipeOps(name: string): Op[] {
  return JSON.parse(recipeBlock('ops', name)) as Op[];
}

function rigOf(doc: unknown): Rig {
  const { model, diagnostics } = validateModel(doc);
  if (!model) throw new Error(formatDiagnostics(diagnostics));
  return new Rig(model);
}
