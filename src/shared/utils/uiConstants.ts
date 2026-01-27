/**
 * Shared UI constants for frontend webview components.
 * Centralizes string literals used across multiple views.
 */

// =============================================================================
// VS Code Command Links
// =============================================================================

/**
 * VS Code command URIs for use in anchor href attributes.
 * Format: command:{commandId}
 */
export const COMMAND_LINKS = {
  GETTING_STARTED: 'command:texra.openGettingStarted',
  CREATE_SAMPLE_PROJECT: 'command:texra.createSampleProject',
  CLONE_OVERLEAF: 'command:texra.cloneOverleafProject',
  DOWNLOAD_ARXIV: 'command:texra.downloadArXivSource',
} as const;

// =============================================================================
// Permission Kinds
// =============================================================================

/**
 * Permission prompt types used in the progress view.
 */
export const PERMISSION_KIND = {
  TOOL_EDIT: 'toolEdit',
  BASH: 'bash',
  RETRY: 'retry',
  PROPOSAL: 'proposal',
} as const;

export type PermissionKind =
  (typeof PERMISSION_KIND)[keyof typeof PERMISSION_KIND];

// =============================================================================
// Getting Started Content
// =============================================================================

/**
 * Generates the getting started banner HTML with command links.
 * Used in both MainView and ProgressView.
 */
export function getGettingStartedHtml(prefix = ''): string {
  return (
    prefix +
    `<a href="${COMMAND_LINKS.GETTING_STARTED}">open the getting started walkthrough</a>, ` +
    `<a href="${COMMAND_LINKS.CREATE_SAMPLE_PROJECT}">create a sample project</a>, ` +
    `<a href="${COMMAND_LINKS.CLONE_OVERLEAF}">clone an Overleaf project</a>, or ` +
    `<a href="${COMMAND_LINKS.DOWNLOAD_ARXIV}">download an arXiv source</a>.`
  );
}
