// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { hostPort } from '@common/hostPort';
import { ToolError } from '@shared/schemas';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latexToolchain';
import { LEAN4_EXTENSION_ID } from '@tools/lean/leanTypes';
import { executed } from '@tools/core/result';

// Local file imports
import { defineTool } from '../core/define';
import { SetupPlatform } from './platform';

/**
 * Allowlist of VS Code extensions the setup agent may install.
 * Matches the install flows already surfaced by the LaTeX tab.
 */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  LATEX_WORKSHOP_EXT_ID,
  LEAN4_EXTENSION_ID,
]);

/** Grace period before re-reading the extension registry after an install. */
const REGISTRATION_GRACE_MS = 250;

const InstallVscodeExtensionInputSchema = z.strictObject({
  extensionId: z
    .string()
    .min(1)
    .describe(
      'VS Code extension ID in "<publisher>.<name>" form (e.g. "James-Yu.latex-workshop").',
    ),
});

type InstallVscodeExtensionInput = z.infer<
  typeof InstallVscodeExtensionInputSchema
>;

const installExtension = Effect.fn('InstallVscodeExtensionTool.execute')(
  function* (input: InstallVscodeExtensionInput) {
    const platform = yield* SetupPlatform;
    const id = input.extensionId.trim();

    if (!ALLOWED_EXTENSIONS.has(id)) {
      return yield* Effect.fail(
        new ToolError(
          `Extension "${id}" is not in the setup allowlist. Allowed: ${[...ALLOWED_EXTENSIONS].sort().join(', ')}.`,
        ),
      );
    }

    const extensions = platform.extensions;
    if (!extensions) {
      return yield* Effect.fail(
        new ToolError('This host cannot install VS Code extensions.'),
      );
    }
    if (extensions.isInstalled(id)) {
      return executed(
        `The "${id}" extension is already installed. No action taken.`,
        `Extension ${id} already installed`,
      );
    }

    yield* hostPort(() => extensions.install(id));

    // Give VS Code a brief moment to register the new extension.
    yield* Effect.sleep(REGISTRATION_GRACE_MS);
    const installed = extensions.isInstalled(id);

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
  // Requires VS Code extensions.
  unavailableHosts: ['cli', 'desktop'],
  requiresApproval: true,
  description: `Install a VS Code extension from the Marketplace. Allowlisted: James-Yu.latex-workshop, leanprover.lean4. Blocks other extension IDs. Use this (rather than \`invoke_command workbench.extensions.installExtension\`) so the caller gets a clean success/failure status.`,
  schema: InstallVscodeExtensionInputSchema,
  execute: installExtension,
});
