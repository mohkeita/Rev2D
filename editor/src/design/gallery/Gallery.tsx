/**
 * The design-system gallery (editor/gallery.html): the editor mock, every component, every token
 * and the icon set, in the light and the dark appearance.
 *
 * URL: `#mock | #components | #tokens | #icons` picks the page. Query parameters set the initial
 * state for screenshots and tests: `appearance=light|dark|auto`, `bare` (no gallery header: the mock
 * fills the window), `sheet` (the mock's sheet is open), `lang=ko`, `compare` (light and dark side by
 * side), `transparency=reduce`, `contrast=more`, `motion=reduce`.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  IconButton,
  List,
  ListRow,
  ListSection,
  Popover,
  SegmentedControl,
  Switch,
  ToastProvider,
  parseAppearance,
  useAppearance,
  type Appearance,
} from '../index.js';
import { EditorMock } from './EditorMock.js';
import { Specimens } from './Specimens.js';
import { IconsPage, TokensPage } from './Tokens.js';

type Page = 'mock' | 'components' | 'tokens' | 'icons';
const PAGES: Page[] = ['mock', 'components', 'tokens', 'icons'];

function pageFromHash(): Page {
  const h = window.location.hash.replace('#', '');
  return (PAGES as string[]).includes(h) ? (h as Page) : 'mock';
}

function useRootFlag(attribute: string, on: boolean, value: string): void {
  useEffect(() => {
    const root = document.documentElement;
    if (on) root.setAttribute(attribute, value);
    else root.removeAttribute(attribute);
  }, [attribute, on, value]);
}

export function Gallery() {
  const query = new URLSearchParams(window.location.search);
  const initialAppearance = query.has('appearance') ? parseAppearance(query.get('appearance')) : undefined;
  const { appearance, resolved, setAppearance } = useAppearance(initialAppearance);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [compare, setCompare] = useState(query.has('compare'));
  const [korean, setKorean] = useState(query.get('lang') === 'ko');
  const [reduceTransparency, setReduceTransparency] = useState(query.get('transparency') === 'reduce');
  const [moreContrast, setMoreContrast] = useState(query.get('contrast') === 'more');
  const [reduceMotion, setReduceMotion] = useState(query.get('motion') === 'reduce');
  const bare = query.has('bare');

  useRootFlag('data-transparency', reduceTransparency, 'reduce');
  useRootFlag('data-contrast', moreContrast, 'more');
  useRootFlag('data-motion', reduceMotion, 'reduce');

  useEffect(() => {
    const onHash = (): void => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (next: Page): void => {
    window.location.hash = next;
    setPage(next);
  };

  let content: ReactNode;
  if (page === 'mock') content = <EditorMock key={korean ? 'ko' : 'en'} sheet={query.has('sheet')} korean={korean} />;
  else if (page === 'components') content = <Specimens />;
  else if (page === 'tokens') content = <TokensPage />;
  else content = <IconsPage />;

  const scrolls = page !== 'mock';
  const body =
    compare && scrolls ? (
      <div className="g-compare">
        <div className="g-compare-side r2-app" data-appearance="light" data-testid="compare-light">
          {content}
        </div>
        <div className="g-compare-side r2-app" data-appearance="dark" data-testid="compare-dark">
          {content}
        </div>
      </div>
    ) : (
      content
    );

  return (
    <ToastProvider offset={page === 'mock' ? 236 : 28}>
      <div className="g-shell" data-page={page} data-bare={bare ? '' : undefined} data-resolved={resolved} data-testid="gallery">
        {!bare && (
          <header className="g-header">
            <div className="g-brand">
              <span className="g-brand-mark" aria-hidden="true" />
              <span className="g-brand-name">Rev2D</span>
              <span className="g-brand-sub">Design System</span>
            </div>
            <SegmentedControl
              aria-label="Page"
              data-testid="page-switch"
              value={page}
              onChange={go}
              options={[
                { value: 'mock', label: 'Editor' },
                { value: 'components', label: 'Components' },
                { value: 'tokens', label: 'Tokens' },
                { value: 'icons', label: 'Icons' },
              ]}
            />
            <div className="g-header-tools">
              <SegmentedControl
                aria-label="Appearance"
                data-testid="appearance-switch"
                value={appearance}
                onChange={(v: Appearance) => setAppearance(v)}
                options={[
                  { value: 'auto', icon: 'appearance', ariaLabel: 'Automatic' },
                  { value: 'light', icon: 'sun', ariaLabel: 'Light' },
                  { value: 'dark', icon: 'moon', ariaLabel: 'Dark' },
                ]}
              />
              <Popover title="Display" width={280} placement="bottom-end" trigger={<IconButton icon="sliders" label="Display options" variant="gray" data-testid="display-options" />}>
                <List variant="inset">
                  <ListSection footer="The same switches follow the system settings: prefers-reduced-transparency, prefers-contrast and prefers-reduced-motion.">
                    <ListRow title="Compare Light and Dark" trailing={(id) => <Switch aria-labelledby={id} size="sm" checked={compare} onChange={setCompare} data-testid="opt-compare" />} />
                    <ListRow title="Korean Interface" trailing={(id) => <Switch aria-labelledby={id} size="sm" checked={korean} onChange={setKorean} data-testid="opt-korean" />} />
                    <ListRow title="Reduce Transparency" trailing={(id) => <Switch aria-labelledby={id} size="sm" checked={reduceTransparency} onChange={setReduceTransparency} data-testid="opt-transparency" />} />
                    <ListRow title="Increase Contrast" trailing={(id) => <Switch aria-labelledby={id} size="sm" checked={moreContrast} onChange={setMoreContrast} data-testid="opt-contrast" />} />
                    <ListRow title="Reduce Motion" trailing={(id) => <Switch aria-labelledby={id} size="sm" checked={reduceMotion} onChange={setReduceMotion} data-testid="opt-motion" />} />
                  </ListSection>
                </List>
              </Popover>
            </div>
          </header>
        )}
        <main className={scrolls ? 'g-main r2-scroll' : 'g-main'} data-scrolls={scrolls ? '' : undefined}>
          {body}
        </main>
      </div>
    </ToastProvider>
  );
}
