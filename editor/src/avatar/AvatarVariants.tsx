/**
 * "Drawn variants" in Avatar mode's trailing panel: closed eyes and mouth shapes drawn by an image
 * generator replace the mesh deformation (src/avatar/variants.ts). Every variant is a row with a
 * thumbnail of its area, its state (in use, out of date, rejected with the reason, not imported,
 * requested, not drawn) and a menu (show it in the preview, remove the drawing). Below the rows:
 *
 *   Draw with AI…     an "avatar-variants" job of the AI panel (the illustration goes to the
 *                     provider's image generator: the sheet says so before anything is sent);
 *                     disabled with the reason when no AI can draw, with "Copy the Request" for an
 *                     agent in a terminal;
 *   Import Drawings   for drawings placed in variants/ by hand: an import job (its banner shows);
 *   more              write the masks and prompts, open the instructions.
 */
import { useEffect, useMemo, useState } from 'react';
import { VARIANT_IDS, type VariantId } from '../../../src/avatar/types.js';
import { avatarFileUrl } from '../api.js';
import { Badge, Button, Icon, IconButton, InspectorSection, Menu, Spinner, type MenuEntry } from '../design/index.js';
import { useT, type Translate } from '../i18n/index.js';
import { Dialog, useLingering } from '../ui/Dialog.js';
import { LinkButton, Notice } from '../ui/kit.js';
import { aiAvailability, avatarVariantsRequest, drawingProvider, startAi, variantsTerminalRequest, type AiAvailability } from './ai.js';
import { shallowEqual, useAvatar } from './hooks.js';
import { avatarStore } from './store.js';
import { splitRows, suggestedDrawIds, thumbCrop, variantPose, variantRows, type VariantRowView } from './variantRows.js';
import { rejectText, variantLabel } from './variantText.js';
import './avatar-variants.css';

const THUMB = { width: 64, height: 32 };

function stateLabel(t: Translate, state: VariantRowView['state']): string {
  return t(`avatar.variants.state.${state}` as 'avatar.variants.state.accepted');
}

/** The section. */
export function AvatarVariants() {
  const t = useT();
  const s = useAvatar(
    (st) => ({
      info: st.variants,
      error: st.variantsError,
      files: st.info?.files,
      image: st.image,
      ref: st.ref,
      built: st.meta !== null,
      running: st.job?.state === 'running',
      importing: st.job?.state === 'running' && st.job.kind === 'variants',
      aiBusy: st.ai !== null && st.ai.kind === 'avatar-variants',
      requesting: st.requestingVariants,
    }),
    shallowEqual,
  );
  const [expanded, setExpanded] = useState(false);
  const [ai, setAi] = useState<AiAvailability | null>(null);
  const [drawing, setDrawing] = useState<{ ids: VariantId[] } | null>(null);
  const [removing, setRemoving] = useState<VariantId | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void aiAvailability(t('avatar.ai.unavailable')).then((a) => live && setAi(a));
    return () => {
      live = false;
    };
  }, [t]);

  const rows = useMemo(() => (s.info ? variantRows(s.info, s.files, s.image?.file ?? 'source.png') : []), [s.info, s.files, s.image]);
  const { shown, hidden } = splitRows(rows);
  const visible = expanded ? rows : shown;
  const inUse = rows.filter((r) => r.state === 'accepted').length;
  const drawer = drawingProvider(ai);
  const drawReason = !s.built
    ? t('avatar.variants.notBuilt')
    : !ai
      ? t('avatar.new.aiChecking')
      : !ai.enabled
        ? (ai.reason ?? t('avatar.ai.unavailable'))
        : !drawer
          ? t('avatar.variants.noDrawer', { example: 'Codex' })
          : s.aiBusy
            ? t('avatar.variants.busy')
            : null;

  const copy = async (): Promise<void> => {
    if (!s.ref) return;
    try {
      await navigator.clipboard.writeText(variantsTerminalRequest(s.ref.project, s.ref.projectPath, suggestedDrawIds(s.info)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const more: MenuEntry[] = [
    { id: 'request', label: t('avatar.variants.writeRequests'), icon: 'document', disabled: s.requesting || !s.built },
    { id: 'readme', label: t('avatar.variants.openReadme'), icon: 'external', disabled: !s.info?.requests.readme },
  ];

  return (
    <InspectorSection
      title={t('avatar.variants.title')}
      defaultOpen
      className="ed-avvariants"
      data-testid="avatar-variants"
      trailing={
        <span className="ed-avvariants-trailing">
          {inUse > 0 && (
            <Badge tone="success" data-testid="avatar-variants-count">
              {t('avatar.variants.counts', { n: inUse })}
            </Badge>
          )}
          <Menu
            items={more}
            aria-label={t('avatar.variants.menu')}
            placement="bottom-end"
            onAction={(id) => {
              if (id === 'request') void avatarStore.requestVariants(suggestedDrawIds(s.info));
              else if (id === 'readme' && s.info?.requests.readme) window.open(avatarFileUrl(s.info.requests.readme, Date.now()), '_blank', 'noopener');
            }}
          >
            <IconButton icon="more" size="sm" label={t('avatar.variants.menu')} data-testid="avatar-variants-menu" />
          </Menu>
        </span>
      }
    >
      <p className="ed-avvariants-intro">{t('avatar.variants.intro')}</p>
      {!s.info ? (
        <div className="ed-avvariants-loading">{s.error ? <Notice tone="danger">{s.error}</Notice> : <Spinner size={16} />}</div>
      ) : (
        <>
          <ul className="ed-avvariants-rows" data-testid="avatar-variants-list">
            {visible.map((row) => (
              <VariantRow key={row.id} row={row} info={s.info!} image={s.image} onRemove={() => setRemoving(row.id)} />
            ))}
          </ul>
          {hidden.length > 0 && (
            <LinkButton className="ed-avvariants-more" onClick={() => setExpanded(!expanded)} data-testid="avatar-variants-more">
              {expanded ? t('avatar.variants.less') : t('avatar.variants.more', { n: hidden.length })}
            </LinkButton>
          )}
        </>
      )}
      <div className="ed-avvariants-actions">
        <Button variant="tinted" icon="sparkles" disabled={drawReason !== null} onClick={() => setDrawing({ ids: suggestedDrawIds(s.info) })} data-testid="avatar-variants-draw">
          {t('avatar.variants.draw')}
        </Button>
        <Button icon="import" disabled={!s.built || s.running} loading={s.importing} onClick={() => void avatarStore.importVariants()} data-testid="avatar-variants-import">
          {s.importing ? t('avatar.variants.importing') : t('avatar.variants.import')}
        </Button>
      </div>
      {drawReason !== null && (
        <div className="ed-avvariants-why" data-testid="avatar-variants-why">
          <Icon name="info" size={14} />
          <span>
            {drawReason}
            {s.built && <> {t('avatar.variants.copyHint', { example: 'Codex' })}</>}
          </span>
          {s.built && (
            <Button size="sm" variant="plain" icon={copied ? 'check' : 'copy'} onClick={() => void copy()} data-testid="avatar-variants-copy">
              {copied ? t('common.copied') : t('avatar.variants.copyRequest')}
            </Button>
          )}
        </div>
      )}
      <DrawSheet request={drawing} provider={drawer} onClose={() => setDrawing(null)} />
      <RemoveAlert id={removing} onClose={() => setRemoving(null)} />
    </InspectorSection>
  );
}

function VariantRow({ row, info, image, onRemove }: { row: VariantRowView; info: NonNullable<ReturnType<typeof avatarStore.get>['variants']>; image: { width: number; height: number } | null; onRemove(): void }) {
  const t = useT();
  const crop = thumbCrop(info.areas[row.group], image, THUMB);
  const url = avatarFileUrl(row.thumb.file, row.thumb.version || undefined);
  const label = variantLabel(t, row.id);
  const detail = row.detail;
  const items: MenuEntry[] = [
    { id: 'preview', label: t('avatar.variants.preview'), icon: 'eye' },
    { type: 'separator' },
    { id: 'remove', label: t('avatar.variants.remove'), icon: 'trash', destructive: true, disabled: !row.drawn && !row.sprite },
  ];
  const show = () => avatarStore.setPreviewParams({ ...avatarStore.get().previewParams, ...variantPose(row.id) });
  return (
    <li className="ed-avvariant" data-state={row.state} data-testid={`avatar-variant-${row.id}`}>
      <button type="button" className="ed-avvariant-main" onClick={show} title={t('avatar.variants.preview')}>
        <span
          className="ed-avvariant-thumb"
          data-empty={row.drawn ? undefined : ''}
          style={crop ? { backgroundImage: `url("${url}")`, backgroundSize: crop.backgroundSize, backgroundPosition: crop.backgroundPosition } : undefined}
          aria-hidden="true"
        />
        <span className="ed-avvariant-text">
          <span className="ed-avvariant-name">
            <span className="r2-truncate">{label}</span>
            {row.recommended && row.state === 'missing' && <span className="ed-avvariant-rec">{t('avatar.variants.recommended')}</span>}
          </span>
          {detail.kind === 'reason' && (
            <span className="ed-avvariant-detail" data-tone="danger" title={detail.hint ? `${detail.text}\n\n${detail.hint}` : detail.text} data-testid={`avatar-variant-reason-${row.id}`}>
              {rejectText(t, detail.code, detail.values, detail.text)}
            </span>
          )}
          {detail.kind === 'stale' && <span className="ed-avvariant-detail" data-tone="warning">{t('avatar.variants.staleText')}</span>}
          {detail.kind === 'check' && <span className="ed-avvariant-detail r2-num">{t('avatar.variants.check', { outside: detail.outside.toFixed(2), inside: Math.round(detail.inside * 100) })}</span>}
          {detail.kind === 'drawn' && <span className="ed-avvariant-detail">{t('avatar.variants.drawnText')}</span>}
          {detail.kind === 'requested' && <span className="ed-avvariant-detail">{t('avatar.variants.requestedText')}</span>}
        </span>
      </button>
      <Badge tone={row.tone} className="ed-avvariant-state" data-testid={`avatar-variant-state-${row.id}`}>
        {stateLabel(t, row.state)}
      </Badge>
      <Menu
        items={items}
        aria-label={label}
        placement="bottom-end"
        onAction={(id) => {
          if (id === 'preview') show();
          else if (id === 'remove') onRemove();
        }}
      >
        <IconButton icon="more" size="sm" label={t('avatar.variants.rowMenu', { label })} data-testid={`avatar-variant-menu-${row.id}`} />
      </Menu>
    </li>
  );
}

/** "Draw with AI": which variants, who draws them, and that the illustration is sent to that provider. */
function DrawSheet({ request, provider, onClose }: { request: { ids: VariantId[] } | null; provider: { id: string; name: string } | null; onClose(): void }) {
  const shown = useLingering(request);
  if (!shown.value) return null;
  return <DrawSheetBody key={shown.value.ids.join(',')} open={shown.open} initial={shown.value.ids} provider={provider} onClose={onClose} />;
}

function DrawSheetBody({ open, initial, provider, onClose }: { open: boolean; initial: VariantId[]; provider: { id: string; name: string } | null; onClose(): void }) {
  const t = useT();
  const ref = useAvatar((st) => st.ref);
  const [ids, setIds] = useState<VariantId[]>(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const name = provider?.name ?? 'AI';
  const toggle = (id: VariantId) => setIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : VARIANT_IDS.filter((x) => x === id || list.includes(x))));
  const start = async (): Promise<void> => {
    if (!ref || !provider || ids.length === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    const job = await startAi(avatarVariantsRequest(ref.projectPath, ids, provider.id), t('avatar.ai.unavailable'));
    setBusy(false);
    if ('error' in job) {
      setFailure(t('avatar.variants.drawFailed', { message: job.error }));
      return;
    }
    avatarStore.setAiJob({ id: job.jobId, kind: 'avatar-variants' });
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={t('avatar.variants.drawTitle')}
      icon="sparkles"
      description={t('avatar.variants.drawText', { provider: name })}
      size="md"
      onCancel={() => !busy && onClose()}
      onConfirm={() => void start()}
      testId="avatar-variants-draw-sheet"
      className="ed-avdraw"
      actions={
        <>
          <Button size="lg" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" variant="filled" icon="sparkles" disabled={ids.length === 0 || !provider} loading={busy} onClick={() => void start()} data-testid="avatar-variants-draw-start">
            {t('avatar.variants.drawStart', { n: ids.length })}
          </Button>
        </>
      }
    >
      <div className="ed-avdraw-body">
        {(['eyes', 'mouth'] as const).map((group) => (
          <fieldset key={group} className="ed-avdraw-group">
            <legend>{t(`avatar.variants.group.${group}` as 'avatar.variants.group.eyes')}</legend>
            <div className="ed-avdraw-chips">
              {VARIANT_IDS.filter((id) => (group === 'eyes' ? id.startsWith('eyes') : id.startsWith('mouth'))).map((id) => (
                <label key={id} className="ed-avdraw-chip" data-checked={ids.includes(id) ? '' : undefined}>
                  <input type="checkbox" checked={ids.includes(id)} onChange={() => toggle(id)} data-testid={`avatar-variants-pick-${id}`} />
                  <Icon name={ids.includes(id) ? 'checkCircle' : group === 'eyes' ? 'eye' : 'mouth'} size={14} />
                  <span>{variantLabel(t, id)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {ids.length === 0 && <p className="ed-avdraw-none">{t('avatar.variants.drawNone')}</p>}
        <Notice tone="info" icon="globe" data-testid="avatar-variants-privacy">
          {t('avatar.variants.privacy', { provider: name })}
        </Notice>
        {failure && <Notice tone="danger">{failure}</Notice>}
      </div>
    </Dialog>
  );
}

/** Removing a variant deletes its drawing; the import that follows removes its sprite. */
function RemoveAlert({ id, onClose }: { id: VariantId | null; onClose(): void }) {
  const t = useT();
  const shown = useLingering(id);
  if (!shown.value) return null;
  const target = shown.value;
  const remove = () => {
    void avatarStore.importVariants({ remove: [target] });
    onClose();
  };
  return (
    <Dialog
      alert
      open={shown.open}
      icon="trash"
      title={t('avatar.variants.removeTitle', { label: variantLabel(t, target) })}
      description={t('avatar.variants.removeText', { file: `variants/${target}.png` })}
      onCancel={onClose}
      onConfirm={remove}
      testId="avatar-variants-remove-alert"
      actions={
        <>
          <Button size="lg" block onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" block destructive onClick={remove} data-testid="avatar-variants-remove-confirm">
            {t('avatar.variants.removeConfirm')}
          </Button>
        </>
      }
    />
  );
}
