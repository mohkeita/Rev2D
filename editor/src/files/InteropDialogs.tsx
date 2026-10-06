/**
 * Interop dialogs: "Import Live2D Motions…" (Live2D JSON files into the open model, converted by the
 * server and written as one undoable edit), "Export To > Spine… / Live2D Motions…" (files into a
 * workspace folder) and the conversion report of a Spine import. Every dialog ends with the report:
 * what was approximated or dropped, with its code, where it was found and a hint.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ExportResponse, InteropReport, Live2dImportResponse } from '../api.js';
import type { InteropIssue } from '../../../src/interop/types.js';
import type { DetectedFormat } from '../../../src/interop/detect.js';
import { Badge, Button, Icon, List, ListRow, ListSection, SegmentedControl, Select, Switch, TextField } from '../design/index.js';
import { useT, type MessageKey, type Translate } from '../i18n/index.js';
import { useApp, useSession } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { Dialog } from '../ui/Dialog.js';
import { FieldRow, LinkButton, Notice } from '../ui/kit.js';
import { ErrorNote, FileRow, PathInfo, ReplaceAlert } from './dialog-parts.js';
import { planLive2d } from './importing.js';
import { baseName, formatSize, relativeToRoot } from './paths.js';
import './interop.css';

const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * A ref whose button takes the focus when `active` turns true: the result view of a dialog replaces
 * its form inside the same sheet, and the button that had the focus is gone with the form.
 */
function useFocusWhen(active: boolean): RefObject<HTMLButtonElement | null> {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.focus({ preventScroll: true });
  }, [active]);
  return ref;
}

type ParamMapChoice = 'standard' | 'none' | 'prefix';

const PARAM_MAPS: ReadonlyArray<{ value: ParamMapChoice; label: MessageKey; note: MessageKey }> = [
  { value: 'standard', label: 'files.interop.map.standard', note: 'files.interop.map.standard.note' },
  { value: 'none', label: 'files.interop.map.none', note: 'files.interop.map.none.note' },
  { value: 'prefix', label: 'files.interop.map.prefix', note: 'files.interop.map.prefix.note' },
];

/** How Rev2D parameter ids map to Live2D ids (segments carry `data-value` for tests). */
function ParamMapField({ value, onChange }: { value: ParamMapChoice; onChange(v: ParamMapChoice): void }) {
  const t = useT();
  const note = PARAM_MAPS.find((m) => m.value === value)!.note;
  return (
    <FieldRow label={t('files.interop.map.label')} hint={t(note)}>
      <SegmentedControl<ParamMapChoice>
        block
        aria-label={t('files.interop.map.label')}
        value={value}
        onChange={onChange}
        options={PARAM_MAPS.map((m) => ({ value: m.value, label: t(m.label) }))}
        data-testid="param-map"
      />
    </FieldRow>
  );
}

function Choice<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T; options: Array<[T, string]>; onChange(v: T): void; testId: string }) {
  return (
    <FieldRow label={label} layout="inline">
      <Select<T> block aria-label={label} value={value} onChange={onChange} options={options.map(([v, text]) => ({ value: v, label: text }))} data-testid={testId} />
    </FieldRow>
  );
}

// ----------------------------------------------------------------------------- report

function IssueRow({ issue }: { issue: InteropIssue }) {
  return (
    <li className="ed-report-issue" data-severity={issue.severity}>
      <Icon name={issue.severity === 'warning' ? 'warning' : 'info'} size={16} className="ed-report-icon" />
      <div className="ed-report-body">
        <div className="ed-report-head">
          <code className="ed-report-code ed-mono-small">{issue.code}</code>
          {issue.where && <span className="ed-report-where ed-mono-small">{issue.where}</span>}
        </div>
        <div className="ed-report-message">{issue.message}</div>
        {issue.hint && <div className="ed-report-hint">→ {issue.hint}</div>}
      </div>
    </li>
  );
}

/** A conversion report: counts, the warnings, the info notes (folded when there are warnings) and the stats. */
export function ReportView({ report }: { report: InteropReport }) {
  const t = useT();
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  const info = report.issues.filter((i) => i.severity === 'info');
  const [showInfo, setShowInfo] = useState(warnings.length === 0);
  const stats = Object.entries(report.stats);
  return (
    <div className="ed-report" data-testid="report">
      <div className="ed-report-counts">
        <Badge tone={warnings.length ? 'warning' : 'neutral'} icon={warnings.length ? 'warning' : undefined} data-testid="report-warnings">
          {t('files.report.warnings', { n: warnings.length })}
        </Badge>
        <Badge>{t('files.report.info', { n: info.length })}</Badge>
        {!report.issues.length && <span className="ed-muted">{t('files.report.clean')}</span>}
        {info.length > 0 && warnings.length > 0 && (
          <LinkButton className="ed-report-toggle" onClick={() => setShowInfo((v) => !v)} data-testid="report-toggle-info">
            {showInfo ? t('files.report.hideInfo', { n: info.length }) : t('files.report.showInfo', { n: info.length })}
          </LinkButton>
        )}
      </div>
      {(warnings.length > 0 || (showInfo && info.length > 0)) && (
        <ul className="ed-report-list r2-scroll">
          {warnings.map((i, n) => (
            <IssueRow key={`w${n}`} issue={i} />
          ))}
          {showInfo && info.map((i, n) => <IssueRow key={`i${n}`} issue={i} />)}
        </ul>
      )}
      {stats.length > 0 && (
        <p className="ed-report-stats" title={t('files.report.statsHint')}>
          {stats.map(([k, v]) => `${k} ${v}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

export function ReportDialog({ open = true, title, subtitle, report }: { open?: boolean; title: string; subtitle?: string; report: InteropReport }) {
  const t = useT();
  const session = useSession();
  return (
    <Dialog
      open={open}
      title={title}
      icon="info"
      size="md"
      onCancel={() => session.closeDialog()}
      onConfirm={() => session.closeDialog()}
      testId="report-dialog"
      footer={subtitle ? <span className="ed-dialog-path ed-mono-small" title={subtitle}>{subtitle}</span> : null}
      actions={
        <Button size="lg" variant="filled" onClick={() => session.closeDialog()} data-autofocus="">
          {t('common.close')}
        </Button>
      }
    >
      <ReportView report={report} />
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- Live2D import

function stemOf(name: string): string {
  return name.replace(/\.(motion3|exp3)\.json$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^(?=[^A-Za-z_])/, '_');
}

const LIVE2D_KIND: Partial<Record<DetectedFormat, MessageKey>> = {
  'live2d-model3': 'files.live2d.kind.model3',
  'live2d-motion3': 'files.live2d.kind.motion3',
  'live2d-exp3': 'files.live2d.kind.exp3',
  'live2d-physics3': 'files.live2d.kind.physics3',
  'live2d-cdi3': 'files.live2d.kind.cdi3',
};

/** "Imported 2 animations (idle, tap), 1 physics group (hair)." */
function importSummary(t: Translate, r: Live2dImportResponse): string {
  const s = r.summary;
  const parts: string[] = [];
  if (s.animations.length) parts.push(t('files.live2d.summary.animations', { n: s.animations.length, names: s.animations.join(', ') }));
  if (s.physics.length) parts.push(t('files.live2d.summary.physics', { n: s.physics.length, names: s.physics.join(', ') }));
  if (s.updates) parts.push(t('files.live2d.summary.names', { n: s.updates }));
  const replaced = [...s.replaced, ...s.removedPhysics];
  if (!parts.length) return t('files.live2d.summary.nothing');
  return replaced.length ? t('files.live2d.summary.importedReplaced', { parts: parts.join(', '), replaced: replaced.join(', ') }) : t('files.live2d.summary.imported', { parts: parts.join(', ') });
}

export function Live2dDialog({ open = true, files }: { open?: boolean; files: File[] }) {
  const t = useT();
  const session = useSession();
  const busy = useApp((s) => s.fileBusy);
  const file = useApp((s) => s.file);
  const plan = useMemo(() => planLive2d(files), [files]);
  const [paramMap, setParamMap] = useState<ParamMapChoice>('standard');
  const [physics, setPhysics] = useState<'replace' | 'merge' | 'skip'>('replace');
  const [displayInfo, setDisplayInfo] = useState<'fill' | 'overwrite' | 'skip'>('fill');
  const [id, setId] = useState('');
  const [failure, setFailure] = useState<{ error?: string; hint?: string } | null>(null);
  const [done, setDone] = useState<{ response: Live2dImportResponse; written: boolean } | null>(null);
  const doneButton = useFocusWhen(done !== null);

  const formats = new Set(plan.files.map((f) => f.format));
  const model3 = formats.has('live2d-model3');
  const showPhysics = model3 || formats.has('live2d-physics3');
  const showDisplay = model3 || formats.has('live2d-cdi3');
  const animFiles = plan.files.filter((f) => f.format === 'live2d-motion3' || f.format === 'live2d-exp3');
  const showId = !model3 && animFiles.length === 1;
  const defaultId = showId ? `${animFiles[0].format === 'live2d-exp3' ? 'exp_' : ''}${stemOf(animFiles[0].name)}` : '';
  const idProblem = showId && id.trim() && !ID.test(id.trim()) ? t('files.live2d.idProblem') : null;
  const target = baseName(file);

  const run = async (): Promise<void> => {
    if (plan.error || busy || idProblem) return;
    setFailure(null);
    const r = await session.importLive2d(files, {
      paramMap,
      ...(showPhysics ? { physics } : {}),
      ...(showDisplay ? { displayInfo } : {}),
      ...(showId && id.trim() ? { id: id.trim() } : {}),
    });
    if (r.ok) setDone({ response: r.response, written: r.written });
    else if (!r.cancelled) setFailure(r);
  };

  if (done) {
    const { response, written } = done;
    return (
      <Dialog
        open={open}
        title={t('files.live2d.doneTitle')}
        icon="checkCircle"
        size="md"
        onCancel={() => session.closeDialog()}
        onConfirm={() => session.closeDialog()}
        testId="live2d-dialog"
        footer={written ? t('files.live2d.undoHint') : null}
        actions={
          <Button ref={doneButton} size="lg" variant="filled" onClick={() => session.closeDialog()} data-autofocus="" data-testid="live2d-done">
            {t('common.done')}
          </Button>
        }
      >
        <p className="ed-dialog-text" data-testid="live2d-summary">
          {importSummary(t, response)}{' '}
          {!response.changed ? t('files.live2d.unchanged', { file: target }) : written ? t('files.live2d.saved', { file: target }) : t('files.live2d.notSaved', { file: target })}
        </p>
        <ReportView report={response.report} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      title={t('files.live2d.title', { file: target })}
      icon="upload"
      size="md"
      onCancel={() => session.closeDialog()}
      onConfirm={() => void run()}
      testId="live2d-dialog"
      actions={
        <>
          <Button size="lg" onClick={() => session.closeDialog()}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" variant="filled" disabled={!!plan.error || !!idProblem} loading={!!busy} onClick={() => void run()} data-autofocus={showId ? undefined : ''} data-testid="live2d-confirm">
            {busy ? t('files.import.importing') : t('files.live2d.confirm')}
          </Button>
        </>
      }
    >
      <FieldRow
        label={t('files.import.files', { n: plan.files.length })}
        labelTrailing={
          <LinkButton onClick={() => session.pickLive2dFiles()} data-testid="live2d-choose">
            {t('files.import.chooseOther')}
          </LinkButton>
        }
      >
        <div className="ed-filelist r2-scroll" data-testid="live2d-files">
          {plan.files.map((f) => (
            <FileRow
              key={f.name}
              icon={f.format ? 'file' : 'close'}
              name={f.name}
              size={formatSize(f.size)}
              dim={!f.format}
              badge={<Badge tone={f.format ? 'tint' : 'neutral'}>{f.format ? t(LIVE2D_KIND[f.format] ?? 'files.import.kind.model') : t('files.import.kind.skipped')}</Badge>}
            />
          ))}
        </div>
      </FieldRow>
      {plan.error && <Notice tone="danger">{plan.error}</Notice>}
      <p className="ed-dialog-note">{model3 ? t('files.live2d.model3Note') : t('files.live2d.mocNote')}</p>
      <ParamMapField value={paramMap} onChange={setParamMap} />
      {showId && (
        <TextField
          label={t('files.live2d.animationId')}
          mono
          value={id}
          placeholder={defaultId}
          onChange={setId}
          error={idProblem ?? undefined}
          data-autofocus=""
          data-testid="live2d-id"
        />
      )}
      {showPhysics && (
        <Choice<'replace' | 'merge' | 'skip'>
          label={t('files.live2d.physics')}
          value={physics}
          onChange={setPhysics}
          testId="live2d-physics"
          options={[
            ['replace', t('files.live2d.physics.replace')],
            ['merge', t('files.live2d.physics.merge')],
            ['skip', t('files.live2d.physics.skip')],
          ]}
        />
      )}
      {showDisplay && (
        <Choice<'fill' | 'overwrite' | 'skip'>
          label={t('files.live2d.names')}
          value={displayInfo}
          onChange={setDisplayInfo}
          testId="live2d-display"
          options={[
            ['fill', t('files.live2d.names.fill')],
            ['overwrite', t('files.live2d.names.overwrite')],
            ['skip', t('files.live2d.names.skip')],
          ]}
        />
      )}
      <ErrorNote result={failure} />
    </Dialog>
  );
}

/** Hidden file input behind "Import Live2D Motions…". */
export function Live2dPicker() {
  const session = useSession();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    session.setLive2dPicker(() => ref.current?.click());
    return () => session.setLive2dPicker(null);
  }, [session]);
  return (
    <input
      ref={ref}
      type="file"
      multiple
      accept=".json,application/json"
      className="r2-visually-hidden"
      tabIndex={-1}
      aria-hidden="true"
      data-testid="live2d-input"
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (files.length) session.openDialog({ kind: 'live2d', files });
      }}
    />
  );
}

// ----------------------------------------------------------------------------- export

const STATUS_KEY: Record<string, MessageKey> = { new: 'files.export.status.new', replaced: 'files.export.status.replaced', unchanged: 'files.export.status.unchanged' };

export function ExportDialog({ open = true, format }: { open?: boolean; format: 'spine' | 'live2d' }) {
  const t = useT();
  const session = useSession();
  const busy = useApp((s) => s.fileBusy);
  const file = useApp((s) => s.file);
  const root = useApp((s) => s.workspace?.root ?? null);
  const animations = useApp((s) => s.model?.animations.map((a) => a.id) ?? [], shallowEqual);
  const stem = baseName(file).replace(/(\.r2d)?\.jsonc?$/i, '') || 'model';
  const [selected, setSelected] = useState<Set<string>>(() => new Set(animations));
  const [dir, setDir] = useState(`exports/${stem}-${format}`);
  const [fps, setFps] = useState('30');
  const [textureScale, setTextureScale] = useState<'1' | '2'>('1');
  const [pma, setPma] = useState(true);
  const [paramPoses, setParamPoses] = useState(false);
  const [paramMap, setParamMap] = useState<ParamMapChoice>('standard');
  const [replace, setReplace] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ error?: string; hint?: string } | null>(null);
  const [done, setDone] = useState<ExportResponse | null>(null);
  const doneButton = useFocusWhen(done !== null);

  const spine = format === 'spine';
  const fpsValue = Number(fps);
  const dirProblem = !dir.trim() ? t('files.export.dirProblem') : null;
  const fpsProblem = !(fps.trim() !== '' && fpsValue > 0 && fpsValue <= 240) ? t('files.export.fpsProblem') : null;
  const problem = dirProblem ?? fpsProblem;

  const run = async (overwrite = false): Promise<void> => {
    if (problem || busy) return;
    setFailure(null);
    const chosen = animations.filter((a) => selected.has(a));
    const r = await session.exportModel({
      format,
      dir: dir.trim(),
      ...(overwrite ? { overwrite: true } : {}),
      ...(chosen.length === animations.length ? {} : { animations: chosen }),
      fps: fpsValue,
      ...(spine ? { textureScale: textureScale === '2' ? 2 : 1, premultipliedAlpha: pma, paramPoses } : { paramMap }),
    });
    if (r.ok) setDone(r.response);
    else if (r.exists) setReplace(/already exist:\s*([^;]+)/.exec(r.error ?? '')?.[1]?.trim() ?? dir);
    else if (!r.cancelled) setFailure(r);
  };

  if (done) {
    const shown = (root && relativeToRoot(done.dir, root)) || done.dir;
    return (
      <Dialog
        open={open}
        title={spine ? t('files.export.doneTitle.spine') : t('files.export.doneTitle.live2d')}
        icon="checkCircle"
        size="md"
        onCancel={() => session.closeDialog()}
        onConfirm={() => session.closeDialog()}
        testId="export-dialog"
        actions={
          <Button ref={doneButton} size="lg" variant="filled" onClick={() => session.closeDialog()} data-autofocus="" data-testid="export-done">
            {t('common.done')}
          </Button>
        }
      >
        <p className="ed-dialog-text" data-testid="export-summary">
          {t('files.export.summary', { n: done.files.length, dir: shown })}
        </p>
        <div className="ed-filelist r2-scroll" data-testid="export-files">
          {done.files.map((f) => (
            <FileRow
              key={f.path}
              icon={/\.png$/i.test(f.path) ? 'texture' : 'file'}
              name={(root && relativeToRoot(f.path, root)) || f.path}
              title={f.path}
              size={formatSize(f.bytes)}
              dim={f.status === 'unchanged'}
              badge={<Badge tone={f.status === 'new' ? 'tint' : 'neutral'}>{STATUS_KEY[f.status] ? t(STATUS_KEY[f.status]) : f.status}</Badge>}
            />
          ))}
        </div>
        <ReportView report={done.report} />
        {done.notes[1] && <p className="ed-dialog-note">{done.notes[1]}</p>}
      </Dialog>
    );
  }

  const toggle = (id: string, on: boolean): void =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      <Dialog
        open={open}
        title={spine ? t('files.export.title.spine') : t('files.export.title.live2d')}
        icon="export"
        size="md"
        onCancel={() => session.closeDialog()}
        onEscape={() => (replace ? setReplace(null) : session.closeDialog())}
        onConfirm={() => void run()}
        testId="export-dialog"
        footer={<PathInfo label={t('files.export.writesTo')} path={dir.trim()} />}
        actions={
          <>
            <Button size="lg" onClick={() => session.closeDialog()}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" variant="filled" disabled={!!problem} loading={!!busy} onClick={() => void run()} data-autofocus="" data-testid="export-confirm">
              {busy ? t('files.export.exporting') : t('files.export.confirm')}
            </Button>
          </>
        }
      >
        <p className="ed-dialog-note">{spine ? t('files.export.note.spine') : t('files.export.note.live2d')}</p>
        <FieldRow
          label={t('files.export.animations')}
          labelTrailing={
            animations.length > 1 ? (
              <span className="ed-export-links">
                <LinkButton onClick={() => setSelected(new Set(animations))} data-testid="export-anims-all">
                  {t('common.all')}
                </LinkButton>
                <LinkButton onClick={() => setSelected(new Set())} data-testid="export-anims-none">
                  {t('common.none')}
                </LinkButton>
              </span>
            ) : undefined
          }
          hint={animations.length === 0 ? (spine ? t('files.export.noAnimations.spine') : t('files.export.noAnimations.live2d')) : undefined}
        >
          {animations.length > 0 && (
            <div className="ed-export-anims r2-scroll" data-testid="export-anims">
              <List variant="inset" size="sm">
                <ListSection>
                  {animations.map((a) => (
                    <ListRow
                      key={a}
                      icon="film"
                      iconColor="var(--r2-kind-animation)"
                      title={<span className="ed-mono-small">{a}</span>}
                      trailing={(labelId) => <Switch size="sm" aria-labelledby={labelId} checked={selected.has(a)} onChange={(on) => toggle(a, on)} data-testid={`export-anim-${a}`} />}
                    />
                  ))}
                </ListSection>
              </List>
            </div>
          )}
        </FieldRow>
        <FieldRow label={t('files.export.frameRate')} layout="inline" hint={spine ? t('files.export.frameRate.spine') : t('files.export.frameRate.live2d')} error={fpsProblem ?? undefined}>
          <TextField className="ed-export-fps" inputMode="decimal" value={fps} onChange={setFps} aria-label={t('files.export.frameRate')} trailing={<span className="ed-faint">fps</span>} data-testid="export-fps" />
        </FieldRow>
        {spine ? (
          <>
            <FieldRow label={t('files.export.textureScale')} layout="inline">
              <SegmentedControl<'1' | '2'>
                aria-label={t('files.export.textureScale')}
                value={textureScale}
                onChange={setTextureScale}
                options={[
                  { value: '1', label: '1×' },
                  { value: '2', label: '2×' },
                ]}
                data-testid="export-texture-scale"
              />
            </FieldRow>
            <List variant="inset" className="ed-export-options">
              <ListSection>
                <ListRow
                  title={t('files.export.pma')}
                  subtitle={t('files.export.pma.note')}
                  trailing={(labelId) => <Switch aria-labelledby={labelId} checked={pma} onChange={setPma} data-testid="export-pma" />}
                />
                <ListRow
                  title={t('files.export.paramPoses')}
                  subtitle={t('files.export.paramPoses.note')}
                  trailing={(labelId) => <Switch aria-labelledby={labelId} checked={paramPoses} onChange={setParamPoses} data-testid="export-param-poses" />}
                />
              </ListSection>
            </List>
          </>
        ) : (
          <ParamMapField value={paramMap} onChange={setParamMap} />
        )}
        <TextField
          label={t('files.export.folder')}
          mono
          value={dir}
          onChange={(v) => {
            setDir(v);
            setReplace(null);
          }}
          error={dirProblem ?? undefined}
          hint={t('files.export.folder.hint')}
          data-testid="export-dir"
        />
        <ErrorNote result={failure} />
      </Dialog>
      <ReplaceAlert target={replace} busy={!!busy} onCancel={() => setReplace(null)} onReplace={() => void run(true)} />
    </>
  );
}
