/**
 * Parameter sliders grouped by `group`. The slider shows the EVALUATED value live (after animation
 * and physics); moving it sets an explicit value, which beats animation AND physics (core SPEC §9).
 * Badges mark params driven by the active animation layers ("anim") or by physics: the physics badge
 * is also the pin toggle (pinned = explicit value held; unpinned = physics drives it), and a pinned
 * physics output shows where physics would put it as a ghost tick on the slider.
 */
import { useMemo, useState } from 'react';
import type { Parameter } from '../../../src/core/index.js';
import { useApp, useSession } from '../state/context.js';
import { matches } from '../state/outline.js';
import { physicsParams } from '../state/playback.js';
import { Icon } from '../ui/icons.js';

function formatValue(v: number, p: Parameter): string {
  const span = Math.abs(p.max - p.min);
  const decimals = span >= 100 ? 1 : span >= 10 ? 2 : 3;
  return v.toFixed(decimals);
}

export function Parameters() {
  const session = useSession();
  const model = useApp((s) => s.model);
  const overridden = useApp((s) => Object.keys(s.overrides).length);
  const search = useApp((s) => s.search);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Joined into strings so the panel re-renders only when the driven sets change.
  // (Ids cannot contain "|".)
  const animatedKey = useApp((s) => [...session.animatedNow(s)].sort().join('|'));
  const physicsKey = useApp((s) => (s.physics && s.model ? [...physicsParams(s.model)].sort().join('|') : ''));
  const animated = useMemo(() => new Set(animatedKey.split('|')), [animatedKey]);
  const physics = useMemo(() => new Set(physicsKey.split('|')), [physicsKey]);
  const groups = useMemo(() => {
    const out = new Map<string, Parameter[]>();
    for (const p of model?.parameters ?? []) {
      const g = p.group ?? 'General';
      out.set(g, [...(out.get(g) ?? []), p]);
    }
    return [...out.entries()];
  }, [model]);
  // The outliner's filter applies here too; say so, since it hides sliders.
  const matching = model?.parameters.filter((p) => matches(p.id, search)).length ?? 0;

  return (
    <section className="panel-section params" data-testid="parameters">
      <div className="section-head">
        <span className="section-title">Parameters</span>
        <span className="count">{model?.parameters.length ?? 0}</span>
        {search && model && (
          <button className="tag tag-accent filter-tag" title="Filtered by the outliner search — click to clear" onClick={() => session.store.set({ search: '' })}>
            {matching} match “{search}” ✕
          </button>
        )}
        <div className="section-actions">
          <button
            className="button button-small"
            disabled={overridden === 0}
            title="Clear all explicit parameter values (animation / defaults take over)"
            onClick={() => session.resetAllParams()}
            data-testid="reset-all-params"
          >
            <Icon name="reset" size={12} /> Reset all
          </button>
        </div>
      </div>
      <div className="section-body">
        {!model || model.parameters.length === 0 ? (
          <p className="empty-note">{model ? 'This model has no parameters.' : 'No valid model loaded.'}</p>
        ) : matching === 0 ? (
          <p className="empty-note">No parameter id contains “{search}”.</p>
        ) : (
          groups.map(([group, params]) => {
            const shown = params.filter((p) => matches(p.id, search));
            if (shown.length === 0) return null;
            const open = !collapsed.has(group);
            return (
              <div key={group} className="param-group">
                {groups.length > 1 && (
                  <button
                    className="group-head"
                    onClick={() => {
                      const next = new Set(collapsed);
                      if (open) next.add(group);
                      else next.delete(group);
                      setCollapsed(next);
                    }}
                  >
                    <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                    <span>{group}</span>
                    <span className="count">{params.length}</span>
                  </button>
                )}
                {open && shown.map((p) => <ParamRow key={p.id} param={p} anim={animated.has(p.id)} phys={physics.has(p.id)} />)}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/** Horizontal position of value v on a slider track (the 12 px thumb's center travels inside the track). */
const trackPos = (v: number, p: Parameter): string => {
  const u = Math.min(1, Math.max(0, (v - p.min) / (p.max - p.min || 1)));
  return `calc(6px + (100% - 12px) * ${u})`;
};

function ParamRow({ param: p, anim, phys }: { param: Parameter; anim: boolean; phys: boolean }) {
  const session = useSession();
  const value = useApp((s) => s.values[p.id] ?? p.default ?? Math.min(p.max, Math.max(p.min, 0)));
  const override = useApp((s) => s.overrides[p.id]);
  const physValue = useApp((s) => (phys ? s.physicsValues[p.id] : undefined));
  const selected = useApp((s) => s.selection.includes(`param:${p.id}`));
  const [draft, setDraft] = useState<string | null>(null);
  const step = (p.max - p.min) / 1000 || 0.001;
  const commitDraft = (): void => {
    if (draft === null) return;
    const v = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(v)) session.setParam(p.id, v);
    setDraft(null);
  };
  const overriddenFlag = override !== undefined;
  const pct = ((value - p.min) / (p.max - p.min || 1)) * 100;
  // Animation / physics move the slider by themselves unless an explicit value holds it.
  const driver = overriddenFlag ? null : phys ? 'phys' : anim ? 'anim' : null;
  const fmt = (v: number): string => formatValue(v, p);
  const pinTitle = overriddenFlag
    ? `Pinned at ${fmt(value)}: this explicit value replaces the physics output${physValue !== undefined ? ` (physics would give ${fmt(physValue)}, the ghost tick on the slider)` : ''}.\nClick to unpin: physics drives ${p.id} again.`
    : `Physics drives ${p.id} every frame (now ${fmt(value)}).\nClick to pin it at this value: an explicit value beats physics. Dragging the slider or typing a value pins it too.`;
  return (
    <div
      className={`param-row${selected ? ' is-selected' : ''}${overriddenFlag ? ' is-overridden' : ''}${driver ? ` is-driven driven-${driver}` : ''}`}
      data-param={p.id}
    >
      <div className="param-top">
        <button
          className="param-name"
          title={`${p.description ? `${p.description}\n` : ''}param:${p.id}  [${p.min} … ${p.max}]  default ${p.default ?? 0}\nClick to inspect · double-click to reset`}
          onClick={() => session.select([`param:${p.id}`])}
          onDoubleClick={() => session.resetParam(p.id)}
        >
          {overriddenFlag && <span className="override-dot" title="Explicit value (double-click to reset)" />}
          {p.id}
        </button>
        {anim && (
          <span
            className="badge badge-anim"
            title={
              overriddenFlag
                ? 'An animation track drives this parameter, but your explicit value beats it (reset to let the animation drive it; starting playback releases it)'
                : 'Driven by the active animation (moving the slider sets an explicit value, which beats the animation, and pauses playback)'
            }
          >
            anim
          </span>
        )}
        {phys && (
          <button
            type="button"
            className={`badge badge-phys pin-toggle${overriddenFlag ? ' is-pinned' : ''}`}
            title={pinTitle}
            aria-pressed={overriddenFlag}
            aria-label={overriddenFlag ? `Unpin ${p.id} (let physics drive it)` : `Pin ${p.id} at its current value`}
            onClick={() => session.setPinned(p.id, !overriddenFlag)}
            data-testid={`param-pin-${p.id}`}
          >
            <Icon name="pin" size={10} />
            {overriddenFlag ? 'pinned' : 'phys'}
          </button>
        )}
        <input
          className="param-number"
          type="text"
          inputMode="decimal"
          aria-label={`${p.id} value`}
          value={draft ?? formatValue(value, p)}
          onFocus={(e) => {
            setDraft(formatValue(value, p));
            e.currentTarget.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft(null);
              e.currentTarget.blur();
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const delta = (e.shiftKey ? 100 : 10) * step * (e.key === 'ArrowUp' ? 1 : -1);
              session.setParam(p.id, value + delta);
              setDraft(formatValue(Math.min(p.max, Math.max(p.min, value + delta)), p));
            }
          }}
        />
        <button
          className={`icon-button icon-button-small reset-param${overriddenFlag ? '' : ' is-hidden'}`}
          title="Reset (release the explicit value)"
          onClick={() => session.resetParam(p.id)}
          tabIndex={overriddenFlag ? 0 : -1}
        >
          <Icon name="reset" size={12} />
        </button>
      </div>
      <div className="slider-wrap">
        <input
          className="slider"
          type="range"
          min={p.min}
          max={p.max}
          step={step}
          value={value}
          style={{ ['--fill' as string]: `${pct}%` }}
          aria-label={p.id}
          data-testid={`param-slider-${p.id}`}
          onChange={(e) => session.setParam(p.id, Number(e.target.value))}
          onDoubleClick={() => session.resetParam(p.id)}
        />
        {overriddenFlag && physValue !== undefined && (
          <span
            className="param-ghost"
            style={{ left: trackPos(physValue, p) }}
            title={`Physics output: ${fmt(physValue)} (not applied while ${p.id} is pinned)`}
            data-testid={`param-ghost-${p.id}`}
          />
        )}
      </div>
    </div>
  );
}
