/**
 * Where a job works and what the panel suggests (pure).
 *
 * The open model decides the job's context: `file` (the model, relative to the workspace root) and
 * `project` (its folder, which the server makes the agent's working directory; the root itself is
 * left out). Suggestions are requests that fit the open document; they are i18n keys, so the request
 * is sent in the person's language.
 */
import type { Model } from '../../../src/core/index.js';
import type { MessageKey } from '../i18n/index.js';
import { baseName, dirOf, normalizeSlashes, relativeToRoot } from '../files/paths.js';

export interface WorkContext {
  /** The open model relative to the workspace root ('/'-separated); absent when none is open. */
  file?: string;
  /** Its folder relative to the root; absent for the root itself. */
  project?: string;
  /** The folder's display name ('' when the root is unknown). */
  folder: string;
  /** The folder as an absolute path (null when the root is unknown). */
  folderPath: string | null;
}

export function workContext(file: string | null | undefined, root: string | null | undefined): WorkContext {
  const r = root ? normalizeSlashes(root) : null;
  const rel = file && r ? relativeToRoot(file, r) : null;
  if (rel === null || rel === '') return { folder: r ? baseName(r) : '', folderPath: r };
  const project = dirOf(rel);
  return {
    file: rel,
    ...(project ? { project } : {}),
    folder: project ? baseName(project) : r ? baseName(r) : '',
    folderPath: r ? (project ? `${r}/${project}` : r) : null,
  };
}

/**
 * The context of a job: what the caller gives wins; the open model fills `project` and `file` when
 * the caller left them out (`file` only when it lies inside the project the job works in).
 */
export function jobContext(base: WorkContext, given: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...given };
  if (!('project' in given) && base.project) out.project = base.project;
  const project = typeof out.project === 'string' ? normalizeSlashes(out.project).replace(/^\.\/?/, '') : '';
  if (!('file' in given) && base.file && (!project || base.file.startsWith(`${project}/`))) out.file = base.file;
  return out;
}

export interface Suggestion {
  id: string;
  key: MessageKey;
}

/** Up to four requests that fit the open document. */
export function suggestionsFor(model: Pick<Model, 'parameters' | 'animations'> | null): Suggestion[] {
  if (!model) {
    return [
      { id: 'new-model', key: 'ai.suggest.newModel' },
      { id: 'how-to', key: 'ai.suggest.howTo' },
    ];
  }
  const anims = new Set((model.animations ?? []).map((a) => a.id));
  const params = new Set((model.parameters ?? []).map((p) => p.id));
  const out: Suggestion[] = [];
  if (anims.has('idle') && !anims.has('blink')) out.push({ id: 'blink', key: 'ai.suggest.blinkOverIdle' });
  if (anims.has('idle')) out.push({ id: 'analyze-idle', key: 'ai.suggest.analyzeIdle' });
  if (anims.size === 0) out.push({ id: 'create-idle', key: 'ai.suggest.createIdle' });
  if (params.has('AngleX')) out.push({ id: 'head-turn', key: 'ai.suggest.headTurn' });
  out.push({ id: 'validate', key: 'ai.suggest.validate' });
  out.push({ id: 'explain', key: 'ai.suggest.explain' });
  return out.slice(0, 4);
}
