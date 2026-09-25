/**
 * Inspector for the selected object: live pose values (read-only), what drives it, and its RAW JSON
 * from the document (as written on disk). Apply replaces the object in the raw document and writes
 * it (PUT {doc}); edits that would make the model invalid are held back with the diagnostics.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  parseJsonc,
  type Diagnostic,
  type IkConstraint,
  type IkPose,
  type Model,
  type PhysicsGroup,
  type PhysicsPose,
  type Pose,
} from '../../../src/core/index.js';
import { formatModelJson } from '../../../src/core/format.js';
import { textureUrl } from '../api.js';
import { useApp, useSession } from '../state/context.js';
import { entityPointer, getEntity, hasJsonComments, parseRefKey, refKey, resolveRef, type EntityRef, type RawDoc } from '../state/doc.js';
import { Icon } from '../ui/icons.js';
import { KIND_ICON } from './Outliner.js';

const KIND_LABEL: Record<EntityRef['kind'], string> = {
  part: 'Part',
  bone: 'Bone',
  warp: 'Warp',
  param: 'Parameter',
  animation: 'Animation',
  binding: 'Binding',
  ik: 'IK constraint',
  physics: 'Physics group',
  texture: 'Texture',
};

export function Inspector() {
  const selection = useApp((s) => s.selection);
  const doc = useApp((s) => s.doc);
  const ref = selection.length ? resolveRef(doc, selection[0]) ?? parseRefKey(selection[0]) : null;
  return (
    <section className="panel-section inspector" data-testid="inspector">
      <div className="section-head">
        <span className="section-title">Inspector</span>
        {selection.length > 1 && <span className="count">{selection.length} selected · showing first</span>}
      </div>
      <div className="section-body">
        {ref ? <InspectorBody key={refKey(ref)} entity={ref} /> : <p className="empty-note">Select a part, bone, warp, parameter or animation in the viewport or outliner.</p>}
      </div>
    </section>
  );
}

function InspectorBody({ entity }: { entity: EntityRef }) {
  const session = useSession();
  const doc = useApp((s) => s.doc);
  const model = useApp((s) => s.model);
  const diagnostics = useApp((s) => s.diagnostics);
  const raw = getEntity(doc, entity);
  const pointer = entityPointer(doc, entity);
  const own = pointer ? diagnostics.filter((d) => d.path === pointer || d.path.startsWith(`${pointer}/`)) : [];

  return (
    <div className="inspector-body">
      <div className="inspector-title">
        <Icon name={KIND_ICON[entity.kind]} className={`icon kind-${entity.kind}`} />
        <div className="inspector-name">
          <span className="inspector-id" title={refKey(entity)}>
            {entity.kind === 'binding' && model ? bindingTitle(model, entity.id) : entity.id}
          </span>
          <span className="inspector-kind">
            {KIND_LABEL[entity.kind]}
            {pointer && <span className="mono muted"> · {pointer}</span>}
          </span>
        </div>
        {(entity.kind === 'part' || entity.kind === 'bone' || entity.kind === 'warp') && (
          <button className="icon-button" title="Frame in viewport (F)" onClick={() => session.focus('selection')}>
            <Icon name="fit" />
          </button>
        )}
      </div>
      {raw === undefined ? (
        <p className="empty-note">{refKey(entity)} is not in the current file version.</p>
      ) : (
        <>
          {own.length > 0 && <DiagnosticList items={own} />}
          {model && <LiveInfo entity={entity} model={model} />}
          <JsonEditor entity={entity} raw={raw} pointer={pointer} doc={doc} />
        </>
      )}
    </div>
  );
}

function bindingTitle(model: Model, id: string): string {
  const b = /^\d+$/.test(id) ? model.bindings[Number(id)] : model.bindings.find((x) => x.id === id);
  return b ? `${b.id ? `${b.id}: ` : ''}${b.target}` : id;
}

// ------------------------------------------------------------------------------------ live info

const n3 = (v: number): string => String(Math.round(v * 1000) / 1000);
const n1 = (v: number): string => String(Math.round(v * 10) / 10);

function Prop({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

function LiveInfo({ entity, model }: { entity: EntityRef; model: Model }) {
  const session = useSession();
  // Re-render with every new pose.
  useApp((s) => s.poseTick);
  const values = useApp((s) => s.values);
  const physicsOn = useApp((s) => s.physics);
  const physicsValues = useApp((s) => s.physicsValues);
  const overrides = useApp((s) => s.overrides);
  const pose: Pose | null = session.currentFrame()?.pose ?? null;
  const drivers = useMemo(() => driversOf(model, entity), [model, entity]);
  let props: ReactNode = null;

  if (entity.kind === 'part' && pose) {
    const pp = pose.parts[entity.id];
    const def = model.parts.find((p) => p.id === entity.id);
    if (pp && def) {
      const b = pp.bounds;
      props = (
        <>
          <Prop k="shape">{def.shape.type}</Prop>
          <Prop k="parent">{def.parent ?? (def.skin ? `skin: ${def.skin.bones.join(', ')}` : '—')}</Prop>
          <Prop k="drawn">{pose.drawOrder.includes(entity.id) ? `yes · #${pose.drawOrder.indexOf(entity.id)} of ${pose.drawOrder.length}` : 'no'}</Prop>
          <Prop k="opacity / z">
            {n3(pp.opacity)} / {n3(pp.z)}
          </Prop>
          <Prop k="bounds">{b ? `[${b.map(n1).join(', ')}]` : '—'}</Prop>
          <Prop k="center">{b ? `${n1(b[0] + b[2] / 2)}, ${n1(b[1] + b[3] / 2)}` : '—'}</Prop>
          {def.mask?.length ? <Prop k={def.maskInvert ? 'mask (inv)' : 'mask'}>{def.mask.join(', ')}</Prop> : null}
          {def.blend !== 'normal' && <Prop k="blend">{def.blend}</Prop>}
        </>
      );
    }
  } else if (entity.kind === 'bone' && pose) {
    const bp = pose.bones[entity.id];
    if (bp) {
      props = (
        <>
          <Prop k="world x, y">
            {n1(bp.x)}, {n1(bp.y)}
          </Prop>
          <Prop k="world rot">{n3(bp.rotation)}°</Prop>
          <Prop k="world scale">
            {n3(bp.scaleX)}, {n3(bp.scaleY)}
          </Prop>
          <Prop k="tip">
            {n1(bp.tip[0])}, {n1(bp.tip[1])}
          </Prop>
          <Prop k="local">
            x {n1(bp.local.x)} · y {n1(bp.local.y)} · rot {n3(bp.local.rotation)}°
          </Prop>
        </>
      );
    }
  } else if (entity.kind === 'warp' && pose) {
    const w = model.warps.find((x) => x.id === entity.id);
    if (w) {
      props = (
        <>
          <Prop k="lattice">
            {w.cols} × {w.rows} cells · {(w.cols + 1) * (w.rows + 1)} points
          </Prop>
          <Prop k="parent">{w.parent ?? '—'}</Prop>
          <Prop k="rest rect">[{w.rect.join(', ')}]</Prop>
        </>
      );
    }
  } else if (entity.kind === 'param') {
    const p = model.parameters.find((x) => x.id === entity.id);
    if (p) {
      props = (
        <>
          <Prop k="value">{values[p.id] !== undefined ? n3(values[p.id]) : '—'}</Prop>
          {physicsValues[p.id] !== undefined && overrides[p.id] !== undefined && <Prop k="physics">{n3(physicsValues[p.id])} (pinned: not applied)</Prop>}
          <Prop k="range">
            {p.min} … {p.max} (default {p.default ?? 0})
          </Prop>
        </>
      );
    }
  } else if (entity.kind === 'ik') {
    const k = model.ik.find((x) => x.id === entity.id);
    if (k) props = <IkInfo k={k} diag={pose?.ik?.[entity.id]} />;
  } else if (entity.kind === 'physics') {
    const g = model.physics.find((x) => x.id === entity.id);
    if (g) props = <PhysicsInfo group={g} model={model} diag={pose?.physics?.[entity.id]} physicsOn={physicsOn} />;
  } else if (entity.kind === 'texture') {
    const info = session.textures.get(entity.id)?.info;
    props = (
      <>
        <Prop k="size">{info ? `${info.width} × ${info.height} px` : 'not loaded'}</Prop>
        {info && (
          <dd className="texture-preview">
            <img src={textureUrl(entity.id, session.textureVersion)} alt={`texture ${entity.id}`} />
          </dd>
        )}
      </>
    );
  } else if (entity.kind === 'animation') {
    const a = model.animations.find((x) => x.id === entity.id);
    if (a) {
      props = (
        <>
          <Prop k="duration">
            {a.duration}s{a.loop ? ' · loop' : ' · once'}
          </Prop>
          <Prop k="tracks">{a.tracks.length}</Prop>
          {a.events?.length ? <Prop k="events">{a.events.map((e) => `${e.name}@${e.t}`).join(', ')}</Prop> : null}
        </>
      );
    }
  }

  if (!props && drivers.length === 0) return null;
  return (
    <div className="live-info">
      {props && <dl className="props">{props}</dl>}
      {drivers.length > 0 && (
        <div className="drivers">
          <div className="drivers-title">{entity.kind === 'param' ? 'Drives' : 'Driven by'}</div>
          {drivers.map((d) => (
            <button key={d.key + d.label} className="driver" onClick={() => session.select([d.key])} title={`Select ${d.key}`}>
              <Icon name={d.key.startsWith('binding:') ? 'link' : 'film'} size={12} />
              <span className="mono">{d.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Extension above which a two-bone chain is close enough to straight that the elbow/knee may visibly snap (= api SNAP_EXTENSION). */
const SNAP_RISK = 0.98;

/** Live IK diagnostics (core Pose.ik): does the chain reach its target, how extended is it. */
/** Headline of the IK diagnostics: color class and text. */
function ikStatus(k: IkConstraint, d: IkPose): { cls: 'diag-ok' | 'diag-warn' | 'diag-bad'; text: string } {
  if (k.bones.length === 1) return { cls: 'diag-ok', text: 'aims at the target (one-bone IK rotates toward it)' };
  if (d.extension >= 1 && !d.reached) return { cls: 'diag-bad', text: 'out of reach' };
  if (d.extension > SNAP_RISK) return { cls: 'diag-warn', text: 'near full extension: the joint may snap' };
  return d.reached ? { cls: 'diag-ok', text: 'reaches the target' } : { cls: 'diag-warn', text: 'does not reach the target' };
}

function IkInfo({ k, diag }: { k: IkConstraint; diag: IkPose | undefined }) {
  const status = diag ? ikStatus(k, diag) : null;
  return (
    <>
      <Prop k="chain">
        {k.bones.join(' → ')} → target {k.target}
      </Prop>
      <Prop k="settings">
        mix {n3(k.mix)}
        {k.bones.length === 2 ? ` · bend ${k.bendPositive ? '+' : '−'}` : ''}
        {k.stretch ? ' · stretch' : ''}
        {k.softness ? ` · softness ${n1(k.softness)} px` : ''}
      </Prop>
      {!diag ? (
        <Prop k="live">no diagnostics in this pose</Prop>
      ) : (
        <>
          <Prop k="status">
            <span className={`ik-status ${status!.cls}`} data-testid="ik-status">
              {status!.text}
            </span>
          </Prop>
          <Prop k="extension">
            <span className="extension-meter" title="distance to the target / maximum reach (1 = fully straight)">
              <span className={`extension-fill ${status!.cls}`} style={{ width: `${Math.min(100, diag.extension * 100)}%` }} />
            </span>{' '}
            {n3(diag.extension)}
          </Prop>
          <Prop k="distance / reach">
            {n1(diag.distance)} / {n1(diag.maxReach)} px
          </Prop>
          <Prop k="tip error">{n1(diag.error)} px</Prop>
          {diag.bend !== undefined && <Prop k="bend">{n1(diag.bend)}° (180 = straight)</Prop>}
          {diag.stretch !== undefined && Math.abs(diag.stretch - 1) > 1e-6 && <Prop k="stretch">× {n3(diag.stretch)}</Prop>}
          {status!.cls !== 'diag-ok' && k.bones.length === 2 && (
            <Prop k="fix">
              <span className="fix-hint">
                {diag.extension >= 1 && !diag.reached
                  ? `move ${k.target} closer, lengthen ${k.bones.join(' / ')}, or set "stretch": true`
                  : `set "softness" (px, e.g. 10) so the joint eases out, or keep ${k.target} closer`}
              </span>
            </Prop>
          )}
        </>
      )}
    </>
  );
}

/** Live physics outputs (core Pose.physics): raw output, value written, clamping, pinned values. */
function PhysicsInfo({ group, model, diag, physicsOn }: { group: PhysicsGroup; model: Model; diag: PhysicsPose | undefined; physicsOn: boolean }) {
  return (
    <>
      <Prop k="inputs">{group.inputs.map((i) => `${i.param} (${i.type}${i.weight !== 1 ? ` ×${n3(i.weight)}` : ''})`).join(', ')}</Prop>
      <Prop k="chain">
        {group.segments.length} segment{group.segments.length === 1 ? '' : 's'} · {group.segments.map((sg) => n1(sg.length)).join(' + ')} px
      </Prop>
      {!physicsOn ? (
        <Prop k="outputs">physics is off (timeline toggle): the outputs keep their parameter values</Prop>
      ) : !diag ? (
        <Prop k="outputs">no diagnostics in this pose</Prop>
      ) : (
        <dd className="physics-outputs">
          <table className="mini-table" data-testid="physics-outputs">
            <thead>
              <tr>
                <th>output</th>
                <th title="physics output before clamping to the parameter range (value × scale)">raw</th>
                <th title="value written to the parameter">value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {diag.outputs.map((o, i) => {
                const p = model.parameters.find((q) => q.id === o.param);
                const note = o.overridden ? 'pinned' : o.clamped ? 'clamped' : '';
                return (
                  <tr key={`${o.param}${i}`} className={o.clamped ? 'is-clamped' : undefined}>
                    <td title={p ? `range ${p.min} … ${p.max}` : undefined}>{o.param}</td>
                    <td>{n3(o.raw)}</td>
                    <td>{n3(o.value)}</td>
                    <td
                      className={note ? `note note-${note}` : undefined}
                      title={
                        o.overridden
                          ? 'an explicit (pinned) value replaces this output; unpin it in the Parameters panel'
                          : o.clamped && p
                            ? `raw output is outside ${p.min} … ${p.max}: lower the output scale or widen the parameter range`
                            : undefined
                      }
                    >
                      {note}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </dd>
      )}
    </>
  );
}

/** Bindings / animation tracks that target the entity (or, for a parameter, what it drives). */
function driversOf(model: Model, e: EntityRef): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  const bindingKey = (i: number): string => `binding:${model.bindings[i].id ?? i}`;
  if (e.kind === 'param') {
    model.bindings.forEach((b, i) => {
      if (b.params.includes(e.id)) out.push({ key: bindingKey(i), label: b.target });
    });
    for (const a of model.animations) {
      if (a.tracks.some((t) => t.target === `param:${e.id}`)) out.push({ key: `animation:${a.id}`, label: `animation ${a.id}` });
    }
    for (const g of model.physics) {
      if (g.outputs.some((o) => o.param === e.id)) out.push({ key: `physics:${g.id}`, label: `physics ${g.id}` });
    }
    return out;
  }
  const prefixes: Record<string, string> = { part: 'part:', bone: 'bone:', warp: 'warp:', ik: 'ik:' };
  const prefix = prefixes[e.kind];
  if (!prefix) return out;
  const hit = (target: string): boolean => target.startsWith(`${prefix}${e.id}.`);
  model.bindings.forEach((b, i) => {
    if (hit(b.target)) out.push({ key: bindingKey(i), label: `${b.target.slice(prefix.length + e.id.length + 1)} ← ${b.params.join(' × ')}` });
  });
  for (const a of model.animations) {
    for (const t of a.tracks) {
      if (hit(t.target)) out.push({ key: `animation:${a.id}`, label: `${t.target.slice(prefix.length + e.id.length + 1)} ← ${a.id}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------ JSON editor

interface Draft {
  /** Formatted JSON the draft started from. */
  base: string;
  text: string;
}

function JsonEditor({ entity, raw, pointer, doc }: { entity: EntityRef; raw: unknown; pointer: string | null; doc: RawDoc | null }) {
  const session = useSession();
  const base = useMemo(() => formatModelJson(raw).trimEnd(), [raw]);
  const [draft, setDraft] = useState<Draft>({ base, text: base });
  const [issues, setIssues] = useState<{ diagnostics: Diagnostic[]; blocked: boolean; message?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileText = useApp((s) => s.text);
  const fileHasComments = useMemo(() => hasJsonComments(fileText), [fileText]);

  // Follow changes of the object on disk unless the user is mid-edit.
  useEffect(() => {
    setDraft((d) => (d.base === base ? d : d.text === d.base ? { base, text: base } : d));
  }, [base]);

  const dirty = draft.text !== base;
  // While an apply is in flight the new version arrives before the draft is rebased: not a conflict.
  const changedOnDisk = !busy && draft.base !== base && draft.text !== draft.base;

  const apply = async (force: boolean): Promise<void> => {
    const parsed = parseJsonc(draft.text);
    if (!parsed.ok) {
      setIssues({ diagnostics: [parsed.error], blocked: false, message: 'Not valid JSON.' });
      return;
    }
    setBusy(true);
    try {
      const result = await session.applyEdit(entity, parsed.value, force);
      if (result.ok) {
        setIssues(null);
        // Same text the new `base` prop will have (the document now holds exactly this value).
        const canonical = formatModelJson(parsed.value).trimEnd();
        setDraft({ base: canonical, text: canonical });
      } else {
        setIssues({ diagnostics: result.diagnostics.filter((d) => d.severity !== 'info'), blocked: result.blocked === true, message: result.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const revert = (): void => {
    setDraft({ base, text: base });
    setIssues(null);
  };

  const errors = issues?.diagnostics ?? [];
  const inObject = pointer ? errors.filter((d) => d.path === pointer || d.path.startsWith(`${pointer}/`) || d.code === 'json-syntax') : errors;
  const elsewhere = errors.filter((d) => !inObject.includes(d));

  return (
    <div className="json-editor">
      <div className="json-head">
        <span className="json-title">Raw JSON</span>
        {dirty && <span className="tag tag-accent">edited</span>}
        <div className="section-actions">
          <button className="button button-small" disabled={!dirty || busy} onClick={revert} title="Discard your changes">
            Revert
          </button>
          <button
            className="button button-small button-primary"
            disabled={!dirty || busy || !doc}
            onClick={() => void apply(false)}
            title="Replace this object in the file (Ctrl+Enter or Ctrl+S)"
            data-testid="inspector-apply"
          >
            Apply
          </button>
        </div>
      </div>
      {changedOnDisk && (
        <div className="notice notice-warning">
          <span>This object changed on disk while you were editing.</span>
          <button className="link-button" onClick={revert}>
            Load latest
          </button>
        </div>
      )}
      {!doc && <div className="notice notice-error">The file is not valid JSON right now; editing is disabled until it parses again.</div>}
      {dirty && fileHasComments && (
        <div className="notice notice-warning">Applying rewrites the file as formatted JSON: the comments in it will be removed.</div>
      )}
      <textarea
        className="json-text"
        spellCheck={false}
        value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          const mod = e.ctrlKey || e.metaKey;
          if (mod && (e.key === 'Enter' || e.key.toLowerCase() === 's') && dirty) {
            // Ctrl+S here means "save my edit": apply it instead of the global document save,
            // which would ignore the draft.
            e.preventDefault();
            e.stopPropagation();
            if (!busy) void apply(false);
          } else if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = t;
            const text = `${draft.text.slice(0, a)}  ${draft.text.slice(b)}`;
            setDraft({ ...draft, text });
            requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
          }
        }}
        rows={Math.min(24, Math.max(6, draft.text.split('\n').length + 1))}
        aria-label="Raw JSON of the selected object"
        data-testid="inspector-json"
      />
      {issues && (
        <div className="apply-issues">
          {issues.message && <p className="error-text">{issues.message}</p>}
          {issues.blocked && <p className="error-text">Not applied: the model would have {errors.filter((d) => d.severity === 'error').length} error(s).</p>}
          {inObject.length > 0 && <DiagnosticList items={inObject} />}
          {elsewhere.length > 0 && (
            <>
              <p className="muted small">Elsewhere in the document:</p>
              <DiagnosticList items={elsewhere} />
            </>
          )}
          {issues.blocked && (
            <button className="button button-small button-danger" onClick={() => void apply(true)} disabled={busy}>
              Apply anyway (write with errors)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DiagnosticList({ items, onPick }: { items: readonly Diagnostic[]; onPick?: (d: Diagnostic) => void }) {
  return (
    <ul className="diag-list">
      {items.map((d, i) => (
        <li key={`${d.path}|${d.code}|${i}`} className={`diag diag-${d.severity}${onPick ? ' is-clickable' : ''}`} onClick={onPick ? () => onPick(d) : undefined}>
          <Icon name={d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info'} size={14} />
          <div className="diag-body">
            <div className="diag-message">{d.message}</div>
            <div className="diag-meta">
              <span className="mono">{d.path || '/'}</span>
              <span className="diag-code">{d.code}</span>
            </div>
            {d.hint && <pre className="diag-hint">{d.hint}</pre>}
          </div>
        </li>
      ))}
    </ul>
  );
}
