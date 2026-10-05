/** Command definition shared by the registry, the dispatcher and the help renderer. */
import type { FlagSpec } from './args.js';
import type { Ctx } from './context.js';

export type FlagGroup = 'pose' | 'sequencePose' | 'sample' | 'frame';

export type CommandGroup = 'check' | 'edit' | 'interop' | 'live' | 'reference';

export const GROUP_TITLES: Record<CommandGroup, string> = {
  check: 'Check & look',
  edit: 'Create & edit',
  interop: 'Import & export (Spine, Live2D)',
  live: 'Live editing',
  reference: 'Reference & integration',
};

export interface Command {
  /** "render", or "editor state" for subcommands. */
  name: string;
  group: CommandGroup;
  summary: string;
  /** Synopsis after "rev2d ", e.g. "render <model> -o <out.png> [pose flags] [frame flags]". */
  usage: string;
  /**
   * Positional placeholders: "<x>" required, "[x]" optional, a trailing "..." makes it variadic.
   * Used to check the positional count before run().
   */
  args: string[];
  flags: FlagSpec[];
  /**
   * Named shared flag groups this command accepts (listed separately in help): pose (with --time),
   * sequencePose (pose flags of commands that sample an animation over time: --time hidden and
   * rejected), sample (the sampling window: --fps/--frames/--from/--to/--times/--warmup), frame.
   */
  flagGroups?: FlagGroup[];
  /** Command-specific descriptions of shared flags (by flag name), shown instead of the generic ones. */
  flagNotes?: Record<string, string>;
  /** Adds --json. */
  json?: boolean;
  description?: string[];
  examples: string[];
  run(ctx: Ctx): Promise<number>;
}

/** Min/max positional count from the placeholders. */
export function arity(cmd: Command): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const a of cmd.args) {
    const variadic = a.endsWith('...>') || a.endsWith('...]');
    if (a.startsWith('<')) min++;
    max = variadic ? Infinity : max + 1;
  }
  return { min, max };
}
