import type { RegisteredToolName } from '@tools/registry';
import { DIAGNOSTICS_ADD_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import { SETUP_PLATFORM_TOOL_NAMES } from '@tools/setup/platform';

type CliUnavailableTool =
  RegisteredToolName | typeof DIAGNOSTICS_ADD_RUNTIME_CAPABILITY;

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
 * The setup-platform-backed tools are currently wired only by the VS Code
 * extension host. Hide them until the CLI provides an honest SetupPlatform
 * adapter for secrets, commands, extensions, auth, config, and terminal runs.
 *
 * The `inline_comment` tool is backed by VS Code's CommentController, which the
 * CLI has no equivalent for, so it is hidden too.
 *
 * The `diagnostics.add` capability writes VS Code diagnostics through the
 * extension host. Keep diagnostics `list`/`count` available, but hide that
 * write sub-command from the CLI tool schema.
 *
 * Subagents inherit these exclusions through `runtimeUnavailableTools` on the
 * run context.
 */
export const CLI_UNAVAILABLE_TOOLS: readonly CliUnavailableTool[] = [
  'inquiry',
  ...SETUP_PLATFORM_TOOL_NAMES,
  'inline_comment',
  DIAGNOSTICS_ADD_RUNTIME_CAPABILITY,
];
