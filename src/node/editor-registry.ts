/**
 * Discovery of running editor servers, so the CLI / MCP server can talk to the editor a human is
 * looking at ("what does the user see?", "show the user this pose").
 *
 * Each server writes ~/.rev2d/editors/<pid>-<port>.json while running (one process may run several
 * servers). Stale entries (dead pid) are ignored and cleaned up opportunistically.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface EditorEntry {
  pid: number;
  url: string;
  /** Absolute path of the model file being edited. */
  file: string;
  startedAt: string;
}

/**
 * One animation layer of the editor (EditorState.animations, setAnimations commands). Mirrors
 * core AnimationLayer (SPEC §6): weight 0..1 (default 1); mode 'override' (default: later layers
 * win) or 'add' (param tracks add weight * (v - default) on top); start = global time at which
 * the layer starts (local time = time - start, default 0); hold (default true) = a non-looping
 * layer keeps its first/last key values outside [0, duration] (false: it contributes nothing there).
 */
export interface EditorLayer {
  id: string;
  weight?: number;
  mode?: 'override' | 'add';
  start?: number;
  hold?: boolean;
}

/**
 * Editor view state, published by the editor UI (POST /api/state) and readable by AI tools
 * (GET /api/state). Mirrors PoseInput so it can be rendered server-side.
 */
export interface EditorState {
  file: string;
  /**
   * Evaluated value of every parameter as shown, physics outputs and pinned values included: together with `time` and
   * `animations` (for non-parameter tracks) they define the pose, so screenshots render them with
   * physics off.
   */
  params: Record<string, number>;
  /** Global playback time in seconds (layers with `start` run at time - start). */
  time: number;
  /** Animation layers in blend order: the timeline's main animation first, then the extra layers. */
  animations: EditorLayer[];
  playing: boolean;
  selection: string[];
  overlay: string[];
  /** Visible region of the viewport in model space [x, y, w, h]. */
  viewBox: [number, number, number, number] | null;
  /** The editor's physics toggle (its results are already in `params`). */
  physics?: boolean;
  /** Parts hidden in the editor's preview (not in the model); screenshots leave them out. */
  hidden?: string[];
  /**
   * Parameters with an explicit value in the editor (slider moved, value typed or physics output
   * pinned): their `params` value beats animation and physics until the human releases it.
   */
  pinned?: string[];
  updatedAt: string;
}

/** Commands an AI can send to the editor (POST /api/command); forwarded to the UI over SSE. */
export type EditorCommand =
  | { type: 'setParams'; params: Record<string, number>; reset?: boolean }
  | { type: 'play'; animation?: string }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'setAnimations'; animations: EditorLayer[] }
  | { type: 'select'; ids: string[] }
  | { type: 'setOverlay'; overlay: string[] }
  | { type: 'focus'; viewBox: [number, number, number, number] | 'fit' }
  | { type: 'reload' }
  | { type: 'message'; text: string };

export function registryDir(): string {
  return path.join(os.homedir(), '.rev2d', 'editors');
}

/** Port of an editor URL ("80" / "443" when the URL names none, "0" when it does not parse). */
function portOf(url: string): string {
  if (!URL.canParse(url)) return '0';
  const u = new URL(url);
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

/** Advertise a running server; returns a function that withdraws exactly this entry. */
export function registerEditor(entry: EditorEntry): () => void {
  const dir = registryDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.pid}-${portOf(entry.url)}.json`);
  writeFileSync(file, JSON.stringify(entry, null, 2));
  return () => rmSync(file, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Running editors, newest first. Optionally only those editing `file`. */
export function listEditors(file?: string): EditorEntry[] {
  const dir = registryDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: EditorEntry[] = [];
  for (const n of names) {
    const full = path.join(dir, n);
    try {
      const e = JSON.parse(readFileSync(full, 'utf8')) as EditorEntry;
      if (!alive(e.pid)) {
        rmSync(full, { force: true });
        continue;
      }
      if (file && path.resolve(file).toLowerCase() !== path.resolve(e.file).toLowerCase()) continue;
      out.push(e);
    } catch {
      // ignore unreadable entries
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Find the editor to talk to: explicit url, else the newest editor (for `file` if given). */
export function findEditor(opts: { url?: string; file?: string } = {}): EditorEntry | null {
  if (opts.url) return { pid: -1, url: opts.url.replace(/\/$/, ''), file: opts.file ?? '', startedAt: '' };
  return listEditors(opts.file)[0] ?? null;
}
