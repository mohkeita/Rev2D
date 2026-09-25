import { describe, expect, it } from 'vitest';
import { formatModelJson } from '../format.js';

describe('formatModelJson', () => {
  it('keeps primitive arrays inline and objects multiline', () => {
    const s = formatModelJson({ a: [1, 2, 3], b: { type: 'ellipse', cx: 1.123456789, cy: -0 }, list: [{ t: 0, v: 1 }] });
    expect(s).toBe(
      '{\n  "a": [1, 2, 3],\n  "b": { "type": "ellipse", "cx": 1.1235, "cy": 0 },\n  "list": [\n    { "t": 0, "v": 1 }\n  ]\n}\n',
    );
    expect(JSON.parse(s)).toBeTruthy();
  });
  it('wraps long point lists keeping pairs', () => {
    const pts = Array.from({ length: 60 }, (_, i) => i * 10.5);
    const s = formatModelJson({ points: pts }, { width: 60 });
    for (const line of s.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    expect(JSON.parse(s).points).toEqual(pts);
  });
});
