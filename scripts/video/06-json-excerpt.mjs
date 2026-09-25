/**
 * Step 6 - a short, real excerpt of examples/hana/hana.r2d.json: one parameter and one binding
 * that uses it, cut verbatim (same lines, same formatting) out of the shipped file.
 *
 *   node scripts/video/06-json-excerpt.mjs
 *
 * Output: out/video/assets/json/hana-excerpt.json (the excerpt as it reads in the file, with the
 * line numbers), hana-excerpt.txt (the same text for a caption), plus a verified render of the
 * binding's effect (AngleZ -30 / 0 / 30 sweep) so the excerpt can sit next to what it does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ASSETS, ROOT, bytesOf, commandEntry, ensureDir, log, must, pngSize, rel, runCli, updateManifest } from './lib.mjs';

const MODEL = 'examples/hana/hana.r2d.json';
const PARAM = 'AngleZ';
const BINDING = 'headTilt';
const dir = ensureDir(path.join(ASSETS, 'json'));
const text = readFileSync(path.join(ROOT, MODEL), 'utf8');
const lines = text.split(/\r?\n/);
const model = JSON.parse(text);

/** Lines of the array element whose `"id": "<id>"` line is found inside the given top-level array. */
function objectLines(arrayKey, id) {
  const arrStart = lines.findIndex((l) => l.startsWith(`  "${arrayKey}": [`));
  const idLine = lines.findIndex((l, i) => i > arrStart && l.trim() === `"id": "${id}",`);
  if (arrStart < 0 || idLine < 0) throw new Error(`${arrayKey}/${id} not found`);
  let start = idLine;
  while (lines[start].trim() !== '{') start--;
  let end = idLine;
  const indent = lines[start].match(/^\s*/)[0];
  while (!(lines[end].startsWith(`${indent}}`) && lines[end].trim().startsWith('}'))) end++;
  const slice = lines.slice(start, end + 1).map((l) => l.slice(indent.length)).join('\n').replace(/,$/, '');
  JSON.parse(slice); // it must be a complete JSON object
  return { from: start + 1, to: end + 1, text: slice };
}

const param = objectLines('parameters', PARAM);
const binding = objectLines('bindings', BINDING);
const b = model.bindings.find((x) => x.id === BINDING);
if (!b.params.includes(PARAM)) throw new Error(`${BINDING} does not use ${PARAM}`);

const excerpt = `// ${MODEL}  (lines ${param.from}-${param.to})\n"parameters": [ ...\n${param.text},\n... ],\n\n// (lines ${binding.from}-${binding.to})\n"bindings": [ ...\n${binding.text},\n... ]\n`;
writeFileSync(path.join(dir, 'hana-excerpt.txt'), excerpt);
writeFileSync(path.join(dir, 'hana-excerpt.json'), JSON.stringify({ model: MODEL, parameter: { lines: [param.from, param.to], text: param.text, value: JSON.parse(param.text) }, binding: { lines: [binding.from, binding.to], text: binding.text, value: JSON.parse(binding.text) } }, null, 2));

// What the binding does, rendered by the CLI (physics off so the head angle shows exactly as set).
const sweepPng = path.join(dir, 'hana-anglez-sweep.png');
const r = must(runCli(['sheet', MODEL, '-o', rel(sweepPng), '--sweep', `${PARAM}=-30,0,30`, '--no-physics', '--scale', '0.6']));
log(r.stdout.trim().split('\n')[0]);

updateManifest('06-json-excerpt', [
  { id: 'json/hana-excerpt', kind: 'text', path: rel(path.join(dir, 'hana-excerpt.txt')), bytes: bytesOf(path.join(dir, 'hana-excerpt.txt')), source: MODEL, lines: { parameter: [param.from, param.to], binding: [binding.from, binding.to] }, text: excerpt, note: `parameter ${PARAM} + binding ${BINDING} (bone:head.rotation <- ${PARAM}), verbatim lines of the shipped file` },
  { id: 'json/hana-excerpt-json', kind: 'json', path: rel(path.join(dir, 'hana-excerpt.json')), bytes: bytesOf(path.join(dir, 'hana-excerpt.json')) },
  { ...commandEntry('json/anglez-sweep', r), kind: 'image', path: rel(sweepPng), bytes: bytesOf(sweepPng), ...pngSize(sweepPng), note: `what the excerpt does: ${PARAM} = -30 / 0 / 30 -> head rotation -10 / 0 / 10 degrees` },
]);
console.log(excerpt);
