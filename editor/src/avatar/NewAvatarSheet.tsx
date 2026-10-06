/**
 * "Avatar from an illustration": the sheet that creates an avatar project from ONE picture (start
 * screen card, File > New Avatar from Illustration…). The person drops or picks a PNG, names the
 * avatar and chooses who places the landmarks: the AI (an "avatar-create" job of the AI panel; the
 * default when the agent bridge is available) or themselves (Avatar mode's checklist). When
 * the AI is not available the reason is shown, and the same request can be copied as text for an
 * agent in a terminal.
 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Button, Icon, Spinner, TextField } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { useApp, useSession } from '../state/context.js';
import { Dialog, useLingering } from '../ui/Dialog.js';
import { Notice } from '../ui/kit.js';
import { aiAvailability, avatarCreateRequest, startAi, terminalRequest, type AiAvailability } from './ai.js';
import { createAvatarProject, onNewAvatarSheet } from './actions.js';
import { avatarNameFrom, isAvatarName } from './naming.js';
import { avatarStore } from './store.js';
import './new-avatar-sheet.css';

type Placement = 'ai' | 'manual';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Picked {
  file: File;
  url: string;
  width: number;
  height: number;
  /** Whether the picture has transparent pixels (sampled). */
  transparent: boolean | null;
}

async function inspectPicture(file: File): Promise<Picked | { error: 'png' | 'read' }> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head.length < 8 || PNG.some((b, i) => head[i] !== b)) return { error: 'png' };
  try {
    const bitmap = await createImageBitmap(file);
    let transparent: boolean | null = null;
    try {
      const w = Math.min(64, bitmap.width);
      const h = Math.min(64, bitmap.height);
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        transparent = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 250) {
            transparent = true;
            break;
          }
        }
      }
    } catch {
      transparent = null;
    }
    const picked = { file, url: URL.createObjectURL(file), width: bitmap.width, height: bitmap.height, transparent };
    bitmap.close();
    return picked;
  } catch {
    return { error: 'read' };
  }
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export function NewAvatarSheet() {
  const [request, setRequest] = useState<{ file: File | null } | null>(null);
  useEffect(
    () =>
      onNewAvatarSheet((open, file) => {
        setRequest(open ? { file: file ?? null } : null);
      }),
    [],
  );
  const shown = useLingering(request);
  if (!shown.value) return null;
  return <SheetBody open={shown.open} initial={shown.value.file} onClose={() => setRequest(null)} />;
}

function SheetBody({ open, initial, onClose }: { open: boolean; initial: File | null; onClose(): void }) {
  const t = useT();
  const session = useSession();
  const root = useApp((s) => s.workspace?.root ?? '');
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [placement, setPlacement] = useState<Placement>('manual');
  const [ai, setAi] = useState<AiAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ error: string; hint?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [over, setOver] = useState(false);

  useEffect(() => {
    let live = true;
    void aiAvailability(t('avatar.ai.unavailable')).then((a) => {
      if (!live) return;
      setAi(a);
      if (a.enabled) setPlacement('ai');
    });
    return () => {
      live = false;
    };
  }, [t]);

  const take = async (file: File): Promise<void> => {
    setPickError(null);
    setFailure(null);
    const r = await inspectPicture(file);
    if ('error' in r) {
      setPickError(r.error === 'png' ? t('avatar.new.notPng', { name: file.name }) : t('avatar.new.unreadable', { name: file.name }));
      return;
    }
    setPicked((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return r;
    });
    if (!nameTouched) setName(avatarNameFrom(file.name));
  };

  useEffect(() => {
    if (initial) void take(initial);
    // Only the picture the sheet was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(() => () => (picked ? URL.revokeObjectURL(picked.url) : undefined), [picked]);

  const nameError = name && !isAvatarName(name) ? t('avatar.new.badName') : null;
  const canCreate = !!picked && !!name && !nameError && !busy;
  const aiOn = ai?.enabled === true;

  const create = async (): Promise<void> => {
    if (!picked || !canCreate) return;
    setBusy(true);
    setFailure(null);
    let base64: string;
    try {
      base64 = await readBase64(picked.file);
    } catch (e) {
      setBusy(false);
      setFailure({ error: t('avatar.new.unreadable', { name: picked.file.name }) + ` ${(e as Error).message}` });
      return;
    }
    const r = await createAvatarProject(session, { name, image: { name: picked.file.name, base64 }, unique: true });
    if (!r.ok) {
      setBusy(false);
      if (!r.cancelled) setFailure({ error: r.error, hint: r.hint });
      return;
    }
    const result = r.result;
    if (placement === 'ai' && aiOn) {
      const job = await startAi(avatarCreateRequest(result.projectPath, result.image.path), t('avatar.ai.unavailable'));
      if ('error' in job) {
        session.toast('error', t('avatar.new.aiFailed', { message: job.error }), {
          action: { label: t('avatar.new.copyRequest'), run: () => void navigator.clipboard?.writeText(terminalRequest(result.project, result.projectPath)) },
        });
      } else avatarStore.setAiJob({ id: job.jobId, kind: 'avatar-create' });
    }
    session.toast('success', t('avatar.new.created', { path: result.projectPath || result.name }), result.notes.length ? { details: result.notes.slice(1) } : {});
    setBusy(false);
    onClose();
  };

  const copy = async (): Promise<void> => {
    const project = `${root ? `${root.replace(/[\\/]+$/, '')}/` : ''}${name || 'avatar'}`;
    try {
      await navigator.clipboard.writeText(terminalRequest(project, name || 'avatar'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const onDrag = (e: DragEvent<HTMLElement>, kind: 'over' | 'leave' | 'drop'): void => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'over') {
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
    } else setOver(false);
    if (kind === 'drop') {
      const file = [...e.dataTransfer.files][0];
      if (file) void take(file);
    }
  };

  return (
    <Dialog
      open={open}
      title={t('avatar.new.title')}
      icon="avatar"
      description={t('avatar.new.description')}
      size="md"
      onCancel={() => !busy && onClose()}
      onConfirm={() => void create()}
      testId="avatar-new-sheet"
      className="ed-avnew"
      actions={
        <>
          <Button size="lg" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" variant="filled" disabled={!canCreate} loading={busy} onClick={() => void create()} data-testid="avatar-new-create">
            {placement === 'ai' && aiOn ? t('avatar.new.createAi') : t('avatar.new.create')}
          </Button>
        </>
      }
    >
      <div className="ed-avnew-body" onDragEnter={(e) => onDrag(e, 'over')} onDragOver={(e) => onDrag(e, 'over')} onDragLeave={(e) => onDrag(e, 'leave')} onDrop={(e) => onDrag(e, 'drop')}>
        <button type="button" className="ed-avnew-drop" data-over={over ? '' : undefined} data-filled={picked ? '' : undefined} onClick={() => input.current?.click()} data-testid="avatar-new-drop">
          {picked ? (
            <>
              <span className="ed-avnew-thumb">
                <img src={picked.url} alt="" />
              </span>
              <span className="ed-avnew-file">
                <strong className="r2-truncate">{picked.file.name}</strong>
                <span className="r2-num">
                  {picked.width} × {picked.height} px
                </span>
                <span className="ed-avnew-change">{t('avatar.new.change')}</span>
              </span>
            </>
          ) : (
            <>
              <span className="ed-avnew-drop-icon">
                <Icon name="image" size={28} />
              </span>
              <strong>{t('avatar.new.drop')}</strong>
              <span className="ed-avnew-drop-sub">{t('avatar.new.dropSub')}</span>
            </>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void take(file);
            e.target.value = '';
          }}
          data-testid="avatar-new-input"
        />
        {pickError && <Notice tone="danger">{pickError}</Notice>}
        {picked && picked.transparent === false && <Notice tone="info">{t('avatar.new.opaque')}</Notice>}
        <TextField
          label={t('avatar.new.name')}
          value={name}
          onChange={(v) => {
            setName(v);
            setNameTouched(true);
          }}
          error={nameError ?? undefined}
          hint={nameError ? undefined : t('avatar.new.nameHint', { folder: `${name || '…'}/` })}
          mono
          data-testid="avatar-new-name"
        />
        <fieldset className="ed-avnew-choice">
          <legend>{t('avatar.new.placeTitle')}</legend>
          <label className="ed-avnew-option" data-disabled={aiOn ? undefined : ''} data-checked={placement === 'ai' && aiOn ? '' : undefined}>
            <input type="radio" name="avatar-placement" value="ai" checked={placement === 'ai' && aiOn} disabled={!aiOn} onChange={() => setPlacement('ai')} data-testid="avatar-new-ai" />
            <Icon name="sparkles" size={20} className="ed-avnew-option-icon" />
            <span className="ed-avnew-option-text">
              <strong>{t('avatar.new.ai')}</strong>
              <span>{aiOn ? t('avatar.new.aiText') : (ai?.reason ?? t('avatar.new.aiChecking'))}</span>
            </span>
          </label>
          <label className="ed-avnew-option" data-checked={placement === 'manual' || !aiOn ? '' : undefined}>
            <input type="radio" name="avatar-placement" value="manual" checked={placement === 'manual' || !aiOn} onChange={() => setPlacement('manual')} data-testid="avatar-new-manual" />
            <Icon name="hand" size={20} className="ed-avnew-option-icon" />
            <span className="ed-avnew-option-text">
              <strong>{t('avatar.new.manual')}</strong>
              <span>{t('avatar.new.manualText')}</span>
            </span>
          </label>
          {ai && !aiOn && (
            <div className="ed-avnew-copy">
              <span>{t('avatar.new.copyHint')}</span>
              <Button size="sm" variant="plain" icon={copied ? 'check' : 'copy'} onClick={() => void copy()} data-testid="avatar-new-copy">
                {copied ? t('common.copied') : t('avatar.new.copyRequest')}
              </Button>
            </div>
          )}
        </fieldset>
        {failure && (
          <Notice tone="danger" hint={failure.hint}>
            {failure.error}
          </Notice>
        )}
        {busy && (
          <div className="ed-avnew-busy" role="status">
            <Spinner size={14} />
            <span>{t('avatar.new.creating')}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
