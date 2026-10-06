/**
 * The editor's languages (editor/src/i18n): the three dictionaries are complete and consistent, the
 * message syntax works, and the language is English wherever there is no browser (so the unit tests
 * of the session and the file helpers keep reading English).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { designStrings } from '../editor/src/design/strings.js';
import { DICTIONARIES, LANGUAGES, detectLanguage, formatMessage, getLanguage, isLanguage, setLanguage, t, translate, type MessageKey } from '../editor/src/i18n/index.js';
import { fileNameProblem, formatWhen } from '../editor/src/files/paths.js';

const { en, ko, ja } = DICTIONARIES;
const keys = Object.keys(en) as MessageKey[];

/** `{name}` and `{name|one|other}` placeholders of a message: the variable names. */
function variables(message: string): string[] {
  return [...message.matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)].map((m) => m[1]!).sort();
}

afterEach(() => setLanguage('en', false));

describe('editor i18n: dictionaries', () => {
  it('has the same keys in English, Korean and Japanese, none empty', () => {
    expect(keys.length).toBeGreaterThan(400);
    for (const [name, dict] of [['ko', ko], ['ja', ja]] as const) {
      expect(Object.keys(dict).sort(), name).toEqual([...keys].sort());
      expect(keys.filter((k) => dict[k].trim() === ''), `${name}: empty messages`).toEqual([]);
    }
    expect(keys.filter((k) => en[k].trim() === '')).toEqual([]);
  });

  it('uses only the variables of the English message in the translations', () => {
    const extra: string[] = [];
    for (const [name, dict] of [['ko', ko], ['ja', ja]] as const) {
      for (const k of keys) {
        const allowed = new Set(variables(en[k]));
        for (const v of variables(dict[k])) if (!allowed.has(v)) extra.push(`${name} ${k}: {${v}}`);
      }
    }
    expect(extra).toEqual([]);
  });

  it('is actually translated: Korean has Hangul, Japanese has kana or kanji', () => {
    // Messages that are the same in every language: product and format names, command names of the
    // AI bridge, pure variables.
    const same = (k: MessageKey): boolean => !/[A-Za-z]{3,}/.test(en[k].replace(/\{[^}]*\}/g, '').replace(/\b(AI|JSON|IK|Spine|Live2D|Rev2D|PNG|fps|px|OK|setAnimations)\b/g, ''));
    const untranslated = (dict: Record<MessageKey, string>, script: RegExp): MessageKey[] => keys.filter((k) => !same(k) && !script.test(dict[k]));
    expect(untranslated(ko, /[가-힣]/)).toEqual([]);
    expect(untranslated(ja, /[぀-ヿ一-鿿]/)).toEqual([]);
  });

  it('keeps Korean free of particles that depend on the final consonant of a variable', () => {
    // "{name}을" / "{name}은" ... read wrongly for half of all names; "{name}을(를)" spells both.
    const risky = keys.filter((k) => /\}(을|를|은|는|이|가|와|과|으로)(?![가-힣(])/.test(ko[k]));
    expect(risky).toEqual([]);
  });
});

describe('editor i18n: messages', () => {
  it('inserts variables and picks plural forms', () => {
    expect(formatMessage('Opened {path}', { path: 'a/b.json' })).toBe('Opened a/b.json');
    expect(formatMessage('{n} {n|error|errors}', { n: 1 })).toBe('1 error');
    expect(formatMessage('{n} {n|error|errors}', { n: 3 })).toBe('3 errors');
    expect(formatMessage('{n} {n|error|errors}', { n: 0 })).toBe('0 errors');
    // An unknown variable stays visible; text that only looks like a placeholder is left alone.
    expect(formatMessage('Hello {who}', {})).toBe('Hello {who}');
    expect(formatMessage('need [x, y, w, h] and "a|b"', {})).toBe('need [x, y, w, h] and "a|b"');
    // A value is inserted as it is, braces included.
    expect(formatMessage('bad viewBox {value}', { value: '{"a":1}' })).toBe('bad viewBox {"a":1}');
  });

  it('translates in English by default and in the language set', () => {
    expect(getLanguage()).toBe('en');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('session.write.rejected', { n: 2 })).toBe('Not saved: the server rejected the model (2 errors).');
    setLanguage('ko', false);
    expect(t('common.cancel')).toBe('취소');
    expect(designStrings.search).toBe('검색');
    expect(designStrings.resize('타임라인')).toBe('타임라인 크기 조절');
    setLanguage('ja', false);
    expect(t('common.cancel')).toBe('キャンセル');
    expect(translate('en', 'common.cancel')).toBe('Cancel');
    setLanguage('en', false);
    expect(designStrings.search).toBe('Search');
  });

  it('localizes the pure file helpers through the current language', () => {
    expect(fileNameProblem('')).toMatch(/Enter a file name/);
    const now = new Date(2026, 8, 26, 12, 0).getTime();
    expect(formatWhen(now - 10_000, now)).toBe('just now');
    setLanguage('ko', false);
    expect(fileNameProblem('')).toMatch(/[가-힣]/);
    expect(formatWhen(now - 10_000, now)).toMatch(/[가-힣]/);
  });

  it('picks the language from browser language tags', () => {
    expect(detectLanguage(['ko-KR', 'en-US'])).toBe('ko');
    expect(detectLanguage(['ja'])).toBe('ja');
    expect(detectLanguage(['fr-FR', 'ja-JP'])).toBe('ja');
    expect(detectLanguage(['de', 'fr'])).toBe('en');
    expect(detectLanguage([])).toBe('en');
    expect(LANGUAGES.map((l) => l.id)).toEqual(['en', 'ko', 'ja']);
    expect(isLanguage('ko')).toBe(true);
    expect(isLanguage('zh')).toBe(false);
  });
});
