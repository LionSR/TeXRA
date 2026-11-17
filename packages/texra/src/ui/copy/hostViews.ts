/**
 * What a host view says when it cannot show its content, and the actions it
 * offers then: the VS Code extension's webviews and the desktop's panes.
 */

/** The action that tries a failed load again. */
export const RETRY_LABEL = 'Retry';

/** A webview whose page could not be built, named by what the user calls
 *  it ("settings"), with the cause. */
export function viewLoadFailedText(view: string, cause: string): string {
  return `The TeXRA ${view} view could not load: ${cause}`;
}

/** The desktop command palette's row for another open project. */
export function switchToProjectLabel(project: string): string {
  return `Switch to ${project}`;
}
