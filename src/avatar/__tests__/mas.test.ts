/**
 * Import of a Mesh Avatar Studio rig.json (version 1) on a small hand-written rig: field mapping,
 * unit conversion, derived face oval and chin, notes, and validity of the result.
 */
import { describe, expect, it } from 'vitest';
import { formatDiagnostics } from '../../core/validate.js';
import { importMasRig, MasImportError } from '../mas.js';
import { parseAvatarSpec } from '../spec.js';
import { HEIGHT, masRig, WIDTH, type Json } from './fixtures.js';

function imported(mutate: (rig: Json) => void = () => {}, name?: string) {
  const rig = masRig();
  mutate(rig);
  const r = importMasRig(rig, name === undefined ? {} : { name });
  return { doc: r.doc as Json, notes: r.notes, text: r.notes.join('\n') };
}

describe('importMasRig', () => {
  it('produces a spec that validates against the image', () => {
    const { doc } = imported(undefined, 'sample');
    const r = parseAvatarSpec(doc, { imageSize: { width: WIDTH, height: HEIGHT } });
    expect(formatDiagnostics(r.diagnostics)).toBe('0 errors, 0 warnings');
    expect(r.spec).not.toBeNull();
    expect(doc).toMatchObject({ format: 'rev2d-avatar', version: 1, name: 'sample', image: { file: 'source.png', width: WIDTH, height: HEIGHT } });
    expect(imported().doc.name).toBe('avatar');
    expect(imported(undefined, 'my avatar').doc.name).toBe('my_avatar');
  });

  it('maps the head and converts radians to degrees', () => {
    const { doc, text } = imported();
    expect(doc.head).toEqual({ center: [200, 170], radius: [130, 150], pivot: [200, 300], neck: [285, 340], turn: { x: 14, y: 11 }, tilt: 9 });
    expect(text).toContain('head.turnBand [290, 380] is not imported');
  });

  it('maps eyes[0] / eyes[1] to imageLeft / imageRight with roi as region', () => {
    const { doc, text } = imported();
    expect(doc.face.eyes.imageLeft).toEqual({
      opening: [150, 195, 155, 188, 165, 185, 175, 188, 180, 195, 175, 202, 165, 205, 155, 202],
      region: [142, 195, 150, 180, 165, 176, 180, 180, 188, 195, 180, 210, 165, 214, 150, 210],
    });
    expect(doc.face.eyes.imageRight.opening.slice(0, 4)).toEqual([220, 195, 225, 188]);
    expect(text).toContain('The generated eye curves (x0, x1, top, bot) are not imported');
    // Eyes listed right-to-left are put on the right sides.
    const swapped = imported((rig) => rig.eyes.reverse());
    expect(swapped.doc.face.eyes.imageLeft.opening[0]).toBe(150);
    expect(swapped.text).toContain('eyes[0] lies right of eyes[1]');
  });

  it('turns the mouth line (centre, angle, half length) into two corners and keeps the bow', () => {
    const { doc } = imported();
    // 16 px along 30 degrees clockwise: (13.86, 8).
    expect(doc.face.mouth.imageLeft).toEqual([186.14, 240]);
    expect(doc.face.mouth.imageRight).toEqual([213.86, 256]);
    expect(doc.face.mouth.bow).toBe(2);
    expect(doc.face.mouth.area).toEqual({ center: [200, 250], radius: [24, 14], rotation: 15 });
    // A line that runs right-to-left still yields imageLeft on the left.
    const reversed = imported((rig) => (rig.mouth.angle = Math.PI));
    expect(reversed.doc.face.mouth.imageLeft[0]).toBeLessThan(reversed.doc.face.mouth.imageRight[0]);
  });

  it('takes nose, cheeks and ears, and says that the brow region is dropped', () => {
    const { doc, text } = imported();
    expect(doc.face.nose).toEqual([200, 225]);
    expect(doc.face.cheeks).toEqual({ imageLeft: [155, 225], imageRight: [245, 225] });
    expect(doc.face.ears).toEqual({ imageLeft: [122, 200], imageRight: [278, 200] });
    expect(doc.face.brows).toBeUndefined();
    expect(text).toContain('face.brow (one brow region) is not imported');
    expect(text).toContain('remove an ear that is not visible');
    const oneEar = imported((rig) => delete rig.face.earL);
    expect(oneEar.doc.face.ears).toEqual({ imageRight: [278, 200] });
  });

  it('derives the face oval and the chin from the face ellipses and says so', () => {
    const { doc, text } = imported();
    // Axis: eye midpoint (200, 195) -> mouth (200, 248), straight down. Chin: 65% of the jaw
    // ellipse's 24 px below its centre (200, 262).
    expect(doc.face.chin).toEqual([200, 277.6]);
    // Centre: halfway between the eye midpoint and the nose (200, 225).
    expect(doc.face.center).toEqual([200, 210]);
    // Radii: 0.9 x the distance to the ears (78.6), and the distance to the chin.
    expect(doc.face.radius).toEqual([70.8, 67.6]);
    expect(text).toContain('face.center [200, 210], face.radius [70.8, 67.6] and face.chin [200, 277.6] were estimated');
    expect(doc.notes).toEqual(['Imported from a Mesh Avatar Studio rig.json. Estimated by the importer, check them in the overlay: face.center, face.radius, face.chin.']);
    // A tilted head: the chin follows the face axis.
    const tilted = imported((rig) => {
      rig.mouth.cx = 220;
      delete rig.face.jaw;
    });
    expect(tilted.doc.face.chin[0]).toBeGreaterThan(225);
    // Without a jaw ellipse: 0.75 x the eye-to-mouth distance below the mouth; without ears: 0.85 x the eye distance.
    const bare = imported((rig) => {
      delete rig.face.jaw;
      delete rig.face.earL;
      delete rig.face.earR;
    });
    expect(bare.doc.face.chin).toEqual([200, 287.8]);
    expect(bare.doc.face.radius[0]).toBe(59.5);
  });

  it('maps strands: sigma -> width (x 2), k -> stiffness, max -> swing, with a guessed group', () => {
    const { doc, text } = imported();
    expect(doc.hair.strands).toEqual([
      { id: 'bang1', nodes: [170, 60, 165, 110, 160, 160], width: 20, swing: 6, stiffness: 1.1, group: 'front' },
      { id: 'lock_right', nodes: [300, 120, 310, 220, 305, 320], width: 24, swing: 9, stiffness: 0.6, group: 'side' },
    ]);
    expect(text).toContain('Strand width is 2 x sigma');
    expect(text).toContain('bang1: front, lock_right: side');
    const dup = imported((rig) => (rig.strands[1].name = 'bang1'));
    expect(dup.doc.hair.strands.map((s: Json) => s.id)).toEqual(['bang1', 'bang1_2']);
  });

  it('maps buns, accessories and the hand to attachments', () => {
    const { doc, text } = imported();
    expect(doc.attachments).toEqual([
      { id: 'bunL', kind: 'jiggle', center: [120, 60], radius: [40, 35] },
      { id: 'tassel_r', kind: 'pendulum', outline: [310, 150, 335, 150, 335, 230, 310, 230], pivot: [322, 152], tip: [322, 228], follow: 'head' },
      { id: 'hand', kind: 'cutout', outline: [140, 300, 190, 300, 190, 420, 140, 420], follow: 'body', contact: [180, 285] },
    ]);
    expect(text).toContain("Pendulum outlines (tassel_r) are the accessories' bounding boxes");
    expect(text).toContain('Not imported: hand.elbow, hand.wrist, hand.forearmShare');
    // An accessory that hangs outside the head ellipse follows the body.
    const low = imported((rig) => Object.assign(rig.accessories[0], { pivot: [322, 400], tip: [322, 470], box: [310, 398, 335, 472] }));
    expect(low.doc.attachments[1].follow).toBe('body');
  });

  it('maps the body: roll band -> fade, roll -> sway in degrees, shoulders left first', () => {
    const { doc, text } = imported();
    expect(doc.body).toEqual({ pivot: [200, 620], fade: [380, 500], sway: 3, chest: { center: [200, 420], radius: [110, 70] }, shoulders: [[90, 380], [310, 380]] });
    expect(text).toContain('body.breathBand [400, 500] is not imported');
    expect(text).toContain('mesh (cell sizes) is not imported');
    expect(text).toContain('view (padding, gaze centre) is not imported');
    const one = imported((rig) => rig.body.shoulders.pop());
    expect(one.doc.body.shoulders).toBeUndefined();
    expect(one.text).toContain('body.shoulders has 1 entry');
  });

  it('leaves what the rig lacks to be placed, like a draft', () => {
    const { doc, text } = imported((rig) => {
      delete rig.mouth;
      delete rig.face.mouth;
      delete rig.eyes;
      delete rig.face.eyeA;
      delete rig.body;
      delete rig.strands;
      delete rig.accessories;
      delete rig.hand;
      delete rig.buns;
    });
    const r = parseAvatarSpec(doc);
    expect(new Set(r.diagnostics.map((d) => d.code))).toEqual(new Set(['avatar-missing-landmark']));
    expect(r.diagnostics.map((d) => d.path)).toContain('/face/eyes/imageLeft/opening');
    expect(r.diagnostics.map((d) => d.path)).toContain('/face/chin');
    expect(r.diagnostics.map((d) => d.path)).toContain('/body/pivot');
    expect(text).toContain('The rig lists 0 eyes');
    expect(text).toContain('The rig has no "mouth"');
    expect(text).toContain('The rig has no "body"');
    expect(text).toContain('could not be estimated');
    expect(doc.hair).toEqual({ strands: [] });
    expect(doc.attachments).toEqual([]);
    // Only the face.mouth ellipse: corners and area are estimated from it.
    const ellipseOnly = imported((rig) => delete rig.mouth);
    expect(ellipseOnly.doc.face.mouth).toEqual({ imageLeft: [186.8, 250], imageRight: [213.2, 250], bow: 0, area: { center: [200, 250], radius: [22, 12], rotation: 0 } });
    expect(ellipseOnly.text).toContain('estimated from the face.mouth ellipse');
  });

  it('rejects what is not a version 1 rig', () => {
    const fail = (rig: unknown) => {
      try {
        importMasRig(rig);
      } catch (e) {
        expect(e).toBeInstanceOf(MasImportError);
        return e as MasImportError;
      }
      throw new Error('expected a MasImportError');
    };
    expect(fail([]).message).toMatch(/is a JSON object/);
    expect(fail({ ...masRig(), version: 2 }).message).toBe('unsupported rig.json version 2');
    expect(fail({ version: 1 }).hint).toMatch(/image\.width and image\.height/);
    expect(fail({ version: 1, image: { width: 10.5, height: 10 } }).message).toMatch(/no usable image size/);
  });
});
