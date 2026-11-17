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

/** The desktop PDF tab's action that opens its file in the system viewer. */
export const OPEN_EXTERNALLY_LABEL = 'Open externally';

/** A desktop PDF tab whose file did not load. */
export const PDF_LOAD_FAILED_TITLE = 'This PDF could not be shown';

/** Chromium's net error for a file that is not there. */
const ERR_FILE_NOT_FOUND = -6;

/** Why a PDF tab's file did not load, from the frame's net error: a missing
 *  file says so and where it was; any other failure carries Chromium's own
 *  name for it, the only detail there is. */
export function pdfLoadFailureText(
  path: string,
  errorCode: number,
  errorDescription: string,
): string {
  return errorCode === ERR_FILE_NOT_FOUND
    ? `${path} is no longer there. Rebuild it to show it again.`
    : `${path} did not load (${errorDescription}).`;
}
