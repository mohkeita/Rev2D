/**
 * Start screen, shown while no model is open: New / Open / Import, the recent files of this
 * workspace and example cards. An example opens the New dialog with it preselected, so the example
 * is COPIED into the workspace, never edited in place.
 */
import { useApp, useSession } from '../state/context.js';
import { Icon, type IconName } from '../ui/icons.js';
import { baseName, dirOf, relativeToRoot, rootLabel } from './paths.js';
import { FILE_SHORTCUTS } from './shortcuts.js';
import { EXAMPLE_ORDER, SIZED_TEMPLATES, shortDescription, templateThumbnail, templateTitle } from './templates.js';
import { useTemplates } from './useTemplates.js';

function ActionCard({
  icon,
  title,
  text,
  shortcut,
  onClick,
  primary,
  testId,
}: {
  icon: IconName;
  title: string;
  text: string;
  shortcut?: string;
  onClick(): void;
  primary?: boolean;
  testId: string;
}) {
  return (
    <button className={`start-action${primary ? ' is-primary' : ''}`} onClick={onClick} data-testid={testId}>
      <span className="start-action-icon">
        <Icon name={icon} size={20} />
      </span>
      <span className="start-action-text">
        <span className="start-action-title">{title}</span>
        <span className="start-action-sub">{text}</span>
      </span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

export function StartScreen() {
  const session = useSession();
  const root = useApp((s) => s.workspace?.root ?? null);
  const recent = useApp((s) => s.workspace?.recent ?? []);
  const busy = useApp((s) => s.fileBusy);
  const { templates } = useTemplates();
  const examples = (templates ?? [])
    .filter((t) => !SIZED_TEMPLATES.has(t.name))
    .sort((a, b) => {
      const ia = EXAMPLE_ORDER.indexOf(a.name);
      const ib = EXAMPLE_ORDER.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const recentItems = recent
    .map((abs) => ({ abs, rel: root ? relativeToRoot(abs, root) : null }))
    .filter((r): r is { abs: string; rel: string } => r.rel !== null);
  const outside = recent.length - recentItems.length;

  return (
    <main className="start-screen" data-testid="start-screen">
      <div className="start-inner">
        <header className="start-head">
          <span className="start-logo" aria-hidden="true" />
          <div className="start-title">
            <h1>Rev2D</h1>
            <p>2D rigging &amp; animation you can edit by hand or with an AI. Open a model to start.</p>
          </div>
          {root && (
            <span className="start-root" title={root}>
              <Icon name="home" size={13} />
              <span className="ellipsis">{root}</span>
            </span>
          )}
        </header>

        <div className="start-actions">
          <ActionCard
            icon="fileNew"
            title="New model"
            text="A starter rig or an empty canvas"
            shortcut={FILE_SHORTCUTS.new}
            onClick={() => session.openDialog({ kind: 'new' })}
            primary
            testId="start-new"
          />
          <ActionCard
            icon="folderOpen"
            title="Open…"
            text={`Browse the models in ${rootLabel(root)}`}
            shortcut={FILE_SHORTCUTS.open}
            onClick={() => session.openDialog({ kind: 'open' })}
            testId="start-open"
          />
          <ActionCard
            icon="upload"
            title="Import from computer"
            text="A model .json with its PNG textures, or a Spine export (or drop them here)"
            onClick={() => session.pickImportFiles()}
            testId="start-import"
          />
        </div>

        <div className="start-columns">
          <section className="start-section start-recent" aria-labelledby="start-recent-title">
            <h2 id="start-recent-title">
              <Icon name="clock" size={14} /> Recent
            </h2>
            {recentItems.length === 0 ? (
              <div className="start-empty">
                <p>Nothing opened in this workspace yet.</p>
                <p className="muted">Models you open or create appear here.</p>
              </div>
            ) : (
              <ul className="recent-list">
                {recentItems.map((r) => (
                  <li key={r.abs}>
                    <button className="recent-item" onClick={() => void session.openRecent(r.abs)} disabled={!!busy} title={r.abs} data-testid="start-recent-item">
                      <Icon name="file" size={16} />
                      <span className="recent-text">
                        <span className="recent-name">{baseName(r.rel)}</span>
                        <span className="recent-dir">{dirOf(r.rel) ? `${dirOf(r.rel)}/` : `${rootLabel(root)}/`}</span>
                      </span>
                      <Icon name="chevronRight" size={14} className="icon recent-go" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {outside > 0 && (
              <p className="start-note muted">
                {outside} recent file{outside === 1 ? ' is' : 's are'} in other folders; start <code>rev2d edit</code> there to open {outside === 1 ? 'it' : 'them'}.
              </p>
            )}
          </section>

          <section className="start-section start-examples" aria-labelledby="start-examples-title">
            <h2 id="start-examples-title">
              <Icon name="sparkle" size={14} /> Start from an example
              <span className="start-h2-note">copied into your workspace, the original stays untouched</span>
            </h2>
            <div className="example-grid">
              {templates === null && <div className="start-empty muted">Loading examples…</div>}
              {examples.map((t) => {
                const thumb = templateThumbnail(t.name);
                return (
                  <button
                    key={t.name}
                    className="example-card"
                    onClick={() => session.openDialog({ kind: 'new', template: t.name })}
                    title={t.description}
                    data-testid={`example-${t.name}`}
                  >
                    <span className="example-thumb">{thumb ? <img src={thumb} alt="" /> : <Icon name="model" size={28} />}</span>
                    <span className="example-name">{templateTitle(t.name)}</span>
                    <span className="example-desc">{shortDescription(t.description, 90)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="start-foot muted">
          <Icon name="bolt" size={13} />
          <span>
            AI agents can open, create and save models here too, through the editor bridge (MCP or <code>rev2d editor</code>); this window follows along.
          </span>
        </footer>
      </div>
    </main>
  );
}
