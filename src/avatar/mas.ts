/**
 * Import of a Mesh Avatar Studio project: its rig.json (version 1, the documented field reference
 * is docs/rig-fields.md of that project) -> a Rev2D avatar spec document.
 *
 *   importMasRig(rig, {name?}) -> {doc, notes}
 *
 * `doc` is a RAW avatar.json value (validate it with parseAvatarSpec; what the rig lacks stays
 * `null`, to be placed like in a draft). `notes` name everything that was approximated, derived or
 * left out. This is an independent reading of the documented format; no code of that project is used.
 *
 * Mapping (MAS angles are radians, Rev2D degrees; both are clockwise-positive with +y down):
 *
 *   image.width / height        -> image
 *   head cx cy rx ry             -> head.center, head.radius
 *   head pivotX pivotY           -> head.pivot
 *   head weightBand              -> head.neck
 *   head shiftX / shiftY         -> head.turn.x / .y
 *   head maxRoll (rad)           -> head.tilt (deg)
 *   eyes[0], eyes[1]             -> face.eyes.imageLeft / imageRight (opening; roi -> region)
 *   face.nose (ellipse)          -> face.nose (its centre)
 *   mouth cx cy angle halfLen bow -> face.mouth.imageLeft / imageRight (centre -+ halfLen along the angle), bow
 *   mouth.area                   -> face.mouth.area (angle -> rotation in degrees)
 *   cheeks                       -> face.cheeks
 *   face.earL / earR             -> face.ears (assigned to the image side they lie on)
 *   face eyes / nose / jaw / ears -> face.center, face.radius, face.chin (DERIVED, see deriveFace)
 *   strands name nodes sigma k max -> hair.strands id nodes width (= 2 x sigma) stiffness swing; group guessed
 *   buns                         -> attachments of kind "jiggle"
 *   accessories pivot tip box    -> attachments of kind "pendulum" with the box as a rectangular outline
 *   hand.outline, hand.contact   -> an attachment of kind "cutout" (follow: body)
 *   body pivotX pivotY           -> body.pivot
 *   body rollBand                -> body.fade
 *   body maxRoll (rad)           -> body.sway (deg)
 *   body.chest, body.shoulders   -> body.chest, body.shoulders (two ellipse centres, image left first)
 *
 * Not imported (no counterpart; each is named in the notes when present): head.turnBand,
 * body.breathBand, face.brow and the jaw band, the generated eye curves (x0, x1, top, bot),
 * accessory split and colour isolation, the hand's jaw / background reconstruction, joints and
 * bands, mesh cell sizes, view settings.
 */
import { AVATAR_FORMAT, AVATAR_VERSION } from './schema.js';
import { avatarSpecName, draftAvatarSpec } from './spec.js';
import { ellipseLevel, round, type Vec2 } from './tools/geometry.js';

export class MasImportError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'MasImportError';
  }
}

export interface MasImportOptions {
  /** Name of the avatar (default "avatar"); made a valid id. */
  name?: string;
}

export interface MasImportResult {
  /** A raw avatar spec document. */
  doc: Record<string, unknown>;
  /** What was approximated, derived or not imported, one sentence each. */
  notes: string[];
}

type Obj = Record<string, unknown>;

const RAD_TO_DEG = 180 / Math.PI;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pair(v: unknown): Vec2 | null {
  return Array.isArray(v) && v.length === 2 && num(v[0]) !== null && num(v[1]) !== null ? [v[0] as number, v[1] as number] : null;
}

interface Ellipse {
  center: Vec2;
  radius: Vec2;
}

/** {cx, cy, rx, ry} -> centre and radii. */
function ellipse(v: unknown): Ellipse | null {
  if (!isObj(v)) return null;
  const cx = num(v.cx);
  const cy = num(v.cy);
  const rx = num(v.rx);
  const ry = num(v.ry);
  return cx !== null && cy !== null && rx !== null && ry !== null && rx > 0 && ry > 0 ? { center: [cx, cy], radius: [rx, ry] } : null;
}

/** [[x, y], ...] -> flat [x0, y0, x1, y1, ...]. */
function flat(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: number[] = [];
  for (const p of v) {
    const q = pair(p);
    if (!q) return null;
    out.push(q[0], q[1]);
  }
  return out;
}

function deg(rad: number): number {
  return round(rad * RAD_TO_DEG, 3);
}

function uniqueId(text: string, used: Set<string>): string {
  const base = avatarSpecName(text);
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
  used.add(id);
  return id;
}

function centroidX(points: number[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 2) sum += points[i];
  return sum / (points.length / 2);
}

export function importMasRig(rig: unknown, options: MasImportOptions = {}): MasImportResult {
  if (!isObj(rig)) throw new MasImportError('a Mesh Avatar Studio rig is a JSON object', 'pass the parsed rig.json of the project');
  if (rig.version !== 1) {
    throw new MasImportError(`unsupported rig.json version ${JSON.stringify(rig.version)}`, 'this importer reads Mesh Avatar Studio rig.json version 1');
  }
  const image = isObj(rig.image) ? rig.image : {};
  const width = num(image.width);
  const height = num(image.height);
  if (width === null || height === null || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new MasImportError('rig.json has no usable image size', 'image.width and image.height must be the pixel size of the source illustration');
  }

  const notes: string[] = [];
  const derived: string[] = [];
  const doc = draftAvatarSpec(options.name ?? 'avatar', width, height);
  doc.format = AVATAR_FORMAT;
  doc.version = AVATAR_VERSION;

  // ------------------------------------------------------------------ head
  const head = isObj(rig.head) ? rig.head : null;
  const headEllipse = ellipse(head);
  if (head) {
    const out: Obj = {
      center: headEllipse?.center ?? null,
      radius: headEllipse?.radius ?? null,
      pivot: num(head.pivotX) !== null && num(head.pivotY) !== null ? [head.pivotX, head.pivotY] : null,
      neck: pair(head.weightBand),
    };
    const shiftX = num(head.shiftX);
    const shiftY = num(head.shiftY);
    if (shiftX !== null && shiftY !== null) out.turn = { x: Math.abs(shiftX), y: Math.abs(shiftY) };
    const roll = num(head.maxRoll);
    if (roll !== null) out.tilt = Math.abs(deg(roll));
    doc.head = out;
    const turnBand = pair(head.turnBand);
    if (turnBand) notes.push(`head.turnBand [${turnBand.join(', ')}] is not imported: in Rev2D the turn ends at the head ellipse and the head motion fades over head.neck (= weightBand).`);
  } else {
    notes.push('The rig has no "head": place head.center, head.radius, head.pivot and head.neck by hand.');
  }

  // ------------------------------------------------------------------ eyes
  const face = doc.face as Obj;
  const rigFace = isObj(rig.face) ? rig.face : {};
  const eyes = Array.isArray(rig.eyes) ? rig.eyes : [];
  const eyeEntries = eyes.slice(0, 2).map((e) => (isObj(e) ? { opening: flat(e.opening), region: flat(e.roi) } : { opening: null, region: null }));
  while (eyeEntries.length < 2) eyeEntries.push({ opening: null, region: null });
  if (eyes.length !== 2) notes.push(`The rig lists ${eyes.length} eyes (2 expected): trace the missing eye's opening and region by hand.`);
  const [first, second] = eyeEntries;
  const firstShape = first.opening ?? first.region;
  const secondShape = second.opening ?? second.region;
  if (firstShape && secondShape && centroidX(firstShape) > centroidX(secondShape)) {
    eyeEntries.reverse();
    notes.push('eyes[0] lies right of eyes[1] in the image: the two were swapped so that imageLeft is the eye on the image left.');
  }
  face.eyes = { imageLeft: eyeEntries[0], imageRight: eyeEntries[1] };
  if (eyes.some((e) => isObj(e) && ('top' in e || 'bot' in e))) {
    notes.push('The generated eye curves (x0, x1, top, bot) are not imported: Rev2D samples the opening curves when it builds the layers.');
  }

  // ------------------------------------------------------------------ nose, mouth, cheeks, ears
  const nose = ellipse(rigFace.nose);
  face.nose = nose ? nose.center : null;
  if (!nose) notes.push('The rig has no face.nose: place face.nose (the nose tip) by hand.');

  const mouth = isObj(rig.mouth) ? rig.mouth : null;
  let mouthCenter: Vec2 | null = null;
  if (mouth && num(mouth.cx) !== null && num(mouth.cy) !== null && num(mouth.halfLen) !== null) {
    const angle = num(mouth.angle) ?? 0;
    const half = Math.abs(mouth.halfLen as number);
    const dx = Math.cos(angle) * half;
    const dy = Math.sin(angle) * half;
    mouthCenter = [mouth.cx as number, mouth.cy as number];
    let left: Vec2 = [round(mouthCenter[0] - dx, 2), round(mouthCenter[1] - dy, 2)];
    let right: Vec2 = [round(mouthCenter[0] + dx, 2), round(mouthCenter[1] + dy, 2)];
    if (left[0] > right[0]) [left, right] = [right, left];
    const area = ellipse(mouth.area);
    const areaAngle = isObj(mouth.area) ? (num(mouth.area.angle) ?? 0) : 0;
    face.mouth = {
      imageLeft: left,
      imageRight: right,
      bow: num(mouth.bow) ?? 0,
      area: area ? { center: area.center, radius: area.radius, rotation: deg(areaAngle) } : { center: null, radius: null, rotation: 0 },
    };
    if (!area) notes.push('The rig has no mouth.area: place face.mouth.area (an ellipse a little larger than the lips) by hand.');
  } else {
    const region = ellipse(rigFace.mouth);
    if (region) {
      mouthCenter = region.center;
      face.mouth = {
        imageLeft: [round(region.center[0] - region.radius[0] * 0.6, 2), region.center[1]],
        imageRight: [round(region.center[0] + region.radius[0] * 0.6, 2), region.center[1]],
        bow: 0,
        area: { center: region.center, radius: region.radius, rotation: 0 },
      };
      derived.push('face.mouth');
      notes.push('The rig has no "mouth" line: the mouth corners and area were estimated from the face.mouth ellipse; check them.');
    } else {
      notes.push('The rig has no "mouth": place the mouth corners and the mouth area by hand.');
    }
  }

  const cheeks = Array.isArray(rig.cheeks) && rig.cheeks.length === 2 ? [pair(rig.cheeks[0]), pair(rig.cheeks[1])] : null;
  if (cheeks && cheeks[0] && cheeks[1]) {
    const [a, b] = cheeks[0][0] <= cheeks[1][0] ? [cheeks[0], cheeks[1]] : [cheeks[1], cheeks[0]];
    face.cheeks = { imageLeft: a, imageRight: b };
  }

  const ears = [ellipse(rigFace.earL), ellipse(rigFace.earR)].filter((e): e is Ellipse => e !== null).sort((a, b) => a.center[0] - b.center[0]);
  const middleX = headEllipse?.center[0] ?? width / 2;
  const earLeft = ears.find((e) => e.center[0] < middleX);
  const earRight = [...ears].reverse().find((e) => e.center[0] >= middleX);
  if (earLeft || earRight) {
    face.ears = { ...(earLeft ? { imageLeft: earLeft.center } : {}), ...(earRight ? { imageRight: earRight.center } : {}) };
    notes.push('face.ears come from earL / earR, which Mesh Avatar Studio marks even where hair hides the ear: remove an ear that is not visible.');
  }
  if (isObj(rigFace.brow)) notes.push('face.brow (one brow region) is not imported: Rev2D brows are two polylines; add face.brows when both brows are visible.');

  // ------------------------------------------------------------------ face oval and chin (derived)
  const eyeCenters = [ellipse(rigFace.eyeA)?.center ?? null, ellipse(rigFace.eyeB)?.center ?? null];
  const shapes = [eyeEntries[0].opening ?? eyeEntries[0].region, eyeEntries[1].opening ?? eyeEntries[1].region];
  const eyeA = eyeCenters[0] ?? (shapes[0] ? meanPoint(shapes[0]) : null);
  const eyeB = eyeCenters[1] ?? (shapes[1] ? meanPoint(shapes[1]) : null);
  const derivedFace = deriveFace({ eyeA, eyeB, nose: nose?.center ?? null, mouth: mouthCenter, jaw: ellipse(rigFace.jaw), ears: ears.map((e) => e.center) });
  face.center = derivedFace.center;
  face.radius = derivedFace.radius;
  face.chin = derivedFace.chin;
  if (derivedFace.center) derived.push('face.center', 'face.radius');
  if (derivedFace.chin) derived.push('face.chin');
  if (derivedFace.center && derivedFace.chin) {
    notes.push(
      `Mesh Avatar Studio has no face oval and no chin point: face.center ${fmt(derivedFace.center)}, face.radius ${fmt(derivedFace.radius!)} and face.chin ${fmt(derivedFace.chin)} were estimated from its eye, nose, mouth, jaw and ear ellipses. Look at them in the overlay and correct them.`,
    );
  } else {
    notes.push('The face oval and the chin could not be estimated (the rig lacks eye, nose or mouth data): place face.center, face.radius and face.chin by hand.');
  }

  // ------------------------------------------------------------------ hair
  const used = new Set<string>();
  const strands: Obj[] = [];
  const guessed: string[] = [];
  for (const s of Array.isArray(rig.strands) ? rig.strands : []) {
    if (!isObj(s)) continue;
    const nodes = flat(s.nodes);
    const id = uniqueId(typeof s.name === 'string' && s.name ? s.name : 'strand', used);
    const sigma = num(s.sigma);
    const group = strandGroup(id, nodes, derivedFace.center, derivedFace.radius);
    guessed.push(`${id}: ${group}`);
    if (sigma === null || sigma <= 0) notes.push(`Strand "${id}" has no sigma: its width was set to 2.5% of the image width; adjust it to the visible width of the lock.`);
    strands.push({
      id,
      nodes,
      width: sigma !== null && sigma > 0 ? round(sigma * 2, 3) : round(width * 0.025, 0),
      ...(num(s.max) !== null && (s.max as number) > 0 ? { swing: s.max } : {}),
      ...(num(s.k) !== null && (s.k as number) > 0 ? { stiffness: s.k } : {}),
      group,
    });
  }
  doc.hair = { strands };
  if (strands.length) {
    notes.push(`Strand width is 2 x sigma (sigma is about half the visible lock width). Strand groups were guessed from names and positions (${guessed.join(', ')}): front = bangs, side = locks beside the face, back = hair behind the shoulders.`);
  }

  // ------------------------------------------------------------------ attachments
  const attachments: Obj[] = [];
  const attachmentIds = new Set<string>();
  if (isObj(rig.buns)) {
    for (const [name, value] of Object.entries(rig.buns)) {
      const e = ellipse(value);
      if (!e) continue;
      attachments.push({ id: uniqueId(name, attachmentIds), kind: 'jiggle', center: e.center, radius: e.radius });
    }
  }
  const boxes: string[] = [];
  for (const a of Array.isArray(rig.accessories) ? rig.accessories : []) {
    if (!isObj(a)) continue;
    const id = uniqueId(typeof a.name === 'string' && a.name ? a.name : 'accessory', attachmentIds);
    const box = Array.isArray(a.box) && a.box.length === 4 && a.box.every((v) => num(v) !== null) ? (a.box as number[]) : null;
    const pivot = pair(a.pivot);
    const inHead = pivot && headEllipse ? ellipseLevel(headEllipse.center, headEllipse.radius, 0, pivot[0], pivot[1]) <= 1 : true;
    attachments.push({
      id,
      kind: 'pendulum',
      outline: box ? [box[0], box[1], box[2], box[1], box[2], box[3], box[0], box[3]] : null,
      pivot,
      tip: pair(a.tip),
      follow: inHead ? 'head' : 'body',
    });
    boxes.push(id);
  }
  if (boxes.length) {
    notes.push(
      `Pendulum outlines (${boxes.join(', ')}) are the accessories' bounding boxes: Mesh Avatar Studio isolates the object inside its box by colour (split, color.redness, color.minRed are not imported). Trace each outline around the object for a clean cut.`,
    );
  }
  const hand = isObj(rig.hand) ? rig.hand : null;
  if (hand) {
    const outline = flat(hand.outline);
    const contact = pair(hand.contact);
    attachments.push({ id: uniqueId('hand', attachmentIds), kind: 'cutout', outline, follow: 'body', ...(contact ? { contact } : {}) });
    const extra = ['jaw', 'jawRange', 'background', 'elbow', 'wrist', 'knuckle', 'forearmShare', 'armBand', 'wristBand', 'handBand', 'fingerXBand', 'fingerYBand', 'pinBand'].filter((k) => k in hand);
    if (extra.length) notes.push(`The hand becomes a cut-out that follows the body (its contact point follows the head a little). Not imported: hand.${extra.join(', hand.')} (arm joints, bands and the reconstruction of the jaw and background behind the hand; Rev2D fills what the cut-out hides by inpainting).`);
  }
  doc.attachments = attachments;

  // ------------------------------------------------------------------ body
  const body = isObj(rig.body) ? rig.body : null;
  if (body) {
    const chest = ellipse(body.chest);
    const out: Obj = {
      pivot: num(body.pivotX) !== null && num(body.pivotY) !== null ? [body.pivotX, body.pivotY] : null,
      fade: pair(body.rollBand),
      sway: num(body.maxRoll) !== null ? Math.abs(deg(body.maxRoll as number)) : 2,
      chest: { center: chest?.center ?? null, radius: chest?.radius ?? null },
    };
    const shoulders = (Array.isArray(body.shoulders) ? body.shoulders : []).map(ellipse).filter((e): e is Ellipse => e !== null);
    if (shoulders.length === 2) {
      shoulders.sort((a, b) => a.center[0] - b.center[0]);
      out.shoulders = [shoulders[0].center, shoulders[1].center];
    } else if (shoulders.length) {
      notes.push(`body.shoulders has ${shoulders.length} entry (Rev2D takes both shoulders or none): not imported.`);
    }
    doc.body = out;
    const breathBand = pair(body.breathBand);
    if (breathBand) notes.push(`body.breathBand [${breathBand.join(', ')}] is not imported: the breath rises the chest ellipse with a smooth falloff (body.breath sets the amount).`);
  } else {
    notes.push('The rig has no "body": place body.pivot, body.fade and body.chest by hand.');
  }

  if (isObj(rig.mesh)) notes.push('mesh (cell sizes) is not imported: Rev2D chooses its lattice sizes from the image size (build.cell overrides them).');
  if (isObj(rig.view)) notes.push('view (padding, gaze centre) is not imported: it configures the Mesh Avatar Studio viewer.');

  if (derived.length) doc.notes = [`Imported from a Mesh Avatar Studio rig.json. Estimated by the importer, check them in the overlay: ${derived.join(', ')}.`];
  else doc.notes = ['Imported from a Mesh Avatar Studio rig.json.'];
  return { doc, notes };
}

function fmt(p: Vec2): string {
  return `[${round(p[0])}, ${round(p[1])}]`;
}

function meanPoint(points: number[]): Vec2 {
  let x = 0;
  let y = 0;
  const n = points.length / 2;
  for (let i = 0; i < points.length; i += 2) {
    x += points[i];
    y += points[i + 1];
  }
  return [x / n, y / n];
}

function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

interface FaceInputs {
  eyeA: Vec2 | null;
  eyeB: Vec2 | null;
  nose: Vec2 | null;
  mouth: Vec2 | null;
  jaw: Ellipse | null;
  ears: Vec2[];
}

/**
 * Face oval and chin from the landmarks Mesh Avatar Studio has.
 * - The face axis runs from the point between the eyes through the mouth centre (heads are often
 *   tilted in the picture).
 * - Chin: on that axis below the mouth. With a jaw ellipse ("centre just above the chin, covering
 *   the lower jaw") it sits 65% of the way from the jaw centre to the ellipse's lower edge, measured
 *   along the axis; without one, 0.75 x the eye-to-mouth distance below the mouth.
 * - Face centre: halfway between the eye midpoint and the nose tip.
 * - Radii: vertically the distance from the centre to the chin; horizontally 0.9 x the mean
 *   distance to the ear centres (two ears), else 0.85 x the distance between the eyes.
 */
function deriveFace(f: FaceInputs): { center: Vec2 | null; radius: Vec2 | null; chin: Vec2 | null } {
  if (!f.eyeA || !f.eyeB) return { center: null, radius: null, chin: null };
  const eyeMid: Vec2 = [(f.eyeA[0] + f.eyeB[0]) / 2, (f.eyeA[1] + f.eyeB[1]) / 2];
  const eyeDistance = length(f.eyeB[0] - f.eyeA[0], f.eyeB[1] - f.eyeA[1]);
  const below = f.mouth ?? f.nose;
  if (!below || eyeDistance === 0) return { center: null, radius: null, chin: null };
  const span = length(below[0] - eyeMid[0], below[1] - eyeMid[1]);
  if (span === 0) return { center: null, radius: null, chin: null };
  const axis: Vec2 = [(below[0] - eyeMid[0]) / span, (below[1] - eyeMid[1]) / span];

  let chin: Vec2;
  if (f.mouth) {
    let d = 0.75 * span;
    if (f.jaw) {
      // Extent of the jaw ellipse along the axis, and the mouth's position along it from the jaw centre.
      const extent = 1 / length(axis[0] / f.jaw.radius[0], axis[1] / f.jaw.radius[1]);
      const along = (f.mouth[0] - f.jaw.center[0]) * axis[0] + (f.mouth[1] - f.jaw.center[1]) * axis[1];
      const fromJaw = 0.65 * extent - along;
      if (fromJaw > 0.2 * span && fromJaw < 1.5 * span) d = fromJaw;
    }
    chin = [f.mouth[0] + axis[0] * d, f.mouth[1] + axis[1] * d];
  } else {
    // Only the nose is known: the chin lies about 1.5 x the eye-to-nose distance below the nose.
    chin = [below[0] + axis[0] * 1.5 * span, below[1] + axis[1] * 1.5 * span];
  }

  const nose = f.nose ?? [eyeMid[0] + axis[0] * span * 0.55, eyeMid[1] + axis[1] * span * 0.55];
  const center: Vec2 = [(eyeMid[0] + nose[0]) / 2, (eyeMid[1] + nose[1]) / 2];
  const ry = length(chin[0] - center[0], chin[1] - center[1]);
  const rx = f.ears.length === 2 ? 0.9 * ((length(f.ears[0][0] - center[0], f.ears[0][1] - center[1]) + length(f.ears[1][0] - center[0], f.ears[1][1] - center[1])) / 2) : 0.85 * eyeDistance;
  return { center: [round(center[0]), round(center[1])], radius: [round(rx), round(ry)], chin: [round(chin[0]), round(chin[1])] };
}

function strandGroup(id: string, nodes: number[] | null, faceCenter: Vec2 | null, faceRadius: Vec2 | null): 'front' | 'side' | 'back' {
  if (/bang|front|fringe|forelock/i.test(id)) return 'front';
  if (/side/i.test(id)) return 'side';
  if (/back|rear|tail/i.test(id)) return 'back';
  if (nodes && faceCenter && faceRadius) {
    // A lock whose tip hangs over the face is a bang; one beside the face is side hair.
    const tipX = nodes[nodes.length - 2];
    return Math.abs(tipX - faceCenter[0]) < faceRadius[0] * 0.85 ? 'front' : 'side';
  }
  return 'front';
}
