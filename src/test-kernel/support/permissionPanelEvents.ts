/**
 * Every permission panel answers the user through one `permission-action`
 * CustomEvent carrying a `decision` payload, so one recorder serves all of
 * them: attach it to a mounted panel and assert on the decisions it collected,
 * in order.
 */
export function recordPermissionActions(
  panel: EventTarget,
): Record<string, unknown>[] {
  const decisions: Record<string, unknown>[] = [];
  panel.addEventListener('permission-action', (event) => {
    decisions.push(
      (event as CustomEvent<{ decision: Record<string, unknown> }>).detail
        .decision,
    );
  });
  return decisions;
}
