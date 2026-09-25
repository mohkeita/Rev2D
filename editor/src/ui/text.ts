/** File name of a path (either separator). */
export function basename(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}
