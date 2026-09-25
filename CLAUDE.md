@AGENTS.md

## Claude Code specifics

- Register the Rev2D MCP server (absolute path to this checkout; forward slashes work on Windows):
  `claude mcp add rev2d -- node /absolute/path/to/Rev2D/bin/rev2d.js mcp`.
  Add `--scope project` to write `.mcp.json` for everyone on the project. Check it with
  `claude mcp list` or `/mcp`. The tools then appear as `mcp__rev2d__rev2d_render`,
  `mcp__rev2d__rev2d_apply_ops`, ...; call `rev2d_guide` first.
- Without the MCP server, drive the CLI from the shell: `node bin/rev2d.js <command>` (or
  `npx rev2d` inside the repo) and open the PNGs it writes with the Read tool to look at them.
  Text beats pixels where it can: `inspect --track` tables and `analyze` reports are cheaper to read
  than a GIF, and the notes under `render`/`sheet` point at IK, physics and view-box problems.
- Worked, tested examples for most rigging tasks: `node bin/rev2d.js docs recipes` (docs/RECIPES.md).
- `rev2d edit` and `rev2d watch` run until stopped: start them in the background, or ask the user
  to run `rev2d edit <model>` (or `rev2d edit <dir>` for a workspace with a start screen) in their
  own terminal and use `rev2d editor state|command|screenshot`. `rev2d editor command --open <file>`
  switches their editor to another model inside its workspace root (ask before switching away from
  their work); see AGENTS.md §1.10.
- Write scratch renders under `out/` (git-ignored).
