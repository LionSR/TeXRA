// Third-party imports
import { Effect, Option, Schedule, Schema } from 'effect';

// Local imports
import { executed, ToolError, defineTool } from '@texra-ai/worldline/plugins';
import { LATEX_WORKSHOP_EXT_ID } from '@texra/shared/constants/latexToolchain';
import { LEAN4_EXTENSION_ID } from '@texra/tools/lean/leanTypes';

// Local file imports
import {
  EDITOR_EXTENSIONS_CAPABILITY,
  EditorIntegration,
} from '@texra/hosts/editorIntegration';

/**
 * How long to poll the extension registry after an install. VS Code registers
 * a new extension asynchronously after the install command resolves.
 */
const REGISTRATION_TIMEOUT = '3 seconds';

const InstallVscodeExtensionInputSchema = Schema.Struct({
  // The extensions the setup agent may install: the install flows the
  // LaTeX tab already offers.
  extensionId: Schema.Literals([
    LATEX_WORKSHOP_EXT_ID,
    LEAN4_EXTENSION_ID,
  ]).annotate({ description: 'VS Code extension ID.' }),
});

type InstallVscodeExtensionInput =
  (typeof InstallVscodeExtensionInputSchema)['Type'];

const installExtension = Effect.fn('InstallVscodeExtensionTool.execute')(
  function* (input: InstallVscodeExtensionInput) {
    const id = input.extensionId;
    const extensions = yield* EditorIntegration;
    if (!extensions) {
      return yield* new ToolError(
        'This host cannot install VS Code extensions.',
      );
    }
    if (extensions.installed(id)) {
      return executed(
        `The "${id}" extension is already installed. No action taken.`,
        `Extension ${id} already installed`,
      );
    }

    yield* extensions
      .install(id)
      .pipe(
        Effect.mapError(
          (failure) =>
            new ToolError(
              `VS Code refused to install "${id}": ${failure.message}`,
            ),
        ),
      );

    // Poll until VS Code registers the new extension, up to the timeout.
    const installed = Option.getOrElse(
      yield* Effect.sync(() => extensions.installed(id)).pipe(
        Effect.repeat({
          schedule: Schedule.spaced('100 millis'),
          until: (registered) => registered,
        }),
        Effect.timeoutOption(REGISTRATION_TIMEOUT),
      ),
      () => false,
    );

    return executed(
      installed
        ? `Successfully installed "${id}". It is now available in VS Code.`
        : `Requested install of "${id}". VS Code has not yet confirmed the extension is active. You may need to reload the window.`,
      installed
        ? `Installed extension ${id}`
        : `Install issued for ${id} (verify manually)`,
    );
  },
);

export const InstallVscodeExtensionTool = defineTool({
  name: 'install_vscode_extension',
  // Offered where the host has an editor (VS Code).
  hostCapability: EDITOR_EXTENSIONS_CAPABILITY,
  requiresApproval: true,
  description: `Install a VS Code extension from the Marketplace. \`extensionId\` lists the extensions it may install (LaTeX Workshop, Lean 4). Use this (rather than \`invoke_command workbench.extensions.installExtension\`) so the caller gets a clean success/failure status.`,
  schema: InstallVscodeExtensionInputSchema,
  execute: installExtension,
});
