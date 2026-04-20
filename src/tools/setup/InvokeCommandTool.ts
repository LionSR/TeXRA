// Third-party imports
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@tools/result';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

/**
 * Allowlist of VS Code commands the setup agent may invoke.
 * Grouped for readability; all commands share the same risk profile (each
 * one opens an existing, trusted UI flow). Do NOT add destructive commands
 * (delete, reset, clean) to this list.
 */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // API keys & auth
  'texra.setApiKey',
  'texra.removeApiKey',
  'texra.auth.signIn',
  'texra.auth.signOut',
  'texra.auth.viewProfile',
  // Settings dashboard tabs
  'texra.showSettingsView',
  'texra.showDashboard',
  'texra.showMemory',
  'texra.showAgentHistory',
  'texra.showModels',
  'texra.showAgents',
  'texra.showMultiAgent',
  'texra.showTools',
  'texra.showGitSettings',
  // Workspace bootstrap
  'texra.createSampleProject',
  'texra.showMainView',
  // Refresh helpers
  'texra.refreshApiKeyStatus',
  'texra.refreshAllOptions',
  // Extensions
  'workbench.extensions.installExtension',
  // Walkthrough re-entry
  'texra.openGettingStarted',
]);

const InvokeCommandInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .describe('VS Code command ID (must be in the setup allowlist).'),
  args: z
    .array(z.unknown())
    .prefault([])
    .describe('Positional arguments forwarded to the command.'),
});

type InvokeCommandInput = z.infer<typeof InvokeCommandInputSchema>;

export class InvokeCommandTool extends defineTool({
  name: 'invoke_command',
  description: `Invoke an allowlisted VS Code command. Use this to hand off to TeXRA's existing UX — the API-key quick-pick (texra.setApiKey), the Researcher Access sign-in (texra.auth.signIn), the settings-dashboard tab openers (texra.showModels / texra.showAgents / texra.showMemory / texra.showMultiAgent / texra.showTools / texra.showGitSettings), the sample-project creator (texra.createSampleProject), and the LaTeX Workshop install (workbench.extensions.installExtension with "James-Yu.latex-workshop"). Non-allowlisted commands are rejected. Prefer this over re-implementing flows that already exist in the UI.`,
  schema: InvokeCommandInputSchema,
}) {
  protected async execute(input: InvokeCommandInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const commandId = input.command.trim();

    if (!ALLOWED_COMMANDS.has(commandId)) {
      throw new ToolError(
        `Command "${commandId}" is not in the setup allowlist. Allowed: ${[...ALLOWED_COMMANDS].sort().join(', ')}.`,
      );
    }

    await platform.commands.invoke(commandId, ...input.args);

    const argPreview =
      input.args.length > 0
        ? ` with args ${JSON.stringify(input.args).slice(0, 200)}`
        : '';

    return {
      summary: `Invoked ${commandId}${argPreview}`,
      output: `Invoked VS Code command "${commandId}"${argPreview}. If this opens a UI prompt, wait for the user's response before continuing.`,
    };
  }
}
