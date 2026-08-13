// Third-party imports
import { z } from 'zod';

// Local imports
import { AUTH_COMMANDS } from '@auth/constants';
import { ToolError, type ToolResult } from '@shared/schemas';
import type { CommandId } from '@shared/commands/catalog';

// Local file imports
import { executed } from '@tools/core/result';
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

/**
 * Allowlist of VS Code commands the setup agent may invoke.
 * Grouped for readability; all commands share the same risk profile (each
 * one opens an existing, trusted UI flow). Do NOT add destructive commands
 * (delete, reset, clean) to this list.
 */
// Intentionally excluded: `AUTH_COMMANDS.SIGN_OUT` — the setup agent's
// purpose is to *establish* credentials, and signing the user out
// mid-setup would undo the very credential the assistant just wired up.
// A user who genuinely wants to sign out has the Profile command for it.
const ALLOWED_COMMAND_IDS = [
  // API keys & auth
  'texra.setApiKey',
  'texra.removeApiKey',
  AUTH_COMMANDS.SIGN_IN,
  AUTH_COMMANDS.VIEW_PROFILE,
  // Settings dashboard tabs
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
  'texra.cloneOverleafProject',
  'texra.downloadArXivSource',
  // Walkthrough re-entry
  'texra.openGettingStarted',
] as const satisfies readonly CommandId[];

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(ALLOWED_COMMAND_IDS);

const InvokeCommandInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .describe('VS Code command ID (must be in the setup allowlist).'),
});

type InvokeCommandInput = z.infer<typeof InvokeCommandInputSchema>;

export class InvokeCommandTool extends defineTool({
  name: 'invoke_command',
  requiresApproval: true,
  description: `Invoke an allowlisted VS Code command. Use this to hand off to TeXRA's existing UX: the API-key quick-pick (texra.setApiKey), the Researcher Access sign-in (texra.auth.signIn), the settings-dashboard tab openers (texra.showDashboard / texra.showModels / texra.showAgents / texra.showMemory / texra.showMultiAgent / texra.showTools / texra.showGitSettings), the sample-project creator (texra.createSampleProject), the Overleaf clone wizard (texra.cloneOverleafProject), and the arXiv source downloader (texra.downloadArXivSource). Non-allowlisted commands are rejected. To install a VS Code extension (LaTeX Workshop, Lean 4), use \`install_vscode_extension\` instead: it enforces a stricter per-extension allowlist.`,
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

    if (!platform.commands) {
      throw new ToolError(
        'VS Code command invocation is unavailable in this host.',
      );
    }
    await platform.commands.invoke(commandId);

    return executed(
      `Invoked VS Code command "${commandId}". If this opens a UI prompt, wait for the user's response before continuing.`,
      `Invoked ${commandId}`,
    );
  }
}
