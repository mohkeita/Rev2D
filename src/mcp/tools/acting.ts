import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GESTURES, EXPRESSIONS } from '../../gestures/index.js';
import { addTool, json, result, resolvePath, ToolError, type ToolContext } from '../context.js';
const shared = {
  path: z.string().min(1),
  id: z.string().min(1).optional(),
  t: z.number().nonnegative().optional(),
  duration: z.number().positive().optional(),
  intensity: z.number().min(0).max(1).optional(),
  hold: z.number().nonnegative().optional(),
  release: z.number().positive().optional(),
  dry_run: z.boolean().default(false),
};
export function registerActingTools(server: McpServer, ctx: ToolContext): void {
  addTool(
    server,
    'rev2d_gesture_list',
    {
      title: 'List acting libraries',
      description:
        'List reusable gestures and facial expressions. These use standard parameters; absent controls produce gesture-missing-param warnings. Read rev2d_docs topic gestures for side conventions, timing, drawn hands and idle_alive.',
      input: z.strictObject({}),
      effect: 'read-only',
    },
    async () => result([json({ gestures: GESTURES, expressions: EXPRESSIONS })]),
  );
  for (const kind of ['gesture', 'expression'] as const) {
    const input = z.strictObject({
      ...shared,
      ...(kind === 'gesture'
        ? {
            gesture: z.string().min(1),
            side: z.enum(['R', 'L', 'both']).optional(),
            count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
          }
        : { expression: z.string().min(1) }),
    });
    addTool(
      server,
      `rev2d_${kind}_apply`,
      {
        title: `Apply a ${kind}`,
        description: `Generate an acting animation with anticipation, overshoot, settling, hold and release. Writes the model unless dry_run is true; replaces only an animation with the same id. Missing standard parameters are skipped with diagnostics. Render a sheet and analyze after applying.`,
        input,
        effect: 'destructive',
      },
      async (a) => {
        try {
          const io = await import('../../node/acting.js'),
            { path, dry_run, ...options } = a,
            name =
              kind === 'gesture' ? ('gesture' in a ? a.gesture : '') : 'expression' in a ? a.expression : '';
          const r = await io.applyActing(resolvePath(ctx, path), kind, String(name), {
            ...options,
            dryRun: dry_run,
          });
          return result([json(r)], !r.ok);
        } catch (e) {
          const err = e as Error & { diagnostics?: import('../../core/types.js').Diagnostic[] };
          throw new ToolError(
            err.message,
            err.diagnostics ?? [],
            `use rev2d_gesture_list and correct the model or options`,
          );
        }
      },
    );
  }
}
