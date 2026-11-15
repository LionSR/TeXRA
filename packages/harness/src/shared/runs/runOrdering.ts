/** The order the run tabs list runs in. */

/** Sort runs newest first, breaking ties alphabetically by id. */
export function compareByNewestCreationTime(
  a: { readonly id: string; readonly createdAt: number },
  b: { readonly id: string; readonly createdAt: number },
): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}
