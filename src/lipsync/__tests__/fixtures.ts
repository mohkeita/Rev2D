/** Synthetic audio for the lip-sync tests: signals and a small WAV writer (no audio files in the repo). */

export interface WavSpec {
  sampleRate: number;
  /** One Float32Array or number[] per channel, all of the same length, values -1..1. */
  channels: ArrayLike<number>[];
  bits: 8 | 16 | 24 | 32 | 64;
  /** IEEE float samples (format tag 3) instead of integers (tag 1). */
  float?: boolean;
  /** Write a WAVE_FORMAT_EXTENSIBLE header (format tag 0xfffe with the real tag in the sub-format). */
  extensible?: boolean;
  /** Override the format tag (e.g. 6 = A-law) to build files the decoder must refuse. */
  formatTag?: number;
  /** Chunks written between "fmt " and "data" (odd lengths get their pad byte). */
  extraChunks?: Array<{ id: string; data: Uint8Array }>;
  /** Override the length field of the data chunk (streamed files write 0 or 0xffffffff). */
  dataLength?: number;
}

function chunk(id: string, data: Uint8Array, length = data.length): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, length, true);
  out.set(data, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Encode little-endian RIFF / WAVE bytes. Integer samples are scaled like every encoder does (x * 2^(bits-1), clamped). */
export function encodeWav(spec: WavSpec): Uint8Array {
  const { sampleRate, channels, bits } = spec;
  const count = channels.length;
  const frames = count > 0 ? channels[0].length : 0;
  const width = bits / 8;
  const tag = spec.formatTag ?? (spec.float ? 3 : 1);

  const fmt = new Uint8Array(spec.extensible ? 40 : 16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, spec.extensible ? 0xfffe : tag, true);
  f.setUint16(2, count, true);
  f.setUint32(4, sampleRate, true);
  f.setUint32(8, sampleRate * count * width, true);
  f.setUint16(12, count * width, true);
  f.setUint16(14, bits, true);
  if (spec.extensible) {
    f.setUint16(16, 22, true); // cbSize
    f.setUint16(18, bits, true); // valid bits
    f.setUint32(20, 0, true); // channel mask
    f.setUint16(24, tag, true); // sub-format GUID: the tag, then the fixed tail
    fmt.set([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 26);
  }

  const data = new Uint8Array(frames * count * width);
  const d = new DataView(data.buffer);
  const full = 2 ** (bits - 1);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const x = channels[c][i];
      const at = (i * count + c) * width;
      if (spec.float) {
        if (bits === 64) d.setFloat64(at, x, true);
        else d.setFloat32(at, x, true);
        continue;
      }
      const v = Math.max(-full, Math.min(full - 1, Math.round(x * full)));
      if (bits === 8) d.setUint8(at, v + 128);
      else if (bits === 16) d.setInt16(at, v, true);
      else if (bits === 24) {
        d.setUint8(at, v & 0xff);
        d.setUint8(at + 1, (v >> 8) & 0xff);
        d.setUint8(at + 2, (v >> 16) & 0xff);
      } else d.setInt32(at, v, true);
    }
  }

  const body = concat([
    Uint8Array.from('WAVE', (ch) => ch.charCodeAt(0)),
    chunk('fmt ', fmt),
    ...(spec.extraChunks ?? []).map((c) => chunk(c.id, c.data)),
    chunk('data', data, spec.dataLength),
  ]);
  return chunk('RIFF', body);
}

/** A sine tone. */
export function tone(sampleRate: number, seconds: number, amplitude: number, frequency = 220): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return out;
}

export function silence(sampleRate: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(sampleRate * seconds));
}

/** Deterministic white noise (a small LCG; Math.random would make the tests flaky). */
export function noise(sampleRate: number, seconds: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds));
  let state = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = amplitude * (state / 0x80000000 - 1);
  }
  return out;
}

export function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Sample-wise sum of signals of the same length. */
export function mix(a: Float32Array, b: Float32Array): Float32Array {
  return a.map((v, i) => v + b[i]);
}
