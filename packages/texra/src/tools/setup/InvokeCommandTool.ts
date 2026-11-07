// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import { defineTool } from '@texra-ai/harness';
import { executed, ToolError } from '@texra-ai/harness/plugins';
import type { CommandId } from '@texra/shared/commands/catalog';

// Local file imports
import { assertInSetupAllowlist, SetupPlatform } from './platform';

/** The Lean 4 extension's toolchain installers, each its own prompted flow. */
const LEAN4_SETUP_COMMANDS = [
  'lean4.setup.installElan',
  'lean4.setup.installDeps',
  'lean4.setup.updateElan',
  'lean4.setup.selectDefaultToolchain',
];

/**
 * The TeXRA commands the setup agent may invoke: each opens an existing,
 * trusted UI flow. Never add one that deletes, resets or cleans anything.
 */
const SETUP_INVOKABLE_COMMANDS = [
  'texra.createSampleProject',
  'texra.openGettingStarted',
  'texra.cloneOverleafProject',
  'texra.downloadArXivSource',
  'texra.setApiKey',
  'texra.removeApiKey',
  'texra.showMemory',
  'texra.showModels',
  'texra.showAgents',
  'texra.showTools',
  'texra.showTeamSettings',
  'texra.showGitSettings',
  'texra.showMainView',
  'texra.showDashboard',
] as const satisfies readonly CommandId[];

/** The commands the setup agent may invoke: TeXRA's own and the Lean 4
 *  extension's installers. */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  ...SETUP_INVOKABLE_COMMANDS,
  ...LEAN4_SETUP_COMMANDS,
]);

const InvokeCommandInputSchema = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'VS Code command ID (must be in the setup allowlist).',
  }),
  // Declared so a value is refused: a struct drops an undeclared key before
  // any check sees it, and no credential may reach the host through command
  // arguments. `null` passes, as OpenAI-compatible providers send it for
  // every advertised field.
  args: Schema.optionalKey(Schema.Null).annotate({
    description: 'Not accepted: this tool takes no arguments. Leave it out.',
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
  // Offered where the host passes its commands (VS Code).
  hostCapability: 'commands' satisfies keyof SetupPlatform['Service'],
  requiresApproval: true,
  description: `Invoke an allowlisted VS Code command. Use this to hand off to TeXRA's existing UX: the API-key quick-pick (texra.setApiKey), the settings-dashboard tab openers (texra.showDashboard / texra.showModels / texra.showAgents / texra.showMemory / texra.showTeamSettings / texra.showTools / texra.showGitSettings), the sample-project creator (texra.createSampleProject), the Overleaf clone wizard (texra.cloneOverleafProject), the arXiv source downloader (texra.downloadArXivSource), and the Lean 4 extension's toolchain installers (lean4.setup.installElan / lean4.setup.installDeps / lean4.setup.updateElan / lean4.setup.selectDefaultToolchain). Non-allowlisted commands are rejected. To install a VS Code extension (LaTeX Workshop, Lean 4), use \`install_vscode_extension\` instead: it enforces a stricter per-extension allowlist.`,
  schema: InvokeCommandInputSchema,
  execute: invokeCommand,
});
