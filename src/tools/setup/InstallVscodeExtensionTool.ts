// Third-party imports
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@shared/schemas';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latexToolchain';
import { LEAN4_EXTENSION_ID } from '@tools/lean/leanTypes';
import { executed } from '@tools/core/result';
import { delay } from '@utils/core';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

/**
 * Allowlist of VS Code extensions the setup agent may install.
 * Matches the install flows already surfaced by the LaTeX tab.
 */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  LATEX_WORKSHOP_EXT_ID,
  LEAN4_EXTENSION_ID,
]);

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

export class InstallVscodeExtensionTool extends defineTool({
  name: 'install_vscode_extension',
  requiresApproval: true,
  description: `Install a VS Code extension from the Marketplace. Allowlisted: James-Yu.latex-workshop, leanprover.lean4. Blocks other extension IDs. Use this (rather than \`invoke_command workbench.extensions.installExtension\`) so the caller gets a clean success/failure status.`,
  schema: InstallVscodeExtensionInputSchema,
}) {
  protected async execute(
    input: InstallVscodeExtensionInput,
  ): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const id = input.extensionId.trim();

    if (!ALLOWED_EXTENSIONS.has(id)) {
      throw new ToolError(
        `Extension "${id}" is not in the setup allowlist. Allowed: ${[...ALLOWED_EXTENSIONS].sort().join(', ')}.`,
      );
    }

    if (!platform.extensions) {
      throw new ToolError('This host cannot install VS Code extensions.');
    }
    if (platform.extensions.isInstalled(id)) {
      return executed(
        `The "${id}" extension is already installed. No action taken.`,
        `Extension ${id} already installed`,
      );
    }

    await platform.extensions.install(id);

    // Give VS Code a brief moment to register the new extension.
    await delay(250);
    const installed = platform.extensions.isInstalled(id);

    return executed(
      installed
        ? `Successfully installed "${id}". It is now available in VS Code.`
        : `Requested install of "${id}". VS Code has not yet confirmed the extension is active. You may need to reload the window.`,
      installed
        ? `Installed extension ${id}`
        : `Install issued for ${id} (verify manually)`,
    );
  }
}
