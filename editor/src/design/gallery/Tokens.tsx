/** Gallery pages "Tokens" and "Icons". */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Icon, ICON_NAMES, SearchField, type IconName } from '../index.js';
import { SPRINGS, springProgress, type SpringName } from '../logic/spring.js';
import { Specimen } from './Specimens.js';

/** A colour token shown in the light and in the dark appearance, each on its own base background. */
function Swatch({ token, label }: { token: string; label?: string }) {
  return (
    <div className="g-swatch">
      <div className="g-swatch-chips">
        <span className="g-chip" data-appearance="light">
          <i style={{ background: `var(${token})` }} />
        </span>
        <span className="g-chip" data-appearance="dark">
          <i style={{ background: `var(${token})` }} />
        </span>
      </div>
      <code className="g-token">{label ?? token.replace('--r2-', '')}</code>
    </div>
  );
}

function Swatches({ title, tokens }: { title: string; tokens: string[] }) {
  return (
    <div className="g-swatch-group">
      <h4 className="g-subtitle">{title}</h4>
      <div className="g-swatches">
        {tokens.map((t) => (
          <Swatch key={t} token={t} />
        ))}
      </div>
    </div>
  );
}

const TEXT_STYLES: Array<{ token: string; ios: string; spec: string }> = [
  { token: 'large-title', ios: 'Large Title', spec: '26 / 32 Bold' },
  { token: 'title-1', ios: 'Title 1', spec: '22 / 28 Bold' },
  { token: 'title-2', ios: 'Title 2', spec: '17 / 22 Semibold' },
  { token: 'title-3', ios: 'Title 3', spec: '15 / 20 Semibold' },
  { token: 'headline', ios: 'Headline', spec: '13 / 18 Semibold' },
  { token: 'body', ios: 'Body', spec: '13 / 18 Regular' },
  { token: 'callout', ios: 'Callout', spec: '12 / 16 Regular' },
  { token: 'subhead', ios: 'Subhead', spec: '12 / 16 Semibold' },
  { token: 'footnote', ios: 'Footnote', spec: '11 / 14 Regular' },
  { token: 'caption', ios: 'Caption 2', spec: '10 / 13 Medium' },
  { token: 'mono', ios: 'Monospaced', spec: '12 / 16 Mono' },
];

const RADII = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'capsule'];
const SPACES = ['0-5', '1', '1-5', '2', '3', '4', '5', '6', '8', '10', '12', '16'];

function SpringCurve({ name }: { name: SpringName }) {
  const points = Array.from({ length: 61 }, (_, i) => {
    const x = i / 60;
    return `${(x * 120).toFixed(1)},${(70 - springProgress(x, SPRINGS[name]) * 56).toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="g-curve" viewBox="0 0 120 80" aria-hidden="true">
      <line x1="0" y1="14" x2="120" y2="14" className="g-curve-target" />
      <polyline points={points} />
    </svg>
  );
}

function MaterialRow({ appearance }: { appearance: 'light' | 'dark' }) {
  const cell = (cls: string, label: string): ReactNode => (
    <div className={`g-material ${cls}`}>
      <span>{label}</span>
    </div>
  );
  return (
    <div className="g-material-stage r2-app" data-appearance={appearance}>
      <div className="g-material-backdrop" aria-hidden="true" />
      {cell('r2-material-ultrathin', 'ultrathin')}
      {cell('r2-material-thin', 'thin')}
      {cell('r2-material-regular', 'regular')}
      {cell('r2-material-thick', 'thick')}
      {cell('r2-glass g-material-glass', 'glass')}
      {cell('r2-glass-panel g-material-glass', 'glass-panel')}
      {cell('r2-glass-clear g-material-glass', 'glass-clear')}
    </div>
  );
}

export function TokensPage() {
  const [run, setRun] = useState(0);
  return (
    <div className="g-grid">
      <Specimen id="colors" title="Colour" wide note="Each swatch shows the light value (left) and the dark value (right). Labels, fills and separators are translucent so they work on any surface, including glass.">
        <Swatches title="Labels" tokens={['--r2-label', '--r2-label-2', '--r2-label-3', '--r2-label-4']} />
        <Swatches title="Fills" tokens={['--r2-fill', '--r2-fill-2', '--r2-fill-3', '--r2-fill-4', '--r2-fill-raised']} />
        <Swatches title="Separators" tokens={['--r2-separator', '--r2-separator-strong', '--r2-separator-opaque']} />
        <Swatches title="Backgrounds" tokens={['--r2-bg', '--r2-bg-2', '--r2-bg-3', '--r2-bg-grouped', '--r2-bg-grouped-2', '--r2-bg-grouped-3']} />
        <Swatches title="Tint" tokens={['--r2-tint', '--r2-tint-solid', '--r2-tint-solid-hover', '--r2-tint-fill', '--r2-selection', '--r2-focus-color']} />
        <Swatches title="System palette" tokens={['--r2-red', '--r2-orange', '--r2-yellow', '--r2-green', '--r2-mint', '--r2-teal', '--r2-cyan', '--r2-blue', '--r2-indigo', '--r2-purple', '--r2-pink', '--r2-brown']} />
        <Swatches title="Grays" tokens={['--r2-gray', '--r2-gray-2', '--r2-gray-3', '--r2-gray-4', '--r2-gray-5', '--r2-gray-6']} />
        <Swatches title="Semantic" tokens={['--r2-success', '--r2-success-text', '--r2-success-fill', '--r2-warning', '--r2-warning-text', '--r2-warning-fill', '--r2-danger', '--r2-danger-text', '--r2-danger-solid', '--r2-danger-fill']} />
        <Swatches title="Canvas" tokens={['--r2-canvas', '--r2-canvas-glow', '--r2-canvas-check-a', '--r2-canvas-check-b', '--r2-canvas-grid', '--r2-scrim']} />
        <Swatches
          title="Rig kinds"
          tokens={['--r2-kind-part', '--r2-kind-bone', '--r2-kind-warp', '--r2-kind-parameter', '--r2-kind-animation', '--r2-kind-binding', '--r2-kind-ik', '--r2-kind-physics', '--r2-kind-texture']}
        />
      </Specimen>

      <Specimen id="materials" title="Materials and glass" wide note="Standard materials belong to the content layer; glass is the controls layer that floats above the canvas. Never glass on glass: use fills on top of it.">
        <MaterialRow appearance="light" />
        <MaterialRow appearance="dark" />
      </Specimen>

      <Specimen id="type" title="Type" wide note="System fonts only. Names follow the iOS text styles; sizes follow the denser macOS column of the HIG table.">
        <div className="g-type">
          {TEXT_STYLES.map((s) => (
            <div key={s.token} className="g-type-row">
              <div className="g-type-meta">
                <code className="g-token">text-{s.token}</code>
                <span className="g-caption">
                  {s.ios} · {s.spec}
                </span>
              </div>
              <div className="g-type-sample" style={{ font: `var(--r2-text-${s.token})`, letterSpacing: s.token.startsWith('large') || s.token === 'title-1' || s.token === 'title-2' ? 'var(--r2-tracking-display)' : undefined }}>
                <span>Turn the head 12.5°</span>
                <span lang="ko">고개를 12.5° 돌리기</span>
                <span lang="ja">頭を12.5°回す</span>
              </div>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen id="radii" title="Shape" note="Fixed radii, capsules, and concentric shapes: an inner radius is the outer radius minus the padding between them.">
        <div className="g-radii">
          {RADII.map((r) => (
            <div key={r} className="g-radius">
              <i style={{ borderRadius: `var(--r2-radius-${r})` }} />
              <code className="g-token">{r}</code>
            </div>
          ))}
        </div>
        <div className="g-concentric">
          <div className="g-concentric-outer">
            <div className="g-concentric-mid">
              <div className="g-concentric-inner">28 − 8 − 8</div>
            </div>
          </div>
          <div className="g-concentric-capsule">
            <span />
            <span />
            <span />
          </div>
        </div>
      </Specimen>

      <Specimen id="spacing" title="Spacing" note="A 4 pt grid. Half steps only for optical corrections inside controls.">
        <div className="g-spaces">
          {SPACES.map((s) => (
            <div key={s} className="g-space">
              <code className="g-token">space-{s}</code>
              <i style={{ width: `var(--r2-space-${s})` }} />
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen id="elevation" title="Elevation" note="Four shadows: knobs, cards, popovers, sheets. Depth also comes from materials, not from borders.">
        <div className="g-shadows">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="g-shadow" style={{ boxShadow: `var(--r2-shadow-${n})` }}>
              <code className="g-token">shadow-{n}</code>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen id="motion" title="Motion" note="Springs sampled into linear() easings: smooth for surfaces, snappy for controls, bouncy for small confirmations. Under Reduce Motion they become short fades.">
        <div className="g-motion">
          {(Object.keys(SPRINGS) as SpringName[]).map((name) => (
            <div key={name} className="g-motion-row">
              <SpringCurve name={name} />
              <div className="g-motion-track">
                <i key={run} style={{ '--g-ease': `var(--r2-spring-${name})` } as CSSProperties} data-run={run > 0 ? '' : undefined} />
              </div>
              <code className="g-token">spring-{name}</code>
            </div>
          ))}
          <Button size="sm" icon="play" onClick={() => setRun((n) => n + 1)}>
            Play
          </Button>
        </div>
        <div className="g-durations">
          {['instant 90', 'fast 160', 'base 260', 'slow 420', 'slower 600'].map((d) => (
            <code key={d} className="g-token">
              duration-{d.split(' ')[0]} <span>{d.split(' ')[1]} ms</span>
            </code>
          ))}
        </div>
      </Specimen>

      <Specimen id="sizes" title="Control sizes, focus" note="Pointer: 24 / 28 / 36 / 44 px. On touch screens controls grow and keep an invisible 44 px target. The focus ring is a 2 px tint outline, 2 px away.">
        <div className="g-sizes">
          {(['sm', 'md', 'lg', 'xl'] as const).map((s) => (
            <div key={s} className="g-size">
              <Button size={s} variant="gray">
                {s.toUpperCase()}
              </Button>
              <code className="g-token">control-{s}</code>
            </div>
          ))}
          <div className="g-size">
            <Button variant="gray" className="g-focus-demo">
              Focused
            </Button>
            <code className="g-token">focus-color</code>
          </div>
        </div>
      </Specimen>
    </div>
  );
}

const SAMPLE_SIZES = [16, 20, 24, 32];
const SAMPLE_ICONS: IconName[] = ['sparkles', 'play', 'eye', 'layers', 'sliders', 'face', 'settings', 'hand'];

export function IconsPage() {
  const [query, setQuery] = useState('');
  const names = ICON_NAMES.filter((n) => n.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="g-grid">
      <Specimen
        id="icons"
        title={`Icons (${ICON_NAMES.length})`}
        wide
        note="Original glyphs on a 24 px grid with round 1.75 – 2 px strokes, coloured by the text colour. Transport glyphs are solid. Every icon-only control carries a label."
      >
        <div className="g-icon-tools">
          <SearchField value={query} onChange={setQuery} placeholder="Filter icons" width={220} />
          <div className="g-icon-sizes">
            {SAMPLE_SIZES.map((size) => (
              <div key={size} className="g-icon-size">
                {SAMPLE_ICONS.map((n) => (
                  <Icon key={n} name={n} size={size} />
                ))}
                <code className="g-token">{size}</code>
              </div>
            ))}
          </div>
        </div>
        <div className="g-icons" data-testid="icon-grid">
          {names.map((n) => (
            <div key={n} className="g-icon" title={n}>
              <Icon name={n} size={24} />
              <code className="g-token">{n}</code>
            </div>
          ))}
        </div>
      </Specimen>
    </div>
  );
}
