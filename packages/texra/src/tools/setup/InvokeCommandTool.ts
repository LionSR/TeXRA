// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import { defineTool } from '@texra-ai/harness';
import { executed, ToolError } from '@texra-ai/harness/plugins';
import type { CommandId } from '@texra/shared/commands/catalog';

// Local file imports
import { assertInSetupAllowlist, SetupPlatform } from './platform';

/**
 * Allowlist of VS Code commands the setup agent may invoke.
 * Grouped for readability; all commands share the same risk profile (each
 * one opens an existing, trusted UI flow). Do NOT add destructive commands
 * (delete, reset, clean) to this list.
 */
const ALLOWED_COMMAND_IDS = [
  // API keys
  'texra.setApiKey',
  'texra.removeApiKey',
  // Settings dashboard tabs
  'texra.showDashboard',
  'texra.showMemory',
  'texra.showModels',
  'texra.showAgents',
  'texra.showTeamSettings',
  'texra.showTools',
  'texra.showGitSettings',
  // Workspace bootstrap
  'texra.createSampleProject',
  'texra.showMainView',
  'texra.cloneOverleafProject',
  'texra.downloadArXivSource',
  // Walkthrough re-entry
  'texra.openGettingStarted',
] as const satisfies readonly CommandId[];

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(ALLOWED_COMMAND_IDS);

const InvokeCommandInputSchema = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'VS Code command ID (must be in the setup allowlist).',
  }),
});

type InvokeCommandInput = typeof InvokeCommandInputSchema.Type;

const invokeCommand = Effect.fn('InvokeCommandTool.execute')(function* (
  input: InvokeCommandInput,
) {
  const platform = yield* SetupPlatform;
  const commandId = input.command.trim();

  yield* assertInSetupAllowlist('Command', commandId, ALLOWED_COMMANDS);

  const commands = platform.commands;
  if (!commands) {
    return yield* Effect.fail(
      new ToolError('VS Code command invocation is unavailable in this host.'),
    );
  }
  yield* commands
    .invoke(commandId)
    .pipe(
      Effect.catchTag('SetupCommandFailed', (failure) =>
        Effect.fail(
          new ToolError(
            `VS Code command "${commandId}" failed: ${failure.message}`,
          ),
        ),
      ),
    );

  return executed(
    `Invoked VS Code command "${commandId}". If this opens a UI prompt, wait for the user's response before continuing.`,
    `Invoked ${commandId}`,
  );
});

export const InvokeCommandTool = defineTool({
  name: 'invoke_command',
  // Requires VS Code commands.
  unavailableHosts: ['cli', 'desktop', 'sdk'],
  requiresApproval: true,
  description: `Invoke an allowlisted VS Code command. Use this to hand off to TeXRA's existing UX: the API-key quick-pick (texra.setApiKey), the settings-dashboard tab openers (texra.showDashboard / texra.showModels / texra.showAgents / texra.showMemory / texra.showTeamSettings / texra.showTools / texra.showGitSettings), the sample-project creator (texra.createSampleProject), the Overleaf clone wizard (texra.cloneOverleafProject), and the arXiv source downloader (texra.downloadArXivSource). Non-allowlisted commands are rejected. To install a VS Code extension (LaTeX Workshop, Lean 4), use \`install_vscode_extension\` instead: it enforces a stricter per-extension allowlist.`,
  schema: InvokeCommandInputSchema,
  execute: invokeCommand,
});
