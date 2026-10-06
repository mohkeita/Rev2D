/**
 * File dialogs: Open (workspace browser + recent files), New (template picker + name, canvas size,
 * location), Save As (folder + file name), Import (files picked on the computer + target folder; a
 * Spine export is converted on the way) and the unsaved-changes alert; the interop dialogs (Live2D
 * import, export to Spine / Live2D, conversion report) live in InteropDialogs.tsx. All are sheets of
 * the design system (ui/Dialog.tsx: Esc cancels, Enter confirms, the focus is kept inside).
 * Replacing an existing file always asks first, in an alert on top of the dialog.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FileEntry } from '../api.js';
import { AvatarHost } from '../avatar/AvatarHost.js';
import { Badge, Button, Icon, List, ListRow, ListSection, Spinner, TextField } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { useApp, useSession } from '../state/context.js';
import type { Session } from '../state/session.js';
import type { FileOpResult } from '../state/session.js';
import type { UnsavedPrompt } from '../state/app.js';
import { Dialog, useLingering } from '../ui/Dialog.js';
import { FieldRow, LinkButton, Notice } from '../ui/kit.js';
import { ErrorNote, FileRow, PathInfo, ReplaceAlert } from './dialog-parts.js';
import { FileBrowser } from './FileBrowser.js';
import { ExportDialog, Live2dDialog, Live2dPicker, ReportDialog } from './InteropDialogs.js';
import { jsonKind, planImport, spinePageCheck, textureCheck, texturePlacement } from './importing.js';
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
import { SIZED_TEMPLATES, templateSummary, templateThumbnail, templateTitle } from './templates.js';
import { useTemplates } from './useTemplates.js';
import './file-dialogs.css';

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

type Failure = Extract<FileOpResult, { ok: false }>;

// ----------------------------------------------------------------------------- Open

function OpenDialog({ open }: { open: boolean }) {
  const t = useT();
  const session = useSession();
  const { rootName, currentRel, root } = useWorkspaceInfo();
  const recent = useApp((s) => s.workspace?.recent ?? []);
  const busy = useApp((s) => s.fileBusy);
  const [dir, setDir] = useState(() => initialDir(session));
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const close = () => session.closeDialog();

  const openFile = async (file: string): Promise<void> => {
    setFailure(null);
    lastDir = dir;
    // An avatar project's avatar.json opens the project: its built model, or the project alone (Avatar mode).
    const r = await session.openFile(file);
    if (!r.ok && !r.cancelled) setFailure(r);
  };
  const openable = !!selected && isOpenable(selected);
  const canOpen = openable && !busy;
  const recentInRoot = recent
    .map((abs) => ({ abs, rel: root ? relativeToRoot(abs, root) : null }))
    .filter((r): r is { abs: string; rel: string } => r.rel !== null);

  return (
    <Dialog
      open={open}
      title={t('files.open.title')}
      icon="folderOpen"
      size="lg"
      onCancel={close}
      onConfirm={() => canOpen && void openFile(selected!.path)}
      testId="open-dialog"
      footer={selected ? <span className="ed-dialog-path ed-mono-small" title={selected.path}>{selected.path}</span> : t('files.open.hint')}
      actions={
        <>
          <Button size="lg" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" variant="filled" disabled={!openable} loading={!!busy} onClick={() => canOpen && void openFile(selected!.path)} data-testid="open-confirm">
            {busy ? t('files.open.opening') : t('common.open')}
          </Button>
        </>
      }
    >
      <div className="ed-open">
        <section className="ed-open-recent" aria-label={t('files.recent.title')}>
          <div className="ed-open-recent-title">
            <Icon name="clock" size={14} />
            <span>{t('files.recent.title')}</span>
          </div>
          {recentInRoot.length === 0 ? (
            <p className="ed-open-recent-empty">{t('files.open.recentEmpty')}</p>
          ) : (
            <List variant="sidebar" className="ed-open-recent-list r2-scroll">
              <ListSection>
                {recentInRoot.map((r) => (
                  <ListRow
                    key={r.abs}
                    icon="file"
                    iconColor="var(--r2-kind-part)"
                    title={baseName(r.rel)}
                    subtitle={dirOf(r.rel) || rootName}
                    selected={currentRel === r.rel}
                    disabled={!!busy}
                    onSelect={() => void openFile(r.abs)}
                    data-testid="open-recent-item"
                  />
                ))}
              </ListSection>
            </List>
          )}
        </section>
        <FileBrowser
          mode="open"
          variant="fill"
          dir={dir}
          onDir={setDir}
          selected={selected?.path ?? null}
          onSelect={setSelected}
          onActivate={(e) => void openFile(e.path)}
          rootName={rootName}
          autoFocus
          currentRel={currentRel}
          className="ed-open-browser"
        />
      </div>
      <ErrorNote result={failure} />
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- New

function parseSize(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 8192 ? n : null;
}

function NewDialog({ open, initialTemplate }: { open: boolean; initialTemplate?: string }) {
  const t = useT();
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
  const nameProblem = fileNameProblem(modelFileName(effectiveFile));
  const sizeProblem = sized && (!parseSize(width) || !parseSize(height)) ? t('files.new.sizeProblem') : null;
  const problem = nameProblem ?? sizeProblem;

  const pick = (id: string): void => {
    setTemplate(id);
    setReplace(null);
    if (!nameTouched) setName(SIZED_TEMPLATES.has(id) ? 'untitled' : id);
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
    const i = list.findIndex((x) => x.name === template);
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d || !list.length) return;
    e.preventDefault();
    const next = list[Math.max(0, Math.min(list.length - 1, i + d))];
    pick(next.name);
    listRef.current?.querySelector<HTMLElement>(`[data-template="${next.name}"]`)?.focus();
  };

  return (
    <>
      <Dialog
        open={open}
        title={t('files.new.title')}
        icon="fileNew"
        size="lg"
        onCancel={() => session.closeDialog()}
        onEscape={() => (replace ? setReplace(null) : session.closeDialog())}
        onConfirm={() => void create()}
        testId="new-dialog"
        footer={<PathInfo label={t('files.new.creates')} path={target} />}
        actions={
          <>
            <Button size="lg" onClick={() => session.closeDialog()}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" variant="filled" disabled={!!problem} loading={!!busy} onClick={() => void create()} data-testid="new-confirm">
              {busy ? t('files.new.creating') : t('files.new.create')}
            </Button>
          </>
        }
      >
        <div className="ed-new">
          <div className="ed-tpl-list r2-scroll" role="radiogroup" aria-label={t('files.new.template')} ref={listRef} onKeyDown={onListKey} data-testid="template-list">
            {templates === null && (
              <div className="ed-tpl-note">
                <Spinner size={14} />
                <span>{t('files.new.loadingTemplates')}</span>
              </div>
            )}
            {templatesError && <div className="ed-tpl-note ed-danger-text">{t('files.new.templatesError', { error: templatesError })}</div>}
            {list.map((tpl) => {
              const thumb = templateThumbnail(tpl.name);
              const on = tpl.name === template;
              const starter = SIZED_TEMPLATES.has(tpl.name);
              return (
                <button
                  key={tpl.name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  className="ed-tpl"
                  onClick={() => pick(tpl.name)}
                  title={tpl.description}
                  data-template={tpl.name}
                  data-testid={`template-${tpl.name}`}
                >
                  <span className="ed-tpl-thumb">{thumb ? <img src={thumb} alt="" /> : <Icon name={tpl.name === 'empty' ? 'plus' : 'model'} size={20} />}</span>
                  <span className="ed-tpl-text">
                    <span className="ed-tpl-name">
                      <span className="ed-ellipsis">{templateTitle(tpl.name)}</span>
                      <Badge tone={starter ? 'neutral' : 'tint'}>{starter ? t('files.new.starter') : t('files.new.example')}</Badge>
                    </span>
                    <span className="ed-tpl-desc">{templateSummary(tpl.name, tpl.description)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="ed-new-form">
            <TextField
              label={t('files.new.name')}
              value={name}
              onChange={(v) => {
                setName(v);
                setNameTouched(true);
                setReplace(null);
              }}
              data-autofocus=""
              data-testid="new-name"
            />
            {sized && (
              <FieldRow label={t('files.new.canvas')} error={sizeProblem ?? undefined}>
                <TextField
                  className="ed-new-size"
                  inputMode="numeric"
                  value={width}
                  onChange={(v) => {
                    setWidth(v);
                    setReplace(null);
                  }}
                  aria-label={t('files.new.canvasWidth')}
                  data-testid="new-width"
                />
                <span className="ed-faint" aria-hidden="true">
                  ×
                </span>
                <TextField
                  className="ed-new-size"
                  inputMode="numeric"
                  value={height}
                  onChange={(v) => {
                    setHeight(v);
                    setReplace(null);
                  }}
                  aria-label={t('files.new.canvasHeight')}
                  data-testid="new-height"
                />
                <span className="ed-muted">px</span>
              </FieldRow>
            )}
            <FieldRow label={t('files.new.location')} className="ed-new-location">
              <FileBrowser
                mode="folder"
                variant="compact"
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
              />
            </FieldRow>
            <TextField
              label={t('files.fileName')}
              mono
              value={effectiveFile}
              onChange={(v) => {
                setFileName(v);
                setFileTouched(true);
                setReplace(null);
              }}
              error={nameProblem && effectiveFile ? nameProblem : undefined}
              hint={!sized ? t('files.new.exampleNote') : undefined}
              data-testid="new-file"
            />
          </div>
        </div>
        <ErrorNote result={failure} />
      </Dialog>
      <ReplaceAlert target={replace} busy={!!busy} onCancel={() => setReplace(null)} onReplace={() => void create(true)} />
    </>
  );
}

// ----------------------------------------------------------------------------- Save As

function SaveAsDialog({ open }: { open: boolean }) {
  const t = useT();
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
    <>
      <Dialog
        open={open}
        title={t('files.saveAs.title')}
        icon="saveAs"
        size="md"
        onCancel={() => session.closeDialog()}
        onEscape={() => (replace ? setReplace(null) : session.closeDialog())}
        onConfirm={() => void save()}
        testId="save-as-dialog"
        footer={<PathInfo label={t('files.saveAs.savesTo')} path={target} />}
        actions={
          <>
            <Button size="lg" onClick={() => session.closeDialog()}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" variant="filled" disabled={!!problem} loading={!!busy} onClick={() => void save()} data-testid="save-as-confirm">
              {busy ? t('common.saving') : t('common.save')}
            </Button>
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
        />
        <TextField
          label={t('files.fileName')}
          mono
          value={fileName}
          onChange={(v) => {
            setFileName(v);
            setReplace(null);
          }}
          error={problem && fileName ? problem : undefined}
          hint={t('files.saveAs.textureNote')}
          data-autofocus="stem"
          data-testid="save-as-name"
        />
        <ErrorNote result={failure} />
      </Dialog>
      <ReplaceAlert target={replace} busy={!!busy} onCancel={() => setReplace(null)} onReplace={() => void save(true)} />
    </>
  );
}

// ----------------------------------------------------------------------------- Import

function ImportDialog({ open, files }: { open: boolean; files: File[] }) {
  const t = useT();
  const session = useSession();
  const { rootName, currentRel } = useWorkspaceInfo();
  const busy = useApp((s) => s.fileBusy);
  const plan = useMemo(() => planImport(files), [files]);
  const [dir, setDir] = useState(() => initialDir(session));
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [check, setCheck] = useState<ReturnType<typeof textureCheck> | null>(null);
  /** Picked PNG -> the subfolder path the model references it by (where it is written). */
  const [placement, setPlacement] = useState<Record<string, string>>({});
  /** The picked .json is a Spine skeleton (converted by the server) and its atlas pages vs the picked PNGs. */
  const [spine, setSpine] = useState(false);
  const [pages, setPages] = useState<ReturnType<typeof spinePageCheck> | null>(null);
  const [replace, setReplace] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    const model = files.find((f) => f.name === plan.model);
    if (!model) return;
    let alive = true;
    model
      .text()
      .then(async (text) => {
        if (!alive) return;
        if (jsonKind(model.name, text) === 'spine') {
          setSpine(true);
          const atlasTexts = await Promise.all(files.filter((f) => plan.atlases.includes(f.name)).map((f) => f.text()));
          if (alive) setPages(spinePageCheck(atlasTexts, plan.textures));
          return;
        }
        setCheck(textureCheck(text, plan.textures));
        setPlacement(texturePlacement(text, plan.textures));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [files, plan]);

  const spineModel = plan.model ? `${plan.model.replace(/\.jsonc?$/i, '')}.r2d.json` : '';
  const target = plan.model ? joinPath(dir, spine ? spineModel : plan.model) : '';

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
    <>
      <Dialog
        open={open}
        title={spine ? t('files.import.titleSpine') : t('files.import.title')}
        icon="upload"
        size="md"
        onCancel={() => session.closeDialog()}
        onEscape={() => (replace ? setReplace(null) : session.closeDialog())}
        onConfirm={() => void run()}
        testId="import-dialog"
        footer={target ? <PathInfo label={t('files.import.opens')} path={target} /> : null}
        actions={
          <>
            <Button size="lg" onClick={() => session.closeDialog()}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" variant="filled" disabled={!!plan.error} loading={!!busy} onClick={() => void run()} data-testid="import-confirm">
              {busy ? (spine ? t('files.import.converting') : t('files.import.importing')) : spine ? t('files.import.confirmSpine') : t('files.import.confirm')}
            </Button>
          </>
        }
      >
        <FieldRow
          label={t('files.import.files', { n: files.length })}
          labelTrailing={
            <LinkButton onClick={() => session.pickImportFiles()} data-testid="import-choose">
              {t('files.import.chooseOther')}
            </LinkButton>
          }
        >
          <div className="ed-filelist r2-scroll" data-testid="import-files">
            {files.map((f) => {
              const kind = f.name === plan.model ? 'model' : plan.textures.includes(f.name) ? 'texture' : spine && plan.atlases.includes(f.name) ? 'atlas' : 'skipped';
              const label =
                kind === 'model'
                  ? spine
                    ? t('files.import.kind.spine')
                    : t('files.import.kind.model')
                  : kind === 'texture'
                    ? spine
                      ? pages && pages.unused.includes(f.name)
                        ? t('files.import.kind.notPage')
                        : t('files.import.kind.page')
                      : t('files.import.kind.texture')
                    : kind === 'atlas'
                      ? t('files.import.kind.atlas')
                      : t('files.import.kind.skipped');
              return (
                <FileRow
                  key={f.name}
                  icon={kind === 'model' || kind === 'atlas' ? 'file' : kind === 'texture' ? 'texture' : 'close'}
                  name={placement[f.name] ?? f.name}
                  title={placement[f.name] ? t('files.import.placed', { name: f.name, path: placement[f.name] }) : undefined}
                  size={formatSize(f.size)}
                  dim={kind === 'skipped'}
                  badge={<Badge tone={kind === 'model' ? 'tint' : 'neutral'}>{label}</Badge>}
                />
              );
            })}
          </div>
        </FieldRow>
        {plan.error && <Notice tone="danger">{plan.error}</Notice>}
        {plan.skipped.length > 0 && !plan.error && <p className="ed-dialog-note">{t('files.import.skippedNote')}</p>}
        {spine && (
          <p className="ed-dialog-note" data-testid="import-spine-note">
            {t('files.import.spineNote', { file: spineModel })}
          </p>
        )}
        {spine && plan.atlases.length === 0 && <Notice tone="warning">{t('files.import.noAtlas')}</Notice>}
        {spine && pages && pages.missing.length > 0 && <Notice tone="warning">{t('files.import.missingPages', { n: pages.missing.length, names: pages.missing.join(', ') })}</Notice>}
        {check && check.missing.length > 0 && <Notice tone="warning">{t('files.import.missingTextures', { n: check.missing.length, names: check.missing.join(', ') })}</Notice>}
        <FieldRow label={t('files.import.intoFolder')}>
          <FileBrowser
            mode="folder"
            variant="compact"
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
          />
        </FieldRow>
        <ErrorNote result={failure} />
      </Dialog>
      <ReplaceAlert target={replace} busy={!!busy} onCancel={() => setReplace(null)} onReplace={() => void run(true)} />
    </>
  );
}

// ----------------------------------------------------------------------------- unsaved changes

/** "Save changes to x?": Save (the default), Don't Save, Cancel; Save Anyway when the model was rejected. */
export function UnsavedDialog({ prompt, open = true }: { prompt: UnsavedPrompt; open?: boolean }) {
  const t = useT();
  const session = useSession();
  const saving = prompt.phase === 'saving';
  const asking = prompt.phase === 'asking' ? prompt : null;
  return (
    <Dialog
      alert
      open={open}
      icon="warning"
      className="ed-alert-warning"
      title={t('files.unsaved.title', { file: prompt.file })}
      description={t('files.unsaved.message', { action: prompt.action })}
      onCancel={() => !saving && session.resolveUnsaved('cancel')}
      onConfirm={() => !saving && session.resolveUnsaved('save')}
      testId="unsaved-dialog"
      actions={
        <>
          <Button size="lg" block onClick={() => session.resolveUnsaved('cancel')} disabled={saving} data-testid="unsaved-cancel">
            {t('common.cancel')}
          </Button>
          <Button size="lg" block destructive onClick={() => session.resolveUnsaved('discard')} disabled={saving} data-testid="unsaved-discard">
            {t('files.unsaved.discard')}
          </Button>
          {asking?.canForce && (
            <Button size="lg" block destructive onClick={() => session.resolveUnsaved('saveAnyway')} data-testid="unsaved-save-anyway">
              {t('files.unsaved.saveAnyway')}
            </Button>
          )}
          <Button size="lg" block variant="filled" loading={saving} onClick={() => session.resolveUnsaved('save')} data-autofocus="" data-testid="unsaved-save">
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      {asking?.error ? (
        <Notice tone="danger" hint={asking.canForce ? t('files.unsaved.forceHint') : undefined} data-testid="unsaved-error">
          {asking.error}
        </Notice>
      ) : null}
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- host

/** Hidden file input behind "Import from Computer…" (Live2D files it is given go to the Live2D import). */
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
      accept=".json,.jsonc,.png,.atlas,.txt,application/json,image/png"
      className="r2-visually-hidden"
      tabIndex={-1}
      aria-hidden="true"
      data-testid="import-input"
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (files.length) session.openPickedFiles(files);
      }}
    />
  );
}

/** A number that changes whenever `value` is another (non-null) object: a fresh dialog per request. */
function useIdentityKey(value: object | null): number {
  const ref = useRef<{ value: object | null; key: number }>({ value, key: 0 });
  if (value !== null && ref.current.value !== value) ref.current = { value, key: ref.current.key + 1 };
  return ref.current.key;
}

/** Whichever file dialog is open, the unsaved-changes alert above it, and the import file inputs. */
export function FileDialogs() {
  const current = useApp((s) => s.dialog);
  const key = useIdentityKey(current);
  // Closed dialogs stay rendered (open={false}) while their closing animation plays.
  const dialog = useLingering(current);
  const prompt = useLingering(useApp((s) => s.unsavedPrompt));
  const d = dialog.value;
  return (
    <>
      {d?.kind === 'open' && <OpenDialog key={key} open={dialog.open} />}
      {d?.kind === 'new' && <NewDialog key={key} open={dialog.open} initialTemplate={d.template} />}
      {d?.kind === 'saveAs' && <SaveAsDialog key={key} open={dialog.open} />}
      {d?.kind === 'import' && <ImportDialog key={key} open={dialog.open} files={d.files} />}
      {d?.kind === 'live2d' && <Live2dDialog key={key} open={dialog.open} files={d.files} />}
      {d?.kind === 'export' && <ExportDialog key={key} open={dialog.open} format={d.format} />}
      {d?.kind === 'report' && <ReportDialog key={key} open={dialog.open} title={d.title} subtitle={d.subtitle} report={d.report} />}
      {prompt.value && <UnsavedDialog prompt={prompt.value} open={prompt.open} />}
      <ImportPicker />
      <Live2dPicker />
      {/* Avatar mode: its store, keys and the "Avatar from an Illustration" sheet. */}
      <AvatarHost />
    </>
  );
}
