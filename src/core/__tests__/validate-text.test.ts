import { describe, expect, it } from 'vitest';
import { levenshtein } from '../address.js';
import { didYouMean } from '../validate/text.js';

/** Full edit-distance oracle, without the bounded search's early exits. */
function reference(got: string, options: readonly string[]): string | null {
  let best: string | null = null;
  let distance = Infinity;
  for (const option of options) {
    const longest = Math.max(got.length, option.length);
    const limit = Math.min(Math.max(2, Math.floor(longest / 3)), longest - 1);
    const d = levenshtein(got.toLowerCase(), option.toLowerCase());
    if (d <= limit && d < distance) {
      best = option;
      distance = d;
    }
  }
  return best === null ? null : `did you mean ${JSON.stringify(best)}?`;
}

describe('bounded diagnostic suggestions', () => {
  it('agrees with full edit distance across short strings and candidate orders', () => {
    const words = [''];
    let level = [''];
    for (let length = 1; length <= 4; length++) {
      level = level.flatMap((prefix) => ['a', 'b', '_'].map((c) => prefix + c));
      words.push(...level);
    }
    for (const got of words) {
      for (let i = 0; i < words.length; i++) {
        const options = [words[i], words[(i + 1) % words.length], words[(i + 7) % words.length]];
        expect(didYouMean(got, options)).toBe(reference(got, options));
      }
    }
  });

  it('preserves case handling, repeated characters, Unicode and long ids', () => {
    const cases: [string, string[]][] = [
      ['aaaaab', ['bbbbba', 'aaabb', 'aaaabb']],
      ['missing1999', ['bone1999', 'missing1998']],
      ['HÉAD😀', ['héAd😃', 'héAd😀']],
      ['x'.repeat(80) + 'a', ['x'.repeat(80) + 'b', 'z'.repeat(81)]],
      ['xyz', ['abc', 'abcd', '']],
    ];
    for (const [got, options] of cases) expect(didYouMean(got, options)).toBe(reference(got, options));
  });

  it('keeps the first candidate on a tie', () => {
    expect(didYouMean('hed', ['head', 'hid'])).toBe('did you mean "head"?');
    expect(didYouMean('hed', ['hid', 'head'])).toBe('did you mean "hid"?');
  });
});
