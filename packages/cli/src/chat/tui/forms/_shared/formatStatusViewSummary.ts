/** Shared status-view fold: before the status loads there is no label, so the
 *  summary is the `checking` placeholder while loading (unless the load
 *  errored) and 'Status unavailable' otherwise; once loaded, an error or a
 *  refresh annotates the loaded label. */
export function formatStatusViewSummary(
  view: { readonly loading: boolean; readonly error: boolean },
  checking: string,
  label: string | undefined,
): string {
  if (label === undefined) {
    if (view.loading && !view.error) return checking;
    return 'Status unavailable';
  }
  if (view.error) return `${label} · status unavailable`;
  return view.loading ? `${label} · refreshing` : label;
}
