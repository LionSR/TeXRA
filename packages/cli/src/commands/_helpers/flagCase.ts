/**
 * Flag-name casing conversions shared by dispatch (kebab) and global-arg
 * lookup (camel) — both exist to let flag lookups tolerate every spelling
 * citty can produce for a flag name.
 */

export function toKebabCaseFlagName(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/_+/g, '-')
    .toLowerCase();
}

export function toCamelCaseFlagName(name: string): string {
  return name.replaceAll(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}
