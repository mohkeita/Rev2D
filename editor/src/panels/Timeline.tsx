/**
 * Bottom timeline: animation picker, transport, repeat, speed, time readout, physics toggle, a
 * scrubber with key ticks per track (grouped by address kind) and extra animation layers with their
 * weight and options (blend mode override/add, start offset, hold/once for one-shots).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Animation } from '../../../src/core/index.js';
import { useApp, useSession } from '../state/context.js';
import type { LayerState } from '../state/app.js';
import { allKeyTimes, explicitOptions, frameOf, layerPhase, optionsLabel, trackGroups } from '../state/playback.js';
import { refKey, resolveRef } from '../state/doc.js';
import { Icon } from '../ui/icons.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];

/** Local time for display (time - start): the end of a looping animation reads as its duration, not 0. */
function displayTime(t: number, anim: Animation | null, start = 0): number {
  if (!anim) return t;
  const { local } = layerPhase(t, anim, { start });
  return anim.loop && t - start > 0 && local < 1e-9 ? anim.duration : local;
}

export function Timeline() {
  const model = useApp((s) => s.model);
  const animationId = useApp((s) => s.animation);
  const start = useApp((s) => explicitOptions(s.animationOptions).start ?? 0);
  const anim = model?.animations.find((a) => a.id === animationId) ?? null;
  return (
    <div className="timeline" data-testid="timeline">
      <Transport anim={anim} start={start} />
      <div className="timeline-main">
        <div className="timeline-tracks">{anim ? <Tracks anim={anim} start={start} /> : <NoAnimation />}</div>
        <Layers />
      </div>
    </div>
  );
}

function NoAnimation() {
  const count = useApp((s) => s.model?.animations.length ?? 0);
  return (
    <p className="empty-note timeline-empty">
      {count ? 'Setup pose — pick an animation to see its tracks, or press Space to play the first one.' : 'This model has no animations.'}
    </p>
  );
}

function Transport({ anim, start }: { anim: Animation | null; start: number }) {
  const session = useSession();
  const model = useApp((s) => s.model);
  const playing = useApp((s) => s.playing);
  const time = useApp((s) => s.time);
  const repeat = useApp((s) => s.repeat);
  const speed = useApp((s) => s.speed);
  const physics = useApp((s) => s.physics);
  const weight = useApp((s) => s.animationWeight);
  const options = useApp((s) => optionsLabel(s.animationOptions));
  const fps = model?.meta.fps ?? 30;
  const t = displayTime(time, anim, start);
  return (
    <div className="transport">
      <select
        className="select anim-select"
        value={anim?.id ?? ''}
        onChange={(e) => session.setAnimation(e.target.value || null)}
        aria-label="Animation"
        data-testid="animation-select"
      >
        <option value="">Setup pose (no animation)</option>
        {model?.animations.map((a) => (
          <option key={a.id} value={a.id}>
            {a.id} · {a.duration}s{a.loop ? '' : ' · once'}
          </option>
        ))}
      </select>
      {anim && weight !== 1 && (
        <button
          className="tag tag-accent filter-tag"
          title="The main animation plays at this weight (set by an AI setAnimations command). Click to play it at full weight."
          onClick={() => session.setAnimationWeight(1)}
          data-testid="animation-weight"
        >
          weight {weight.toFixed(2)} ✕
        </button>
      )}
      {anim && options && (
        <button
          className="tag tag-accent filter-tag"
          title={`Layer options of the main animation, set by an AI setAnimations command: ${options} (add = param tracks add on top; from Ns = starts at global time N, so the readout shows time − N; once = contributes nothing after its end). Click to clear them.`}
          onClick={() => session.setAnimationOptions({})}
          data-testid="animation-options"
        >
          {options} ✕
        </button>
      )}
      <div className="tool-group">
        <button className="icon-button" title="Go to start (Home)" onClick={() => session.seek(0)}>
          <Icon name="toStart" />
        </button>
        <button className="icon-button" title="Previous frame (←)" onClick={() => session.stepFrame(-1)}>
          <Icon name="stepBack" />
        </button>
        <button
          className={`icon-button play-button${playing ? ' is-on' : ''}`}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => session.togglePlay()}
          disabled={!model}
          data-testid="play"
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button className="icon-button" title="Next frame (→)" onClick={() => session.stepFrame(1)}>
          <Icon name="stepFwd" />
        </button>
        <button
          className={`icon-button${repeat ? ' is-on' : ''}`}
          title={repeat ? 'Repeat: on (keeps playing past the end)' : 'Repeat: off (stops at the end)'}
          aria-pressed={repeat}
          onClick={() => session.setRepeat(!repeat)}
        >
          <Icon name="repeat" />
        </button>
      </div>
      <div
        className="time-readout"
        title={`Local time of the animation / duration · frame at meta.fps${start ? ` (global time ${time.toFixed(2)} s − start ${start} s)` : ''}`}
        data-testid="time-readout"
      >
        <span className="time-now">{t.toFixed(2)}</span>
        <span className="muted"> / {anim ? anim.duration.toFixed(2) : '—'} s</span>
        <span className="frame">f{frameOf(t, fps)}</span>
      </div>
      <label className="speed" title="Playback speed">
        <select className="select select-small" value={speed} onChange={(e) => session.setSpeed(Number(e.target.value))} aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
      <label className={`toggle${physics ? ' is-on' : ''}`} title="Simulate physics (pendulums driving parameters)">
        <input type="checkbox" checked={physics} onChange={(e) => session.setPhysics(e.target.checked)} />
        <Icon name="physics" size={14} />
        <span>Physics</span>
      </label>
    </div>
  );
}

/** Horizontal position of time t as a percentage of the lane width. */
const xOf = (t: number, duration: number): string => `${(t / duration) * 100}%`;

function Tracks({ anim, start }: { anim: Animation; start: number }) {
  const session = useSession();
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
    // "bone:head.rotation" -> select bone:head; "param:X" -> select param:X.
    const dot = target.indexOf('.', target.indexOf(':'));
    const resolved = resolveRef(doc, dot > 0 ? target.slice(0, dot) : target);
    if (resolved) session.select([refKey(resolved)]);
  };

  return (
    <div
      className="tracks"
      onPointerDown={(e) => {
        if (!(e.target as HTMLElement).closest('.lanes-col')) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        session.pause();
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e.clientX);
      }}
      data-testid="tracks"
    >
      <div className="track-labels">
        <div className="ruler-label">
          <span className="muted">{anim.tracks.length} tracks</span>
        </div>
        <div className="track-label summary-label">All keys</div>
        {groups.map((g) => (
          <div key={g.kind} className="track-group">
            <div className="track-group-head">{g.kind}</div>
            {g.rows.map((r) => (
              <button key={r.target} className="track-label" title={`${r.target} — click to select`} onClick={() => selectTarget(r.target)}>
                {r.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="lanes-col">
        <div className="ruler">
          <div className="ruler-inner">
            {ticks.map((k) => (
              <div key={k.t} className={`tick${k.major ? ' is-major' : ''}`} style={{ left: xOf(k.t, d) }}>
                {k.major && <span>{k.t}s</span>}
              </div>
            ))}
            <Playhead anim={anim} start={start} className="playhead-head" />
          </div>
        </div>
        <div className="lanes" ref={lanes}>
          <div className="lane summary-lane">
            {summary.map((k) => (
              <span key={k} className="key key-summary" style={{ left: xOf(k, d) }} />
            ))}
          </div>
          {groups.map((g) => (
            <div key={g.kind} className="track-group">
              <div className="lane lane-group" />
              {g.rows.map((r) => (
                <div key={r.target} className="lane" title={r.target}>
                  {r.times.map((k) => (
                    <span key={k} className={`key kind-${g.kind}`} style={{ left: xOf(k, d) }} title={`${r.target} @ ${k}s`} />
                  ))}
                </div>
              ))}
            </div>
          ))}
          {anim.events?.map((ev, i) => (
            <span key={`${ev.name}${i}`} className="event-marker" style={{ left: xOf(ev.t, d) }} title={`event "${ev.name}" @ ${ev.t}s`} />
          ))}
          <Playhead anim={anim} start={start} className="playhead" />
        </div>
      </div>
    </div>
  );
}

/** The only timeline element that follows the clock, so key rows do not re-render every frame. */
function Playhead({ anim, start, className }: { anim: Animation; start: number; className: string }) {
  const t = useApp((s) => displayTime(s.time, anim, start));
  return <div className={className} style={{ left: xOf(Math.min(t, anim.duration), anim.duration) }} />;
}

function Layers() {
  const session = useSession();
  const model = useApp((s) => s.model);
  const primary = useApp((s) => s.animation);
  const layers = useApp((s) => s.layers);
  const others = model?.animations.filter((a) => a.id !== primary) ?? [];
  // Blend order of the enabled extras (later layers win for param tracks), shown when it matters.
  const order = layers.filter((l) => l.enabled && l.id !== primary && others.some((a) => a.id === l.id)).map((l) => l.id);
  return (
    <div className="layers" data-testid="layers">
      <div className="layers-head">
        <Icon name="layers" size={14} />
        <span>Extra layers</span>
      </div>
      {others.length === 0 ? (
        <p className="empty-note">No other animations to layer.</p>
      ) : (
        others.map((a) => {
          const l = layers.find((x) => x.id === a.id) ?? { id: a.id, weight: 1, enabled: false };
          return (
            <div key={a.id} className={`layer${l.enabled ? ' is-on' : ''}`} data-testid={`layer-${a.id}`}>
              <div className="layer-row">
                <label className="layer-name" title={`Play "${a.id}" on top of the main animation`}>
                  <input type="checkbox" checked={l.enabled} onChange={(e) => session.setLayer(a.id, { enabled: e.target.checked })} />
                  <span>{a.id}</span>
                  {l.enabled && order.length > 1 && (
                    <span className="tag tag-dim" title="Blend order: later layers are applied over earlier ones">
                      #{order.indexOf(a.id) + 1}
                    </span>
                  )}
                </label>
                <input
                  className="slider slider-small"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={l.weight}
                  disabled={!l.enabled}
                  style={{ ['--fill' as string]: `${l.weight * 100}%` }}
                  onChange={(e) => session.setLayer(a.id, { weight: Number(e.target.value) })}
                  aria-label={`${a.id} weight`}
                />
                <span className="layer-weight mono">{l.weight.toFixed(2)}</span>
              </div>
              {l.enabled && <LayerOptionsRow anim={a} layer={l} />}
            </div>
          );
        })
      )}
    </div>
  );
}

const PHASE_LABEL = { before: 'waits', playing: 'plays', held: 'holds end', done: 'done' } as const;

/** Blend mode, start offset and (one-shots) hold/once of an enabled extra layer, plus where it is now. */
function LayerOptionsRow({ anim, layer }: { anim: Animation; layer: LayerState }) {
  const session = useSession();
  const mode = layer.mode ?? 'override';
  const hold = layer.hold ?? true;
  const start = layer.start ?? 0;
  const phase = useApp((s) => {
    const p = layerPhase(s.time, anim, layer);
    return p.state === 'after' ? (p.active ? 'held' : 'done') : p.state;
  });
  const set = (patch: Partial<LayerState>): void => session.setLayer(anim.id, patch);
  return (
    <div className="layer-options" data-testid={`layer-options-${anim.id}`}>
      <div className="segmented seg-mini" role="group" aria-label={`${anim.id} blend mode`}>
        <button
          type="button"
          className={`seg-button${mode === 'override' ? ' is-on' : ''}`}
          aria-pressed={mode === 'override'}
          title="Override: this layer's parameter tracks blend toward their values by the weight (later layers win)"
          onClick={() => set({ mode: 'override' })}
        >
          over
        </button>
        <button
          type="button"
          className={`seg-button${mode === 'add' ? ' is-on' : ''}`}
          aria-pressed={mode === 'add'}
          title="Add: this layer's parameter tracks add weight × (value − default) on top of the layers below (a gesture over an idle)"
          onClick={() => set({ mode: 'add' })}
          data-testid={`layer-mode-add-${anim.id}`}
        >
          add
        </button>
      </div>
      <label className="layer-start" title="Global time in seconds at which this layer starts: its local time is time − start (negative = already running at 0)">
        <span className="muted">start</span>
        <SecondsInput value={start} onCommit={(v) => set({ start: v })} label={`${anim.id} start time`} testId={`layer-start-${anim.id}`} />
      </label>
      {anim.loop ? (
        <span className="muted layer-loops" title="Looping animations wrap; hold / once applies to one-shots">
          loops
        </span>
      ) : (
        <div className="segmented seg-mini" role="group" aria-label={`${anim.id} after its end`}>
          <button
            type="button"
            className={`seg-button${hold ? ' is-on' : ''}`}
            aria-pressed={hold}
            title="Hold: before its start and after its end the one-shot keeps its first / last key values"
            onClick={() => set({ hold: true })}
          >
            hold
          </button>
          <button
            type="button"
            className={`seg-button${!hold ? ' is-on' : ''}`}
            aria-pressed={!hold}
            title="Once: outside [start, start + duration] the one-shot contributes nothing (a wink that must stop affecting the pose)"
            onClick={() => set({ hold: false })}
            data-testid={`layer-once-${anim.id}`}
          >
            once
          </button>
        </div>
      )}
      <span className={`layer-phase phase-${phase}`} title="Where this layer is at the current time" data-testid={`layer-phase-${anim.id}`}>
        {PHASE_LABEL[phase]}
      </span>
    </div>
  );
}

/** A compact seconds field: edits a draft, commits on Enter / blur, Escape cancels, arrows step 0.1 s. */
function SecondsInput({ value, onCommit, label, testId }: { value: number; onCommit: (v: number) => void; label: string; testId: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const commit = (): void => {
    if (draft === null) return;
    const v = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(v)) onCommit(Math.round(v * 1000) / 1000);
    setDraft(null);
  };
  return (
    <input
      className="seconds-input mono"
      type="text"
      inputMode="decimal"
      aria-label={label}
      data-testid={testId}
      value={draft ?? String(+value.toFixed(3))}
      onFocus={(e) => {
        setDraft(String(+value.toFixed(3)));
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          const next = Math.round((value + (e.key === 'ArrowUp' ? 0.1 : -0.1) * (e.shiftKey ? 10 : 1)) * 1000) / 1000;
          onCommit(next);
        }
      }}
    />
  );
}
