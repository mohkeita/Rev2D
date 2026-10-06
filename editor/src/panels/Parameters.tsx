/**
 * Parameter sliders grouped by `group` (a page of the trailing inspector). The slider shows the
 * EVALUATED value live (after animation and physics); moving it sets an explicit value, which beats
 * animation AND physics (core SPEC §9). A dot marks explicit values (reset releases them). Badges
 * mark parameters driven by the active animation layers or by physics: the physics badge is also
 * the pin toggle (pinned = explicit value held; unpinned = physics drives it), and a pinned physics
 * output shows where physics would put it as a ghost tick on the slider.
 */
import { useMemo, useState } from 'react';
import type { Parameter } from '../../../src/core/index.js';
import { Badge, Button, ContextMenu, Icon, IconButton, InspectorSection, NumberField, Slider, type MenuEntry } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { useApp, useSession } from '../state/context.js';
import { matches } from '../state/outline.js';
import { physicsParams } from '../state/playback.js';
import { Chip } from '../ui/kit.js';
import './parameters.css';

/** Decimals shown for a parameter: more for small ranges. */
function decimalsFor(p: Parameter): number {
  const span = Math.abs(p.max - p.min);
  return span >= 100 ? 1 : span >= 10 ? 2 : 3;
}

function formatValue(v: number, p: Parameter): string {
  return v.toFixed(decimalsFor(p));
}

export function Parameters() {
  const session = useSession();
  const t = useT();
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
      const g = p.group ?? '';
      out.set(g, [...(out.get(g) ?? []), p]);
    }
    return [...out.entries()];
  }, [model]);
  const total = model?.parameters.length ?? 0;
  // The outliner's filter applies here too; say so, since it hides sliders.
  const matching = model?.parameters.filter((p) => matches(p.id, search)).length ?? 0;

  return (
    <div className="ed-params" data-testid="parameters">
      <div className="ed-pane-bar">
        <span className="ed-pane-bar-title">{t('params.count', { n: total })}</span>
        {search && model && (
          <Chip label={t('params.filter.clear')} onRemove={() => session.store.set({ search: '' })} data-testid="params-filter">
            {t('params.filter', { n: matching, query: search })}
          </Chip>
        )}
        <span className="ed-pane-bar-space" />
        <Button variant="plain" size="sm" icon="reset" disabled={overridden === 0} title={t('params.resetAll.tip')} onClick={() => session.resetAllParams()} data-testid="reset-all-params">
          {t('params.resetAll')}
        </Button>
      </div>
      <div className="ed-pane-scroll r2-scroll">
        {!model || total === 0 ? (
          <p className="ed-pane-empty">{model ? t('params.none') : t('outliner.noModel')}</p>
        ) : matching === 0 ? (
          <p className="ed-pane-empty">{t('params.noMatch', { query: search })}</p>
        ) : (
          groups.map(([group, params]) => {
            const shown = params.filter((p) => matches(p.id, search));
            if (shown.length === 0) return null;
            return (
              <InspectorSection
                key={group}
                title={group || t('params.general')}
                collapsible={groups.length > 1}
                open={!collapsed.has(group)}
                onOpenChange={(open) => {
                  const next = new Set(collapsed);
                  if (open) next.delete(group);
                  else next.add(group);
                  setCollapsed(next);
                }}
                trailing={<span className="ed-section-count r2-num">{params.length}</span>}
              >
                {shown.map((p) => (
                  <ParamRow key={p.id} param={p} anim={animated.has(p.id)} phys={physics.has(p.id)} />
                ))}
              </InspectorSection>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Horizontal position of value v on the small slider (its 18 px knob's centre travels inside the track). */
const trackPos = (v: number, p: Parameter): string => {
  const u = Math.min(1, Math.max(0, (v - p.min) / (p.max - p.min || 1)));
  return `calc(9px + (100% - 18px) * ${u})`;
};

function ParamRow({ param: p, anim, phys }: { param: Parameter; anim: boolean; phys: boolean }) {
  const session = useSession();
  const t = useT();
  const fallback = p.default ?? Math.min(p.max, Math.max(p.min, 0));
  const value = useApp((s) => s.values[p.id] ?? fallback);
  const override = useApp((s) => s.overrides[p.id]);
  const physValue = useApp((s) => (phys ? s.physicsValues[p.id] : undefined));
  const selected = useApp((s) => s.selection.includes(`param:${p.id}`));
  const step = (p.max - p.min) / 1000 || 0.001;
  const pinned = override !== undefined;
  // Animation / physics move the slider by themselves unless an explicit value holds it.
  const driver = pinned ? null : phys ? 'physics' : anim ? 'animation' : null;
  const fmt = (v: number): string => formatValue(v, p);
  const origin = p.min < fallback && fallback < p.max ? fallback : undefined;

  const pinTip = pinned
    ? t('params.pin.pinnedTip', { id: p.id, value: fmt(value) }) + (physValue !== undefined ? ` ${t('params.pin.ghostTip', { value: fmt(physValue) })}` : '')
    : t('params.pin.drivenTip', { id: p.id, value: fmt(value) });

  const menu = (): MenuEntry[] => [
    { id: 'inspect', label: t('outliner.menu.inspect'), icon: 'sidebarRight', onSelect: () => session.inspect([`param:${p.id}`]) },
    { id: 'reset', label: t('params.reset'), icon: 'reset', disabled: !pinned, onSelect: () => session.resetParam(p.id) },
    ...(phys ? [{ id: 'pin', label: pinned ? t('params.unpin') : t('params.pin'), icon: 'pin' as const, onSelect: () => session.setPinned(p.id, !pinned) }] : []),
    { type: 'separator' },
    { id: 'copy', label: t('outliner.menu.copyId'), icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(p.id).catch(() => undefined) },
  ];

  return (
    <ContextMenu items={menu}>
      <div className="ed-param" data-param={p.id} data-selected={selected ? '' : undefined} data-pinned={pinned ? '' : undefined} data-driver={driver ?? undefined}>
        <div className="ed-param-top">
          <button
            type="button"
            className="ed-param-name"
            title={`${p.description ? `${p.description}\n` : ''}param:${p.id}  [${p.min} … ${p.max}]  ${t('params.default', { value: p.default ?? 0 })}\n${t('params.name.tip')}`}
            onClick={() => session.inspect([`param:${p.id}`])}
            onDoubleClick={() => session.resetParam(p.id)}
          >
            {pinned && <span className="ed-param-dot" title={t('params.explicit')} />}
            <span className="r2-truncate">{p.id}</span>
          </button>
          {anim && (
            <Badge icon="film" title={pinned ? t('params.anim.overriddenTip') : t('params.anim.tip')} className="ed-param-badge" data-tone-kind="animation">
              {t('params.anim')}
            </Badge>
          )}
          {phys && (
            <button
              type="button"
              className="ed-param-pin"
              title={pinTip}
              aria-pressed={pinned}
              aria-label={pinned ? t('params.pin.unpinLabel', { id: p.id }) : t('params.pin.pinLabel', { id: p.id })}
              onClick={() => session.setPinned(p.id, !pinned)}
              data-testid={`param-pin-${p.id}`}
            >
              <Icon name="pin" size={12} strokeWidth={2.2} />
              {pinned ? t('params.pinned') : t('params.physics')}
            </button>
          )}
          <NumberField
            className="ed-param-number"
            size="sm"
            width={64}
            aria-label={t('params.valueOf', { id: p.id })}
            value={Number(fmt(value))}
            min={p.min}
            max={p.max}
            step={step * 10}
            precision={decimalsFor(p)}
            onChange={(v) => session.setParam(p.id, v)}
            data-testid={`param-value-${p.id}`}
          />
          <IconButton
            icon="reset"
            size="sm"
            label={t('params.reset.tip')}
            className="ed-param-reset"
            data-hidden={pinned ? undefined : ''}
            tabIndex={pinned ? 0 : -1}
            tooltip={pinned ? 'left' : false}
            onClick={() => session.resetParam(p.id)}
          />
        </div>
        {/* A double click releases the explicit value (the slider follows animation / physics / the default again). */}
        <div className="ed-param-slider" onDoubleClick={() => session.resetParam(p.id)}>
          <Slider size="sm" min={p.min} max={p.max} step={step} origin={origin} value={value} formatValue={fmt} onChange={(v) => session.setParam(p.id, v)} aria-label={p.id} data-testid={`param-slider-${p.id}`} />
          {pinned && physValue !== undefined && (
            <span className="ed-param-ghost" style={{ left: trackPos(physValue, p) }} title={t('params.ghost.tip', { id: p.id, value: fmt(physValue) })} data-testid={`param-ghost-${p.id}`} />
          )}
        </div>
      </div>
    </ContextMenu>
  );
}
