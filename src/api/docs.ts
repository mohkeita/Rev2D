/**
 * Summaries derived from the bundled Markdown docs, so topic listings (CLI `rev2d docs`, MCP
 * `rev2d_docs`) describe what the files actually contain and never drift from them. Pure functions of
 * the Markdown text (reading the file is the caller's job).
 */

/** Static summary of docs/RECIPES.md, used when the file is missing or has no numbered recipes. */
export const RECIPES_SUMMARY = 'task-oriented cookbook: one ops batch per technique, with the commands that verify it';

/**
 * Recipe names from the numbered "## N. Name: details" headings of docs/RECIPES.md, in file order:
 * the part before ": ", with the first letter lower-cased unless the word is an acronym ("IK").
 * Unnumbered headings (introduction, troubleshooting) and fenced code blocks are skipped.
 */
export function recipeTitles(markdown: string): string[] {
  const titles: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^##\s+\d+\.\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const colon = m[1].indexOf(': ');
    const name = (colon > 0 ? m[1].slice(0, colon) : m[1]).trim();
    if (!name) continue;
    titles.push(/^[A-Z][A-Z0-9]/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1));
  }
  return titles;
}

/**
 * One-line description of the recipes topic listing every recipe in docs/RECIPES.md
 * ("task-oriented cookbook: ... (22 recipes: starter model, head turn, ...)"); the static summary
 * when the text is missing or lists no numbered recipes.
 */
export function recipesDescription(markdown: string | null): string {
  const titles = markdown === null ? [] : recipeTitles(markdown);
  if (!titles.length) return RECIPES_SUMMARY;
  return `${RECIPES_SUMMARY} (${titles.length} recipe${titles.length === 1 ? '' : 's'}: ${titles.join(', ')})`;
}
