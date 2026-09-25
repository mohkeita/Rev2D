/**
 * Debounced watching of a set of files (the model file and its textures).
 *
 * Directories are watched rather than files: editors that save by writing a temp file and renaming
 * it over the original replace the inode, which silently ends a per-file fs.watch. When fs.watch is
 * unavailable for a directory (network drives, missing directories, watcher errors) its files fall
 * back to fs.watchFile stat polling, which also notices files that are created later.
 */
import { watch, watchFile, unwatchFile, type FSWatcher, type Stats } from 'node:fs';
import path from 'node:path';

export interface FileWatcherOptions {
  /** Called once per burst of changes with the absolute paths that changed. */
  onChange: (files: string[]) => void;
  /** Quiet period before a burst is reported (default 100 ms). */
  debounceMs?: number;
  /** A continuously changing file is still reported at least this often (default 1000 ms). */
  maxWaitMs?: number;
  /** Poll every file instead of using fs.watch. */
  poll?: boolean;
  /** Poll interval (default 300 ms). */
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function keyOf(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

export class FileWatcher {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pollIntervalMs: number;
  /** Watched files by key (absolute path, case-folded where the file system is). */
  private files = new Map<string, string>();
  private readonly dirWatchers = new Map<string, FSWatcher>();
  /** Directories where fs.watch failed; their files are polled. */
  private readonly failedDirs = new Set<string>();
  /** Polled files by key, with the exact path and listener needed to unwatch them. */
  private readonly polled = new Map<string, { file: string; listener: (curr: Stats, prev: Stats) => void }>();
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private burstStart = 0;
  private closed = false;

  constructor(private readonly opts: FileWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 100;
    this.maxWaitMs = opts.maxWaitMs ?? 1000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
  }

  /** Replace the watched set (absolute paths). Unchanged entries keep their watchers. */
  setFiles(files: readonly string[]): void {
    if (this.closed) return;
    this.files = new Map(files.map((f) => [keyOf(path.resolve(f)), path.resolve(f)]));
    const dirs = new Map<string, string>();
    for (const f of this.files.values()) dirs.set(keyOf(path.dirname(f)), path.dirname(f));

    for (const [key, w] of this.dirWatchers) {
      if (!dirs.has(key)) {
        w.close();
        this.dirWatchers.delete(key);
      }
    }
    if (!this.opts.poll) {
      for (const [key, dir] of dirs) if (!this.dirWatchers.has(key) && !this.failedDirs.has(key)) this.watchDir(key, dir);
    }

    const wantPolled = new Set<string>();
    for (const [key, file] of this.files) {
      if (this.opts.poll || this.failedDirs.has(keyOf(path.dirname(file)))) wantPolled.add(key);
    }
    for (const [key, { file, listener }] of this.polled) {
      if (!wantPolled.has(key)) {
        unwatchFile(file, listener);
        this.polled.delete(key);
      }
    }
    for (const key of wantPolled) if (!this.polled.has(key)) this.pollFile(key);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    for (const { file, listener } of this.polled.values()) unwatchFile(file, listener);
    this.polled.clear();
    this.pending.clear();
  }

  private watchDir(key: string, dir: string): void {
    let w: FSWatcher;
    try {
      w = watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) {
          // Some platforms omit the name: treat every watched file in the directory as touched.
          for (const f of this.files.values()) if (keyOf(path.dirname(f)) === key) this.mark(f);
          return;
        }
        const f = this.files.get(keyOf(path.join(dir, filename.toString())));
        if (f) this.mark(f);
      });
    } catch (e) {
      this.fallBack(key, dir, e as NodeJS.ErrnoException);
      return;
    }
    w.on('error', (e) => {
      w.close();
      this.dirWatchers.delete(key);
      this.fallBack(key, dir, e as NodeJS.ErrnoException);
      this.setFiles([...this.files.values()]);
    });
    this.dirWatchers.set(key, w);
  }

  private fallBack(key: string, dir: string, e: NodeJS.ErrnoException): void {
    this.failedDirs.add(key);
    this.opts.log?.(`fs.watch unavailable for ${dir} (${e.code ?? e.message}); polling every ${this.pollIntervalMs} ms`);
  }

  private pollFile(key: string): void {
    const file = this.files.get(key)!;
    const listener = (curr: Stats, prev: Stats) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size || curr.ino !== prev.ino) this.mark(file);
    };
    watchFile(file, { persistent: false, interval: this.pollIntervalMs }, listener);
    this.polled.set(key, { file, listener });
  }

  private mark(file: string): void {
    if (this.closed) return;
    const now = Date.now();
    if (this.pending.size === 0) this.burstStart = now;
    this.pending.add(file);
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.burstStart + this.maxWaitMs - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.timer = null;
    const files = [...this.pending];
    this.pending.clear();
    if (files.length && !this.closed) this.opts.onChange(files);
  }
}
