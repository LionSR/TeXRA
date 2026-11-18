// How every list answers typing: which rows a filter keeps.

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
