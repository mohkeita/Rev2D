/**
 * Markdown-lite for the agent's messages (pure: text in, a small tree out; markdown.tsx renders it).
 *
 * Agents answer in Markdown. The panel shows what reads well in a narrow column and nothing that could
 * run: no HTML, no images, links only to http(s) / mailto addresses.
 *
 *   blocks   paragraphs (a single line break stays a line break), # headings, - / * / + and 1. lists
 *            (one nesting level by indentation, "- [ ]" / "- [x]" task items), ``` fenced code, > quotes,
 *            --- rules, | pipe | tables |
 *   inline   `code`, **strong** / __strong__, *emphasis* / _emphasis_, [text](url), bare http(s) URLs
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export interface ListItem {
  inline: Inline[];
  /** Task list item: true / false; null for an ordinary item. */
  checked: boolean | null;
  /** A nested list (one level). */
  children: MdBlock[];
}

export type MdBlock =
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'rule' }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** A line that starts another kind of block (ends a paragraph). */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cur += c;
    } else if (c === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return parseLines(lines, 0);
}

function parseLines(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or the end of the text)
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, inline: parseInline(heading[2]!) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (QUOTE.test(line) && depth < 3) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!) && (QUOTE.test(lines[i]!) || body.length > 0)) {
        const m = QUOTE.exec(lines[i]!);
        if (!m && startsBlock(lines[i]!)) break;
        body.push(m ? m[1]! : lines[i]!);
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseLines(body, depth + 1) });
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const header = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(splitRow(lines[i++]!).map(parseInline));
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const list = parseList(lines, i, depth);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    // Paragraph: until a blank line or another block.
    const body: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!) && !(TABLE_ROW.test(lines[i]!) && TABLE_SEP.test(lines[i + 1] ?? ''))) body.push(lines[i++]!);
    blocks.push({ type: 'paragraph', inline: joinLines(body) });
  }
  return blocks;
}

/** Lines of a paragraph: a line break between them (chat answers use them on purpose). */
function joinLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((l, k) => {
    if (k > 0) out.push({ type: 'br' });
    out.push(...parseInline(l.trim()));
  });
  return out;
}

function parseList(lines: string[], start: number, depth: number): { block: MdBlock; next: number } {
  const first = (BULLET.exec(lines[start]!) ?? ORDERED.exec(lines[start]!))!;
  const ordered = !BULLET.test(lines[start]!);
  const indent = first[1]!.length;
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = ordered ? ORDERED.exec(line) : BULLET.exec(line);
    if (m && m[1]!.length <= indent + 1) {
      // A new item of this list.
      const body = [m[3]!];
      i++;
      const nested: string[] = [];
      while (i < lines.length) {
        const next = lines[i]!;
        if (isBlank(next)) {
          // A blank line ends the list unless an item (of any depth) follows.
          const after = lines[i + 1];
          if (after !== undefined && (BULLET.test(after) || ORDERED.test(after)) && (after.length - after.trimStart().length) >= indent) {
            i++;
            continue;
          }
          break;
        }
        const nm = BULLET.exec(next) ?? ORDERED.exec(next);
        if (nm && nm[1]!.length <= indent + 1) break;
        if (nm && nm[1]!.length > indent + 1) {
          nested.push(next);
          i++;
          continue;
        }
        if (nested.length) {
          nested.push(next);
          i++;
          continue;
        }
        if (startsBlock(next) && !/^\s+/.test(next)) break;
        body.push(next.trim());
        i++;
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body[0]!);
      const checked = task ? task[1] !== ' ' : null;
      if (task) body[0] = task[2]!;
      const minIndent = nested.length ? Math.min(...nested.filter((l) => !isBlank(l)).map((l) => l.length - l.trimStart().length)) : 0;
      items.push({
        inline: joinLines(body),
        checked,
        children: nested.length && depth < 3 ? parseLines(nested.map((l) => l.slice(minIndent)), depth + 1) : [],
      });
      continue;
    }
    break;
  }
  return { block: { type: 'list', ordered, start: ordered ? Number(first[2]) : 1, items }, next: i };
}

// ----------------------------------------------------------------------------------------- inline

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline markup of one line. Code spans first: nothing inside them is markup. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let plain = '';
  const flush = (): void => {
    if (plain) out.push(...parseEmphasis(plain));
    plain = '';
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length && /[\\`*_[\]()#+\-.!|>~]/.test(text[i + 1]!)) {
      plain += `\u0000${text[i + 1]}`;
      i += 2;
      continue;
    }
    if (c === '`') {
      let ticks = 1;
      while (text[i + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      const end = text.indexOf(fence, i + ticks);
      if (end > i) {
        flush();
        let code = text.slice(i + ticks, end);
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push({ type: 'code', text: code });
        i = end + ticks;
        continue;
      }
      plain += fence;
      i += ticks;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  return mergeText(out);
}

/** Escaped characters were marked with \u0000 so emphasis skips them; drop the marks. */
function unescape(s: string): string {
  return s.replace(/\u0000/g, '');
}

function parseEmphasis(s: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let plain = '';
  const flush = (): void => {
    if (plain) out.push(...linkify(unescape(plain)));
    plain = '';
  };
  while (i < s.length) {
    const c = s[i]!;
    const escaped = s[i - 1] === '\u0000';
    if (!escaped && c === '[') {
      const close = findClose(s, i + 1, '[', ']');
      if (close > 0 && s[close + 1] === '(') {
        const end = findClose(s, close + 2, '(', ')');
        if (end > 0) {
          const href = unescape(s.slice(close + 2, end)).trim().split(/\s+/)[0] ?? '';
          const label = parseEmphasis(s.slice(i + 1, close));
          flush();
          if (SAFE_URL.test(href)) out.push({ type: 'link', href, children: label });
          else out.push(...label);
          i = end + 1;
          continue;
        }
      }
    }
    if (!escaped && (c === '*' || c === '_')) {
      const double = s[i + 1] === c;
      const marker = double ? c + c : c;
      const opensWord = s[i + marker.length] !== undefined && !/\s/.test(s[i + marker.length]!);
      // "_" inside a word (snake_case ids) is not emphasis.
      const intraword = c === '_' && i > 0 && /[\p{L}\p{N}]/u.test(s[i - 1]!);
      if (opensWord && !intraword) {
        const end = findMarker(s, i + marker.length, marker);
        if (end > i + marker.length) {
          flush();
          const inner = parseEmphasis(s.slice(i + marker.length, end));
          out.push(double ? { type: 'strong', children: inner } : { type: 'em', children: inner });
          i = end + marker.length;
          continue;
        }
      }
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

function findClose(s: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i - 1] === '\u0000') continue;
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The closing emphasis marker: not after whitespace, and for "_" not inside a word. */
function findMarker(s: string, from: number, marker: string): number {
  for (let i = from; i <= s.length - marker.length; i++) {
    if (s[i - 1] === '\u0000') continue;
    if (s.startsWith(marker, i) && !/\s/.test(s[i - 1] ?? ' ')) {
      if (marker.length === 1 && s[i + 1] === marker) {
        i++;
        continue;
      }
      if (marker[0] === '_' && /[\p{L}\p{N}]/u.test(s[i + marker.length] ?? '')) continue;
      return i;
    }
  }
  return -1;
}

/** Bare http(s) URLs as links (a trailing period or bracket is not part of the address). */
function linkify(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /https?:\/\/[^\s<>"'`]+/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    let url = m[0];
    const trail = /[.,;:!?)\]}'"]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', text: s.slice(last, at) });
    out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
    last = at + url.length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}

function mergeText(list: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of list) {
    const prev = out[out.length - 1];
    if (n.type === 'text' && prev?.type === 'text') out[out.length - 1] = { type: 'text', text: prev.text + n.text };
    else if (n.type !== 'text' || n.text) out.push(n);
  }
  return out;
}

/** The text of a message without markup (for summaries and accessible names). */
export function plainText(blocks: readonly MdBlock[]): string {
  const inline = (list: readonly Inline[]): string =>
    list.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : n.type === 'br' ? ' ' : inline(n.children))).join('');
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'paragraph':
        case 'heading':
          return inline(b.inline);
        case 'list':
          return b.items.map((it) => inline(it.inline)).join(' ');
        case 'code':
          return b.text;
        case 'quote':
          return plainText(b.blocks);
        case 'table':
          return [b.header, ...b.rows].map((r) => r.map(inline).join(' ')).join(' ');
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join(' ');
}
