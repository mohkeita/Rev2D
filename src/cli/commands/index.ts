/** Every command, in help order. */
import { ACTING_COMMANDS,GESTURE_PARENT,EXPRESSION_PARENT } from './acting.js';
import type { Command } from '../command.js';
import { AVATAR_COMMANDS, AVATAR_PARENT } from './avatar.js';
import { create, ops, set } from './edit.js';
import { exportLive2d, exportSpine, importLive2d, importSpine } from './interop.js';
import { edit, editorCommand, editorScreenshot, editorState, mcp } from './live.js';
import { analyze, hit, info, inspect, validate } from './model.js';
import { docs, schema } from './reference.js';
import { diff, frames, gif, render, sheet } from './render.js';
import { watch } from './watch.js';
import { LIBRARY_COMMANDS,LIBRARY_PARENT } from './library.js';
import {EPISODE_COMMANDS,EPISODE_PARENT} from './episode.js';
import { SCENE_COMMANDS, SCENE_PARENT } from './scene.js';

export const COMMANDS: Command[] = [
  validate,
  info,
  render,
  sheet,
  gif,
  frames,
  inspect,
  analyze,
  hit,
  diff,
  create,
  ops,
  set,
  ...AVATAR_COMMANDS,
  ...LIBRARY_COMMANDS,
  ...SCENE_COMMANDS,
  ...EPISODE_COMMANDS,
  ...ACTING_COMMANDS,
  importSpine,
  importLive2d,
  exportSpine,
  exportLive2d,
  watch,
  edit,
  editorState,
  editorCommand,
  editorScreenshot,
  schema,
  docs,
  mcp,
];

/** Commands that are reached through a parent word ("editor state"). */
export const PARENTS: Record<string, { summary: string; subcommands: Command[] }> = {
  import: {
    summary: 'convert Spine exports into models, Live2D motions/physics into a model (spine, live2d)',
    subcommands: [importSpine, importLive2d],
  },
  export: {
    summary: 'write Spine JSON + atlas, or Live2D motion3/physics3/cdi3 JSON (spine, live2d)',
    subcommands: [exportSpine, exportLive2d],
  },
  editor: {
    summary: 'talk to a running editor (state, command, screenshot)',
    subcommands: [editorState, editorCommand, editorScreenshot],
  },
  avatar: AVATAR_PARENT,
  library: LIBRARY_PARENT,
  scene: SCENE_PARENT,
  episode: EPISODE_PARENT,
  gesture:GESTURE_PARENT,expression:EXPRESSION_PARENT,
};
