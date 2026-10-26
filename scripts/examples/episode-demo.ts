/** Original, reproducible six-shot episode; shared Rev2D art, no downloaded media. */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { PACKAGE_ROOT } from '../../src/api/templates.js';
import { writeAtomic, relative } from '../../src/node/episode.js';
import { findFfmpeg } from '../../src/node/video.js';
import { runProgram, encoderArgs, videoArgs } from '../../src/node/episode-media.js';
import { syntheticWav } from './scene-assets.js';
export async function buildEpisodeExample(root: string) {
  root = path.resolve(root);
  await mkdir(root);
  const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((word, i) => ({
    word,
    start: i * 2,
    end: i * 2 + 0.7,
  }));
  const voice = syntheticWav(12);
  const samples = new DataView(voice.buffer, voice.byteOffset, voice.byteLength);
  for (let i = 0; i < (voice.length - 44) / 2; i++)
    if (!words.some((w) => i / 24000 >= w.start && i / 24000 < w.end)) samples.setInt16(44 + i * 2, 0, true);
  await writeFile(path.join(root, 'voice.wav'), voice);
  await writeFile(path.join(root, 'music.wav'), syntheticWav(12));
  await writeAtomic(path.join(root, 'voice.alignment.json'), words);
  await runProgram(await findFfmpeg(), [
    ...encoderArgs,
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=960x540:rate=24:duration=2',
    ...videoArgs,
    '-an',
    path.join(root, 'external.mp4'),
  ]);
  const cue = (i: number) => (i ? `@text:${words[i].word}` : 0),
    common = (id: string, i: number, transition: string) => ({
      id,
      start: cue(i),
      end: i === 5 ? '@end' : cue(i + 1),
      transition,
    });
  await writeAtomic(path.join(root, 'storyboard.json'), {
    version: 1,
    id: 'episode-demo',
    library: relative(root, path.join(PACKAGE_ROOT, 'examples/scenes/room-demo/library')),
    size: [960, 540],
    fps: 24,
    narration: { audio: 'voice.wav', alignment: 'voice.alignment.json' },
    music: { src: 'music.wav', gain: 0.2, duck: { under: 'narration', amount: 0.6 } },
    defaults: { camera: 'static', transition: 'cut' },
    shots: [
      {
        ...common('P001', 0, 'cut'),
        background: 'room',
        characters: [{ id: 'hero', character: 'figure', at: 'sofa_left', pose: 'sitting_phone' }],
        focus: 'hero',
        note: 'One character on the sofa. The cue is at frame zero.',
      },
      {
        ...common('P002', 1, 'dissolve'),
        background: 'room',
        characters: [
          { id: 'hero', character: 'figure', at: 'sofa_left', pose: 'sitting_phone' },
          { id: 'friend', character: 'figure', at: [730, 480], pose: 'standing' },
        ],
        focus: 'friend',
        note: 'Two characters. The portrait crop deliberately excludes the sofa character.',
      },
      {
        ...common('P003', 2, 'whip-left'),
        background: 'room',
        ui: [
          {
            ref: 'phone_progress',
            at: [480, 490],
            tracks: [
              {
                param: 'Progress',
                keys: [
                  { t: 0, v: 0 },
                  { t: 1.8, v: 1 },
                ],
              },
            ],
          },
        ],
        focus: [0.5, 0.5],
        note: 'A reusable phone UI animates its native Progress parameter.',
      },
      {
        ...common('P004', 3, 'whip-right'),
        layers: [
          {
            id: 'actor',
            type: 'model',
            src: relative(
              root,
              path.join(PACKAGE_ROOT, 'examples/scenes/acting-demo/figure/figure_full.r2d.json'),
            ),
            anchor: 'bottom-center',
            x: 480,
            y: 510,
            animations: ['idle_alive', { gesture: 'point_right', t: 0.1, hold: 0.4 }],
          },
        ],
        focus: 'actor',
        note: 'An original fully rigged figure points right.',
      },
      {
        ...common('P005', 4, 'dip-to-black'),
        external: { video: 'external.mp4', fit: 'cover' },
        note: 'An explicitly declared external clip: an original procedural ffmpeg test pattern.',
      },
      {
        ...common('P006', 5, 'cut'),
        background: 'room',
        characters: [{ id: 'hero', character: 'figure', at: 'center', pose: 'standing' }],
        props: [{ ref: 'box', at: [720, 485], scale: 0.5 }],
        bubbles: [
          {
            ref: 'thought',
            attach: 'hero.head',
            offset: [30, -15],
            scale: 0.75,
            content: {
              type: 'image',
              src: relative(
                root,
                path.join(PACKAGE_ROOT, 'examples/scenes/room-demo/library/props/box/source.png'),
              ),
            },
          },
        ],
        focus: 'hero',
        camera: 'slow-push',
        note: 'A thought bubble and prop conclude the episode, preserving the final narration silence.',
      },
    ],
  });
  await writeFile(
    path.join(root, 'README.md'),
    '# Original six-shot episode\n\nGenerated by `node --import tsx scripts/build-episode-example.ts`. Uses original Rev2D artwork from the shared room/acting examples, procedural external video and synthetic timing tones (not speech). See [the episode guide](../../../docs/EPISODE.md) for the runnable workflow.\n',
  );
}
