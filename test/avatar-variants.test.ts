/**
 * Drawn variants on disk and from the command line (src/node/avatar-variants.ts, "rev2d avatar
 * variants request | import | status", the carry-over in buildAvatarProject, GET /api/avatar):
 * a built project of the repository's own test illustration (test/fixtures/avatar-hana.ts at half
 * size) and "drawings" painted programmatically (src/avatar/__tests__/variants-drawings.ts).
 *
 *   - request: masks, prompts, README and preview written; requests written before are kept up to date;
 *   - import: accepted drawings become sprites in layers.json and the model, a rejected one keeps the
 *     earlier sprite and exits 1 with the reason and hint, a deleted drawing removes its sprite, files
 *     that are not drawings are named; the built model shows the drawing at the sprite's pose;
 *   - status: requested / drawn / accepted / rejected / stale;
 *   - a rebuild of the layers keeps the sprites and flags stale ones; the editor server lists them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/main.js';
import { formatModelJson } from '../src/core/format.js';
import { buildRenderList } from '../src/core/rig.js';
import type { ImageRGBA } from '../src/core/types.js';
import { parseAvatarSpec, type AvatarSpec, type LayersMeta } from '../src/avatar/index.js';
import { EYE_FRONT_Z, hashImage, spriteBackdrop, spritesMeta, variantEditable, variantEditAreas, type SpriteBackdrop } from '../src/avatar/variants.js';
import { buildAvatarProject } from '../src/node/avatar.js';
import { avatarVariantStatus, importAvatarVariants, writeAvatarVariantRequests } from '../src/node/avatar-variants.js';
import type { AvatarInfo, AvatarJobEvent, AvatarVariantRequestsResult, AvatarVariantsInfo } from '../src/node/editor-registry.js';
import { loadModelFile } from '../src/node/load.js';
import { decodePNG, encodePNG, renderImage } from '../src/render/index.js';
import { startEditorServer } from '../src/server/index.js';
import { openEvents, removeDir } from '../src/server/__tests__/helpers.js';
import { addPatch, drawClosedEyes, drawOpenMouth, shiftImage } from '../src/avatar/__tests__/variants-drawings.js';
import { hanaIllustration } from './fixtures/avatar-hana.js';

const hana = hanaIllustration(0.5);
const spec = parseAvatarSpec(hana.doc).spec as AvatarSpec;
const W = hana.width;
const H = hana.height;
const openMouth = drawOpenMouth(hana.image, spec);
/** Closed eyes as an image generator draws them: hair and brows stay in front (set up with the built model). */
const closedEyes: ImageRGBA = drawClosedEyes(hana.image, spec);
/** What lies over the eye sprites at rest in the built model (hair in front of the eyes, brows). */
let eyeBackdrop: SpriteBackdrop;

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-avatar-variants-'));
const template = path.join(root, 'template');
let n = 0;

beforeAll(async () => {
  mkdirSync(template, { recursive: true });
  writeFileSync(path.join(template, 'avatar.json'), formatModelJson(hana.doc));
  writeFileSync(path.join(template, 'source.png'), encodePNG(hana.image));
  await buildAvatarProject(template, { folds: false });
  // The layers drawn over the eye sprites (hair, brows) at rest, put in front of the painted eyes.
  const loaded = await loadModelFile(path.join(template, 'hana.r2d.json'));
  const base = decodePNG(readFileSync(path.join(template, 'textures', 'base.png')));
  const backdrop = spriteBackdrop(loaded.model!, loaded.textures, base, variantEditAreas(spec, 'eyes'));
  eyeBackdrop = backdrop;
  const { rect, above } = backdrop;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const i = (y * rect.width + x) * 4;
      const o = ((y + rect.y) * W + x + rect.x) * 4;
      const a = above.data[i + 3] / 255;
      // Only where the eyes were repainted: elsewhere the drawing is the illustration (hair and brows included).
      const repainted = [0, 1, 2, 3].some((c) => closedEyes.data[o + c] !== hana.image.data[o + c]);
      if (repainted) for (let c = 0; c < 3; c++) closedEyes.data[o + c] = Math.round(above.data[i + c] * a + closedEyes.data[o + c] * (1 - a));
    }
  }
}, 120_000);
afterAll(() => removeDir(root));

/** A fresh copy of the built project, relative to the test root. */
function project(): string {
  const name = `p${n++}`;
  cpSync(template, path.join(root, name), { recursive: true });
  return name;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json(): any;
}

async function run(args: string[]): Promise<RunResult> {
  const buf = { stdout: '', stderr: '' };
  const code = await main(args, {
    stdout: { write: (s: string) => ((buf.stdout += s), true) },
    stderr: { write: (s: string) => ((buf.stderr += s), true) },
    cwd: root,
  });
  return { code, ...buf, json: () => JSON.parse(buf.stdout) };
}

const file = (p: string, rel: string) => path.join(root, p, rel);
const draw = (p: string, id: string, image: ImageRGBA) => {
  mkdirSync(file(p, 'variants'), { recursive: true });
  writeFileSync(file(p, `variants/${id}.png`), encodePNG(image));
};
const metaOf = (p: string) => JSON.parse(readFileSync(file(p, 'textures/layers.json'), 'utf8')) as LayersMeta;
const modelOf = (p: string) => JSON.parse(readFileSync(file(p, 'hana.r2d.json'), 'utf8')) as { parts: Array<{ id: string }> };
const spriteParts = (p: string) => modelOf(p).parts.map((x) => x.id).filter((id) => id.startsWith('sprite_'));

describe('rev2d avatar variants: help and usage', () => {
  it('is a subcommand of avatar with its own help', async () => {
    const parent = await run(['avatar', '--help']);
    expect(parent.stdout).toMatch(/\n\s+variants\s+drawn eye \/ mouth variants/);
    const help = await run(['help', 'avatar', 'variants']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('usage: rev2d avatar variants <request|import|status> <project> [ids...] [--all] [--json]');
    expect(help.stdout).toContain('variant-requests/<id>.mask.png');
    expect(help.stdout).toContain('rev2d avatar variants import projects/miko');
  });

  it('rejects unknown actions and variant ids with suggestions', async () => {
    const p = project();
    const action = await run(['avatar', 'variants', 'requset', p]);
    expect(action.code).toBe(2);
    expect(action.stderr).toContain('unknown variants action "requset"');
    expect(action.stderr).toContain('did you mean "request"?');
    const id = await run(['avatar', 'variants', 'request', p, 'eyes_close']);
    expect(id.code).toBe(2);
    expect(id.stderr).toContain('did you mean "eyes_closed"?');
    expect((await run(['avatar', 'variants', 'status', p, 'eyes_closed'])).code).toBe(2);
    expect((await run(['avatar', 'variants', 'import', p, '--all'])).stderr).toContain('--all applies to "request" only');
    expect((await run(['avatar', 'variants', 'status', 'nowhere'])).code).toBe(1);
  });
});

describe('rev2d avatar variants request', () => {
  it('writes masks, prompts, README and preview for the recommended variants', async () => {
    const p = project();
    const r = await run(['avatar', 'variants', 'request', p]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`wrote 2 variant requests for ${p} (eyes_closed, mouth_a); the drawings must be ${W}x${H} px`);
    expect(r.stdout).toContain(`rev2d avatar variants import ${p}`);
    for (const f of ['eyes_closed.mask.png', 'eyes_closed.prompt.txt', 'mouth_a.mask.png', 'mouth_a.prompt.txt', 'README.md', 'preview.png']) expect(existsSync(file(p, `variant-requests/${f}`)), f).toBe(true);
    const mask = decodePNG(readFileSync(file(p, 'variant-requests/eyes_closed.mask.png')));
    expect([mask.width, mask.height]).toEqual([W, H]);
    const [ex, ey] = spec.face.eyes.imageLeft.opening;
    expect(mask.data[(Math.floor(ey) * W + Math.floor(ex)) * 4 + 3]).toBe(0);
    expect(mask.data[3]).toBe(255);
    expect(readFileSync(file(p, 'variant-requests/mouth_a.prompt.txt'), 'utf8')).toContain('the mouth wide open saying "a"');
    expect(readFileSync(file(p, 'variant-requests/README.md'), 'utf8')).toContain(`rev2d avatar variants import ${p}`);
  });

  it('prints JSON, takes ids or --all, and keeps earlier requests up to date', async () => {
    const p = project();
    const one = await run(['avatar', 'variants', 'request', p, 'mouth_o', '--json']);
    expect(one.code, one.stderr).toBe(0);
    const j = one.json();
    expect(Object.keys(j)).toEqual(['ok', 'dir', 'size', 'transparent', 'requests', 'readme', 'preview', 'files', 'notes', 'next']);
    expect(j).toMatchObject({ ok: true, dir: path.join(root, p), size: [W, H], transparent: true });
    expect(j.requests.map((q: any) => q.id)).toEqual(['mouth_o']);
    expect(Object.keys(j.requests[0])).toEqual(['id', 'group', 'label', 'recommended', 'file', 'maskFile', 'promptFile', 'prompt', 'areas']);
    expect(j.files).toEqual(['variant-requests/mouth_o.mask.png', 'variant-requests/mouth_o.prompt.txt', 'variant-requests/README.md', 'variant-requests/preview.png']);
    // Without ids: the recommended ones plus every variant requested before.
    const again = (await run(['avatar', 'variants', 'request', p, '--json'])).json();
    expect(again.requests.map((q: any) => q.id)).toEqual(['eyes_closed', 'mouth_a', 'mouth_o']);
    const all = (await run(['avatar', 'variants', 'request', p, '--all', '--json'])).json();
    expect(all.requests).toHaveLength(9);
    const listed = readFileSync(file(p, 'variant-requests/README.md'), 'utf8');
    for (const id of ['eyes_half', 'mouth_u', 'mouth_o']) expect(listed).toContain(`\`${id}\``);
  });

  it('fails with the diagnostics when the spec has errors', async () => {
    const p = project();
    const doc = JSON.parse(readFileSync(file(p, 'avatar.json'), 'utf8'));
    doc.face.mouth.area = null;
    writeFileSync(file(p, 'avatar.json'), formatModelJson(doc));
    const r = await run(['avatar', 'variants', 'request', p]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot write variant requests for');
    expect(r.stderr).toContain('the edit areas come from the eye regions and the mouth area of avatar.json');
  });
});

describe('rev2d avatar variants import', () => {
  it('cuts accepted drawings into sprites, reports rejected ones and rebuilds the model', async () => {
    const p = project();
    draw(p, 'eyes_closed', closedEyes);
    draw(p, 'mouth_a', shiftImage(openMouth, 3, 0));
    writeFileSync(file(p, 'variants/eyes_closed (1).png'), encodePNG(closedEyes));
    writeFileSync(file(p, 'variants/mouth_o.jpg'), 'not really');
    const r = await run(['avatar', 'variants', 'import', p]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`imported 2 drawings of ${p}: 1 accepted, 1 rejected`);
    expect(r.stdout).toMatch(/eyes_closed\s+accepted\s+outside 0 \(limit 2\), changed inside [\d.]+% \(image left [\d.]+%, image right [\d.]+%\)/);
    expect(r.stdout).toMatch(/mouth_a\s+REJECTED\s+the whole drawing is shifted by 3 px to the right against source\.png/);
    expect(r.stdout).toContain('hint: Ask the image generator again with source.png and the mask variant-requests/mouth_a.mask.png');
    expect(r.stdout).toMatch(/variants\/eyes_closed \(1\)\.png\s+ignored\s+"eyes_closed \(1\)\.png" is not the name of a variant \(did you mean "eyes_closed\.png"\?/);
    expect(r.stdout).toContain('"mouth_o.jpg" is not a .png file (save the drawing as a PNG named variants/mouth_o.png)');
    expect(r.stdout).toContain('sprites: eyes_closed');

    const meta = metaOf(p);
    expect(meta.variants).toEqual(['eyes_closed']);
    expect(meta.layers.filter((l) => l.id.startsWith('sprite_')).map((l) => l.file)).toEqual(['textures/sprite_eyes_closed_imageLeft.png', 'textures/sprite_eyes_closed_imageRight.png']);
    for (const l of meta.layers) expect(existsSync(file(p, l.file)), l.file).toBe(true);
    expect(spritesMeta(meta)!.rejected.map((x) => x.id)).toEqual(['mouth_a']);
    expect(spriteParts(p)).toEqual(['sprite_eyes_closed_imageLeft', 'sprite_eyes_closed_imageRight']);

    // The built model (every feature) shows the drawing inside the eye areas when the eyes close.
    const loaded = await loadModelFile(file(p, 'hana.r2d.json'));
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const rig = loaded.rig!;
    const image = renderImage(buildRenderList(rig, rig.pose({ params: { EyeLOpen: 0, EyeROpen: 0 }, physics: false })), loaded.textures, { supersample: 1 });
    const editable = variantEditable(variantEditAreas(spec, 'eyes'));
    let worst = 0;
    let count = 0;
    for (let i = 0; i < editable.data.length; i++) {
      if (editable.data[i] < 0.999) continue;
      count++;
      for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(image.data[i * 4 + c] - closedEyes.data[i * 4 + c]));
    }
    expect(count).toBeGreaterThan(500);
    // Hair crosses the eye on the image left: the hair in front of it is drawn above the sprite, and
    // the core pixels it covers are part of the check above.
    const front = loaded.model!.parts.find((x) => x.id === 'eyeR_front');
    expect(front).toMatchObject({ z: EYE_FRONT_Z, parent: 'hairWarp' });
    let covered = 0;
    const { rect, above } = eyeBackdrop;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        if (above.data[(y * rect.width + x) * 4 + 3] > 128 && editable.data[(y + rect.y) * W + x + rect.x] >= 0.999) covered++;
      }
    }
    expect(covered).toBeGreaterThan(20);
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('prints JSON; a rejected drawing keeps the earlier sprite; a fixed one replaces it; a deleted one removes it', async () => {
    const p = project();
    draw(p, 'eyes_closed', closedEyes);
    draw(p, 'mouth_a', openMouth);
    const first = await run(['avatar', 'variants', 'import', p, '--json']);
    expect(first.code, first.stderr).toBe(0);
    const j = first.json();
    expect(Object.keys(j)).toEqual(['ok', 'dir', 'accepted', 'rejected', 'kept', 'removed', 'variants', 'checks', 'unreadable', 'ignored', 'sprites', 'deleted', 'layersFile', 'modelFile', 'modelBytes', 'warnings', 'issues', 'diagnostics', 'notes', 'timings', 'next']);
    expect(j).toMatchObject({ ok: true, accepted: ['eyes_closed', 'mouth_a'], rejected: [], kept: [], removed: [], variants: ['eyes_closed', 'mouth_a'], deleted: [], modelFile: file(p, 'hana.r2d.json') });
    expect(j.sprites).toEqual(['textures/sprite_eyes_closed_imageLeft.png', 'textures/sprite_eyes_closed_imageRight.png', 'textures/sprite_mouth_a_mouth.png']);
    expect(j.checks.map((c: any) => [c.id, c.ok])).toEqual([['eyes_closed', true], ['mouth_a', true]]);
    expect(Object.keys(j.checks[0])).toEqual(expect.arrayContaining(['id', 'ok', 'outsideDiff', 'insideChanged', 'tolerance', 'badShare', 'nearDiff', 'areas', 'size', 'shift', 'scale', 'drawingHash']));
    const sprite = readFileSync(file(p, 'textures/sprite_mouth_a_mouth.png'));

    // A worse drawing of the mouth is rejected; the sprite of the accepted one stays.
    draw(p, 'mouth_a', addPatch(openMouth, 100, 230, 60, 40));
    const bad = await run(['avatar', 'variants', 'import', p, 'mouth_a', '--json']);
    expect(bad.code).toBe(1);
    expect(bad.json()).toMatchObject({ ok: false, accepted: [], rejected: ['mouth_a'], kept: ['mouth_a'], variants: ['eyes_closed', 'mouth_a'] });
    expect(bad.json().notes).toContain('mouth_a: the drawing was rejected, so the sprite of the earlier accepted drawing stays');
    expect(readFileSync(file(p, 'textures/sprite_mouth_a_mouth.png')).equals(sprite)).toBe(true);
    const status = await avatarVariantStatus(file(p, ''));
    expect(status.variants.find((v) => v.id === 'mouth_a')).toMatchObject({ state: 'rejected', sprite: true, drawn: true });

    // Deleting a drawing and importing removes its sprite and its image.
    rmSync(file(p, 'variants/eyes_closed.png'));
    draw(p, 'mouth_a', openMouth);
    const removed = (await run(['avatar', 'variants', 'import', p, '--json'])).json();
    expect(removed).toMatchObject({ ok: true, accepted: ['mouth_a'], removed: ['eyes_closed'], variants: ['mouth_a'], deleted: ['textures/sprite_eyes_closed_imageLeft.png', 'textures/sprite_eyes_closed_imageRight.png'] });
    expect(existsSync(file(p, 'textures/sprite_eyes_closed_imageLeft.png'))).toBe(false);
    expect(spriteParts(p)).toEqual(['sprite_mouth_a_mouth']);
    expect(spritesMeta(metaOf(p))!.rejected).toEqual([]);
  });

  it('fails without drawings, or before the first build', async () => {
    const p = project();
    const none = await run(['avatar', 'variants', 'import', p]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no drawings to import in');
    expect(none.stderr).toContain(`rev2d avatar variants request`);
    const unbuilt = `u${n++}`;
    mkdirSync(path.join(root, unbuilt));
    for (const f of ['avatar.json', 'source.png']) cpSync(path.join(template, f), path.join(root, unbuilt, f));
    draw(unbuilt, 'eyes_closed', closedEyes);
    const early = await run(['avatar', 'variants', 'import', unbuilt]);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain('is not built yet');
    expect(early.stderr).toContain('build it first');
  });

  it('reports a drawing that is not a PNG as rejected', async () => {
    const p = project();
    mkdirSync(file(p, 'variants'), { recursive: true });
    writeFileSync(file(p, 'variants/eyes_closed.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    const r = await run(['avatar', 'variants', 'import', p, '--json']);
    expect(r.code).toBe(1);
    expect(r.json().unreadable).toEqual([expect.objectContaining({ id: 'eyes_closed', file: 'variants/eyes_closed.png', reason: expect.stringContaining('is a JPEG image') })]);
    expect(r.json().rejected).toEqual(['eyes_closed']);
  });
});

describe('rev2d avatar variants status', () => {
  it('lists requested, drawn, accepted, rejected and stale variants', async () => {
    const p = project();
    expect((await run(['avatar', 'variants', 'request', p, 'eyes_half'])).code).toBe(0);
    draw(p, 'eyes_closed', closedEyes);
    draw(p, 'mouth_a', openMouth);
    expect((await run(['avatar', 'variants', 'import', p])).code).toBe(0);
    draw(p, 'mouth_o', openMouth);
    draw(p, 'mouth_a', drawOpenMouth(hana.image, spec, 0.5));
    const text = await run(['avatar', 'variants', 'status', p]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`variants of ${p}: 1 accepted, 1 stale, 1 drawn, 1 requested`);
    expect(text.stdout).toMatch(/eyes_closed\s+accepted\s+-\s+yes\s+yes\s+outside 0, changed inside/);
    expect(text.stdout).toMatch(/mouth_a\s+stale\s+-\s+yes\s+yes\s+variants\/mouth_a\.png changed since it was imported/);
    expect(text.stdout).toMatch(/mouth_o\s+drawn\s+-\s+yes\s+-/);
    expect(text.stdout).toMatch(/eyes_half\s+requested\s+yes\s+-\s+-/);
    expect(text.stderr).toContain('1 drawing is not imported yet');
    const j = (await run(['avatar', 'variants', 'status', p, '--json'])).json();
    expect(Object.keys(j)).toEqual(['ok', 'dir', 'name', 'built', 'variants', 'counts', 'ignored', 'notes']);
    expect(j).toMatchObject({ ok: true, name: 'hana', built: true, counts: { accepted: 1, stale: 1, drawn: 1, requested: 1, rejected: 0, missing: 5 } });
    expect(j.variants).toHaveLength(9);
    expect(Object.keys(j.variants[0])).toEqual(['id', 'group', 'label', 'recommended', 'state', 'requested', 'drawn', 'sprite', 'stale', 'rejection', 'check', 'file', 'maskFile', 'promptFile']);
  });
});

describe('sprites across builds', () => {
  it('survive a rebuild of the layers, and go stale when the mouth area changes', async () => {
    const p = project();
    draw(p, 'eyes_closed', closedEyes);
    draw(p, 'mouth_a', openMouth);
    await importAvatarVariants(file(p, ''));
    const before = metaOf(p);
    const sprite = statSync(file(p, 'textures/sprite_mouth_a_mouth.png')).mtimeMs;
    const rebuilt = await buildAvatarProject(file(p, ''), { folds: false });
    expect(rebuilt.removed).toEqual([]);
    expect(metaOf(p)).toEqual(before);
    expect(statSync(file(p, 'textures/sprite_mouth_a_mouth.png')).mtimeMs).toBe(sprite);
    expect(spriteParts(p)).toEqual(['sprite_eyes_closed_imageLeft', 'sprite_eyes_closed_imageRight', 'sprite_mouth_a_mouth']);
    expect(rebuilt.report.issues.filter((i) => i.code.startsWith('avatar-variant'))).toEqual([]);

    // The mouth area moves (its sprite goes stale) and a sprite image is deleted by hand (that variant is left out).
    const doc = JSON.parse(readFileSync(file(p, 'avatar.json'), 'utf8'));
    doc.face.mouth.area.radius = [doc.face.mouth.area.radius[0] - 2, doc.face.mouth.area.radius[1]];
    writeFileSync(file(p, 'avatar.json'), formatModelJson(doc));
    rmSync(file(p, 'textures/sprite_eyes_closed_imageLeft.png'));
    const moved = await buildAvatarProject(file(p, ''), { folds: false });
    expect(moved.report.issues.filter((i) => i.code.startsWith('avatar-variant'))).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'avatar-variant-stale', message: expect.stringContaining('mouth_a') }),
      expect.objectContaining({ severity: 'warning', code: 'avatar-variant-sprite-missing', message: expect.stringContaining('eyes_closed') }),
    ]);
    expect(metaOf(p).variants).toEqual(['mouth_a']);
    expect(existsSync(file(p, 'textures/sprite_eyes_closed_imageRight.png'))).toBe(false);
    const stale = await avatarVariantStatus(file(p, ''));
    expect(stale.variants.find((v) => v.id === 'mouth_a')).toMatchObject({ state: 'stale', stale: ['the mouth area changed since the sprite was cut'] });
    expect(stale.variants.find((v) => v.id === 'eyes_closed')).toMatchObject({ state: 'drawn', sprite: false });
    // Importing again cuts both anew.
    await importAvatarVariants(file(p, ''));
    expect((await avatarVariantStatus(file(p, ''))).counts).toMatchObject({ accepted: 2, stale: 0 });
    expect(existsSync(file(p, 'textures/sprite_eyes_closed_imageLeft.png'))).toBe(true);
  });

  it('are deterministic: the same drawings give the same files', async () => {
    const a = project();
    const b = project();
    for (const p of [a, b]) {
      draw(p, 'eyes_closed', closedEyes);
      await importAvatarVariants(file(p, ''));
    }
    for (const rel of ['textures/layers.json', 'hana.r2d.json', 'textures/sprite_eyes_closed_imageLeft.png']) expect(readFileSync(file(a, rel)).equals(readFileSync(file(b, rel))), rel).toBe(true);
    const req = await writeAvatarVariantRequests(file(a, ''));
    const req2 = await writeAvatarVariantRequests(file(b, ''));
    for (const rel of req.files) expect(readFileSync(file(a, rel)).equals(readFileSync(file(b, rel))), rel).toBe(true);
    expect(req2.files).toEqual(req.files);
    expect(spritesMeta(metaOf(a))!.sprites[0].drawingHash).toBe(hashImage(closedEyes));
  });
});

describe('the editor server', () => {
  /** An editor server on the test root (builds and imports inline unless `process`), with the project open and an event stream. */
  async function serve(p: string, process = false) {
    const server = await startEditorServer({ root: path.join(root, p), port: 0, devVite: false, register: false, staticDir: path.join(root, p, '.no-ui'), log: () => {}, avatar: process ? {} : { build: 'inline' } });
    const sse = await openEvents(server.url);
    const opened = await fetch(`${server.url}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: file(p, 'avatar.json') }) });
    expect(opened.status, await opened.text()).toBe(200);
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(server.url + url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    const jobEnd = async (timeoutMs = 60_000) => (await sse.next((e) => e.event === 'avatar-job' && e.data.state !== 'running', timeoutMs)).data as AvatarJobEvent;
    const close = async () => {
      sse.close();
      await server.close();
    };
    return { server, sse, call, jobEnd, close };
  }

  it('lists the variants with their states and edit areas, writes requests and imports drawings as a job', async () => {
    const p = project();
    draw(p, 'eyes_closed', closedEyes);
    draw(p, 'mouth_a', shiftImage(openMouth, 3, 0));
    const s = await serve(p);
    try {
      const before = await s.call('GET', '/api/avatar/variants');
      expect(before.status).toBe(200);
      const info = before.body as AvatarVariantsInfo;
      expect(info).toMatchObject({ project: path.join(root, p), built: true, requests: { readme: null, preview: null } });
      expect(info.variants.map((v) => [v.id, v.state])).toEqual([['eyes_closed', 'drawn'], ['eyes_half', 'missing'], ['eyes_smile', 'missing'], ['mouth_a', 'drawn'], ['mouth_a_half', 'missing'], ['mouth_i', 'missing'], ['mouth_u', 'missing'], ['mouth_e', 'missing'], ['mouth_o', 'missing']]);
      const eyes = info.areas.eyes!;
      for (const side of ['imageLeft', 'imageRight'] as const) {
        const r = spec.face.eyes[side].region;
        for (let i = 0; i < r.length; i += 2) expect(r[i] >= eyes[0] && r[i] <= eyes[0] + eyes[2] && r[i + 1] >= eyes[1] && r[i + 1] <= eyes[1] + eyes[3]).toBe(true);
      }
      expect(info.areas.mouth).toHaveLength(4);

      // Requests: masks, prompts, README and preview.
      const req = await s.call('POST', '/api/avatar/variants/request', { ids: ['eyes_half'] });
      expect(req.status).toBe(200);
      const written = req.body as AvatarVariantRequestsResult;
      expect(written.requests.map((r) => r.id)).toEqual(['eyes_half']);
      expect(written).toMatchObject({ readme: 'variant-requests/README.md', preview: 'variant-requests/preview.png' });
      expect(existsSync(file(p, 'variant-requests/eyes_half.mask.png'))).toBe(true);
      expect((await s.call('POST', '/api/avatar/variants/request', { ids: ['eyes_open'] })).status).toBe(400);

      // The import is a job: 202, then "avatar-job" events of kind "variants".
      const started = await s.call('POST', '/api/avatar/variants/import');
      expect(started.status).toBe(202);
      expect(started.body).toMatchObject({ state: 'running', step: 'start', kind: 'variants', layers: false });
      const end = await s.jobEnd();
      expect(end).toMatchObject({ state: 'done', kind: 'variants' });
      expect(end.message).toMatch(/^imported the drawn variants of "hana": 1 accepted, 1 rejected in /);
      expect(end.variants).toMatchObject({ accepted: ['eyes_closed'], kept: [], removed: [], variants: ['eyes_closed'] });
      expect(end.variants!.rejected).toEqual([expect.objectContaining({ id: 'mouth_a', reason: expect.stringContaining('shifted by 3 px'), hint: expect.any(String) })]);
      expect(end.report!.layerFiles).toEqual(['textures/sprite_eyes_closed_imageLeft.png', 'textures/sprite_eyes_closed_imageRight.png']);
      expect(((await s.call('GET', '/api/avatar')).body as AvatarInfo).built.variants).toEqual(['eyes_closed']);
      const after = (await s.call('GET', '/api/avatar/variants')).body as AvatarVariantsInfo;
      expect(Object.fromEntries(after.variants.map((v) => [v.id, v.state]))).toMatchObject({ eyes_closed: 'accepted', eyes_half: 'requested', mouth_a: 'rejected' });
      expect(after.variants.find((v) => v.id === 'mouth_a')!.rejection?.reason).toContain('shifted by 3 px');
      expect(after.requests).toEqual({ readme: 'variant-requests/README.md', preview: 'variant-requests/preview.png' });

      // Removing a variant deletes its drawing and its sprite.
      expect((await s.call('POST', '/api/avatar/variants/import', { remove: ['eyes_closed'] })).status).toBe(202);
      const removed = await s.jobEnd();
      expect(removed).toMatchObject({ state: 'done', kind: 'variants' });
      expect(removed.variants).toMatchObject({ removed: ['eyes_closed'], variants: [] });
      expect(existsSync(file(p, 'variants/eyes_closed.png'))).toBe(false);
      expect(existsSync(file(p, 'textures/sprite_eyes_closed_imageLeft.png'))).toBe(false);
      // Removing a drawing that never had a sprite: nothing left to import is fine.
      draw(p, 'mouth_o', openMouth);
      expect((await s.call('POST', '/api/avatar/variants/import', { ids: ['mouth_o'], remove: ['mouth_o'] })).status).toBe(202);
      expect((await s.jobEnd()).variants).toMatchObject({ removed: ['mouth_o'], accepted: [] });
      expect((await s.call('POST', '/api/avatar/variants/import', { remove: ['mouth_x'] })).status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('runs the import as a child process by default', async () => {
    const p = project();
    draw(p, 'eyes_closed', closedEyes);
    const s = await serve(p, true);
    try {
      expect((await s.call('POST', '/api/avatar/variants/import')).status).toBe(202);
      const end = await s.jobEnd(180_000);
      expect(end.message).toMatch(/1 accepted, 0 rejected/);
      expect(end).toMatchObject({ state: 'done', kind: 'variants', variants: { accepted: ['eyes_closed'], variants: ['eyes_closed'] } });
      expect(((await s.call('GET', '/api/avatar')).body as AvatarInfo).built.variants).toEqual(['eyes_closed']);
    } finally {
      await s.close();
    }
  }, 240_000);
});
