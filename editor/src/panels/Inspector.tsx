/**
 * Selection inspector (a page of the trailing panel): the selected object's live pose values
 * (read-only), what drives it, and its RAW JSON from the document (as written on disk) in a code
 * field. Apply replaces the object in the raw document and writes it (PUT {doc}); edits that would
 * make the model invalid are held back with the diagnostics.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { Badge, Button, EmptyState, Icon, IconButton, InspectorSection, List, ListRow } from '../design/index.js';
import { useT, type MessageKey, type Translate } from '../i18n/index.js';
import { useApp, useSession } from '../state/context.js';
import { entityPointer, getEntity, hasJsonComments, parseRefKey, refKey, resolveRef, type EntityRef, type RawDoc } from '../state/doc.js';
import { LinkButton, Notice } from '../ui/kit.js';
import { KIND_COLOR, KIND_ICON } from './Outliner.js';

const KIND_LABEL: Record<EntityRef['kind'], MessageKey> = {
  part: 'kind.part',
  bone: 'kind.bone',
  warp: 'kind.warp',
  param: 'kind.param',
  animation: 'kind.animation',
  binding: 'kind.binding',
  ik: 'kind.ik',
  physics: 'kind.physics',
  texture: 'kind.texture',
};

/** `active`: the page is on screen (the live values only follow the pose while it is). */
export function SelectionInspector({ active }: { active: boolean }) {
  const t = useT();
  const selection = useApp((s) => s.selection);
  const doc = useApp((s) => s.doc);
  const ref = selection.length ? (resolveRef(doc, selection[0]) ?? parseRefKey(selection[0])) : null;
  return (
    <div className="ed-inspect" data-testid="inspector">
      {ref ? (
        <InspectorBody key={refKey(ref)} entity={ref} count={selection.length} active={active} />
      ) : (
        <EmptyState size="sm" icon="cursor" title={t('inspector.empty.title')} description={t('inspector.empty.text')} />
      )}
    </div>
  );
}

function InspectorBody({ entity, count, active }: { entity: EntityRef; count: number; active: boolean }) {
  const session = useSession();
  const t = useT();
  const doc = useApp((s) => s.doc);
  const model = useApp((s) => s.model);
  const diagnostics = useApp((s) => s.diagnostics);
  const raw = getEntity(doc, entity);
  const pointer = entityPointer(doc, entity);
  const own = pointer ? diagnostics.filter((d) => d.path === pointer || d.path.startsWith(`${pointer}/`)) : [];
  const framable = entity.kind === 'part' || entity.kind === 'bone' || entity.kind === 'warp';

  return (
    <>
      <div className="ed-inspect-head">
        <span className="ed-inspect-glyph" style={{ color: KIND_COLOR[entity.kind] }}>
          <Icon name={KIND_ICON[entity.kind]} size={18} />
        </span>
        <div className="ed-inspect-name">
          <h3 className="ed-inspect-id" title={refKey(entity)}>
            {entity.kind === 'binding' && model ? bindingTitle(model, entity.id) : entity.id}
          </h3>
          <div className="ed-inspect-kind">
            {t(KIND_LABEL[entity.kind])}
            {pointer && <span className="ed-mono-small"> · {pointer}</span>}
          </div>
        </div>
        {framable && <IconButton icon="fit" label={t('inspector.frame')} shortcut="F" tooltip="left" onClick={() => session.focus('selection')} />}
      </div>
      {count > 1 && (
        <Notice tone="info" className="ed-inspect-note">
          {t('inspector.multiple', { n: count })}
        </Notice>
      )}
      {raw === undefined ? (
        <p className="ed-pane-empty">{t('inspector.missing', { target: refKey(entity) })}</p>
      ) : (
        <>
          {own.length > 0 && <DiagnosticList items={own} />}
          {model && active && <LiveInfo entity={entity} model={model} />}
          <JsonEditor entity={entity} raw={raw} pointer={pointer} doc={doc} />
        </>
      )}
    </>
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
  const t = useT();
  // Re-render with every new pose.
  useApp((s) => s.poseTick);
  const values = useApp((s) => s.values);
  const physicsOn = useApp((s) => s.physics);
  const physicsValues = useApp((s) => s.physicsValues);
  const overrides = useApp((s) => s.overrides);
  const pose: Pose | null = session.currentFrame()?.pose ?? null;
  const drivers = useMemo(() => driversOf(model, entity, t), [model, entity, t]);
  let props: ReactNode = null;

  if (entity.kind === 'part' && pose) {
    const pp = pose.parts[entity.id];
    const def = model.parts.find((p) => p.id === entity.id);
    if (pp && def) {
      const b = pp.bounds;
      props = (
        <>
          <Prop k={t('inspector.prop.shape')}>{def.shape.type}</Prop>
          <Prop k={t('inspector.prop.parent')}>{def.parent ?? (def.skin ? `skin: ${def.skin.bones.join(', ')}` : '—')}</Prop>
          <Prop k={t('inspector.prop.drawn')}>
            {pose.drawOrder.includes(entity.id) ? t('inspector.prop.drawn.yes', { index: pose.drawOrder.indexOf(entity.id), count: pose.drawOrder.length }) : t('inspector.prop.drawn.no')}
          </Prop>
          <Prop k={t('inspector.prop.opacityZ')}>
            {n3(pp.opacity)} / {n3(pp.z)}
          </Prop>
          <Prop k={t('inspector.prop.bounds')}>{b ? `[${b.map(n1).join(', ')}]` : '—'}</Prop>
          <Prop k={t('inspector.prop.center')}>{b ? `${n1(b[0] + b[2] / 2)}, ${n1(b[1] + b[3] / 2)}` : '—'}</Prop>
          {def.mask?.length ? <Prop k={def.maskInvert ? t('inspector.prop.maskInverted') : t('inspector.prop.mask')}>{def.mask.join(', ')}</Prop> : null}
          {def.blend !== 'normal' && <Prop k={t('inspector.prop.blend')}>{def.blend}</Prop>}
        </>
      );
    }
  } else if (entity.kind === 'bone' && pose) {
    const bp = pose.bones[entity.id];
    if (bp) {
      props = (
        <>
          <Prop k={t('inspector.prop.worldXY')}>
            {n1(bp.x)}, {n1(bp.y)}
          </Prop>
          <Prop k={t('inspector.prop.worldRotation')}>{n3(bp.rotation)}°</Prop>
          <Prop k={t('inspector.prop.worldScale')}>
            {n3(bp.scaleX)}, {n3(bp.scaleY)}
          </Prop>
          <Prop k={t('inspector.prop.tip')}>
            {n1(bp.tip[0])}, {n1(bp.tip[1])}
          </Prop>
          <Prop k={t('inspector.prop.local')}>
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
          <Prop k={t('inspector.prop.lattice')}>{t('inspector.prop.lattice.value', { cols: w.cols, rows: w.rows, points: (w.cols + 1) * (w.rows + 1) })}</Prop>
          <Prop k={t('inspector.prop.parent')}>{w.parent ?? '—'}</Prop>
          <Prop k={t('inspector.prop.restRect')}>[{w.rect.join(', ')}]</Prop>
        </>
      );
    }
  } else if (entity.kind === 'param') {
    const p = model.parameters.find((x) => x.id === entity.id);
    if (p) {
      props = (
        <>
          <Prop k={t('inspector.prop.value')}>{values[p.id] !== undefined ? n3(values[p.id]) : '—'}</Prop>
          {physicsValues[p.id] !== undefined && overrides[p.id] !== undefined && <Prop k={t('inspector.prop.physics')}>{t('inspector.prop.physics.pinned', { value: n3(physicsValues[p.id]) })}</Prop>}
          <Prop k={t('inspector.prop.range')}>{t('inspector.prop.range.value', { min: p.min, max: p.max, default: p.default ?? 0 })}</Prop>
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
        <Prop k={t('inspector.prop.size')}>{info ? `${info.width} × ${info.height} px` : t('inspector.prop.notLoaded')}</Prop>
        {info && (
          <dd className="ed-texture-preview">
            <img src={textureUrl(entity.id, session.textureVersion)} alt={t('inspector.textureAlt', { id: entity.id })} />
          </dd>
        )}
      </>
    );
  } else if (entity.kind === 'animation') {
    const a = model.animations.find((x) => x.id === entity.id);
    if (a) {
      props = (
        <>
          <Prop k={t('inspector.prop.duration')}>
            {a.duration}s · {a.loop ? t('inspector.prop.loops') : t('inspector.prop.once')}
          </Prop>
          <Prop k={t('inspector.prop.tracks')}>{a.tracks.length}</Prop>
          {a.events?.length ? <Prop k={t('inspector.prop.events')}>{a.events.map((e) => `${e.name}@${e.t}`).join(', ')}</Prop> : null}
        </>
      );
    }
  }

  if (!props && drivers.length === 0) return null;
  return (
    <>
      {props && (
        <InspectorSection title={t('inspector.live')}>
          <dl className="ed-props">{props}</dl>
        </InspectorSection>
      )}
      {drivers.length > 0 && (
        <InspectorSection title={entity.kind === 'param' ? t('inspector.drives') : t('inspector.drivenBy')} trailing={<span className="ed-section-count r2-num">{drivers.length}</span>}>
          <List variant="plain" size="sm">
            {drivers.map((d) => (
              <ListRow key={d.key + d.label} icon={d.key.startsWith('binding:') ? 'link' : d.key.startsWith('physics:') ? 'physics' : 'film'} iconColor={KIND_COLOR[d.key.startsWith('binding:') ? 'binding' : d.key.startsWith('physics:') ? 'physics' : 'animation']} title={<span className="ed-mono-small">{d.label}</span>} disclosure onSelect={() => session.inspect([d.key])} />
            ))}
          </List>
        </InspectorSection>
      )}
    </>
  );
}

/** Extension above which a two-bone chain is close enough to straight that the elbow/knee may visibly snap (= api SNAP_EXTENSION). */
const SNAP_RISK = 0.98;

type Tone = 'success' | 'warning' | 'danger';

/** Headline of the IK diagnostics: tone and text. */
function ikStatus(k: IkConstraint, d: IkPose, t: Translate): { tone: Tone; text: string } {
  if (k.bones.length === 1) return { tone: 'success', text: t('inspector.ik.aims') };
  if (d.extension >= 1 && !d.reached) return { tone: 'danger', text: t('inspector.ik.outOfReach') };
  if (d.extension > SNAP_RISK) return { tone: 'warning', text: t('inspector.ik.nearStraight') };
  return d.reached ? { tone: 'success', text: t('inspector.ik.reaches') } : { tone: 'warning', text: t('inspector.ik.misses') };
}

/** Live IK diagnostics (core Pose.ik): does the chain reach its target, how extended is it. */
function IkInfo({ k, diag }: { k: IkConstraint; diag: IkPose | undefined }) {
  const t = useT();
  const status = diag ? ikStatus(k, diag, t) : null;
  return (
    <>
      <Prop k={t('inspector.ik.chain')}>
        {k.bones.join(' → ')} → {k.target}
      </Prop>
      <Prop k={t('inspector.ik.settings')}>
        mix {n3(k.mix)}
        {k.bones.length === 2 ? ` · bend ${k.bendPositive ? '+' : '−'}` : ''}
        {k.stretch ? ' · stretch' : ''}
        {k.softness ? ` · softness ${n1(k.softness)} px` : ''}
      </Prop>
      {!diag ? (
        <Prop k={t('inspector.ik.live')}>{t('inspector.noDiagnostics')}</Prop>
      ) : (
        <>
          <Prop k={t('inspector.ik.status')}>
            <Badge tone={status!.tone} data-testid="ik-status" className="ed-wrap-badge">
              {status!.text}
            </Badge>
          </Prop>
          <Prop k={t('inspector.ik.extension')}>
            <span className="ed-meter" title={t('inspector.ik.extension.tip')}>
              <span className="ed-meter-fill" data-tone={status!.tone} style={{ width: `${Math.min(100, diag.extension * 100)}%` }} />
            </span>{' '}
            {n3(diag.extension)}
          </Prop>
          <Prop k={t('inspector.ik.distance')}>
            {n1(diag.distance)} / {n1(diag.maxReach)} px
          </Prop>
          <Prop k={t('inspector.ik.error')}>{n1(diag.error)} px</Prop>
          {diag.bend !== undefined && <Prop k={t('inspector.ik.bend')}>{t('inspector.ik.bend.value', { value: n1(diag.bend) })}</Prop>}
          {diag.stretch !== undefined && Math.abs(diag.stretch - 1) > 1e-6 && <Prop k={t('inspector.ik.stretch')}>× {n3(diag.stretch)}</Prop>}
          {status!.tone !== 'success' && k.bones.length === 2 && (
            <Prop k={t('inspector.ik.fix')}>
              <span className="ed-muted">
                {diag.extension >= 1 && !diag.reached
                  ? t('inspector.ik.fix.reach', { target: k.target, bones: k.bones.join(' / ') })
                  : t('inspector.ik.fix.soften', { target: k.target })}
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
  const t = useT();
  return (
    <>
      <Prop k={t('inspector.physics.inputs')}>{group.inputs.map((i) => `${i.param} (${i.type}${i.weight !== 1 ? ` ×${n3(i.weight)}` : ''})`).join(', ')}</Prop>
      <Prop k={t('inspector.physics.chain')}>
        {t('inspector.physics.segments', { n: group.segments.length })} · {group.segments.map((sg) => n1(sg.length)).join(' + ')} px
      </Prop>
      {!physicsOn ? (
        <Prop k={t('inspector.physics.outputs')}>{t('inspector.physics.off')}</Prop>
      ) : !diag ? (
        <Prop k={t('inspector.physics.outputs')}>{t('inspector.noDiagnostics')}</Prop>
      ) : (
        <dd className="ed-physics-outputs">
          <table className="ed-mini-table" data-testid="physics-outputs">
            <thead>
              <tr>
                <th>{t('inspector.physics.output')}</th>
                <th title={t('inspector.physics.raw.tip')}>{t('inspector.physics.raw')}</th>
                <th title={t('inspector.physics.value.tip')}>{t('inspector.physics.value')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {diag.outputs.map((o, i) => {
                const p = model.parameters.find((q) => q.id === o.param);
                return (
                  <tr key={`${o.param}${i}`} data-clamped={o.clamped ? '' : undefined}>
                    <td title={p ? `${p.min} … ${p.max}` : undefined}>{o.param}</td>
                    <td>{n3(o.raw)}</td>
                    <td>{n3(o.value)}</td>
                    <td>
                      {o.overridden ? (
                        <Badge tone="tint" title={t('inspector.physics.pinned.tip')}>
                          {t('params.pinned')}
                        </Badge>
                      ) : o.clamped ? (
                        <Badge tone="warning" title={p ? t('inspector.physics.clamped.tip', { min: p.min, max: p.max }) : undefined}>
                          {t('inspector.physics.clamped')}
                        </Badge>
                      ) : null}
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
function driversOf(model: Model, e: EntityRef, t: Translate): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  const bindingKey = (i: number): string => `binding:${model.bindings[i].id ?? i}`;
  if (e.kind === 'param') {
    model.bindings.forEach((b, i) => {
      if (b.params.includes(e.id)) out.push({ key: bindingKey(i), label: b.target });
    });
    for (const a of model.animations) {
      if (a.tracks.some((tr) => tr.target === `param:${e.id}`)) out.push({ key: `animation:${a.id}`, label: `${t('kind.animation')} ${a.id}` });
    }
    for (const g of model.physics) {
      if (g.outputs.some((o) => o.param === e.id)) out.push({ key: `physics:${g.id}`, label: `${t('timeline.physics')} ${g.id}` });
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
    for (const tr of a.tracks) {
      if (hit(tr.target)) out.push({ key: `animation:${a.id}`, label: `${tr.target.slice(prefix.length + e.id.length + 1)} ← ${a.id}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------ code field

/**
 * A code field: monospace text with a line-number gutter that scrolls with it, no wrapping, Tab
 * inserts two spaces. The gutter marks the lines listed in `errorLines` (1-based).
 */
export function CodeField({
  value,
  onChange,
  onKeyDown,
  rows,
  errorLines,
  ...rest
}: {
  value: string;
  onChange: (text: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  rows: number;
  errorLines?: ReadonlySet<number>;
  'aria-label': string;
  'data-testid'?: string;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split('\n').length;
  return (
    <div className="ed-code">
      <div ref={gutter} className="ed-code-gutter" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} data-error={errorLines?.has(i + 1) ? '' : undefined}>
            {i + 1}
          </span>
        ))}
      </div>
      <textarea
        className="ed-code-text r2-scroll"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            onChange(`${value.slice(0, a)}  ${value.slice(b)}`);
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          }
        }}
        {...rest}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------------ JSON editor

interface Draft {
  /** Formatted JSON the draft started from. */
  base: string;
  text: string;
}

function JsonEditor({ entity, raw, pointer, doc }: { entity: EntityRef; raw: unknown; pointer: string | null; doc: RawDoc | null }) {
  const session = useSession();
  const t = useT();
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
      setIssues({ diagnostics: [parsed.error], blocked: false, message: t('inspector.json.invalid') });
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
  const errorCountNow = errors.filter((d) => d.severity === 'error').length;

  return (
    <InspectorSection
      title={t('inspector.json')}
      className="ed-json"
      collapsible={false}
      trailing={
        <>
          {dirty && <Badge tone="tint">{t('inspector.json.edited')}</Badge>}
          <Button size="sm" variant="plain" disabled={!dirty || busy} onClick={revert} title={t('inspector.json.revert.tip')}>
            {t('common.revert')}
          </Button>
          <Button size="sm" variant="filled" disabled={!dirty || busy || !doc} onClick={() => void apply(false)} title={t('inspector.json.apply.tip')} data-testid="inspector-apply">
            {t('common.apply')}
          </Button>
        </>
      }
    >
      <div className="ed-json-body">
        {changedOnDisk && (
          <Notice tone="warning" actions={<LinkButton onClick={revert}>{t('inspector.json.loadLatest')}</LinkButton>}>
            {t('inspector.json.changedOnDisk')}
          </Notice>
        )}
        {!doc && <Notice tone="danger">{t('inspector.json.fileInvalid')}</Notice>}
        {dirty && fileHasComments && <Notice tone="warning">{t('inspector.json.commentsLost')}</Notice>}
        <CodeField
          value={draft.text}
          onChange={(text) => setDraft({ ...draft, text })}
          onKeyDown={(e) => {
            const mod = e.ctrlKey || e.metaKey;
            if (mod && (e.key === 'Enter' || e.key.toLowerCase() === 's') && dirty) {
              // Ctrl+S here means "save my edit": apply it instead of the global document save,
              // which would ignore the draft.
              e.preventDefault();
              e.stopPropagation();
              if (!busy) void apply(false);
            }
          }}
          rows={Math.min(24, Math.max(6, draft.text.split('\n').length + 1))}
          aria-label={t('inspector.json.label')}
          data-testid="inspector-json"
        />
        {issues && (
          <div className="ed-json-issues">
            {issues.message && <Notice tone="danger">{issues.message}</Notice>}
            {issues.blocked && <Notice tone="danger">{t('inspector.json.blocked', { n: errorCountNow })}</Notice>}
            {inObject.length > 0 && <DiagnosticList items={inObject} />}
            {elsewhere.length > 0 && (
              <>
                <p className="ed-json-elsewhere">{t('inspector.json.elsewhere')}</p>
                <DiagnosticList items={elsewhere} />
              </>
            )}
            {issues.blocked && (
              <Button size="sm" destructive onClick={() => void apply(true)} disabled={busy}>
                {t('inspector.json.applyAnyway')}
              </Button>
            )}
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

// ------------------------------------------------------------------------------------ diagnostics

const SEVERITY_ICON = { error: 'error', warning: 'warning', info: 'info' } as const;

/** Diagnostics as grouped rows: message, JSON pointer and code, the hint with the fix. */
export function DiagnosticList({ items, onPick }: { items: readonly Diagnostic[]; onPick?: (d: Diagnostic) => void }) {
  return (
    <ul className="ed-diag-list">
      {items.map((d, i) => {
        const body = (
          <>
            <Icon name={SEVERITY_ICON[d.severity]} size={16} className="ed-diag-icon" />
            <span className="ed-diag-body">
              <span className="ed-diag-message">{d.message}</span>
              <span className="ed-diag-meta">
                <span className="ed-mono-small">{d.path || '/'}</span>
                <span className="ed-diag-code">{d.code}</span>
              </span>
              {d.hint && <span className="ed-diag-hint">{d.hint}</span>}
            </span>
          </>
        );
        return (
          <li key={`${d.path}|${d.code}|${i}`} className="ed-diag" data-severity={d.severity}>
            {onPick ? (
              <button type="button" className="ed-diag-row" onClick={() => onPick(d)}>
                {body}
              </button>
            ) : (
              <div className="ed-diag-row">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
