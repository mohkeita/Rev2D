/**
 * Step 2 - how the AI checks its work: real renders and real text reports from the CLI.
 *
 *   node scripts/video/02-verify.mjs
 *
 * Output (out/video/assets/verify/):
 *   hana-overlay.png          render with bones, warps, labels, grid overlays
 *   hana-sweep-anglex-angley.png   3x3 AngleX x AngleY sweep sheet
 *   hana-overview.png         overview sheet of the expressive parameters
 *   analyze-hana-idle.txt     analyze report (stdout verbatim)
 *   inspect-robot-arm-reach.txt    inspect --track table (stdout verbatim)
 *   terminal.txt              all five commands as a terminal transcript
 * and one manifest entry per command (exact command, stdout, stderr, exit code, timestamps).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ASSETS, bytesOf, commandEntry, ensureDir, log, must, pngSize, rel, runCli, updateManifest, writeTranscript } from './lib.mjs';

const dir = ensureDir(path.join(ASSETS, 'verify'));
const hana = 'examples/hana/hana.r2d.json';
const robot = 'examples/robot-arm/robot-arm.r2d.json';
const out = (f) => rel(path.join(dir, f));

const steps = [
  {
    id: 'verify/render-overlay',
    file: 'hana-overlay.png',
    args: ['render', hana, '-o', out('hana-overlay.png'), '--overlay', 'bones,warps,labels,grid', '--scale', '1.5'],
    note: 'one pose with the rig drawn on top: bones, warp lattices, labels, grid',
  },
  {
    id: 'verify/sheet-sweep',
    file: 'hana-sweep-anglex-angley.png',
    args: ['sheet', hana, '-o', out('hana-sweep-anglex-angley.png'), '--sweep', 'AngleX=-30:30:3', '--sweep', 'AngleY=-30:30:3'],
    note: '3x3 grid: head turn AngleX (columns) x AngleY (rows) through the 2D face warp',
  },
  {
    id: 'verify/sheet-overview',
    file: 'hana-overview.png',
    args: ['sheet', hana, '-o', out('hana-overview.png'), '--overview', 'AngleX,AngleZ,EyeLOpen,MouthOpen,MouthForm,Cheek', '--scale', '0.6'],
    note: 'one row per expressive parameter over its whole range (5 steps)',
  },
  {
    id: 'verify/analyze-hana-idle',
    text: 'analyze-hana-idle.txt',
    args: ['analyze', hana, '--anim', 'idle', '--warmup', '8'],
    note: 'ranges reached, physics clamping, loop seam check, parts leaving the canvas',
  },
  {
    id: 'verify/inspect-robot-arm-reach',
    text: 'inspect-robot-arm-reach.txt',
    args: ['inspect', robot, '--anim', 'reach', '--times', '0:4:9', '--track', 'ik:armIk,bone:hand.tip,param:ReachX,param:Grip,physics:cableSwing.Cable1'],
    note: 'exact numbers over time: IK extension/error, hand tip position, params, raw physics output',
  },
];

const entries = [];
const results = [];
for (const s of steps) {
  log(s.id);
  const r = must(runCli(s.args));
  results.push(r);
  const e = commandEntry(s.id, r, { note: s.note });
  if (s.file) {
    const p = path.join(dir, s.file);
    Object.assign(e, { kind: 'image', path: rel(p), bytes: bytesOf(p), ...pngSize(p) });
  }
  if (s.text) {
    const p = path.join(dir, s.text);
    writeFileSync(p, r.stdout);
    Object.assign(e, { kind: 'command-output', path: rel(p), bytes: bytesOf(p), lines: r.stdout.split('\n').length });
  }
  entries.push(e);
}
const transcript = writeTranscript(path.join(dir, 'terminal.txt'), results);
entries.push({ id: 'verify/terminal', kind: 'transcript', path: rel(transcript), bytes: bytesOf(transcript), note: 'the five verification commands as a terminal transcript (verbatim output)' });
updateManifest('02-verify', entries);
log('done', entries.length, 'entries');
