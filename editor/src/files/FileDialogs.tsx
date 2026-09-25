/**
 * File dialogs: Open (workspace browser + recent files), New (template picker + name, canvas size,
 * location), Save As (folder + file name), Import (files picked on the computer + target folder) and
 * the unsaved-changes prompt. All are modal (ui/Modal.tsx: Esc cancels, Enter confirms, focus is
 * kept inside). Replacing an existing file always asks first.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FileEntry } from '../api.js';
import { useApp, useSession } from '../state/context.js';
import type { Session } from '../state/session.js';
import type { FileOpResult } from '../state/session.js';
import type { UnsavedPrompt } from '../state/app.js';
import { Icon } from '../ui/icons.js';
import { Modal } from '../ui/Modal.js';
import { FileBrowser } from './FileBrowser.js';
import { planImport, textureCheck, texturePlacement } from './importing.js';
import {
  baseName,
  copyName,
  dirOf,
  fileNameProblem,
  isOpenable,
  formatSize,
  joinPath,
  modelFileName,
  relativeToRoot,
  rootLabel,
  slugify,
  uniqueFileName,
} from './paths.js';
import { SIZED_TEMPLATES, shortDescription, templateThumbnail, templateTitle } from './templates.js';
import { useTemplates } from './useTemplates.js';

/** Folder the last dialog worked in (used when no model is open). */
let lastDir = '';

/** Where a dialog starts: the open model's folder, else the last folder used. */
function initialDir(session: Session): string {
  const s = session.get();
  const root = s.workspace?.root;
  if (s.file && root) {
    const rel = relativeToRoot(s.file, root);
    if (rel !== null) return dirOf(rel);
  }
  return lastDir;
}

function useWorkspaceInfo() {
  const root = useApp((s) => s.workspace?.root ?? null);
  const file = useApp((s) => s.file);
  const currentRel = root && file ? relativeToRoot(file, root) : null;
  return { root, rootName: rootLabel(root), currentRel };
}

/** A file already listed in `dir` under this (case-insensitive) name. Nested names are not checked here. */
function existsIn(entries: readonly FileEntry[], name: string): boolean {
  if (name.includes('/')) return false;
  const n = name.toLowerCase();
  return entries.some((e) => e.type !== 'dir' && e.name.toLowerCase() === n);
}

/** Inline "X already exists. Replace it?" row (`target` may list several files, comma-separated). */
function ReplaceConfirm({ target, onReplace, onCancel, busy }: { target: string; onReplace(): void; onCancel(): void; busy: boolean }) {
  const many = target.includes(', ');
  return (
    <div className="notice notice-warning replace-confirm" role="alert" data-testid="replace-confirm">
      <Icon name="warning" />
      <span>
        <b className="mono">{target}</b> {many ? 'already exist. Replace them?' : 'already exists. Replace it?'}
      </span>
      <span className="replace-actions">
        <button className="button button-small" onClick={onCancel} disabled={busy}>
          {many ? 'Keep them' : 'Keep it'}
        </button>
        <button className="button button-small button-danger" onClick={onReplace} disabled={busy} data-testid="replace-confirm-yes">
          Replace
        </button>
      </span>
    </div>
  );
}

function ErrorNote({ result }: { result: { error?: string; hint?: string } | null }) {
  if (!result?.error) return null;
  return (
    <div className="notice notice-error" role="alert" data-testid="dialog-error">
      <Icon name="error" />
      <span>
        {result.error}
        {result.hint && <span className="notice-hint">{result.hint}</span>}
      </span>
    </div>
  );
}

type Failure = Extract<FileOpResult, { ok: false }>;

// ----------------------------------------------------------------------------- Open

function OpenDialog() {
  const session = useSession();
  const { rootName, currentRel, root } = useWorkspaceInfo();
  const recent = useApp((s) => s.workspace?.recent ?? []);
  const busy = useApp((s) => s.fileBusy);
  const [dir, setDir] = useState(() => initialDir(session));
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const close = () => session.closeDialog();

  const open = async (file: string): Promise<void> => {
    setFailure(null);
    lastDir = dir;
    const r = await session.openFile(file);
    if (!r.ok && !r.cancelled) setFailure(r);
  };
  const canOpen = !!selected && isOpenable(selected) && !busy;
  const recentInRoot = recent
    .map((abs) => ({ abs, rel: root ? relativeToRoot(abs, root) : null }))
    .filter((r): r is { abs: string; rel: string } => r.rel !== null);

  return (
    <Modal
      title="Open model"
      icon="folderOpen"
      size="wide"
      onCancel={close}
      onConfirm={() => canOpen && void open(selected!.path)}
      testId="open-dialog"
      footer={
        selected ? (
          <span className="mono ellipsis" title={selected.path}>
            {selected.path}
          </span>
        ) : (
          <span className="muted">Pick a model file. Double-click or Enter opens it.</span>
        )
      }
      actions={
        <>
          <button className="button" onClick={close}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!canOpen} onClick={() => void open(selected!.path)} data-testid="open-confirm">
            {busy ? 'Opening…' : 'Open'}
          </button>
        </>
      }
    >
      <div className="open-layout">
        <aside className="open-side" aria-label="Recent files">
          <div className="side-title">
            <Icon name="clock" size={13} /> Recent
          </div>
          {recentInRoot.length === 0 && <p className="side-empty">Models you open show up here.</p>}
          {recentInRoot.map((r) => (
            <button
              key={r.abs}
              className={`side-item${currentRel === r.rel ? ' is-current' : ''}`}
              title={r.rel}
              onClick={() => void open(r.abs)}
              disabled={!!busy}
              data-testid="open-recent-item"
            >
              <Icon name="file" size={14} />
              <span className="side-item-text">
                <span className="side-item-name">{baseName(r.rel)}</span>
                <span className="side-item-dir">{dirOf(r.rel) || rootName}</span>
              </span>
            </button>
          ))}
        </aside>
        <FileBrowser
          mode="open"
          dir={dir}
          onDir={setDir}
          selected={selected?.path ?? null}
          onSelect={setSelected}
          onActivate={(e) => void open(e.path)}
          rootName={rootName}
          autoFocus
          currentRel={currentRel}
          className="open-browser"
        />
      </div>
      <ErrorNote result={failure} />
    </Modal>
  );
}

// ----------------------------------------------------------------------------- New

function parseSize(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 8192 ? n : null;
}

function NewDialog({ initialTemplate }: { initialTemplate?: string }) {
  const session = useSession();
  const { rootName, currentRel } = useWorkspaceInfo();
  const busy = useApp((s) => s.fileBusy);
  const { templates, error: templatesError } = useTemplates();
  const [template, setTemplate] = useState(initialTemplate ?? 'blank');
  const [name, setName] = useState(initialTemplate && !SIZED_TEMPLATES.has(initialTemplate) ? initialTemplate : 'untitled');
  const [nameTouched, setNameTouched] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileTouched, setFileTouched] = useState(false);
  const [width, setWidth] = useState('512');
  const [height, setHeight] = useState('512');
  const [dir, setDir] = useState(() => initialDir(session));
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [replace, setReplace] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sized = SIZED_TEMPLATES.has(template);
  const autoFile = uniqueFileName(modelFileName(slugify(name)), entries.map((e) => e.name));
  const effectiveFile = fileTouched ? fileName : autoFile;
  const target = joinPath(dir, modelFileName(effectiveFile));
  const problem = fileNameProblem(modelFileName(effectiveFile)) ?? (sized && (!parseSize(width) || !parseSize(height)) ? 'Canvas width and height are whole numbers from 1 to 8192.' : null);

  const pick = (t: string): void => {
    setTemplate(t);
    setReplace(null);
    if (!nameTouched) setName(SIZED_TEMPLATES.has(t) ? 'untitled' : t);
  };

  const create = async (overwrite = false): Promise<void> => {
    if (problem || busy) return;
    setFailure(null);
    if (!overwrite && existsIn(entries, modelFileName(effectiveFile))) {
      setReplace(target);
      return;
    }
    lastDir = dir;
    const r = await session.createModel({
      file: target,
      template,
      name: name.trim() || undefined,
      ...(sized ? { width: parseSize(width)!, height: parseSize(height)! } : {}),
      ...(overwrite ? { overwrite: true } : {}),
    });
    if (r.ok) return;
    if (r.exists) setReplace(target);
    else if (!r.cancelled) setFailure(r);
  };

  const list = templates ?? [];
  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = list.findIndex((t) => t.name === template);
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d || !list.length) return;
    e.preventDefault();
    const next = list[Math.max(0, Math.min(list.length - 1, i + d))];
    pick(next.name);
    listRef.current?.querySelector<HTMLElement>(`[data-template="${next.name}"]`)?.focus();
  };

  return (
    <Modal
      title="New model"
      icon="fileNew"
      size="wide"
      onCancel={() => session.closeDialog()}
      onEscape={() => (replace ? setReplace(null) : session.closeDialog())}
      onConfirm={() => void create()}
      testId="new-dialog"
      footer={
        <span className="mono ellipsis" title={target}>
          <span className="muted">Creates </span>
          {target}
        </span>
      }
      actions={
        <>
          <button className="button" onClick={() => session.closeDialog()}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!!problem || !!busy} onClick={() => void create()} data-testid="new-confirm">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="new-layout">
        <div className="template-list" role="radiogroup" aria-label="Template" ref={listRef} onKeyDown={onListKey} data-testid="template-list">
          {templates === null && <div className="fb-empty">Loading templates…</div>}
          {templatesError && <div className="fb-empty error-text">Templates unavailable: {templatesError}</div>}
          {list.map((t) => {
            const thumb = templateThumbnail(t.name);
            const on = t.name === template;
            return (
              <button
                key={t.name}
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                className={`template-item${on ? ' is-on' : ''}`}
                onClick={() => pick(t.name)}
                data-template={t.name}
                data-testid={`template-${t.name}`}
              >
                <span className={`template-thumb${thumb ? '' : ' is-empty'}`}>{thumb ? <img src={thumb} alt="" /> : <Icon name={t.name === 'empty' ? 'plus' : 'model'} size={18} />}</span>
                <span className="template-text">
                  <span className="template-name">
                    {templateTitle(t.name)}
                    {SIZED_TEMPLATES.has(t.name) ? <span className="tag tag-dim">starter</span> : <span className="tag tag-accent">example</span>}
                  </span>
                  <span className="template-desc">{shortDescription(t.description)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="new-form">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="text-input"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
                setReplace(null);
              }}
              data-autofocus=""
              spellCheck={false}
              data-testid="new-name"
            />
          </label>
          {sized && (
            <div className="field">
              <span className="field-label">Canvas</span>
              <span className="size-inputs">
                <input className="text-input num" type="text" inputMode="numeric" value={width} onChange={(e) => {
                    setWidth(e.target.value);
                    setReplace(null);
                  }} aria-label="Canvas width" data-testid="new-width" />
                <span className="muted">×</span>
                <input className="text-input num" type="text" inputMode="numeric" value={height} onChange={(e) => {
                    setHeight(e.target.value);
                    setReplace(null);
                  }} aria-label="Canvas height" data-testid="new-height" />
                <span className="muted">px</span>
              </span>
            </div>
          )}
          <div className="field field-grow">
            <span className="field-label">Location</span>
            <FileBrowser
              mode="folder"
              dir={dir}
              onDir={(d) => {
                setDir(d);
                setReplace(null);
              }}
              selected={selected?.path ?? null}
              onSelect={(e) => {
                setSelected(e);
                if (e && isOpenable(e)) {
                  setFileName(e.name);
                  setFileTouched(true);
                }
              }}
              onActivate={() => undefined}
              rootName={rootName}
              currentRel={currentRel}
              onEntries={setEntries}
              className="compact"
            />
          </div>
          <label className="field">
            <span className="field-label">File name</span>
            <input
              className="text-input mono"
              type="text"
              value={effectiveFile}
              onChange={(e) => {
                setFileName(e.target.value);
                setFileTouched(true);
                setReplace(null);
              }}
              spellCheck={false}
              data-testid="new-file"
            />
          </label>
          {!sized && <p className="field-note muted">Example textures are copied next to the new model; the example itself is never changed.</p>}
          {problem && effectiveFile && <p className="field-note error-text">{problem}</p>}
        </div>
      </div>
      {replace && <ReplaceConfirm target={replace} busy={!!busy} onCancel={() => setReplace(null)} onReplace={() => void create(true)} />}
      <ErrorNote result={failure} />
    </Modal>
  );
}

// ----------------------------------------------------------------------------- Save As

function SaveAsDialog() {
  const session = useSession();
  const { rootName, currentRel } = useWorkspaceInfo();
  const file = useApp((s) => s.file);
  const busy = useApp((s) => s.fileBusy);
  const [dir, setDir] = useState(() => initialDir(session));
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [fileName, setFileName] = useState(() => copyName(file));
  const [replace, setReplace] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const name = modelFileName(fileName);
  const target = joinPath(dir, name);
  const problem = fileNameProblem(name);

  const save = async (overwrite = false): Promise<void> => {
    if (problem || busy) return;
    setFailure(null);
    // Saving over the open model itself is a plain save (the server needs no overwrite for it).
    if (!overwrite && existsIn(entries, name) && target.toLowerCase() !== (currentRel ?? '').toLowerCase()) {
      setReplace(target);
      return;
    }
    lastDir = dir;
    const r = await session.saveAs(target, overwrite);
    if (r.ok) return;
    if (r.exists) setReplace(target);
    else if (!r.cancelled) setFailure(r);
  };

  return (
    <Modal
      title="Save As"
      icon="saveAs"
      size="medium"
      onCancel={() => session.closeDialog()}
      onEscape={() => (replace ? setReplace(null) : session.closeDialog())}
      onConfirm={() => void save()}
      testId="save-as-dialog"
      footer={<span className="muted">Relative texture paths are rewritten so they still find the same PNG files.</span>}
      actions={
        <>
          <button className="button" onClick={() => session.closeDialog()}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!!problem || !!busy} onClick={() => void save()} data-testid="save-as-confirm">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <FileBrowser
        mode="folder"
        dir={dir}
        onDir={(d) => {
          setDir(d);
          setReplace(null);
        }}
        selected={selected?.path ?? null}
        onSelect={(e) => {
          setSelected(e);
          if (e && isOpenable(e)) {
            setFileName(e.name);
            setReplace(null);
          }
        }}
        onActivate={() => undefined}
        rootName={rootName}
        currentRel={currentRel}
        onEntries={setEntries}
        className="save-browser"
      />
      <label className="field field-inline">
        <span className="field-label">File name</span>
        <input
          className="text-input mono"
          type="text"
          value={fileName}
          onChange={(e) => {
            setFileName(e.target.value);
            setReplace(null);
          }}
          data-autofocus="stem"
          spellCheck={false}
          data-testid="save-as-name"
        />
      </label>
      <p className="field-note">
        <span className="muted">Saves to </span>
        <span className="mono">{target || '…'}</span>
        {problem && fileName && <span className="error-text"> — {problem}</span>}
      </p>
      {replace && <ReplaceConfirm target={replace} busy={!!busy} onCancel={() => setReplace(null)} onReplace={() => void save(true)} />}
      <ErrorNote result={failure} />
    </Modal>
  );
}

// ----------------------------------------------------------------------------- Import

function ImportDialog({ files }: { files: File[] }) {
  const session = useSession();
  const { rootName, currentRel } = useWorkspaceInfo();
  const busy = useApp((s) => s.fileBusy);
  const plan = useMemo(() => planImport(files), [files]);
  const [dir, setDir] = useState(() => initialDir(session));
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [check, setCheck] = useState<ReturnType<typeof textureCheck> | null>(null);
  /** Picked PNG -> the subfolder path the model references it by (where it is written). */
  const [placement, setPlacement] = useState<Record<string, string>>({});
  const [replace, setReplace] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    const model = files.find((f) => f.name === plan.model);
    if (!model) return;
    let alive = true;
    model
      .text()
      .then((text) => {
        if (!alive) return;
        setCheck(textureCheck(text, plan.textures));
        setPlacement(texturePlacement(text, plan.textures));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [files, plan]);

  const target = plan.model ? joinPath(dir, plan.model) : '';

  // No name check up front: the server accepts files identical to the ones there and names the
  // others in its 409 answer.
  const run = async (overwrite = false): Promise<void> => {
    if (plan.error || busy) return;
    setFailure(null);
    lastDir = dir;
    const r = await session.importFiles(files, dir, overwrite);
    if (r.ok) return;
    if (r.exists) setReplace(/already exist:\s*([^;]+)/.exec(r.error ?? '')?.[1]?.trim() ?? target);
    else if (!r.cancelled) setFailure(r);
  };

  return (
    <Modal
      title="Import from computer"
      icon="upload"
      size="medium"
      onCancel={() => session.closeDialog()}
      onEscape={() => (replace ? setReplace(null) : session.closeDialog())}
      onConfirm={() => void run()}
      testId="import-dialog"
      footer={
        target ? (
          <span className="mono ellipsis" title={target}>
            <span className="muted">Opens </span>
            {target}
          </span>
        ) : null
      }
      actions={
        <>
          <button className="button" onClick={() => session.closeDialog()}>
            Cancel
          </button>
          <button className="button" onClick={() => session.pickImportFiles()} title="Pick other files">
            Choose other files…
          </button>
          <button className="button button-primary" disabled={!!plan.error || !!busy} onClick={() => void run()} data-testid="import-confirm">
            {busy ? 'Importing…' : 'Import and open'}
          </button>
        </>
      }
    >
      <div className="import-files" data-testid="import-files">
        {files.map((f) => {
          const kind = f.name === plan.model ? 'model' : plan.textures.includes(f.name) ? 'texture' : 'skipped';
          return (
            <div key={f.name} className={`import-file is-${kind}`}>
              <Icon name={kind === 'model' ? 'file' : kind === 'texture' ? 'texture' : 'close'} />
              <span className="import-name mono" title={placement[f.name] ? `${f.name}, written as ${placement[f.name]} (the path the model uses)` : undefined}>
                {placement[f.name] ?? f.name}
              </span>
              <span className="import-size muted">{formatSize(f.size)}</span>
              <span className={`tag ${kind === 'model' ? 'tag-accent' : kind === 'skipped' ? 'tag-dim' : ''}`}>{kind === 'skipped' ? 'skipped' : kind}</span>
            </div>
          );
        })}
      </div>
      {plan.error && (
        <div className="notice notice-error" role="alert">
          <Icon name="error" />
          <span>{plan.error}</span>
        </div>
      )}
      {plan.skipped.length > 0 && !plan.error && <p className="field-note muted">Only one .json model and .png textures are imported; the other files are skipped.</p>}
      {check && check.missing.length > 0 && (
        <div className="notice notice-warning">
          <Icon name="warning" />
          <span>
            The model uses {check.missing.length === 1 ? 'a texture' : 'textures'} you did not pick: <span className="mono">{check.missing.join(', ')}</span>. Pick{' '}
            {check.missing.length === 1 ? 'it' : 'them'} too, or copy {check.missing.length === 1 ? 'it' : 'them'} into the folder later.
          </span>
        </div>
      )}
      <div className="field field-grow">
        <span className="field-label">Into folder</span>
        <FileBrowser
          mode="folder"
          dir={dir}
          onDir={(d) => {
            setDir(d);
            setReplace(null);
          }}
          selected={selected?.path ?? null}
          onSelect={setSelected}
          onActivate={() => undefined}
          rootName={rootName}
          currentRel={currentRel}
          autoFocus
          className="compact"
        />
      </div>
      {replace && <ReplaceConfirm target={replace} busy={!!busy} onCancel={() => setReplace(null)} onReplace={() => void run(true)} />}
      <ErrorNote result={failure} />
    </Modal>
  );
}

// ----------------------------------------------------------------------------- unsaved changes

export function UnsavedDialog({ prompt }: { prompt: UnsavedPrompt }) {
  const session = useSession();
  const saving = prompt.phase === 'saving';
  const asking = prompt.phase === 'asking' ? prompt : null;
  return (
    <Modal
      alert
      title={`Save changes to ${prompt.file}?`}
      icon="warning"
      tone="warning"
      size="narrow"
      onCancel={() => !saving && session.resolveUnsaved('cancel')}
      onConfirm={() => !saving && session.resolveUnsaved('save')}
      testId="unsaved-dialog"
      actions={
        <>
          <button className="button button-primary" onClick={() => session.resolveUnsaved('save')} disabled={saving} data-autofocus="" data-testid="unsaved-save">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {asking?.canForce && (
            <button className="button button-danger" onClick={() => session.resolveUnsaved('saveAnyway')} data-testid="unsaved-save-anyway">
              Save anyway
            </button>
          )}
          <button className="button" onClick={() => session.resolveUnsaved('discard')} disabled={saving} data-testid="unsaved-discard">
            Don&apos;t save
          </button>
          <button className="button" onClick={() => session.resolveUnsaved('cancel')} disabled={saving} data-testid="unsaved-cancel">
            Cancel
          </button>
        </>
      }
    >
      <p className="dialog-text">
        Your latest edit is not saved to disk. If you don&apos;t save, it is lost when you {prompt.action}.
      </p>
      {asking?.error && (
        <div className="notice notice-error" role="alert">
          <Icon name="error" />
          <span>
            {asking.error}
            {asking.canForce && ' "Save anyway" writes it despite the errors (the Problems panel lists them).'}
          </span>
        </div>
      )}
    </Modal>
  );
}

// ----------------------------------------------------------------------------- host

/** Hidden file input behind "Import from computer…" (also the target of drag and drop). */
function ImportPicker() {
  const session = useSession();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    session.setImportPicker(() => ref.current?.click());
    return () => session.setImportPicker(null);
  }, [session]);
  return (
    <input
      ref={ref}
      type="file"
      multiple
      accept=".json,.jsonc,.png,application/json,image/png"
      className="visually-hidden"
      tabIndex={-1}
      aria-hidden="true"
      data-testid="import-input"
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (files.length) session.openDialog({ kind: 'import', files });
      }}
    />
  );
}

/** Whichever file dialog is open, the unsaved-changes prompt above it, and the import file input. */
export function FileDialogs() {
  const dialog = useApp((s) => s.dialog);
  const prompt = useApp((s) => s.unsavedPrompt);
  return (
    <>
      {dialog?.kind === 'open' && <OpenDialog />}
      {dialog?.kind === 'new' && <NewDialog key={dialog.template ?? ''} initialTemplate={dialog.template} />}
      {dialog?.kind === 'saveAs' && <SaveAsDialog />}
      {dialog?.kind === 'import' && <ImportDialog key={dialog.files.map((f) => f.name).join('|')} files={dialog.files} />}
      {prompt && <UnsavedDialog prompt={prompt} />}
      <ImportPicker />
    </>
  );
}
