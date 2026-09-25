/**
 * Lenient JSON reader for model files (JSONC): standard JSON plus `//` and `/* *\/` comments and
 * trailing commas. A syntax error becomes one 'json-syntax' diagnostic with line:column, the JSON
 * pointer of the enclosing value and a caret excerpt; duplicate keys become warnings.
 */
import type { Diagnostic } from '../types.js';
import { DiagnosticSink, toPointer } from './diagnostics.js';
import { q } from './text.js';

export type JsoncResult = { ok: true; value: unknown; warnings: Diagnostic[] } | { ok: false; error: Diagnostic };

export function parseJsonc(text: string): JsoncResult {
  const parser = new Parser(text);
  try {
    const value = parser.parseDocument();
    return { ok: true, value, warnings: parser.warnings.items };
  } catch (e) {
    if (!(e instanceof JsoncSyntaxError)) throw e;
    const { line, column } = lineColumn(text, e.offset);
    return {
      ok: false,
      error: {
        severity: 'error',
        code: 'json-syntax',
        message: `line ${line}, column ${column}: ${e.message}`,
        path: e.pointer,
        hint: excerpt(text, e.offset),
      },
    };
  }
}

class JsoncSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly pointer: string,
  ) {
    super(message);
  }
}

/** Deeper documents are rejected instead of overflowing the (recursive) parser's stack. */
const MAX_DEPTH = 512;

const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const NUMBER_LIKE = /[-+\w.]+/y;

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

const BAD_WORDS: Record<string, string> = {
  True: 'use lowercase true',
  False: 'use lowercase false',
  None: 'use null (or omit the field)',
  undefined: 'undefined is not JSON; use null or omit the field',
  NaN: 'NaN is not valid JSON; use a finite number',
  Infinity: 'Infinity is not valid JSON; use a finite number',
};

class Parser {
  private pos = 0;
  /** Keys / indices of the containers being parsed; its length is the nesting depth. */
  private readonly path: PropertyKey[] = [];
  readonly warnings = new DiagnosticSink();

  constructor(private readonly text: string) {}

  parseDocument(): unknown {
    this.skip();
    if (this.pos >= this.text.length) this.fail('the document is empty (expected a JSON object)');
    const value = this.parseValue();
    this.skip();
    if (this.pos < this.text.length) this.fail(`unexpected ${this.describeAt(this.pos)} after the end of the document`);
    return value;
  }

  private fail(message: string, offset = this.pos): never {
    throw new JsoncSyntaxError(message, offset, toPointer(this.path));
  }

  private failUnclosed(kind: 'object' | 'array', start: number): never {
    const { line, column } = lineColumn(this.text, start);
    this.fail(`unexpected end of input: the ${kind} opened at line ${line}, column ${column} is never closed`, this.text.length);
  }

  private describeAt(offset: number): string {
    const c = this.text[offset];
    return c === undefined ? 'end of input' : q(c);
  }

  /** Skip whitespace and comments. */
  private skip(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++;
      } else if (c === '/' && t[this.pos + 1] === '/') {
        this.pos = lineEnd(t, this.pos + 2);
      } else if (c === '/' && t[this.pos + 1] === '*') {
        const end = t.indexOf('*/', this.pos + 2);
        if (end < 0) this.fail('unterminated /* comment');
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  private parseValue(): unknown {
    const c = this.text[this.pos];
    if (c === '{' || c === '[') {
      if (this.path.length >= MAX_DEPTH) this.fail(`nesting is too deep (more than ${MAX_DEPTH} levels)`);
      return c === '{' ? this.parseObject() : this.parseArray();
    }
    if (c === '"') return this.parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    if (c === undefined) this.fail('unexpected end of input (expected a value)');
    if (c === "'") this.fail('strings must use double quotes ("...")');
    if (c === '+') this.fail('numbers cannot start with "+"');
    if (c === '.') this.fail('numbers need a leading digit (e.g. 0.5)');
    WORD.lastIndex = this.pos;
    const word = WORD.exec(this.text)?.[0];
    if (word === 'true' || word === 'false' || word === 'null') {
      this.pos += word.length;
      return word === 'null' ? null : word === 'true';
    }
    if (word !== undefined) this.fail(Object.hasOwn(BAD_WORDS, word) ? BAD_WORDS[word] : `unexpected word ${q(word)} (strings must be double-quoted)`);
    this.fail(`unexpected ${this.describeAt(this.pos)} (expected a value)`);
  }

  private parseObject(): Record<string, unknown> {
    const t = this.text;
    const start = this.pos++;
    const obj: Record<string, unknown> = {};
    for (;;) {
      this.skip();
      const c = t[this.pos];
      if (c === '}') {
        this.pos++;
        return obj; // empty object or trailing comma
      }
      if (c === undefined) this.failUnclosed('object', start);
      if (c !== '"') {
        WORD.lastIndex = this.pos;
        const word = WORD.exec(t)?.[0];
        if (word !== undefined) this.fail(`property names must be double-quoted: ${q(word)}`);
        if (c === "'") this.fail('property names must use double quotes ("...")');
        this.fail(`unexpected ${q(c)} (expected a property name or "}")`);
      }
      const key = this.parseString();
      this.skip();
      if (t[this.pos] !== ':') {
        if (this.pos >= t.length) this.failUnclosed('object', start);
        this.fail(`expected ":" after property name ${q(key)}, got ${this.describeAt(this.pos)}`);
      }
      this.pos++;
      this.skip();
      this.path.push(key);
      const value = this.parseValue();
      if (Object.hasOwn(obj, key)) {
        this.warnings.warning('json-duplicate-key', this.path, `duplicate key ${q(key)}; the last value wins`, 'remove one of the duplicates');
      }
      this.path.pop();
      // defineProperty so a "__proto__" key stays an ordinary own property, as with JSON.parse.
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
      const valueEnd = this.pos;
      this.skip();
      const sep = t[this.pos];
      if (sep === ',') {
        this.pos++;
        continue;
      }
      if (sep === '}') {
        this.pos++;
        return obj;
      }
      if (sep === undefined) this.failUnclosed('object', start);
      if (sep === '"') this.fail(`missing "," after the value of ${q(key)}`, valueEnd);
      this.fail(`expected "," or "}" after the value of ${q(key)}, got ${q(sep)}`);
    }
  }

  private parseArray(): unknown[] {
    const t = this.text;
    const start = this.pos++;
    const arr: unknown[] = [];
    for (;;) {
      this.skip();
      const c = t[this.pos];
      if (c === ']') {
        this.pos++;
        return arr; // empty array or trailing comma
      }
      if (c === undefined) this.failUnclosed('array', start);
      if (c === ',') this.fail('unexpected "," (expected a value)');
      this.path.push(arr.length);
      arr.push(this.parseValue());
      this.path.pop();
      const valueEnd = this.pos;
      this.skip();
      const sep = t[this.pos];
      if (sep === ',') {
        this.pos++;
        continue;
      }
      if (sep === ']') {
        this.pos++;
        return arr;
      }
      if (sep === undefined) this.failUnclosed('array', start);
      if (/["{[\d-]/.test(sep)) this.fail(`missing "," after array item ${arr.length - 1}`, valueEnd);
      this.fail(`expected "," or "]" after array item ${arr.length - 1}, got ${q(sep)}`);
    }
  }

  private parseString(): string {
    const t = this.text;
    const start = this.pos++;
    let out = '';
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= t.length) this.fail('unterminated string (missing closing ")', start);
      const c = t.charCodeAt(this.pos);
      if (c === 0x22) {
        out += t.slice(chunk, this.pos++);
        return out;
      }
      if (c === 0x0a || c === 0x0d) this.fail('unterminated string (strings cannot span lines; close it or use \\n)');
      if (c < 0x20) this.fail('control characters in strings must be escaped');
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      out += t.slice(chunk, this.pos);
      const e = t[this.pos + 1];
      if (e !== undefined && Object.hasOwn(ESCAPES, e)) {
        out += ESCAPES[e];
        this.pos += 2;
      } else if (e === 'u') {
        const hex = t.slice(this.pos + 2, this.pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid \\u escape (expected 4 hex digits)');
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
      } else {
        this.fail(`invalid escape "\\${e ?? ''}" (valid: \\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX)`);
      }
      chunk = this.pos;
    }
  }

  private parseNumber(): number {
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.text)?.[0];
    const end = this.pos + (m?.length ?? 0);
    if (m === undefined || /[\w.]/.test(this.text[end] ?? '')) {
      NUMBER_LIKE.lastIndex = this.pos;
      this.fail(`invalid number ${q(NUMBER_LIKE.exec(this.text)?.[0] ?? this.text[this.pos])}`);
    }
    this.pos = end;
    return Number(m);
  }
}

/** Offset of the line break (LF or CR) ending the line that contains `from`, or the text length. */
function lineEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) if (text[i] === '\n' || text[i] === '\r') return i;
  return text.length;
}

/** 1-based line and column of `offset`; LF, CRLF and a lone CR each end a line. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

const EXCERPT_WIDTH = 100;

/** The offending line with a caret under the error column (long lines are windowed). */
function excerpt(text: string, offset: number): string {
  const { line, column } = lineColumn(text, offset);
  const lineStart = offset - (column - 1);
  const full = text.slice(lineStart, lineEnd(text, lineStart)).replace(/\t/g, ' ');
  let snippet = full;
  let caret = column - 1;
  if (full.length > EXCERPT_WIDTH) {
    const from = Math.max(0, Math.min(caret - EXCERPT_WIDTH / 2, full.length - EXCERPT_WIDTH));
    const to = from + EXCERPT_WIDTH;
    snippet = (from > 0 ? '…' : '') + full.slice(from, to) + (to < full.length ? '…' : '');
    caret = caret - from + (from > 0 ? 1 : 0);
  }
  const gutter = String(line);
  return `${gutter} | ${snippet}\n${' '.repeat(gutter.length)} | ${' '.repeat(caret)}^`;
}
