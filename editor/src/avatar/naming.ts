/**
 * Names of new avatar projects (pure): the server takes the avatar's name as an id (letters, digits,
 * "_" and "-", not starting with a digit) and makes it the project folder and <name>.r2d.json.
 */

/** A usable avatar name from a file name ("My Picture (1).png" -> "my-picture-1"). */
export function avatarNameFrom(fileName: string): string {
  const stem = fileName.replace(/\.[A-Za-z0-9]+$/, '');
  let name = stem
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .toLowerCase();
  if (!name) name = 'avatar';
  if (/^\d/.test(name)) name = `avatar-${name}`;
  return name.slice(0, 48).replace(/[-_]+$/, '');
}

/** Whether a name is a valid avatar id (the server's ID_PATTERN). */
export function isAvatarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name);
}
