/**
 * Bottom drawer: the timeline. Its bar holds the transport, the time readout, the animation picker,
 * speed, physics and the drawer toggle; closed, the drawer is just this slim bar. Open, it shows a
 * ruler with the key ticks of every track (grouped by address kind) under a playhead, and the extra
 * animation layers with their weight and options (blend mode override / add, start offset,
 * hold / once for one-shots).
 */
import { useMemo, useRef } from 'react';
import type { Animation } from '../../../src/core/index.js';
import { Badge, Drawer, Icon, IconButton, NumberField, SegmentedControl, Select, Slider, Switch } from '../design/index.js';
import { useT, type MessageKey, type Translate } from '../i18n/index.js';
import { useApp, useSession } from '../state/context.js';
import type { LayerState } from '../state/app.js';
import { allKeyTimes, explicitOptions, frameOf, layerPhase, trackGroups, type LayerOptions } from '../state/playback.js';
import { refKey, resolveRef } from '../state/doc.js';
import { Chip } from '../ui/kit.js';
import './timeline.css';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];

const KIND_COLOR: Record<string, string> = {
  param: 'var(--r2-kind-parameter)',
  bone: 'var(--r2-kind-bone)',
  warp: 'var(--r2-kind-warp)',
  part: 'var(--r2-kind-part)',
  ik: 'var(--r2-kind-ik)',
};

const KIND_TITLE: Record<string, MessageKey> = {
  param: 'timeline.kind.param',
  bone: 'timeline.kind.bone',
  warp: 'timeline.kind.warp',
  part: 'timeline.kind.part',
  ik: 'timeline.kind.ik',
};

/** Local time for display (time - start): the end of a looping animation reads as its duration, not 0. */
function displayTime(time: number, anim: Animation | null, start = 0): number {
  if (!anim) return time;
  const { local } = layerPhase(time, anim, { start });
  return anim.loop && time - start > 0 && local < 1e-9 ? anim.duration : local;
}

/** The non-default layer options in words: "Add · from 1.5 s · Once". */
function optionsText(o: LayerOptions, t: Translate): string {
  const e = explicitOptions(o);
  const parts: string[] = [];
  if (e.mode) parts.push(t('timeline.layer.add'));
  if (e.start !== undefined) parts.push(t('timeline.options.from', { start: +e.start.toFixed(3) }));
  if (e.hold === false) parts.push(t('timeline.layer.once'));
  return parts.join(' · ');
}

export function Timeline({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const model = useApp((s) => s.model);
  const animationId = useApp((s) => s.animation);
  const start = useApp((s) => explicitOptions(s.animationOptions).start ?? 0);
  const anim = model?.animations.find((a) => a.id === animationId) ?? null;
  return (
    <Drawer padded={false} aria-label={t('shell.pane.bottom')} className="ed-tl-panel" data-testid="timeline" data-collapsed={collapsed ? '' : undefined}>
      <div className="ed-tl">
        <Transport anim={anim} start={start} collapsed={collapsed} />
        {!collapsed && (
          <div className="ed-tl-body">
            <div className="ed-tl-tracks">{anim ? <Tracks anim={anim} start={start} /> : <NoAnimation />}</div>
            <Layers />
          </div>
        )}
      </div>
    </Drawer>
  );
}

function NoAnimation() {
  const t = useT();
  const count = useApp((s) => s.model?.animations.length ?? 0);
  return <p className="ed-tl-empty">{count ? t('timeline.setupPose.text') : t('timeline.noAnimations')}</p>;
}

function Transport({ anim, start, collapsed }: { anim: Animation | null; start: number; collapsed: boolean }) {
  const session = useSession();
  const t = useT();
  const model = useApp((s) => s.model);
  const playing = useApp((s) => s.playing);
  const repeat = useApp((s) => s.repeat);
  const speed = useApp((s) => s.speed);
  const physics = useApp((s) => s.physics);
  const weight = useApp((s) => s.animationWeight);
  const options = useApp((s) => s.animationOptions);
  const optionsLabel = optionsText(options, t);
  return (
    <div className="ed-tl-bar">
      <div className="ed-tl-transport" role="group" aria-label={t('timeline.transport')}>
        <IconButton icon="toStart" label={t('timeline.toStart')} shortcut="Home" tooltip="top" onClick={() => session.seek(0)} />
        <IconButton icon="stepBack" label={t('timeline.prevFrame')} shortcut="←" tooltip="top" onClick={() => session.stepFrame(-1)} />
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={playing ? t('timeline.pause') : t('timeline.play')}
          shortcut="Space"
          variant="tinted"
          tooltip="top"
          disabled={!model}
          onClick={() => session.togglePlay()}
          data-testid="play"
        />
        <IconButton icon="stepFwd" label={t('timeline.nextFrame')} shortcut="→" tooltip="top" onClick={() => session.stepFrame(1)} />
        <IconButton icon="repeat" label={repeat ? t('timeline.repeat.on') : t('timeline.repeat.off')} pressed={repeat} tooltip="top" onClick={() => session.setRepeat(!repeat)} data-testid="repeat" />
      </div>
      <TimeReadout anim={anim} start={start} />
      <Select
        aria-label={t('timeline.animation')}
        variant="plain"
        value={anim?.id ?? ''}
        onChange={(id) => session.setAnimation(id || null)}
        className="ed-tl-animation"
        data-testid="animation-select"
        options={[
          { value: '', label: t('timeline.setupPose'), icon: 'person' },
          ...(model?.animations.map((a) => ({ value: a.id, label: a.id, icon: 'film' as const, description: `${a.duration} s${a.loop ? '' : ` · ${t('timeline.oneShot')}`}` })) ?? []),
        ]}
      />
      {anim && weight !== 1 && (
        <Chip label={t('timeline.weight.tip')} onRemove={() => session.setAnimationWeight(1)} data-testid="animation-weight">
          {t('timeline.weight', { weight: weight.toFixed(2) })}
        </Chip>
      )}
      {anim && optionsLabel && (
        <Chip label={t('timeline.options.tip', { options: optionsLabel })} onRemove={() => session.setAnimationOptions({})} data-testid="animation-options">
          {optionsLabel}
        </Chip>
      )}
      <span className="ed-tl-space" />
      <Select
        aria-label={t('timeline.speed')}
        variant="plain"
        size="sm"
        value={String(speed)}
        onChange={(v) => session.setSpeed(Number(v))}
        className="ed-tl-speed"
        options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
      />
      <IconButton icon="physics" label={physics ? t('timeline.physics.on') : t('timeline.physics.off')} pressed={physics} tooltip="top" onClick={() => session.setPhysics(!physics)} data-testid="physics" />
      <IconButton
        icon={collapsed ? 'chevronUp' : 'chevronDown'}
        label={collapsed ? t('timeline.show') : t('timeline.hide')}
        aria-expanded={!collapsed}
        tooltip="top"
        onClick={() => session.togglePanel('dock')}
        data-testid="toggle-dock"
      />
    </div>
  );
}

/** Follows the clock: only this readout re-renders every frame while playing. */
function TimeReadout({ anim, start }: { anim: Animation | null; start: number }) {
  const t = useT();
  const time = useApp((s) => s.time);
  const fps = useApp((s) => s.model?.meta.fps ?? 30);
  const local = displayTime(time, anim, start);
  return (
    <div className="ed-tl-time r2-num" title={start ? t('timeline.time.tipStart', { time: time.toFixed(2), start }) : t('timeline.time.tip')} data-testid="time-readout">
      <span className="ed-tl-now">{local.toFixed(2)}</span>
      <span className="ed-tl-duration"> / {anim ? anim.duration.toFixed(2) : '—'} s</span>
      <span className="ed-tl-frame">f{frameOf(local, fps)}</span>
    </div>
  );
}

/** Horizontal position of time t as a percentage of the lane width. */
const xOf = (time: number, duration: number): string => `${(time / duration) * 100}%`;

function Tracks({ anim, start }: { anim: Animation; start: number }) {
  const session = useSession();
  const t = useT();
  const doc = useApp((s) => s.doc);
  const fps = useApp((s) => s.model?.meta.fps ?? 30);
  const groups = useMemo(() => trackGroups(anim), [anim]);
  const summary = useMemo(() => allKeyTimes(anim), [anim]);
  const lanes = useRef<HTMLDivElement>(null);
  const d = anim.duration;

  const seekAt = (clientX: number): void => {
    const el = lanes.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    // Snap to frames so scrubbing lands on exact frame times (of the global clock: local + start).
    session.seek(Math.max(0, start + Math.round(u * d * fps) / fps));
  };

  const ticks = useMemo(() => {
    const out: Array<{ t: number; major: boolean }> = [];
    const step = d <= 2 ? 0.1 : d <= 10 ? 0.5 : 1;
    const majorEvery = d <= 2 ? 0.5 : d <= 10 ? 1 : 5;
    for (let i = 0; i * step <= d + 1e-9; i++) {
      const v = +(i * step).toFixed(6);
      out.push({ t: v, major: Math.abs(v / majorEvery - Math.round(v / majorEvery)) < 1e-6 });
    }
    return out;
  }, [d]);

  const selectTarget = (target: string): void => {
    // "bone:head.rotation" -> bone:head; "param:X" -> param:X.
    const dot = target.indexOf('.', target.indexOf(':'));
    const resolved = resolveRef(doc, dot > 0 ? target.slice(0, dot) : target);
    if (resolved) session.inspect([refKey(resolved)]);
  };

  return (
    <div
      className="ed-tl-grid"
      onPointerDown={(e) => {
        if (e.button !== 0 || !(e.target as HTMLElement).closest('.ed-tl-lanes')) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        session.pause();
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e.clientX);
      }}
      data-testid="tracks"
    >
      {/* The ruler stays put; the rows scroll under it. Both map time onto the same inner box. */}
      <div className="ed-tl-head">
        <div className="ed-tl-corner">{t('timeline.tracks', { n: anim.tracks.length })}</div>
        <div className="ed-tl-lanes">
          <div className="ed-tl-lanes-inner" ref={lanes}>
            <div className="ed-tl-ruler r2-num" aria-hidden="true">
              {ticks.map((k) => (
                <span key={k.t} className="ed-tl-tick" data-major={k.major ? '' : undefined} style={{ left: xOf(k.t, d) }}>
                  {k.major ? `${k.t}s` : ''}
                </span>
              ))}
            </div>
            <Playhead anim={anim} start={start} head />
          </div>
        </div>
      </div>
      <div className="ed-tl-rows r2-scroll">
        <div className="ed-tl-labels">
          <div className="ed-tl-label ed-tl-label-summary">{t('timeline.allKeys')}</div>
          {groups.map((g) => (
            <div key={g.kind} className="ed-tl-group">
              <div className="ed-tl-group-head">{KIND_TITLE[g.kind] ? t(KIND_TITLE[g.kind]) : g.kind}</div>
              {g.rows.map((r) => (
                <button key={r.target} type="button" className="ed-tl-label" title={t('timeline.track.tip', { target: r.target })} onClick={() => selectTarget(r.target)}>
                  <span className="ed-tl-swatch" style={{ background: KIND_COLOR[g.kind] ?? 'var(--r2-gray)' }} />
                  <span className="r2-truncate">{r.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="ed-tl-lanes">
          <div className="ed-tl-lanes-inner">
            <div className="ed-tl-lane ed-tl-lane-summary">
              {summary.map((k) => (
                <span key={k} className="ed-tl-key" data-summary="" style={{ left: xOf(k, d) }} />
              ))}
            </div>
            {groups.map((g) => (
              <div key={g.kind} className="ed-tl-group">
                <div className="ed-tl-lane ed-tl-lane-head" />
                {g.rows.map((r) => (
                  <div key={r.target} className="ed-tl-lane" title={r.target}>
                    {r.times.length > 1 && (
                      <span
                        className="ed-tl-clip"
                        style={{ left: xOf(r.times[0], d), right: `${100 - (r.times[r.times.length - 1] / d) * 100}%`, background: `color-mix(in srgb, ${KIND_COLOR[g.kind] ?? 'var(--r2-gray)'} 16%, transparent)` }}
                      />
                    )}
                    {r.times.map((k) => (
                      <span key={k} className="ed-tl-key" style={{ left: xOf(k, d), background: KIND_COLOR[g.kind] ?? 'var(--r2-gray)' }} title={`${r.target} @ ${k}s`} />
                    ))}
                  </div>
                ))}
              </div>
            ))}
            {anim.events?.map((ev, i) => (
              <span key={`${ev.name}${i}`} className="ed-tl-event" style={{ left: xOf(ev.t, d) }} title={t('timeline.event.tip', { name: ev.name, time: ev.t })} />
            ))}
            <Playhead anim={anim} start={start} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The only track elements that follow the clock (the head in the ruler, the line over the rows), so key rows do not re-render every frame. */
function Playhead({ anim, start, head }: { anim: Animation; start: number; head?: boolean }) {
  const local = useApp((s) => displayTime(s.time, anim, start));
  return (
    <div className="ed-tl-playhead" style={{ left: xOf(Math.min(local, anim.duration), anim.duration) }} aria-hidden="true">
      {head && <span className="ed-tl-playhead-head" />}
    </div>
  );
}

function Layers() {
  const session = useSession();
  const t = useT();
  const model = useApp((s) => s.model);
  const primary = useApp((s) => s.animation);
  const layers = useApp((s) => s.layers);
  const others = model?.animations.filter((a) => a.id !== primary) ?? [];
  // Blend order of the enabled extras (later layers win for param tracks), shown when it matters.
  const order = layers.filter((l) => l.enabled && l.id !== primary && others.some((a) => a.id === l.id)).map((l) => l.id);
  return (
    <div className="ed-tl-layers r2-scroll" data-testid="layers">
      <div className="ed-tl-layers-head">
        <Icon name="layers" size={14} />
        <span>{t('timeline.layers')}</span>
      </div>
      {others.length === 0 ? (
        <p className="ed-tl-empty">{t('timeline.layers.none')}</p>
      ) : (
        <div className="ed-tl-layer-list">
          {others.map((a) => {
            const l = layers.find((x) => x.id === a.id) ?? { id: a.id, weight: 1, enabled: false };
            return (
              <div key={a.id} className="ed-tl-layer" data-on={l.enabled ? '' : undefined} data-testid={`layer-${a.id}`}>
                <div className="ed-tl-layer-row">
                  <Switch size="sm" checked={l.enabled} onChange={(enabled) => session.setLayer(a.id, { enabled })} aria-label={t('timeline.layer.enable', { id: a.id })} data-testid={`layer-toggle-${a.id}`} />
                  <span className="ed-tl-layer-name r2-truncate" title={t('timeline.layer.enable', { id: a.id })}>
                    {a.id}
                  </span>
                  {l.enabled && order.length > 1 && (
                    <Badge title={t('timeline.layer.order.tip')} className="r2-num">
                      #{order.indexOf(a.id) + 1}
                    </Badge>
                  )}
                  <Slider size="sm" min={0} max={1} step={0.01} value={l.weight} disabled={!l.enabled} showValue="never" onChange={(weight) => session.setLayer(a.id, { weight })} aria-label={t('timeline.layer.weight', { id: a.id })} className="ed-tl-layer-weight" />
                  <span className="ed-tl-layer-value r2-num">{l.weight.toFixed(2)}</span>
                </div>
                {l.enabled && <LayerOptionsRow anim={a} layer={l} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const PHASE_LABEL = { before: 'timeline.phase.before', playing: 'timeline.phase.playing', held: 'timeline.phase.held', done: 'timeline.phase.done' } as const satisfies Record<string, MessageKey>;

/** Blend mode, start offset and (one-shots) hold/once of an enabled extra layer, plus where it is now. */
function LayerOptionsRow({ anim, layer }: { anim: Animation; layer: LayerState }) {
  const session = useSession();
  const t = useT();
  const mode = layer.mode ?? 'override';
  const hold = layer.hold ?? true;
  const start = layer.start ?? 0;
  const phase = useApp((s) => {
    const p = layerPhase(s.time, anim, layer);
    return p.state === 'after' ? (p.active ? 'held' : 'done') : p.state;
  });
  const set = (patch: Partial<LayerState>): void => session.setLayer(anim.id, patch);
  return (
    <div className="ed-tl-layer-options" data-testid={`layer-options-${anim.id}`}>
      <span title={t('timeline.layer.mode.tip')}>
        <SegmentedControl
          size="sm"
          aria-label={t('timeline.layer.mode', { id: anim.id })}
          value={mode}
          onChange={(m) => set({ mode: m })}
          data-testid={`layer-mode-${anim.id}`}
          options={[
            { value: 'override', label: t('timeline.layer.override') },
            { value: 'add', label: t('timeline.layer.add') },
          ]}
        />
      </span>
      <NumberField
        size="sm"
        width={108}
        prefix={t('timeline.layer.start')}
        unit="s"
        step={0.1}
        precision={3}
        value={start}
        onChange={(v) => set({ start: v })}
        aria-label={t('timeline.layer.start.label', { id: anim.id })}
        title={t('timeline.layer.start.tip')}
        data-testid={`layer-start-${anim.id}`}
      />
      {anim.loop ? (
        <span className="ed-tl-layer-loops" title={t('timeline.layer.loops.tip')}>
          {t('timeline.layer.loops')}
        </span>
      ) : (
        <span title={t('timeline.layer.after.tip')}>
          <SegmentedControl
            size="sm"
            aria-label={t('timeline.layer.after', { id: anim.id })}
            value={hold ? 'hold' : 'once'}
            onChange={(v) => set({ hold: v === 'hold' })}
            data-testid={`layer-after-${anim.id}`}
            options={[
              { value: 'hold', label: t('timeline.layer.hold') },
              { value: 'once', label: t('timeline.layer.once') },
            ]}
          />
        </span>
      )}
      <Badge tone={phase === 'playing' ? 'success' : 'neutral'} title={t('timeline.phase.tip')} data-phase={phase} data-testid={`layer-phase-${anim.id}`}>
        {t(PHASE_LABEL[phase])}
      </Badge>
    </div>
  );
}
