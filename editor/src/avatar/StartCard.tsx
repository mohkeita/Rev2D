/**
 * The start screen's card for avatar mode: "Avatar from an Illustration". A click opens the
 * new-avatar sheet; a PNG dropped on the card opens it with that picture.
 */
import { useState, type DragEvent } from 'react';
import { Icon } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { openNewAvatarSheet } from './actions.js';
import './start-card.css';

export function AvatarStartCard() {
  const t = useT();
  const [over, setOver] = useState(false);
  const files = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');
  return (
    <button
      type="button"
      className="ed-avstart"
      data-over={over ? '' : undefined}
      onClick={() => openNewAvatarSheet()}
      onDragEnter={(e) => {
        if (!files(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!files(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!files(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        openNewAvatarSheet([...e.dataTransfer.files][0] ?? null);
      }}
      data-testid="start-avatar"
    >
      <span className="ed-avstart-art" aria-hidden="true">
        <Icon name="image" size={22} className="ed-avstart-art-image" />
        <Icon name="sparkles" size={14} className="ed-avstart-art-spark" />
        <Icon name="avatar" size={26} className="ed-avstart-art-avatar" />
      </span>
      <span className="ed-avstart-text">
        <span className="ed-avstart-title">{t('avatar.start.title')}</span>
        <span className="ed-avstart-sub">{t('avatar.start.text')}</span>
      </span>
      <Icon name="chevronRight" size={14} strokeWidth={2.4} className="ed-avstart-chevron" />
    </button>
  );
}
