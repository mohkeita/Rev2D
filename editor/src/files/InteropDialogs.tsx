/**
 * Interop dialogs: "Import Live2D motions…" (Live2D JSON files into the open model, converted by the
 * server and written as one undoable edit), "Export to > Spine… / Live2D motions…" (files into a
 * workspace folder) and the conversion report of a Spine import. Every dialog ends with the report:
 * what was approximated or dropped, with its code, where it was found and a hint.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportResponse, InteropReport, Live2dImportResponse } from '../api.js';
import type { InteropIssue } from '../../../src/interop/types.js';
import { formatLabel } from '../../../src/interop/detect.js';
import { useApp, useSession } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { Icon } from '../ui/icons.js';
import { Modal } from '../ui/Modal.js';
import { planLive2d } from './importing.js';
import { baseName, formatSize, relativeToRoot } from './paths.js';

const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

type ParamMapChoice = 'standard' | 'none' | 'prefix';

const PARAM_MAPS: Array<{ value: ParamMapChoice; label: string; note: string }> = [
  { value: 'standard', label: 'Standard', note: 'AngleX ↔ ParamAngleX, EyeLOpen ↔ ParamEyeLOpen, MouthOpen ↔ ParamMouthOpenY, …; other ids unchanged' },
  { value: 'none', label: 'Same ids', note: 'Parameter ids are used as they are' },
  { value: 'prefix', label: '"Param" prefix', note: 'Blush ↔ ParamBlush for every parameter of the model' },
];

function Failure({ failure }: { failure: { error?: string; hint?: string } | null }) {
  if (!failure?.error) return null;
  return (
    <div className="notice notice-error" role="alert" data-testid="dialog-error">
      <Icon name="error" />
      <span>
        {failure.error}
        {failure.hint && <span className="notice-hint">{failure.hint}</span>}
      </span>
    </div>
  );
}

function ParamMapField({ value, onChange }: { value: ParamMapChoice; onChange(v: ParamMapChoice): void }) {
  const note = PARAM_MAPS.find((m) => m.value === value)!.note;
  return (
    <div className="field">
      <span className="field-label">Parameter ids</span>
      <span className="segmented" role="radiogroup" aria-label="Parameter ids">
        {PARAM_MAPS.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={value === m.value}
            className={`seg-button${value === m.value ? ' is-on' : ''}`}
            onClick={() => onChange(m.value)}
            data-testid={`param-map-${m.value}`}
          >
            {m.label}
          </button>
        ))}
      </span>
      <span className="field-note muted">{note}</span>
    </div>
  );
}

function Choice<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T; options: Array<[T, string]>; onChange(v: T): void; testId: string }) {
  return (
    <label className="field field-inline">
      <span className="field-label">{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

// ----------------------------------------------------------------------------- report

function IssueRow({ issue }: { issue: InteropIssue }) {
  return (
    <li className={`report-issue is-${issue.severity}`}>
      <Icon name={issue.severity === 'warning' ? 'warning' : 'info'} size={13} />
      <div className="report-issue-body">
        <div className="report-issue-head">
          <code className="report-code">{issue.code}</code>
          {issue.where && <span className="report-where">{issue.where}</span>}
        </div>
        <div className="report-message">{issue.message}</div>
        {issue.hint && <div className="report-hint">→ {issue.hint}</div>}
      </div>
    </li>
  );
}

/** A conversion report: counts, the warnings, the info notes (folded when there are warnings) and the stats. */
export function ReportView({ report }: { report: InteropReport }) {
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  const info = report.issues.filter((i) => i.severity === 'info');
  const [showInfo, setShowInfo] = useState(warnings.length === 0);
  const stats = Object.entries(report.stats);
  return (
    <div className="report" data-testid="report">
      <div className="report-counts">
        <span className={`tag ${warnings.length ? 'tag-warning' : 'tag-dim'}`} data-testid="report-warnings">
          {warnings.length} warning{warnings.length === 1 ? '' : 's'}
        </span>
        <span className="tag tag-dim">{info.length} info</span>
        {!report.issues.length && <span className="muted">Nothing was approximated or dropped.</span>}
      </div>
      {report.issues.length > 0 && (
        <ul className="report-list">
          {warnings.map((i, n) => (
            <IssueRow key={`w${n}`} issue={i} />
          ))}
          {info.length > 0 && warnings.length > 0 && (
            <li className="report-toggle">
              <button className="link-button" onClick={() => setShowInfo((v) => !v)} data-testid="report-toggle-info">
                {showInfo ? 'Hide' : 'Show'} {info.length} info note{info.length === 1 ? '' : 's'}
              </button>
            </li>
          )}
          {showInfo &&
            info.map((i, n) => (
              <IssueRow key={`i${n}`} issue={i} />
            ))}
        </ul>
      )}
      {stats.length > 0 && (
        <p className="report-stats muted" title="Counts of what was converted">
          {stats.map(([k, v]) => `${k} ${v}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

export function ReportDialog({ title, subtitle, report }: { title: string; subtitle?: string; report: InteropReport }) {
  const session = useSession();
  return (
    <Modal
      title={title}
      icon="info"
      size="medium"
      onCancel={() => session.closeDialog()}
      onConfirm={() => session.closeDialog()}
      testId="report-dialog"
      footer={subtitle ? <span className="mono ellipsis">{subtitle}</span> : null}
      actions={
        <button className="button button-primary" onClick={() => session.closeDialog()} data-autofocus="">
          Close
        </button>
      }
    >
      <ReportView report={report} />
    </Modal>
  );
}

// ----------------------------------------------------------------------------- Live2D import

function stemOf(name: string): string {
  return name.replace(/\.(motion3|exp3)\.json$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^(?=[^A-Za-z_])/, '_');
}

/** "Added 2 animations (idle, tap) and 1 physics group (hair)". */
function importSummary(r: Live2dImportResponse): string {
  const s = r.summary;
  const parts: string[] = [];
  if (s.animations.length) parts.push(`${s.animations.length} animation${s.animations.length === 1 ? '' : 's'} (${s.animations.join(', ')})`);
  if (s.physics.length) parts.push(`${s.physics.length} physics group${s.physics.length === 1 ? '' : 's'} (${s.physics.join(', ')})`);
  if (s.updates) parts.push(`${s.updates} name${s.updates === 1 ? '' : 's'} from the display info`);
  const replaced = [...s.replaced, ...s.removedPhysics];
  return parts.length ? `Imported ${parts.join(', ')}${replaced.length ? `; replaced ${replaced.join(', ')}` : ''}.` : 'Nothing was imported.';
}

export function Live2dDialog({ files }: { files: File[] }) {
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

  const formats = new Set(plan.files.map((f) => f.format));
  const model3 = formats.has('live2d-model3');
  const showPhysics = model3 || formats.has('live2d-physics3');
  const showDisplay = model3 || formats.has('live2d-cdi3');
  const animFiles = plan.files.filter((f) => f.format === 'live2d-motion3' || f.format === 'live2d-exp3');
  const showId = !model3 && animFiles.length === 1;
  const defaultId = showId ? `${animFiles[0].format === 'live2d-exp3' ? 'exp_' : ''}${stemOf(animFiles[0].name)}` : '';
  const idProblem = showId && id.trim() && !ID.test(id.trim()) ? 'An id starts with a letter or _ and has only letters, digits, _ and -.' : null;
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
      <Modal
        title="Live2D import"
        icon="check"
        size="medium"
        onCancel={() => session.closeDialog()}
        onConfirm={() => session.closeDialog()}
        testId="live2d-dialog"
        footer={<span className="muted">{written ? 'Undo (Ctrl+Z) takes the whole import back.' : ''}</span>}
        actions={
          <button className="button button-primary" onClick={() => session.closeDialog()} data-autofocus="" data-testid="live2d-done">
            Done
          </button>
        }
      >
        <p className="dialog-text" data-testid="live2d-summary">
          {importSummary(response)}{' '}
          {!response.changed ? `${target} is unchanged.` : written ? `Saved to ${target}.` : `The import is in the editor but not saved to ${target} yet (see the message above).`}
        </p>
        <ReportView report={response.report} />
      </Modal>
    );
  }

  return (
    <Modal
      title={`Import Live2D into ${target}`}
      icon="upload"
      size="medium"
      onCancel={() => session.closeDialog()}
      onConfirm={() => void run()}
      testId="live2d-dialog"
      footer={<span className="muted">The .moc3 model itself is not supported: motions, expressions, physics and names drive this model&apos;s parameters.</span>}
      actions={
        <>
          <button className="button" onClick={() => session.closeDialog()}>
            Cancel
          </button>
          <button className="button" onClick={() => session.pickLive2dFiles()} title="Pick other files">
            Choose other files…
          </button>
          <button className="button button-primary" disabled={!!plan.error || !!busy || !!idProblem} onClick={() => void run()} data-testid="live2d-confirm">
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      <div className="import-files" data-testid="live2d-files">
        {plan.files.map((f) => (
          <div key={f.name} className={`import-file${f.format ? '' : ' is-skipped'}`}>
            <Icon name={f.format ? 'file' : 'close'} />
            <span className="import-name mono">{f.name}</span>
            <span className="import-size muted">{formatSize(f.size)}</span>
            <span className={`tag ${f.format ? 'tag-accent' : 'tag-dim'}`}>{f.format ? formatLabel(f.format).replace(/^Live2D /, '') : 'skipped'}</span>
          </div>
        ))}
      </div>
      {plan.error && (
        <div className="notice notice-error" role="alert">
          <Icon name="error" />
          <span>{plan.error}</span>
        </div>
      )}
      {model3 && <p className="field-note muted">The .model3.json brings the motions, expressions, physics and display names it lists; pick those files together with it.</p>}
      <ParamMapField value={paramMap} onChange={setParamMap} />
      {showId && (
        <label className="field field-inline">
          <span className="field-label">Animation</span>
          <input className="text-input mono" type="text" value={id} placeholder={defaultId} onChange={(e) => setId(e.target.value)} spellCheck={false} data-testid="live2d-id" />
        </label>
      )}
      {idProblem && <p className="field-note error-text">{idProblem}</p>}
      {showPhysics && (
        <Choice<'replace' | 'merge' | 'skip'>
          label="Physics"
          value={physics}
          onChange={setPhysics}
          testId="live2d-physics"
          options={[
            ['replace', 'Replace groups driving the same parameters'],
            ['merge', 'Keep the model’s groups too'],
            ['skip', 'Do not import physics'],
          ]}
        />
      )}
      {showDisplay && (
        <Choice<'fill' | 'overwrite' | 'skip'>
          label="Names"
          value={displayInfo}
          onChange={setDisplayInfo}
          testId="live2d-display"
          options={[
            ['fill', 'Fill in missing names and groups'],
            ['overwrite', 'Overwrite names and groups'],
            ['skip', 'Do not import names'],
          ]}
        />
      )}
      <Failure failure={failure} />
    </Modal>
  );
}

/** Hidden file input behind "Import Live2D motions…". */
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
      className="visually-hidden"
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

const STATUS_TEXT: Record<string, string> = { new: 'new', replaced: 'replaced', unchanged: 'unchanged' };

export function ExportDialog({ format }: { format: 'spine' | 'live2d' }) {
  const session = useSession();
  const busy = useApp((s) => s.fileBusy);
  const file = useApp((s) => s.file);
  const root = useApp((s) => s.workspace?.root ?? null);
  const animations = useApp((s) => s.model?.animations.map((a) => a.id) ?? [], shallowEqual);
  const stem = baseName(file).replace(/(\.r2d)?\.jsonc?$/i, '') || 'model';
  const [selected, setSelected] = useState<Set<string>>(() => new Set(animations));
  const [dir, setDir] = useState(`exports/${stem}-${format}`);
  const [fps, setFps] = useState('30');
  const [textureScale, setTextureScale] = useState<1 | 2>(1);
  const [pma, setPma] = useState(true);
  const [paramPoses, setParamPoses] = useState(false);
  const [paramMap, setParamMap] = useState<ParamMapChoice>('standard');
  const [replace, setReplace] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ error?: string; hint?: string } | null>(null);
  const [done, setDone] = useState<ExportResponse | null>(null);

  const spine = format === 'spine';
  const fpsValue = Number(fps);
  const problem = !dir.trim() ? 'Choose an output folder.' : !(fps.trim() !== '' && fpsValue > 0 && fpsValue <= 240) ? 'The frame rate is a number from 1 to 240.' : null;
  const title = spine ? 'Export to Spine' : 'Export Live2D motions';

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
      ...(spine ? { textureScale, premultipliedAlpha: pma, paramPoses } : { paramMap }),
    });
    if (r.ok) setDone(r.response);
    else if (r.exists) setReplace(/already exist:\s*([^;]+)/.exec(r.error ?? '')?.[1]?.trim() ?? dir);
    else if (!r.cancelled) setFailure(r);
  };

  if (done) {
    const shown = (root && relativeToRoot(done.dir, root)) || done.dir;
    return (
      <Modal
        title={`${title}: done`}
        icon="check"
        size="medium"
        onCancel={() => session.closeDialog()}
        onConfirm={() => session.closeDialog()}
        testId="export-dialog"
        footer={<span className="muted">{done.notes[1] ?? ''}</span>}
        actions={
          <button className="button button-primary" onClick={() => session.closeDialog()} data-autofocus="" data-testid="export-done">
            Done
          </button>
        }
      >
        <p className="dialog-text" data-testid="export-summary">
          Exported {done.files.length} file{done.files.length === 1 ? '' : 's'} to <span className="mono">{shown}</span>.
        </p>
        <div className="import-files" data-testid="export-files">
          {done.files.map((f) => (
            <div key={f.path} className={`import-file${f.status === 'unchanged' ? ' is-skipped' : ''}`}>
              <Icon name={/\.png$/i.test(f.path) ? 'texture' : 'file'} />
              <span className="import-name mono" title={f.path}>
                {(root && relativeToRoot(f.path, root)) || f.path}
              </span>
              <span className="import-size muted">{formatSize(f.bytes)}</span>
              <span className={`tag ${f.status === 'new' ? 'tag-accent' : 'tag-dim'}`}>{STATUS_TEXT[f.status] ?? f.status}</span>
            </div>
          ))}
        </div>
        <ReportView report={done.report} />
      </Modal>
    );
  }

  const toggle = (id: string): void =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      title={title}
      icon="download"
      size="medium"
      onCancel={() => session.closeDialog()}
      onEscape={() => (replace ? setReplace(null) : session.closeDialog())}
      onConfirm={() => void run()}
      testId="export-dialog"
      footer={
        <span className="muted">
          {spine
            ? 'Writes the skeleton .json, the .atlas and PNG pages. Parameters, warps and physics are baked into the animations.'
            : 'Writes motions/*.motion3.json, physics3, cdi3 and a partial model3.json for a Live2D model with matching parameter ids.'}
        </span>
      }
      actions={
        <>
          <button className="button" onClick={() => session.closeDialog()}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!!problem || !!busy} onClick={() => void run()} data-testid="export-confirm">
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">
          Animations
          {animations.length > 1 && (
            <span className="field-label-actions">
              <button className="link-button" onClick={() => setSelected(new Set(animations))}>
                all
              </button>
              <button className="link-button" onClick={() => setSelected(new Set())}>
                none
              </button>
            </span>
          )}
        </span>
        {animations.length === 0 ? (
          <span className="field-note muted">The model has no animations{spine ? ': only the setup pose is exported.' : '.'}</span>
        ) : (
          <div className="export-anims" data-testid="export-anims">
            {animations.map((a) => (
              <label key={a} className={`toggle${selected.has(a) ? ' is-on' : ''}`}>
                <input type="checkbox" checked={selected.has(a)} onChange={() => toggle(a)} />
                <span className="mono">{a}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <label className="field field-inline">
        <span className="field-label">Frame rate</span>
        <input className="text-input num" type="text" inputMode="decimal" value={fps} onChange={(e) => setFps(e.target.value)} aria-label="Frame rate" data-testid="export-fps" />
        <span className="muted">{spine ? 'fps for sampling the baked motion' : 'fps written to the motions'}</span>
      </label>
      {spine ? (
        <>
          <div className="field field-inline">
            <span className="field-label">Textures</span>
            <span className="segmented" role="radiogroup" aria-label="Texture scale">
              {([1, 2] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={textureScale === v} className={`seg-button${textureScale === v ? ' is-on' : ''}`} onClick={() => setTextureScale(v)}>
                  {v}×
                </button>
              ))}
            </span>
            <label className={`toggle${pma ? ' is-on' : ''}`} title="Spine runtimes expect premultiplied alpha; turn it off only for a runtime configured for straight alpha">
              <input type="checkbox" checked={pma} onChange={(e) => setPma(e.target.checked)} />
              <span>Premultiplied alpha</span>
            </label>
          </div>
          <label className={`toggle export-option${paramPoses ? ' is-on' : ''}`}>
            <input type="checkbox" checked={paramPoses} onChange={(e) => setParamPoses(e.target.checked)} data-testid="export-param-poses" />
            <span>Also export each parameter&apos;s min / max pose (animations &quot;param/&lt;id&gt;/min|max&quot;)</span>
          </label>
        </>
      ) : (
        <ParamMapField value={paramMap} onChange={setParamMap} />
      )}
      <label className="field">
        <span className="field-label">Folder</span>
        <input
          className="text-input mono"
          type="text"
          value={dir}
          onChange={(e) => {
            setDir(e.target.value);
            setReplace(null);
          }}
          spellCheck={false}
          data-testid="export-dir"
        />
        <span className="field-note muted">Relative to the workspace root; created when missing.</span>
      </label>
      {problem && <p className="field-note error-text">{problem}</p>}
      {replace && (
        <div className="notice notice-warning replace-confirm" role="alert" data-testid="replace-confirm">
          <Icon name="warning" />
          <span>
            <b className="mono">{replace}</b> {replace.includes(', ') ? 'already exist. Replace them?' : 'already exists. Replace it?'}
          </span>
          <span className="replace-actions">
            <button className="button button-small" onClick={() => setReplace(null)} disabled={!!busy}>
              Keep
            </button>
            <button className="button button-small button-danger" onClick={() => void run(true)} disabled={!!busy} data-testid="replace-confirm-yes">
              Replace
            </button>
          </span>
        </div>
      )}
      <Failure failure={failure} />
    </Modal>
  );
}
