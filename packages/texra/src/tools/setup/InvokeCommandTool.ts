// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import { executed, ToolError, defineTool } from '@texra-ai/worldline/plugins';
import type { CommandId } from '@texra/shared/commands/catalog';

// Local file imports
import { SetupPlatform } from './platform';

/** The Lean 4 extension's toolchain installers, each its own prompted flow. */
const LEAN4_SETUP_COMMANDS = [
  'lean4.setup.installElan',
  'lean4.setup.installDeps',
  'lean4.setup.updateElan',
  'lean4.setup.selectDefaultToolchain',
] as const;

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
  'texra.showTools',
  'texra.showGitSettings',
  'texra.showMainView',
  'texra.showDashboard',
] as const satisfies readonly CommandId[];

const InvokeCommandInputSchema = Schema.Struct({
  // The commands the setup agent may invoke, TeXRA's own and the Lean 4
  // extension's installers, as the enum the model chooses from.
  command: Schema.Literals([
    ...SETUP_INVOKABLE_COMMANDS,
    ...LEAN4_SETUP_COMMANDS,
  ]).annotate({ description: 'VS Code command ID.' }),
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
  const commandId = input.command;
  const commands = platform.commands;
  if (!commands) {
    return yield* new ToolError(
      'VS Code command invocation is unavailable in this host.',
    );
  }
  yield* commands
    .invoke(commandId)
    .pipe(
      Effect.catchTag('HostFailed', (failure) =>
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
  description: `Invoke an allowlisted VS Code command; \`command\` lists them. Use this to hand off to TeXRA's existing UX: the API-key quick-picks, the main view, the getting-started page and the settings-dashboard tab openers, the sample-project creator, the Overleaf clone wizard, the arXiv source downloader, and the Lean 4 extension's toolchain installers. To install a VS Code extension (LaTeX Workshop, Lean 4), use \`install_vscode_extension\` instead: it enforces a stricter per-extension allowlist.`,
  schema: InvokeCommandInputSchema,
  execute: invokeCommand,
});
