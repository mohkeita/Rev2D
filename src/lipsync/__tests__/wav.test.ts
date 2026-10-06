import { describe, expect, it } from 'vitest';
import { decodeWav } from '../index.js';
import { encodeWav, tone } from './fixtures.js';

/** A short test signal that uses the whole range, both signs and the extremes. */
const SIGNAL = [0, 0.25, -0.25, 0.5, -0.5, 0.999, -1, 0.1, -0.7, 0.33];

function expectSamples(actual: Float32Array, expected: ArrayLike<number>, tolerance: number): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(Math.abs(actual[i] - expected[i]), `sample ${i}: ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(tolerance);
}

describe('decodeWav: PCM layouts', () => {
  it('16-bit mono', () => {
    const audio = decodeWav(encodeWav({ sampleRate: 22050, channels: [SIGNAL], bits: 16 }));
    expect(audio.sampleRate).toBe(22050);
    expect(audio.channels).toBe(1);
    expect(audio.samples).toBeInstanceOf(Float32Array);
    expectSamples(audio.samples, SIGNAL, 1 / 32768);
    // Full scale: -1 is exact, +1 clips one step below.
    expect(audio.samples[6]).toBe(-1);
  });

  it('8-bit is unsigned', () => {
    const bytes = encodeWav({ sampleRate: 8000, channels: [SIGNAL], bits: 8 });
    const audio = decodeWav(bytes);
    expectSamples(audio.samples, SIGNAL, 1 / 128);
    // Silence is the byte 128, not 0.
    const quiet = decodeWav(encodeWav({ sampleRate: 8000, channels: [[0, 0, 0]], bits: 8 }));
    expect(Array.from(quiet.samples)).toEqual([0, 0, 0]);
    expect(bytes[bytes.length - SIGNAL.length]).toBe(128);
  });

  it('24-bit keeps the sign', () => {
    const audio = decodeWav(encodeWav({ sampleRate: 48000, channels: [SIGNAL], bits: 24 }));
    expectSamples(audio.samples, SIGNAL, 1 / 8388608 + 1e-7);
    expect(audio.samples[2]).toBeLessThan(0);
    expect(audio.samples[6]).toBe(-1);
  });

  it('32-bit integer', () => {
    const audio = decodeWav(encodeWav({ sampleRate: 44100, channels: [SIGNAL], bits: 32 }));
    expectSamples(audio.samples, SIGNAL, 1e-6);
  });

  it('32-bit float', () => {
    const audio = decodeWav(encodeWav({ sampleRate: 44100, channels: [SIGNAL], bits: 32, float: true }));
    expect(Array.from(audio.samples)).toEqual(Array.from(new Float32Array(SIGNAL)));
  });

  it('float samples outside -1..1 are clamped and NaN is silence', () => {
    const audio = decodeWav(encodeWav({ sampleRate: 44100, channels: [[1.5, -3, Number.NaN, 0.5]], bits: 32, float: true }));
    expect(Array.from(audio.samples)).toEqual([1, -1, 0, 0.5]);
  });

  it('every layout decodes the same tone', () => {
    const signal = tone(8000, 0.05, 0.8, 440);
    const reference = decodeWav(encodeWav({ sampleRate: 8000, channels: [signal], bits: 32, float: true })).samples;
    for (const [bits, tolerance] of [[8, 1 / 128], [16, 1 / 32768], [24, 1e-6], [32, 1e-6]] as const) {
      expectSamples(decodeWav(encodeWav({ sampleRate: 8000, channels: [signal], bits })).samples, reference, tolerance);
    }
  });
});

describe('decodeWav: channels', () => {
  it('stereo is mixed down to mono', () => {
    const left = [0.5, 1, 0.2, -0.4];
    const right = [-0.5, 0, 0.2, -0.8];
    const audio = decodeWav(encodeWav({ sampleRate: 44100, channels: [left, right], bits: 16 }));
    expect(audio.channels).toBe(2);
    expectSamples(audio.samples, [0, 0.5, 0.2, -0.6], 1 / 32768);
  });

  it('any number of channels is averaged', () => {
    const channels = [[0.6, 0], [0.3, 0], [0, 0.9], [-0.3, 0], [0, 0], [0, 0]];
    const audio = decodeWav(encodeWav({ sampleRate: 48000, channels, bits: 24 }));
    expect(audio.channels).toBe(6);
    expectSamples(audio.samples, [0.1, 0.15], 1e-6);
    const float = decodeWav(encodeWav({ sampleRate: 48000, channels, bits: 32, float: true }));
    expectSamples(float.samples, [0.1, 0.15], 1e-6);
  });
});

describe('decodeWav: container details', () => {
  it('reads WAVE_FORMAT_EXTENSIBLE headers', () => {
    const pcm = decodeWav(encodeWav({ sampleRate: 48000, channels: [SIGNAL, SIGNAL], bits: 24, extensible: true }));
    expect(pcm.channels).toBe(2);
    expectSamples(pcm.samples, SIGNAL, 1e-6);
    const float = decodeWav(encodeWav({ sampleRate: 48000, channels: [SIGNAL], bits: 32, float: true, extensible: true }));
    expectSamples(float.samples, SIGNAL, 1e-7);
  });

  it('skips other chunks, including odd-sized ones with their pad byte', () => {
    const text = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
    const audio = decodeWav(
      encodeWav({
        sampleRate: 16000,
        channels: [SIGNAL],
        bits: 16,
        extraChunks: [
          { id: 'LIST', data: text('INFOISFT\u0005\u0000\u0000\u0000Rev2D') }, // 17 bytes: odd
          { id: 'fact', data: new Uint8Array([10, 0, 0, 0]) },
          { id: 'junk', data: new Uint8Array(3) },
        ],
      }),
    );
    expect(audio.sampleRate).toBe(16000);
    expectSamples(audio.samples, SIGNAL, 1 / 32768);
  });

  it('takes what is there when the data length is 0, 0xffffffff or past the end (streamed files)', () => {
    for (const dataLength of [0, 0xffffffff, 1_000_000]) {
      const audio = decodeWav(encodeWav({ sampleRate: 16000, channels: [SIGNAL], bits: 16, dataLength }));
      expectSamples(audio.samples, SIGNAL, 1 / 32768);
    }
  });

  it('ignores a trailing partial frame', () => {
    const bytes = encodeWav({ sampleRate: 16000, channels: [SIGNAL, SIGNAL], bits: 16 });
    const audio = decodeWav(bytes.subarray(0, bytes.length - 3));
    expect(audio.samples.length).toBe(SIGNAL.length - 1);
  });

  it('works on a view into a larger buffer', () => {
    const bytes = encodeWav({ sampleRate: 16000, channels: [SIGNAL], bits: 16 });
    const padded = new Uint8Array(bytes.length + 64).fill(0xee);
    padded.set(bytes, 32);
    const audio = decodeWav(padded.subarray(32, 32 + bytes.length));
    expectSamples(audio.samples, SIGNAL, 1 / 32768);
  });

  it('an empty data chunk is zero samples', () => {
    const audio = decodeWav(encodeWav({ sampleRate: 16000, channels: [[]], bits: 16 }));
    expect(audio).toEqual({ sampleRate: 16000, channels: 1, samples: new Float32Array(0) });
  });
});

describe('decodeWav: errors', () => {
  const ok = encodeWav({ sampleRate: 16000, channels: [SIGNAL], bits: 16 });

  it('rejects data that is not a WAV file', () => {
    expect(() => decodeWav(new Uint8Array(0))).toThrow(/decodeWav: not a WAV file/);
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toThrow(/not a WAV file/);
    expect(() => decodeWav(Uint8Array.from('ID3 this is an mp3 file', (ch) => ch.charCodeAt(0)))).toThrow(/not a WAV file/);
    const avi = ok.slice();
    avi.set([0x41, 0x56, 0x49, 0x20], 8); // RIFF .... "AVI "
    expect(() => decodeWav(avi)).toThrow(/not a WAV file/);
    expect(() => decodeWav('RIFF' as unknown as Uint8Array)).toThrow(TypeError);
  });

  it('names compressed encodings and says how to convert them', () => {
    const alaw = encodeWav({ sampleRate: 8000, channels: [SIGNAL], bits: 8, formatTag: 6 });
    expect(() => decodeWav(alaw)).toThrow(/unsupported WAV encoding: A-law \(format tag 6\)\. Supported: PCM 8 \/ 16 \/ 24 \/ 32-bit integer and 32-bit float; .*ffmpeg/);
    expect(() => decodeWav(encodeWav({ sampleRate: 8000, channels: [SIGNAL], bits: 8, formatTag: 7 }))).toThrow(/mu-law/);
    expect(() => decodeWav(encodeWav({ sampleRate: 44100, channels: [SIGNAL], bits: 16, formatTag: 85 }))).toThrow(/MP3 \(format tag 85\)/);
    expect(() => decodeWav(encodeWav({ sampleRate: 44100, channels: [SIGNAL], bits: 16, formatTag: 1234 }))).toThrow(/unsupported WAV encoding: format tag 1234\./);
    // An extensible header that wraps a compressed format is refused as well.
    expect(() => decodeWav(encodeWav({ sampleRate: 8000, channels: [SIGNAL], bits: 8, formatTag: 7, extensible: true }))).toThrow(/mu-law/);
  });

  it('rejects sample sizes it cannot read', () => {
    expect(() => decodeWav(encodeWav({ sampleRate: 44100, channels: [SIGNAL], bits: 64, float: true }))).toThrow(/unsupported sample size: 64-bit float/);
    const twelve = ok.slice();
    new DataView(twelve.buffer).setUint16(34, 12, true); // bits per sample
    expect(() => decodeWav(twelve)).toThrow(/unsupported sample size: 12-bit integer/);
    const halfFloat = encodeWav({ sampleRate: 44100, channels: [SIGNAL], bits: 32, float: true });
    new DataView(halfFloat.buffer).setUint16(34, 16, true);
    expect(() => decodeWav(halfFloat)).toThrow(/unsupported sample size: 16-bit float/);
  });

  it('rejects broken headers', () => {
    const noChannels = ok.slice();
    new DataView(noChannels.buffer).setUint16(22, 0, true);
    expect(() => decodeWav(noChannels)).toThrow(/0 channels/);
    const noRate = ok.slice();
    new DataView(noRate.buffer).setUint32(24, 0, true);
    expect(() => decodeWav(noRate)).toThrow(/sample rate of 0 Hz/);
    // Only the RIFF header and the format chunk: no samples.
    expect(() => decodeWav(ok.subarray(0, 36))).toThrow(/no "data" chunk/);
    // The data chunk without a format chunk before or after it.
    const noFmt = ok.slice();
    noFmt.set([0x6a, 0x75, 0x6e, 0x6b], 12); // "fmt " -> "junk"
    expect(() => decodeWav(noFmt)).toThrow(/no "fmt " chunk/);
    expect(() => decodeWav(ok.subarray(0, 24))).toThrow(/"fmt " chunk is too short/);
  });

  it('says so for 64-bit and big-endian containers', () => {
    const rf64 = ok.slice();
    rf64.set([0x52, 0x46, 0x36, 0x34], 0);
    expect(() => decodeWav(rf64)).toThrow(/RF64 files \(64-bit WAV\) are not supported/);
    const rifx = ok.slice();
    rifx.set([0x52, 0x49, 0x46, 0x58], 0);
    expect(() => decodeWav(rifx)).toThrow(/big-endian WAV \(RIFX\) is not supported/);
  });
});
