import type { RegisteredToolName } from '@tools/registry';

/**
 * Tools hidden from every `texra` CLI run — both the headless command paths
 * (`run`, `agents run`, `multi-agent run`) and the interactive TUI chat.
 *
 * The async external-inquiry flow is a VS Code / desktop feature: the user
 * pastes an external model's answer back through the long-lived progress-view
 * panel, possibly hours later and across host reloads. The CLI does not offer
 * that flow, so the `inquiry` tool is excluded from the agent's effective tool
 * list for all CLI runs.
 *
 * The `list_api_keys` audit tool depends on the setup-platform adapter that is
 * currently wired by the VS Code extension host. Hide it until the CLI provides
 * the same SecretStorage enumeration surface.
 *
 * The `inline_comment` tool is backed by VS Code's CommentController, which the
 * CLI has no equivalent for, so it is hidden too.
 *
 * Subagents inherit these exclusions through `runtimeUnavailableTools` on the
 * run context.
 */
export const CLI_UNAVAILABLE_TOOLS: readonly RegisteredToolName[] = [
  'inquiry',
  // list_api_keys reads VS Code's SecretStorage.keys() via the setup platform,
  // which is only wired in the extension host. The CLI has no SecretStorage
  // equivalent, so hide the tool rather than crash at runtime.
  'list_api_keys',
  // inline_comment is backed by the VS Code CommentController (extension host
  // only); the CLI cannot render comment threads.
  'inline_comment',
];
