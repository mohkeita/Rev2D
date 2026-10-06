/**
 * Editor languages: English, Korean, Japanese.
 *
 *   import { t, useT } from '../i18n/index.js';
 *   const t = useT();                      // in a component: re-renders when the language changes
 *   t('toolbar.undo')                      // "Undo" / "실행 취소" / "取り消す"
 *   t('problems.summary', { errors: 2 })   // "{errors} {errors|error|errors}" -> "2 errors"
 *
 * - One flat, typed dictionary per language (locales/en.ts is the source of the keys; ko.ts and
 *   ja.ts must define every key, checked by the compiler and by test/editor-i18n.test.ts).
 * - Message syntax: `{name}` inserts a variable; `{name|one|other}` picks a word by whether the
 *   variable is 1 (English plurals; Korean and Japanese messages simply do not use it).
 * - Code outside React (the session's toasts, pure helpers) calls the module-level `t`, which reads
 *   the current language. Without a browser (unit tests) the language is English.
 * - Model ids, file names and the diagnostics written by the Rev2D core are never translated.
 *
 * Adding a string: add the key to the right namespace file under locales/en/, then to the same file
 * under locales/ko/ and locales/ja/ (the build fails until all three have it).
 */
import { useSyncExternalStore } from 'react';
import { setDesignStrings } from '../design/strings.js';
import { en } from './locales/en.js';
import { ja } from './locales/ja.js';
import { ko } from './locales/ko.js';

export type Language = 'en' | 'ko' | 'ja';
export type MessageKey = keyof typeof en;
export type MessageVars = Record<string, string | number>;
export type Dictionary = Record<MessageKey, string>;
export type Translate = (key: MessageKey, vars?: MessageVars) => string;

/** The languages of the editor with their own names (shown untranslated in the language menu). */
export const LANGUAGES: ReadonlyArray<{ id: Language; name: string; tag: string }> = [
  { id: 'en', name: 'English', tag: 'en' },
  { id: 'ko', name: '한국어', tag: 'ko' },
  { id: 'ja', name: '日本語', tag: 'ja' },
];

export const DICTIONARIES: Record<Language, Dictionary> = { en, ko, ja };
export const LANGUAGE_STORAGE_KEY = 'rev2d.language';

let current: Language = 'en';
const listeners = new Set<() => void>();

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ko' || value === 'ja';
}

/** `{name}` -> the variable; `{name|one|other}` -> `one` when the variable is 1, else `other`. */
export function formatMessage(message: string, vars: MessageVars = {}): string {
  return message.replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, (whole, name: string, one: string | undefined, other: string | undefined) => {
    const value = vars[name];
    if (one !== undefined && other !== undefined) return Number(value) === 1 ? one : other;
    return value === undefined ? whole : String(value);
  });
}

/** The message of `key` in `language` (English when a dictionary lacks it; the key itself as a last resort). */
export function translate(language: Language, key: MessageKey, vars?: MessageVars): string {
  const message = DICTIONARIES[language][key] ?? en[key] ?? key;
  return vars ? formatMessage(message, vars) : message.includes('{') ? formatMessage(message) : message;
}

/** Translate in the current language. */
export const t: Translate = (key, vars) => translate(current, key, vars);

/** One stable function per language, so that hooks depending on it re-run when the language changes. */
const TRANSLATORS: Record<Language, Translate> = {
  en: (key, vars) => translate('en', key, vars),
  ko: (key, vars) => translate('ko', key, vars),
  ja: (key, vars) => translate('ja', key, vars),
};

export function getLanguage(): Language {
  return current;
}

/** BCP 47 tag of the current language, for Intl and toLocale*String. */
export function languageTag(): string {
  return current;
}

/** The first supported language among browser language tags ("ko-KR" -> ko), else English. */
export function detectLanguage(candidates: readonly string[]): Language {
  for (const tag of candidates) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLanguage(base)) return base;
  }
  return 'en';
}

function applyToDocument(language: Language): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  setDesignStrings({
    clear: translate(language, 'design.clear'),
    dismiss: translate(language, 'design.dismiss'),
    expand: translate(language, 'design.expand'),
    collapse: translate(language, 'design.collapse'),
    search: translate(language, 'design.search'),
    select: translate(language, 'design.select'),
    inProgress: translate(language, 'design.inProgress'),
    dragToChange: translate(language, 'design.dragToChange'),
    notifications: translate(language, 'design.notifications'),
    resize: (pane) => translate(language, 'design.resize', { pane }),
  });
}

/** Switch the language (remembered per browser unless `persist` is false). */
export function setLanguage(language: Language, persist = true): void {
  if (persist) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Private mode or blocked storage: the choice lasts for this page only.
    }
  }
  if (language === current) return;
  current = language;
  applyToDocument(language);
  for (const l of [...listeners]) l();
}

/**
 * Pick the language when the page starts: `?lang=` (screenshots, tests), else the remembered choice,
 * else the browser's languages. Returns the language in effect.
 */
export function initLanguage(): Language {
  let chosen: Language | null = null;
  try {
    const query = new URLSearchParams(location.search).get('lang');
    if (isLanguage(query)) chosen = query;
    else {
      const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (isLanguage(stored)) chosen = stored;
    }
  } catch {
    // No location / storage: fall through to the browser's languages.
  }
  chosen ??= detectLanguage(typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']) : []);
  current = chosen;
  applyToDocument(chosen);
  for (const l of [...listeners]) l();
  return chosen;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current language; the component re-renders when it changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** `t` for a component: subscribes to language changes. */
export function useT(): Translate {
  return TRANSLATORS[useLanguage()];
}
