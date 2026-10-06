/**
 * The pages under the live preview:
 *
 *   Pose      compact sliders for the parameters of the compiled model (turn, tilt, eyes, mouth,
 *             body, ... then everything else), Reset, and the Idle switch (idle animation + physics)
 *   Lip sync  vowel buttons held while pressed, and text (kana / Hangul / romaji) played through
 *             src/lipsync at an adjustable rate, once or looping; no audio
 *   Selected  the numbers of the selected part for precise edits, its placement tip, its problems,
 *             "Ask AI to fix this part" and Remove
 */
import { useMemo, useState } from 'react';
import type { AvatarPartItemInfo, HandleShape } from '../../../src/avatar/index.js';
import { resolvePointer } from '../../../src/avatar/parts.js';
import type { Viseme } from '../../../src/lipsync/index.js';
import { Button, EmptyState, Icon, InspectorSection, NumberField, Select, Slider, Switch, TextField } from '../design/index.js';
import { useT, type MessageKey, type Translate } from '../i18n/index.js';
import { Notice } from '../ui/kit.js';
import { useAi } from './ai.js';
import { askAiToFix, canRemove, fitItem, removeItem } from './actions.js';
import { r1, setValue } from './geometry.js';
import { shallowEqual, useAvatar } from './hooks.js';
import { groupLabel, itemLabel, itemTip } from './labels.js';
import { controlValue, poseControls, resetControl, setControl, type PoseControl, type PoseControlId } from './params.js';
import { problemsByItem } from './problems.js';
import { avatarStore } from './store.js';
import './panel-tabs.css';

const CONTROL_LABEL: Record<PoseControlId, MessageKey> = {
  turnX: 'avatar.pose.turnX',
  turnY: 'avatar.pose.turnY',
  tilt: 'avatar.pose.tilt',
  eyes: 'avatar.pose.eyes',
  smile: 'avatar.pose.smile',
  gazeX: 'avatar.pose.gazeX',
  gazeY: 'avatar.pose.gazeY',
  brows: 'avatar.pose.brows',
  mouthOpen: 'avatar.pose.mouthOpen',
  mouthForm: 'avatar.pose.mouthForm',
  cheek: 'avatar.pose.cheek',
  body: 'avatar.pose.body',
  breath: 'avatar.pose.breath',
};

function fmt(v: number, c: PoseControl): string {
  return c.max - c.min > 4 ? v.toFixed(0) : v.toFixed(2);
}

// ------------------------------------------------------------------------------------------ Pose

export function PoseTab() {
  const t = useT();
  const s = useAvatar((st) => ({ version: st.previewVersion, params: st.previewParams, idle: st.idle }), shallowEqual);
  const model = avatarStore.preview.model;
  // s.version: the compiled model changed (parameters may come and go).
  const controls = useMemo(() => poseControls(model), [model, s.version]);
  const hasIdle = !!model?.animations.some((a) => a.id === 'idle');
  const [more, setMore] = useState(false);
  if (!model) return <EmptyState icon="person" title={t('avatar.pose.empty')} description={t('avatar.pose.emptyText')} size="sm" />;
  const row = (c: PoseControl) => {
    const value = controlValue(c, s.params);
    const label = c.control ? t(CONTROL_LABEL[c.control]) : c.params[0];
    const pinned = c.params[0] in s.params;
    return (
      <div key={c.params.join('+')} className="ed-avpose-row" data-pinned={pinned ? '' : undefined} data-param={c.params[0]}>
        <div className="ed-avpose-top">
          <span className="ed-avpose-name" title={c.params.join(', ')}>
            {label}
          </span>
          <span className="ed-avpose-value r2-num">{fmt(value, c)}</span>
        </div>
        <Slider
          size="sm"
          min={c.min}
          max={c.max}
          step={c.step}
          origin={c.default}
          value={value}
          resetValue={c.default}
          onChange={(v) => avatarStore.setPreviewParams(setControl(avatarStore.get().previewParams, c, v))}
          aria-label={label}
          data-testid={`avatar-pose-${c.params[0]}`}
        />
      </div>
    );
  };
  return (
    <div className="ed-avpose" data-testid="avatar-pose">
      <div className="ed-avpose-bar">
        <Switch checked={s.idle} disabled={!hasIdle} onChange={(on) => avatarStore.setIdle(on)} label={t('avatar.pose.idle')} data-testid="avatar-idle" />
        <Button size="sm" variant="plain" icon="reset" disabled={Object.keys(s.params).length === 0} onClick={() => avatarStore.setPreviewParams({})} data-testid="avatar-pose-reset">
          {t('common.reset')}
        </Button>
      </div>
      {!hasIdle && <p className="ed-avpose-note">{t('avatar.pose.noIdle')}</p>}
      <div className="ed-avpose-list">{controls.main.map(row)}</div>
      {controls.more.length > 0 && (
        <InspectorSection title={t('avatar.pose.more', { n: controls.more.length })} open={more} onOpenChange={setMore}>
          <div className="ed-avpose-list">{controls.more.map(row)}</div>
        </InspectorSection>
      )}
      {controls.main.length > 0 && Object.keys(s.params).length > 0 && (
        <Button size="sm" variant="plain" className="ed-avpose-clear" onClick={() => avatarStore.setPreviewParams(controls.main.reduce((acc, c) => resetControl(acc, c), avatarStore.get().previewParams))}>
          {t('avatar.pose.resetMain')}
        </Button>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------------- Lip sync

const VOWELS: Array<{ v: Viseme; label: string }> = [
  { v: 'a', label: 'a' },
  { v: 'i', label: 'i' },
  { v: 'u', label: 'u' },
  { v: 'e', label: 'e' },
  { v: 'o', label: 'o' },
  { v: 'n', label: 'n' },
];

export function LipSyncTab() {
  const t = useT();
  const s = useAvatar((st) => ({ lip: st.lipsync, version: st.previewVersion }), shallowEqual);
  const [unknown, setUnknown] = useState<string[]>([]);
  const model = avatarStore.preview.model;
  const hasMouth = !!model?.parameters.some((p) => p.id === 'MouthOpen');
  const playing = s.lip.startedAt !== null;
  const hold = (v: Viseme | null) => avatarStore.holdVowel(v);
  const play = () => setUnknown(avatarStore.playLipSync());
  return (
    <div className="ed-avlip" data-testid="avatar-lipsync">
      {!hasMouth && model && (
        <Notice tone="info" className="ed-avlip-note">
          {t('avatar.lip.noMouth')}
        </Notice>
      )}
      <section className="ed-avlip-section" aria-label={t('avatar.lip.vowels')}>
        <h4 className="ed-avlip-title">{t('avatar.lip.vowels')}</h4>
        <div className="ed-avlip-vowels">
          {VOWELS.map(({ v, label }) => (
            <button
              key={v}
              type="button"
              className="ed-avvowel"
              data-held={s.lip.vowel === v ? '' : undefined}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                hold(v);
              }}
              onPointerUp={() => hold(null)}
              onPointerCancel={() => hold(null)}
              onKeyDown={(e) => {
                if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                  e.preventDefault();
                  hold(v);
                }
              }}
              onKeyUp={(e) => {
                if (e.key === ' ' || e.key === 'Enter') hold(null);
              }}
              aria-pressed={s.lip.vowel === v}
              aria-label={t('avatar.lip.vowel', { vowel: label })}
              data-testid={`avatar-vowel-${v}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="ed-avlip-hint">{t('avatar.lip.vowelHint')}</p>
      </section>
      <section className="ed-avlip-section" aria-label={t('avatar.lip.text')}>
        <h4 className="ed-avlip-title">{t('avatar.lip.text')}</h4>
        <TextField
          value={s.lip.text}
          onChange={(text) => avatarStore.setLipSync({ text })}
          onCommit={() => play()}
          placeholder={t('avatar.lip.placeholder')}
          aria-label={t('avatar.lip.text')}
          data-testid="avatar-lip-text"
        />
        <div className="ed-avlip-row">
          <span className="ed-avlip-label">{t('avatar.lip.rate')}</span>
          <Slider size="sm" min={3} max={14} step={0.5} value={s.lip.rate} onChange={(rate) => avatarStore.setLipSync({ rate })} formatValue={(v) => t('avatar.lip.rateValue', { n: v })} aria-label={t('avatar.lip.rate')} className="ed-avlip-rate" />
          <span className="ed-avlip-value r2-num">{t('avatar.lip.rateValue', { n: s.lip.rate })}</span>
        </div>
        <div className="ed-avlip-row">
          <Switch checked={s.lip.loop} onChange={(loop) => avatarStore.setLipSync({ loop })} label={t('avatar.lip.loop')} size="sm" />
          <span className="ed-avlip-spacer" />
          {playing ? (
            <Button size="md" icon="stop" onClick={() => avatarStore.stopLipSync()} data-testid="avatar-lip-stop">
              {t('avatar.lip.stop')}
            </Button>
          ) : (
            <Button size="md" variant="tinted" icon="play" disabled={!s.lip.text.trim()} onClick={play} data-testid="avatar-lip-play">
              {t('avatar.lip.play')}
            </Button>
          )}
        </div>
        {unknown.length > 0 && <p className="ed-avlip-hint">{t('avatar.lip.unknown', { chars: unknown.join(' ') })}</p>}
        <p className="ed-avlip-hint">{t('avatar.lip.noAudio')}</p>
      </section>
      {s.lip.mouth && (
        <div className="ed-avlip-meter" aria-hidden="true" data-testid="avatar-lip-meter">
          <span>MouthOpen</span>
          <span className="ed-avlip-bar">
            <span style={{ width: `${Math.round(s.lip.mouth.open * 100)}%` }} />
          </span>
          <span className="r2-num">{s.lip.mouth.open.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------------- Selected

/** The numbers of one item: [label, pointer, index into the value (or null), unit]. */
interface Field {
  key: string;
  label: string;
  pointer: string;
  index: number | null;
  unit?: string;
  min?: number;
  step?: number;
}

function fieldsOf(t: Translate, shape: HandleShape, doc: unknown, vertex: number | null): Field[] {
  const xy = (prefix: string, pointer: string): Field[] => [
    { key: `${pointer}/x`, label: `${prefix}X`, pointer, index: 0, unit: 'px' },
    { key: `${pointer}/y`, label: `${prefix}Y`, pointer, index: 1, unit: 'px' },
  ];
  switch (shape.type) {
    case 'point':
      return xy('', shape.at);
    case 'segment':
      return [...xy('A ', shape.a), ...xy('B ', shape.b)];
    case 'ellipse': {
      const circle = typeof resolvePointer(doc, shape.radius) === 'number';
      return [
        ...xy('', shape.center),
        ...(circle
          ? [{ key: shape.radius, label: 'R', pointer: shape.radius, index: null, unit: 'px', min: 0.1 } as Field]
          : [
              { key: `${shape.radius}/0`, label: 'RX', pointer: shape.radius, index: 0, unit: 'px', min: 0.1 },
              { key: `${shape.radius}/1`, label: 'RY', pointer: shape.radius, index: 1, unit: 'px', min: 0.1 },
            ]),
        ...(shape.rotation ? [{ key: shape.rotation, label: t('avatar.selected.rotation'), pointer: shape.rotation, index: null, unit: '°' } as Field] : []),
      ];
    }
    case 'band':
      return [
        { key: `${shape.range}/0`, label: t('avatar.handle.bandStart'), pointer: shape.range, index: 0, unit: 'px' },
        { key: `${shape.range}/1`, label: t('avatar.handle.bandEnd'), pointer: shape.range, index: 1, unit: 'px' },
      ];
    case 'polygon':
    case 'polyline': {
      if (vertex === null) return [];
      return [
        { key: `${shape.points}/${vertex * 2}`, label: 'X', pointer: shape.points, index: vertex * 2, unit: 'px' },
        { key: `${shape.points}/${vertex * 2 + 1}`, label: 'Y', pointer: shape.points, index: vertex * 2 + 1, unit: 'px' },
      ];
    }
  }
}

function readField(doc: unknown, f: Field): number {
  const v = resolvePointer(doc, f.pointer);
  const n = f.index === null ? v : Array.isArray(v) ? v[f.index] : undefined;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function writeField(doc: Record<string, unknown>, f: Field, value: number): Record<string, unknown> {
  const v = r1(f.min !== undefined ? Math.max(f.min, value) : value);
  if (f.index === null) return setValue(doc, f.pointer, v);
  const list = resolvePointer(doc, f.pointer);
  if (!Array.isArray(list)) return doc;
  const next = list.slice();
  next[f.index] = v;
  return setValue(doc, f.pointer, next);
}

export function SelectedTab() {
  const t = useT();
  const ai = useAi();
  const s = useAvatar((st) => ({ doc: st.doc, selection: st.selection, diagnostics: st.diagnostics, parts: st.parts }), shallowEqual);
  const item = avatarStore.item(s.selection.item);
  if (!item || !s.doc) {
    const group = s.selection.group ? s.parts.find((g) => g.id === s.selection.group) : null;
    return <EmptyState icon="cursor" title={group ? groupLabel(t, group.id) : t('avatar.selected.none')} description={t('avatar.selected.noneText')} size="sm" />;
  }
  return <SelectedItem item={item} doc={s.doc} vertex={s.selection.vertex} diagnostics={s.diagnostics} aiEnabled={ai !== null} t={t} />;
}

function SelectedItem({ item, doc, vertex, diagnostics, aiEnabled, t }: { item: AvatarPartItemInfo; doc: Record<string, unknown>; vertex: number | null; diagnostics: Parameters<typeof problemsByItem>[1]; aiEnabled: boolean; t: Translate }) {
  const group = avatarStore.get().parts.find((g) => g.items.some((i) => i.id === item.id));
  const problems = problemsByItem(doc, diagnostics).get(item.id) ?? [];
  const points = item.shape.type === 'polygon' || item.shape.type === 'polyline' ? (resolvePointer(doc, item.shape.points) as number[] | undefined) : undefined;
  const count = Array.isArray(points) ? Math.floor(points.length / 2) : 0;
  const v = vertex !== null && vertex < count ? vertex : count ? 0 : null;
  const fields = fieldsOf(t, item.shape, doc, v);
  const strand = item.id.startsWith('strand.') && item.shape.type === 'polyline' ? item.shape.points.replace(/\/nodes$/, '') : null;
  const edit = (label: string, next: Record<string, unknown>) => avatarStore.edit(t('avatar.history.set', { item: label }), next);
  const name = itemLabel(t, item, doc);
  return (
    <div className="ed-avsel" data-testid="avatar-selected">
      <header className="ed-avsel-head">
        <span className="ed-avsel-dot" style={{ '--_c': group?.color } as React.CSSProperties} aria-hidden="true" />
        <div className="ed-avsel-titles">
          <strong className="ed-avsel-title">{name}</strong>
          <span className="ed-avsel-sub">
            {group ? groupLabel(t, group.id) : ''}
            {item.cutsLayers && (
              <span className="ed-avsel-cuts" title={t('avatar.selected.cutsTip')}>
                <Icon name="layers" size={12} /> {t('avatar.selected.cuts')}
              </span>
            )}
          </span>
        </div>
        {item.placed && <Button size="sm" variant="plain" icon="fit" onClick={() => fitItem(item.id)} aria-label={t('avatar.menu.fit')} />}
      </header>
      <p className="ed-avsel-tip">{itemTip(t, item, doc)}</p>
      {!item.placed ? (
        <Button size="md" variant="tinted" icon="target" block onClick={() => avatarStore.startPlacing(item.id)} data-testid="avatar-place">
          {t('avatar.selected.place')}
        </Button>
      ) : (
        <>
          {count > 0 && (
            <div className="ed-avsel-vertex">
              <span className="ed-avsel-label">{t('avatar.selected.vertex')}</span>
              <Select
                size="sm"
                value={String(v ?? 0)}
                options={Array.from({ length: count }, (_, i) => ({ value: String(i), label: t('avatar.handle.vertex', { n: i + 1 }) }))}
                onChange={(val) => avatarStore.select(item.id, undefined, Number(val))}
                aria-label={t('avatar.selected.vertex')}
              />
              <span className="ed-avsel-count">{t('avatar.selected.points', { n: count })}</span>
            </div>
          )}
          <div className="ed-avsel-fields">
            {fields.map((f) => (
              <NumberField
                key={f.key}
                size="sm"
                prefix={f.label}
                unit={f.unit}
                step={f.unit === '°' ? 1 : 0.5}
                precision={1}
                min={f.min}
                value={readField(doc, f)}
                onChangeEnd={(val) => edit(name, writeField(avatarStore.get().doc ?? doc, f, val))}
                aria-label={`${name} ${f.label}`}
                data-testid={`avatar-field-${f.label}`}
              />
            ))}
          </div>
          {strand && <StrandFields pointer={strand} doc={doc} label={name} t={t} />}
        </>
      )}
      {problems.length > 0 && (
        <ul className="ed-avsel-problems">
          {problems.map((d, i) => (
            <li key={i} data-sev={d.severity}>
              <Icon name={d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info'} size={13} />
              <span>
                {d.message}
                {d.hint && <span className="ed-avsel-hint">{d.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="ed-avsel-actions">
        <Button size="md" icon="sparkles" disabled={!aiEnabled} onClick={() => void askAiToFix(item)} title={aiEnabled ? undefined : t('avatar.ai.unavailable')} data-testid="avatar-ask-ai">
          {t('avatar.menu.askAi')}
        </Button>
        {canRemove(item) && (
          <Button size="md" variant="plain" destructive icon="trash" onClick={() => removeItem(item)}>
            {t('avatar.menu.remove')}
          </Button>
        )}
      </div>
    </div>
  );
}

function StrandFields({ pointer, doc, label, t }: { pointer: string; doc: Record<string, unknown>; label: string; t: Translate }) {
  const strand = resolvePointer(doc, pointer) as Record<string, unknown> | undefined;
  if (!strand) return null;
  const num = (key: string, fallback: number) => (typeof strand[key] === 'number' ? (strand[key] as number) : fallback);
  const set = (key: string, value: unknown) => avatarStore.edit(t('avatar.history.set', { item: label }), setValue(avatarStore.get().doc ?? doc, `${pointer}/${key}`, value));
  return (
    <div className="ed-avsel-strand">
      <NumberField size="sm" prefix={t('avatar.strand.width')} unit="px" min={1} step={1} precision={1} value={num('width', 10)} onChangeEnd={(v) => set('width', r1(Math.max(1, v)))} />
      <NumberField size="sm" prefix={t('avatar.strand.swing')} unit="px" min={1} step={1} precision={1} value={num('swing', 10)} onChangeEnd={(v) => set('swing', r1(Math.max(1, v)))} />
      <NumberField size="sm" prefix={t('avatar.strand.stiffness')} min={0.1} step={0.1} precision={2} value={num('stiffness', 1)} onChangeEnd={(v) => set('stiffness', Math.max(0.1, Math.round(v * 100) / 100))} />
      <Select
        size="sm"
        value={typeof strand.group === 'string' ? strand.group : 'front'}
        options={[
          { value: 'front', label: t('avatar.strand.front') },
          { value: 'side', label: t('avatar.strand.side') },
          { value: 'back', label: t('avatar.strand.back') },
        ]}
        onChange={(g) => set('group', g)}
        aria-label={t('avatar.strand.group')}
      />
    </div>
  );
}
