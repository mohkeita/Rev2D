/**
 * One toast for a file operation: the server's first note when it says the same thing in more
 * detail ("created hero.r2d.json from template …" for "Created hero.r2d.json"), the other notes
 * (copied textures, rewritten texture paths, skipped files, …) as detail lines.
 */
export function summarizeNotes(message: string, notes: readonly string[]): { text: string; details: string[] } {
  const verb = message.split(' ')[0].toLowerCase();
  const [first, ...rest] = notes;
  if (first && first.toLowerCase().startsWith(`${verb} `)) return { text: first.charAt(0).toUpperCase() + first.slice(1), details: rest };
  return { text: message, details: [...notes] };
}
