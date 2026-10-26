/**
 * layerInputsHash: a stable fingerprint of exactly the spec fields that change the layer IMAGES
 * (textures/*.png). When it differs from LayersMeta.inputsHash the layers are stale and
 * buildAvatarLayers must run again; every other change of the spec only needs compileAvatar.
 *
 * Hashed fields (layerInputs):
 * - image.file, image.width, image.height            another picture, or another pixel grid
 * - head.center, head.radius                          the head ellipse bounds the hair mask
 * - face.eyes.<side>.opening and .region             CUT: eyeball, lid and lash layers, the skin fill behind them
 * - face.mouth.area (center, radius, rotation)       CUT: the mouth patch and the edit mask of drawn mouths
 * - hair.strands[*].id, .nodes, .width, .group       the polylines seed the hair mask (id and group name / sort its layers)
 * - attachments[*] of kind pendulum / cutout: id, kind, outline   CUT: their layers and the inpainting behind them
 * - build.feather                                     the soft edge of every cut layer
 *
 * NOT hashed (they only change the compiled model): turn / tilt / sway / breath amounts, pivots and
 * bands, face oval, nose, chin, mouth corners and bow, iris, brows, cheeks, ears, strand swing and
 * stiffness, pendulum pivot / tip / swing / follow, a cut-out's follow and contact, jiggle
 * attachments (they are not cut out), build.cell, build.variantTolerance, post, notes, name.
 *
 * The hash is FNV-1a (64 bit) over the UTF-8 bytes of a canonical JSON text: object keys sorted,
 * numbers rounded to 3 decimals (so a spec hashes the same before and after it was written to disk
 * with the model formatter), no whitespace. Result: 16 lowercase hex digits.
 */
import type { AvatarSpec } from './types.js';

const PRECISION = 1000;

/** The part of a spec that determines the layer images, as a plain JSON value. */
export function layerInputs(spec: AvatarSpec): Record<string, unknown> {
  const eye = (e: AvatarSpec['face']['eyes']['imageLeft']) => ({ opening: e.opening, region: e.region });
  const area = spec.face.mouth.area;
  return {
    image: { file: spec.image.file, width: spec.image.width, height: spec.image.height },
    head: { center: spec.head.center, radius: spec.head.radius },
    eyes: { imageLeft: eye(spec.face.eyes.imageLeft), imageRight: eye(spec.face.eyes.imageRight) },
    mouthArea: { center: area.center, radius: area.radius, rotation: area.rotation },
    strands: (spec.hair?.strands ?? []).map((s) => ({ id: s.id, nodes: s.nodes, width: s.width, group: s.group })),
    cuts: (spec.attachments ?? []).flatMap((a) => (a.kind === 'jiggle' ? [] : [{ id: a.id, kind: a.kind, outline: a.outline }])),
    feather: spec.build?.feather ?? null,
    ...(spec.arms?.length ? { arms: spec.arms.map(({front,...cut})=>cut), armTorso: { hips:spec.legs?.hips,chest:spec.body.chest } } : {}),
  };
}

/** Canonical JSON: sorted keys, numbers rounded to 3 decimals, no whitespace; undefined members are dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    const r = Math.round(value * PRECISION) / PRECISION;
    return Object.is(r, -0) ? '0' : String(r);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

/**
 * FNV-1a, 64 bit, over the UTF-8 bytes of `text`, as 16 hex digits. Computed on four 16-bit limbs
 * (the prime is 2^40 + 0x1b3), so it needs neither BigInt nor 64-bit integers.
 */
export function fnv1a64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i];
    // (h3 h2 h1 h0) * (0x0000 0x0100 0x0000 0x01b3), keeping the low 64 bits.
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3;
    const t2 = h2 * 0x1b3 + h0 * 0x100;
    const t3 = h3 * 0x1b3 + h1 * 0x100;
    let carry = t0;
    h0 = carry & 0xffff;
    carry = t1 + (carry >>> 16);
    h1 = carry & 0xffff;
    carry = t2 + (carry >>> 16);
    h2 = carry & 0xffff;
    carry = t3 + (carry >>> 16);
    h3 = carry & 0xffff;
  }
  const hex = (v: number) => v.toString(16).padStart(4, '0');
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

/** Hash of everything in the spec that changes the layer images (see the file comment for the list). */
export function layerInputsHash(spec: AvatarSpec): string {
  return fnv1a64(canonicalJson(layerInputs(spec)));
}
