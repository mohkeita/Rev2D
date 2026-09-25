import type { RGBA } from './types.js';

const NAMED: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  pink: '#ffc0cb',
  purple: '#800080',
  brown: '#a52a2a',
  navy: '#000080',
  teal: '#008080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
};

/** Parse a color string into straight RGBA 0..1. Returns null when invalid. */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  const named = NAMED[s];
  if (named) return parseColor(named);
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const v = [...hex].map((ch) => parseInt(ch + ch, 16) / 255);
      return [v[0], v[1], v[2], hex.length === 4 ? v[3] : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const v: number[] = [];
      for (let i = 0; i < hex.length; i += 2) v.push(parseInt(hex.slice(i, i + 2), 16) / 255);
      return [v[0], v[1], v[2], hex.length === 8 ? v[3] : 1];
    }
    return null;
  }
  const m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const nums = parts.map((p, i) => {
      if (p.endsWith('%')) return (parseFloat(p) / 100) * (i < 3 ? 255 : 1);
      return parseFloat(p);
    });
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return [
      clamp01(nums[0] / 255),
      clamp01(nums[1] / 255),
      clamp01(nums[2] / 255),
      nums.length === 4 ? clamp01(nums[3]) : 1,
    ];
  }
  return null;
}

/** Like parseColor but throws a descriptive error. */
export function color(input: string): RGBA {
  const c = parseColor(input);
  if (!c) throw new Error(`invalid color "${input}"`);
  return c;
}

export function formatColor(c: RGBA): string {
  const h = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0');
  const base = `#${h(c[0])}${h(c[1])}${h(c[2])}`;
  return c[3] >= 0.999 ? base : base + h(c[3]);
}

export function mixColor(a: RGBA, b: RGBA, t: number): RGBA {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

export function mulColor(a: RGBA, b: RGBA): RGBA {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
