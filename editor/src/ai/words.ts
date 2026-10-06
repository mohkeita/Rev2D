/** Words of the AI panel built from the pure descriptors (progress, durations, token counts, efforts). */
import type { AgentEffort, AgentSettingSource } from '../../../src/node/editor-registry.js';
import { languageTag, type MessageKey, type Translate } from '../i18n/index.js';
import { baseName, type Progress } from './conversation.js';

/** One short line about what a job does now ("Running node rev2d.js validate …"). */
export function progressText(p: Progress, t: Translate): string {
  switch (p.kind) {
    case 'starting':
      return t('ai.progress.starting');
    case 'working':
      return t('ai.progress.working');
    case 'thinking':
      return t('ai.progress.thinking');
    case 'command':
      return t('ai.progress.command', { command: shortCommand(p.detail) });
    case 'editing':
      return t('ai.progress.editing', { files: p.detail });
    case 'tool':
      return t('ai.progress.tool', { tool: p.detail });
    case 'retry':
      return t('ai.progress.retry');
    case 'stalled':
      return t('ai.progress.stalled');
    case 'ended':
      return p.state === 'done' ? t('ai.state.done') : p.state === 'cancelled' ? t('ai.state.cancelled') : t('ai.state.failed');
  }
}

/** Words of a command line, with their quotes removed, and where each word ends in the text. */
function words(s: string): Array<{ word: string; end: number }> {
  const out: Array<{ word: string; end: number }> = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ') i++;
    if (i >= s.length) break;
    let word = '';
    while (i < s.length && s[i] !== ' ') {
      const q = s[i];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1);
        const stop = close < 0 ? s.length : close;
        word += s.slice(i + 1, stop);
        i = stop + 1;
      } else word += s[i++];
    }
    out.push({ word, end: Math.min(i, s.length) });
  }
  return out;
}

const SHELLS = /^(powershell|pwsh|cmd|bash|sh|zsh)(\.exe)?$/i;
const SHELL_FLAGS = /^(-command|-c|\/c|-lc|-noprofile|-nologo|-noninteractive|-executionpolicy|bypass)$/i;

/**
 * A command line shortened for one line: "node C:/x/bin/rev2d.js validate m.json" becomes
 * "rev2d validate m.json", a program path its file name, and a shell wrapper ("powershell -Command
 * '...'") the command it runs.
 */
export function shortCommand(command: string): string {
  const s = command.replace(/\s+/g, ' ').trim();
  const w = words(s);
  if (!w.length) return s;
  const rest = (k: number): string => (k < w.length ? s.slice(w[k - 1]!.end).trim() : '');
  const prog = baseName(w[0]!.word);
  if (SHELLS.test(prog)) {
    let k = 1;
    while (k < w.length && SHELL_FLAGS.test(w[k]!.word)) k++;
    if (k < w.length && k > 1) return shortCommand(k === w.length - 1 ? w[k]!.word : rest(k));
  }
  const isRev2d = (word: string): boolean => /(^|[\\/])bin[\\/]rev2d\.js$/i.test(word) || /^rev2d(\.js)?$/i.test(baseName(word));
  if (/^node(\.exe)?$/i.test(prog) && w.length > 1 && isRev2d(w[1]!.word)) return `rev2d ${rest(2)}`.trim();
  if (isRev2d(w[0]!.word)) return `rev2d ${rest(1)}`.trim();
  if (/[\\/]/.test(w[0]!.word)) return `${prog} ${rest(1)}`.trim();
  return s;
}

/** "4.8K", "4.8만", "4.8万" (compact, in the current language). */
export function formatCount(n: number): string {
  try {
    return new Intl.NumberFormat(languageTag(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

/** "42 s", "1 min 12 s" (a finished job's duration). */
export function durationText(ms: number, t: Translate): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return t('ai.duration.seconds', { s });
  if (m >= 60) return t('ai.duration.hours', { h: Math.floor(m / 60), m: m % 60 });
  return t('ai.duration.minutes', { m, s });
}

const EFFORT_KEYS: Record<AgentEffort, MessageKey> = {
  minimal: 'ai.effort.minimal',
  low: 'ai.effort.low',
  medium: 'ai.effort.medium',
  high: 'ai.effort.high',
  xhigh: 'ai.effort.xhigh',
  max: 'ai.effort.max',
};

export function effortLabel(effort: AgentEffort | null, t: Translate): string {
  return effort ? t(EFFORT_KEYS[effort]) : t('ai.effort.auto');
}

const TASK_TITLES: Record<string, MessageKey> = {
  'avatar-create': 'ai.task.avatarCreate',
  'avatar-variants': 'ai.task.avatarVariants',
};

/** The title of a task template in the current language (the server's English title for unknown kinds). */
export function taskTitle(task: { kind: string; title: string }, t: Translate): string {
  const key = TASK_TITLES[task.kind];
  return key ? t(key) : task.title;
}

const SOURCE_KEYS: Record<AgentSettingSource, MessageKey> = {
  option: 'ai.settings.source.option',
  flag: 'ai.settings.source.flag',
  user: 'ai.settings.source.user',
  default: 'ai.settings.source.default',
};

export function sourceText(source: AgentSettingSource, t: Translate): string {
  return t(SOURCE_KEYS[source]);
}
