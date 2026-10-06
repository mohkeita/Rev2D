/**
 * The AI panel (trailing sidebar, id AI_PANEL_ID): run Codex or Claude Code from inside the editor
 * through the agent bridge (docs/AGENT-BRIDGE.md).
 *
 *   ┌ ✦ AI Assistant                    (+) (⚙) ┐  new conversation, settings
 *   │ [ Codex CLI | Claude Code ]               │  provider, version, reasoning effort, install hint
 *   │ conversation                              │  Conversation.tsx
 *   │ (progress · elapsed · Stop)               │  Composer.tsx
 *   │ (📁 Working in hana)                       │
 *   │ [ Ask Codex CLI…                     (↑)] │
 *   └ 🔒 Can edit files in this folder  images ⎯ ┘
 */
import { useEffect } from 'react';
import type { AgentEffort, AgentProviderId } from '../../../src/node/editor-registry.js';
import { Button, EmptyState, Icon, IconButton, Inspector, List, ListRow, ListSection, Popover, SegmentedControl, Select, Spinner, Switch, TextField } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { useSession } from '../state/context.js';
import { shallowEqual, useStore } from '../state/store.js';
import { Notice } from '../ui/kit.js';
import { Composer } from './Composer.js';
import { ConversationView } from './ConversationView.js';
import { lastJob } from './conversation.js';
import { explainProblem } from './errors.js';
import { ai, bindSession } from './instance.js';
import { effortLabel, sourceText } from './words.js';
import './ai-panel.css';
import './conversation.css';
import './composer.css';

function ProviderBar() {
  const t = useT();
  const providers = useStore(ai.store, (s) => s.providers);
  const selected = useStore(ai.store, (s) => s.provider);
  const effort = useStore(ai.store, (s) => (s.provider ? (s.efforts[s.provider] ?? null) : null));
  const provider = providers.find((p) => p.id === selected) ?? null;
  if (!providers.length) return null;
  const efforts: Array<{ value: AgentEffort | 'auto'; label: string }> = [{ value: 'auto', label: effortLabel(null, t) }, ...(provider?.efforts ?? []).map((e) => ({ value: e, label: effortLabel(e, t) }))];
  return (
    <div className="ed-ai-providers" data-testid="ai-providers">
      <SegmentedControl<AgentProviderId>
        block
        aria-label={t('ai.provider.label')}
        value={selected ?? undefined}
        onChange={(id) => ai.setProvider(id)}
        options={providers.map((p) => ({
          value: p.id,
          label: (
            <>
              {!p.available && <span className="ed-ai-provider-dot" aria-label={t('ai.provider.notAvailable')} />}
              {p.name}
            </>
          ),
        }))}
        data-testid="ai-provider-picker"
      />
      {provider && (
        <div className="ed-ai-provider-meta">
          <span className="ed-ai-provider-version r2-num" data-testid="ai-provider-version">
            {provider.available ? (provider.version ? t('ai.provider.version', { version: provider.version }) : t('ai.provider.installed')) : t('ai.provider.notAvailable')}
          </span>
          {provider.available && provider.efforts.length > 0 && (
            <span className="ed-ai-effort">
              <span className="ed-ai-effort-label" id="ed-ai-effort-label">
                {t('ai.effort.label')}
              </span>
              <Select<AgentEffort | 'auto'>
                size="sm"
                variant="plain"
                aria-labelledby="ed-ai-effort-label"
                value={effort ?? 'auto'}
                options={efforts}
                onChange={(v) => ai.setEffort(provider.id, v === 'auto' ? null : v)}
                data-testid="ai-effort"
              />
            </span>
          )}
        </div>
      )}
      {provider && !provider.available && (
        <Notice
          tone="warning"
          className="ed-ai-provider-hint"
          data-testid="ai-provider-hint"
          hint={provider.hint ? <span className="ed-mono-small">{provider.hint}</span> : undefined}
          actions={
            <Button variant="tinted" size="sm" onClick={() => void ai.refresh()}>
              {t('ai.provider.check')}
            </Button>
          }
        >
          {t('ai.provider.missing', { name: provider.name })}
        </Notice>
      )}
    </div>
  );
}

function SettingsPopover() {
  const t = useT();
  const settings = useStore(ai.store, (s) => s.settings);
  const saving = useStore(ai.store, (s) => s.sandboxSaving);
  const failed = useStore(ai.store, (s) => s.sandboxProblem);
  const providers = useStore(ai.store, (s) => s.providers);
  const models = useStore(ai.store, (s) => s.models, shallowEqual);
  const value = settings?.settings.codexWindowsSandbox ?? 'config';
  const source = settings?.sources.codexWindowsSandbox ?? 'default';
  return (
    <Popover
      placement="bottom-end"
      width={320}
      title={t('ai.settings.title')}
      onOpenChange={(open) => open && void ai.refreshSettings()}
      trigger={<IconButton icon="settings" label={t('ai.settings.title')} data-testid="ai-settings" />}
      data-testid="ai-settings-popover"
    >
      <List variant="inset" className="ed-ai-settings">
        <ListSection
          header={t('ai.settings.sandbox')}
          footer={
            <>
              {settings?.windows === false ? t('ai.settings.notWindows') : t('ai.settings.sandboxText')}
              <span className="ed-ai-settings-source" data-testid="ai-settings-source">
                {t('ai.settings.sourceLine', { source: sourceText(source, t) })}
              </span>
              {settings?.notes.map((n) => (
                <span key={n} className="ed-ai-settings-source">
                  {n}
                </span>
              ))}
              {failed && <span className="ed-ai-settings-source ed-danger-text">{failed.message}</span>}
            </>
          }
        >
          <ListRow
            title={t('ai.settings.unelevated')}
            trailing={(id) =>
              saving ? (
                <Spinner size={14} />
              ) : (
                <Switch
                  aria-labelledby={id}
                  checked={value === 'unelevated'}
                  disabled={settings?.windows === false}
                  onChange={(on) => void ai.setCodexSandbox(on ? 'unelevated' : 'config')}
                  data-testid="ai-settings-unelevated"
                />
              )
            }
          />
        </ListSection>
        <ListSection header={t('ai.settings.models')} footer={t('ai.settings.modelsText')}>
          {providers.map((p) => (
            <div key={p.id} className="ed-ai-settings-field">
              <TextField
                size="sm"
                label={p.name}
                placeholder={t('ai.settings.modelDefault')}
                value={models[p.id] ?? ''}
                onChange={(v) => ai.setModel(p.id, v)}
                spellCheck={false}
                data-testid={`ai-model-${p.id}`}
              />
            </div>
          ))}
        </ListSection>
      </List>
    </Popover>
  );
}

function Disabled() {
  const t = useT();
  const reason = useStore(ai.store, (s) => s.reason);
  return (
    <EmptyState
      icon="lock"
      size="sm"
      className="ed-ai-state"
      title={t('ai.disabled.title')}
      description={
        <>
          {t('ai.disabled.text')}
          {reason && <span className="ed-ai-state-detail">{reason}</span>}
        </>
      }
      data-testid="ai-disabled"
    />
  );
}

function LoadError() {
  const t = useT();
  const problem = useStore(ai.store, (s) => s.loadProblem);
  const text = problem ? explainProblem(problem) : null;
  return (
    <EmptyState
      icon="warning"
      size="sm"
      className="ed-ai-state"
      title={text ? t(text.title.key, text.title.vars) : t('ai.problem.server.title')}
      description={
        <>
          {text?.text && t(text.text.key, text.text.vars)}
          {text?.detail && <span className="ed-ai-state-detail">{text.detail}</span>}
        </>
      }
      actions={
        <Button variant="tinted" icon="refresh" onClick={() => void ai.init(true)} data-testid="ai-reload">
          {t('common.retry')}
        </Button>
      }
      data-testid="ai-load-error"
    />
  );
}

export function AiPanel() {
  const session = useSession();
  const t = useT();
  useEffect(() => {
    bindSession(session);
    void ai.init();
  }, [session]);
  const status = useStore(ai.store, (s) => s.status);
  const hasConversation = useStore(ai.store, (s) => lastJob(s.jobs, s.conversation) !== null);
  const offline = useStore(ai.store, (s) => s.connection === 'offline');
  const ready = status === 'ready';
  return (
    <Inspector
      className="ed-ai"
      title={t('ai.title')}
      icon="sparkles"
      padded={false}
      aria-label={t('ai.title')}
      data-testid="ai-panel"
      data-status={status}
      actions={
        ready ? (
          <>
            <IconButton icon="plus" label={t('ai.newConversation')} disabled={!hasConversation} onClick={() => ai.newConversation()} data-testid="ai-new" />
            <SettingsPopover />
          </>
        ) : undefined
      }
      header={ready ? <ProviderBar /> : undefined}
      footer={ready ? <Composer /> : undefined}
    >
      {offline && ready && (
        <div className="ed-ai-offline" role="status">
          <Icon name="clock" size={12} />
          {t('ai.offline')}
        </div>
      )}
      {ready ? (
        <ConversationView />
      ) : status === 'disabled' ? (
        <Disabled />
      ) : status === 'error' ? (
        <LoadError />
      ) : (
        <div className="ed-ai-loading" data-testid="ai-loading">
          <Spinner size={18} />
        </div>
      )}
    </Inspector>
  );
}
