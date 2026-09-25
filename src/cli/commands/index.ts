/** Every command, in help order. */
import type { Command } from '../command.js';
import { create, ops, set } from './edit.js';
import { edit, editorCommand, editorScreenshot, editorState, mcp } from './live.js';
import { analyze, hit, info, inspect, validate } from './model.js';
import { docs, schema } from './reference.js';
import { diff, frames, gif, render, sheet } from './render.js';
import { watch } from './watch.js';

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
  editor: {
    summary: 'talk to a running editor (state, command, screenshot)',
    subcommands: [editorState, editorCommand, editorScreenshot],
  },
};
