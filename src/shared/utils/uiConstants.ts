/** VS Code command URIs for use in anchor href attributes. */
export const COMMAND_LINKS = {
  RUN_SETUP_ASSISTANT: 'command:texra.runSetupAssistant',
  GETTING_STARTED: 'command:texra.openGettingStarted',
  CREATE_SAMPLE_PROJECT: 'command:texra.createSampleProject',
  CLONE_OVERLEAF: 'command:texra.cloneOverleafProject',
  DOWNLOAD_ARXIV: 'command:texra.downloadArXivSource',
} as const;

export const PERMISSION_KIND = {
  TOOL_EDIT: 'toolEdit',
  BASH: 'bash',
  RETRY: 'retry',
  PROPOSAL: 'proposal',
  PLAN_APPROVAL: 'planApproval',
  EXTERNAL_INQUIRY: 'externalInquiry',
  USER_QUESTION: 'userQuestion',
} as const;

export type PermissionKind =
  (typeof PERMISSION_KIND)[keyof typeof PERMISSION_KIND];

/** Permission kinds that support rejection feedback */
export const FEEDBACK_ELIGIBLE_KINDS = new Set<PermissionKind>([
  PERMISSION_KIND.TOOL_EDIT,
  PERMISSION_KIND.BASH,
  PERMISSION_KIND.PROPOSAL,
  PERMISSION_KIND.PLAN_APPROVAL,
  PERMISSION_KIND.EXTERNAL_INQUIRY,
  PERMISSION_KIND.USER_QUESTION,
]);

/** Generates the getting started banner HTML with command links. */
export function getGettingStartedHtml(prefix = ''): string {
  return (
    prefix +
    `<a href="${COMMAND_LINKS.RUN_SETUP_ASSISTANT}">run the setup assistant agent</a>, ` +
    `<a href="${COMMAND_LINKS.GETTING_STARTED}">open the getting started walkthrough</a>, ` +
    `<a href="${COMMAND_LINKS.CREATE_SAMPLE_PROJECT}">create a sample project</a>, ` +
    `<a href="${COMMAND_LINKS.CLONE_OVERLEAF}">clone an Overleaf project</a>, or ` +
    `<a href="${COMMAND_LINKS.DOWNLOAD_ARXIV}">download an arXiv source</a>.`
  );
}
