// How every list answers typing and keys, in the web views and the terminal:
// which rows a filter keeps and where a keyboard move lands. Pure, so the
// terminal imports it too. Each surface decides which keys it forwards: a
// filter input keeps Home and End for its caret.

/** Whether every word of a filter `query` appears in `text`, in any order
 *  and ignoring case in the user's locale: "paper review" finds "Review a
 *  paper". An empty query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

type ListMove = 'next' | 'previous' | 'first' | 'last';

/** The move a key makes in a list laid out top to bottom (`vertical`) or
 *  start to end (`horizontal`); undefined for any other key. */
export function listMoveOfKey(
  key: string,
  orientation: 'vertical' | 'horizontal',
): ListMove | undefined {
  if (key === 'Home') return 'first';
  if (key === 'End') return 'last';
  const vertical = orientation === 'vertical';
  if (key === (vertical ? 'ArrowDown' : 'ArrowRight')) return 'next';
  if (key === (vertical ? 'ArrowUp' : 'ArrowLeft')) return 'previous';
  return undefined;
}

/** Where `move` lands from `index` in a `count`-row list: a step past
 *  either end wraps to the other. -1 when the list is empty. */
export function nextListIndex(
  move: ListMove,
  index: number,
  count: number,
): number {
  if (count <= 0) return -1;
  const at = Math.min(Math.max(index, 0), count - 1);
  switch (move) {
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    case 'next':
      return (at + 1) % count;
    case 'previous':
      return (at - 1 + count) % count;
  }
}
