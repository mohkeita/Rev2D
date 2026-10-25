/** Original synthetic scene pack. Used by the shipped example builder and integration tests. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { figureFixture, figureAvatarDoc, roomFixture, propFixtures } from '../../test/fixtures/studio.js';
import { buildPhoneUI } from './phone-ui.js';
import { initLibrary, importLibraryImage, rigLibraryPose, readLibrary } from '../../src/node/library.js';
import { encodePNG } from '../../src/render/png.js';
import { formatModelJson } from '../../src/core/format.js';
import type { SceneInput } from '../../src/scene/schema.js';

/** A timing reference tone, not synthesized speech. */
export function syntheticWav(duration = 6, sampleRate = 24000): Uint8Array {
  const samples = Math.round(duration * sampleRate),
    bytes = new Uint8Array(44 + samples * 2),
    view = new DataView(bytes.buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate,
      envelope = Math.min(1, t * 20, (duration - t) * 20);
    view.setInt16(44 + i * 2, Math.round(Math.sin(t * Math.PI * 2 * 220) * 1800 * envelope), true);
  }
  return bytes;
}
export function roomScene(portrait = false): SceneInput {
  const width = portrait ? 1080 : 1920,
    height = portrait ? 1920 : 1080;
  const factor = height / 540,
    left = (width - 960 * factor) / 2;
  const x = (v: number) => left + v * factor,
    y = (v: number) => v * factor;
  return {
    version: 1,
    library: './library',
    width,
    height,
    fps: 24,
    duration: 6,
    background: '#f4e7d5',
    narration: { audio: './voice.wav', alignment: './voice.alignment.json' },
    layers: [
      { id: 'room', type: 'background', ref: 'room', scale: factor, x: left },
      {
        id: 'hero',
        type: 'character',
        character: 'figure',
        at: 'room.sofa_left',
        poses: [
          { t: 0, pose: 'sitting_phone' },
          { t: '@text:se lève', pose: 'standing' },
        ],
        animations: ['idle', 'blink'],
      },
      {
        id: 'box',
        type: 'prop',
        ref: 'box',
        at: [x(portrait ? 530 : 710), y(495)],
        scale: portrait ? 0.7 : 1,
        enter: { t: '@word:5', type: 'pop', duration: 0.35, overshoot: 0.15 },
      },
      {
        id: 'idea',
        type: 'bubble',
        ref: 'thought',
        attach: 'hero.head',
        offset: [factor * 25, -factor * 10],
        scale: portrait ? 0.7 : 1,
        content: { type: 'image', src: './library/props/box/source.png' },
        enter: { t: '@text:idée', type: 'draw-on', duration: 0.4 },
        exit: { t: 5.5, type: 'fade', duration: 0.3 },
      },
      {
        id: 'phone',
        type: 'ui',
        ref: 'phone_progress',
        at: [portrait ? 800 : 1650, portrait ? 1580 : 680],
        scale: portrait ? 0.7 : 1,
        enter: { t: 0.5, type: 'fade' },
        tracks: [
          {
            param: 'Progress',
            keys: [
              { t: 0, v: 0, ease: 'inOutSine' },
              { t: 6, v: 1 },
            ],
          },
        ],
      },
    ],
    tracks: [
      {
        target: 'layer:hero.x',
        keys: [
          { t: 0, v: x(portrait ? 435 : 225), ease: 'step' },
          { t: '@text:se lève', v: x(portrait ? 465 : 500) },
        ],
      },
      {
        target: 'layer:hero.y',
        keys: [
          { t: 0, v: y(355), ease: 'step' },
          { t: '@text:se lève', v: y(480) },
        ],
      },
    ],
    camera: portrait
      ? {
          keys: [
            { t: 0, x: 540, y: 1150, zoom: 1.4 },
            { t: 6, x: 540, y: 1160, zoom: 1.46 },
          ],
        }
      : 'slow-push',
  };
}
export async function buildSceneExample(root: string): Promise<void> {
  await mkdir(root);
  const library = path.join(root, 'library');
  await initLibrary(library, 'scene-demo');
  const sources = path.join(root, 'sources');
  await mkdir(sources);
  const room = path.join(sources, 'room.png');
  await writeFile(room, encodePNG(roomFixture().image));
  await importLibraryImage(room, library, { kind: 'background', id: 'room' });
  for (const pose of ['sitting_phone', 'standing'] as const) {
    const file = path.join(sources, pose + '.png');
    await writeFile(file, encodePNG(figureFixture(pose, '#00ff00').image));
    const imported = await importLibraryImage(file, library, {
      kind: 'character',
      character: 'figure',
      pose,
      trim: false,
    });
    await writeFile(
      path.join(imported.directory, 'avatar.json'),
      formatModelJson(figureAvatarDoc('figure_' + pose)),
    );
    await rigLibraryPose(library, 'figure', pose);
  }
  for (const [id, image] of Object.entries(propFixtures())) {
    const file = path.join(sources, id + '.png');
    await writeFile(file, encodePNG(image));
    await importLibraryImage(file, library, { kind: id === 'box' ? 'prop' : 'bubble', id, trim: false });
  }
  await mkdir(path.join(library, 'ui'));
  await writeFile(path.join(library, 'ui/phone.r2d.json'), formatModelJson(buildPhoneUI()));
  const manifest = await readLibrary(library);
  manifest.characters[0].height = 260;
  for (const pose of manifest.characters[0].poses)
    pose.anchor = pose.id.startsWith('sitting') ? [180, 330] : [180, 455];
  manifest.backgrounds[0].anchors = {
    sofa_left: { at: [225, 355], scale: 1, pose_tags: ['sitting'] },
    center: { at: [500, 480], scale: 1, pose_tags: ['standing'] },
  };
  manifest.bubbles[0].content_rect = [35, 30, 170, 75];
  manifest.bubbles[0].tail = [38, 157];
  manifest.ui.push({
    id: 'phone_progress',
    model: 'ui/phone.r2d.json',
    params: { Progress: '0..1' },
    tags: ['phone'],
  });
  await writeFile(path.join(library, 'library.json'), formatModelJson(manifest));
  await writeFile(path.join(root, 'voice.wav'), syntheticWav());
  await writeFile(
    path.join(root, 'voice.alignment.json'),
    formatModelJson([
      { word: 'Il', start: 0, end: 0.3 },
      { word: 'se', start: 2.5, end: 2.7 },
      { word: 'lève', start: 2.7, end: 3 },
      { word: 'un', start: 3.1, end: 3.2 },
      { word: 'carton', start: 3.2, end: 3.5 },
      { word: 'idée', start: 4, end: 4.4 },
    ]),
  );
  await writeFile(path.join(root, 'scene.json'), formatModelJson(roomScene()));
  await writeFile(path.join(root, 'portrait.json'), formatModelJson(roomScene(true)));
}
