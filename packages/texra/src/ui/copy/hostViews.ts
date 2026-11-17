/**
 * What a host view says when it cannot show its content, and the actions it
 * offers then: the VS Code extension's webviews and the desktop's panes.
 */

/** The desktop command palette's row for another open project. */
export function switchToProjectLabel(project: string): string {
  return `Switch to ${project}`;
}
