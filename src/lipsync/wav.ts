/**
 * WAV (RIFF) decoding for volume lip sync: linear PCM in the integer and float layouts every tool
 * writes. Pure (a DataView over the bytes), so it also runs in the browser.
 */
import type { WavAudio } from './types.js';

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const FORMAT_NAMES: Record<number, string> = {
  2: 'Microsoft ADPCM',
  6: 'A-law',
  7: 'mu-law',
  17: 'IMA ADPCM',
  49: 'GSM 6.10',
  80: 'MPEG',
  85: 'MP3',
  255: 'AAC',
};

const SUPPORTED = 'PCM 8 / 16 / 24 / 32-bit integer and 32-bit float';
const CONVERT_HINT = 'convert it to 16-bit PCM first, e.g. ffmpeg -i in.wav -c:a pcm_s16le out.wav';

function fail(message: string): never {
  throw new Error(`decodeWav: ${message}`);
}

/** Decode PCM WAV (8 / 16 / 24 / 32-bit integer or 32-bit float). Throws a descriptive error for other formats. */
export function decodeWav(bytes: Uint8Array): WavAudio {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodeWav: expected the file contents as a Uint8Array');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.byteLength;
  const tag = (at: number): string => (at + 4 <= size ? String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]) : '');

  const riff = tag(0);
  if (riff === 'RF64' || riff === 'BW64') fail(`${riff} files (64-bit WAV) are not supported; ${CONVERT_HINT}`);
  if (riff === 'RIFX') fail(`big-endian WAV (RIFX) is not supported; ${CONVERT_HINT}`);
  if (size < 12 || riff !== 'RIFF' || tag(8) !== 'WAVE') fail('not a WAV file (it does not start with a RIFF / WAVE header)');

  let format: { tag: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | undefined;
  let data: { start: number; length: number } | undefined;
  let pos = 12;
  while (pos + 8 <= size && !(format && data)) {
    const id = tag(pos);
    const length = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (length < 16 || body + 16 > size) fail('the "fmt " chunk is too short');
      let formatTag = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first field of the sub-format GUID.
      if (formatTag === FORMAT_EXTENSIBLE && length >= 26 && body + 26 <= size) formatTag = view.getUint16(body + 24, true);
      format = {
        tag: formatTag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // Streamed files leave the length at 0 or 0xffffffff: take what is there.
      const available = size - body;
      data = { start: body, length: length === 0 || length > available ? available : length };
    }
    pos = body + length + (length & 1);
  }
  if (!format) fail('no "fmt " chunk found (the file is truncated or not a WAV file)');
  if (!data) fail('no "data" chunk found (the file has no audio samples)');

  const { channels, sampleRate, bits } = format;
  if (format.tag !== FORMAT_PCM && format.tag !== FORMAT_FLOAT) {
    const name = FORMAT_NAMES[format.tag];
    fail(`unsupported WAV encoding: ${name ? `${name} (format tag ${format.tag})` : `format tag ${format.tag}`}. Supported: ${SUPPORTED}; ${CONVERT_HINT}`);
  }
  if (channels < 1) fail('the header says 0 channels');
  if (sampleRate < 1) fail('the header says a sample rate of 0 Hz');
  const float = format.tag === FORMAT_FLOAT;
  if (float ? bits !== 32 : bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) {
    fail(`unsupported sample size: ${bits}-bit ${float ? 'float' : 'integer'}. Supported: ${SUPPORTED}; ${CONVERT_HINT}`);
  }

  const width = bits / 8;
  // blockAlign is the frame size; fall back to the packed size when a writer left it inconsistent.
  const stride = format.blockAlign >= width * channels ? format.blockAlign : width * channels;
  const frames = Math.floor(data.length / stride);
  const samples = new Float32Array(frames);
  const read = sampleReader(view, float, bits);
  for (let f = 0; f < frames; f++) {
    const at = data.start + f * stride;
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(at + c * width);
    const v = sum / channels;
    samples[f] = v !== v ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
  }
  return { sampleRate, channels, samples };
}

/** Reader of one little-endian sample at a byte offset, scaled to -1..1. */
function sampleReader(view: DataView, float: boolean, bits: number): (at: number) => number {
  if (float) return (at) => view.getFloat32(at, true);
  switch (bits) {
    case 8:
      return (at) => (view.getUint8(at) - 128) / 128; // 8-bit WAV is unsigned
    case 16:
      return (at) => view.getInt16(at, true) / 32768;
    case 24:
      return (at) => ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608);
    default:
      return (at) => view.getInt32(at, true) / 2147483648;
  }
}
