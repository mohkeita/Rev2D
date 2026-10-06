/** Japanese. Every key of the English dictionary must be here (the type says so). */
import type { en } from './en.js';
import { ai } from './ja/ai.js';
import { avatar } from './ja/avatar.js';
import { common } from './ja/common.js';
import { files } from './ja/files.js';
import { panels } from './ja/panels.js';
import { session } from './ja/session.js';
import { shell } from './ja/shell.js';

export const ja: Record<keyof typeof en, string> = { ...common, ...ai, ...avatar, ...shell, ...panels, ...session, ...files };
