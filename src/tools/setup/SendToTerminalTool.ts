// Third-party imports
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@tools/result';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

/**
 * Some commands cannot run through the captured-stdio `bash` tool:
 *
 *   - `sudo apt-get install ...` needs the user's password at a real TTY
 *   - `brew install --cask mactex` and similar prompt for confirmation
 *   - shells that drop the process into a paginator / editor
 *
 * For those cases the agent types the command into a real VS Code
 * integrated terminal. The terminal is shown to the user; by default the
 * command is left at the prompt unexecuted so the user's Enter keystroke
 * is the explicit approval (and gives them a chance to edit or cancel).
 *
 * This is intentionally a separate tool from `bash`:
 *   - `bash`: captured stdio, agent reads the result, approval dialog gates execution.
 *   - `send_to_terminal`: interactive TTY, no captured output, the visible terminal + Enter keystroke is the approval.
 *
 * Use the right one for the job — never reach for this tool to bypass
 * `bash` approvals on commands that would have worked in `bash`.
 */
const SendToTerminalInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      'The command to type into the integrated terminal. One command per call (a script is fine if it is the user-visible operation, but no chaining unrelated steps).',
    ),
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'One short sentence stating why this needs an interactive terminal instead of the regular `bash` tool — typically "sudo password prompt" or "interactive confirmation". The reason is shown back to the user.',
    ),
  name: z
    .string()
    .min(1)
    .max(60)
    .prefault('TeXRA: setup')
    .describe(
      'Display name for the terminal tab (e.g. "TeXRA: install LaTeX"). Defaults to "TeXRA: setup".',
    ),
  execute: z
    .boolean()
    .prefault(false)
    .describe(
      'When false (default), the command is typed but not executed — the user must press Enter to run it, which is the approval gate. Set true ONLY for a follow-up no-op like clearing the screen, never for the privileged command itself.',
    ),
});

type SendToTerminalInput = z.infer<typeof SendToTerminalInputSchema>;

export class SendToTerminalTool extends defineTool({
  name: 'send_to_terminal',
  description: `Type a command into a VS Code integrated terminal and reveal the terminal to the user. Use this — instead of \`bash\` — when the command needs a real TTY: \`sudo\` password prompts, package managers that ask for confirmation (e.g. \`brew install --cask\`), or anything that drops the user into an interactive UI. By default the command is left at the prompt unexecuted, so the user must press Enter to run it (that keystroke is the approval). You receive no captured output — after sending, ask the user to confirm completion before continuing, then re-probe with \`verify_setup\` or \`probe_environment\`. Do NOT use this to bypass \`bash\` approvals for commands that would work in \`bash\`.`,
  schema: SendToTerminalInputSchema,
}) {
  protected async execute(input: SendToTerminalInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const command = input.command.trim();

    if (command.length === 0) {
      throw new ToolError('Refusing to send an empty command to the terminal.');
    }

    const name = input.name.trim() || 'TeXRA: setup';
    await platform.terminal.sendCommand({
      name,
      command,
      execute: input.execute,
    });

    const verb = input.execute
      ? 'sent and executed in'
      : 'typed (awaiting Enter) into';
    return {
      summary: `Command ${verb} terminal "${name}"`,
      output:
        `${verb.charAt(0).toUpperCase() + verb.slice(1)} the integrated terminal "${name}":\n` +
        '```\n' +
        command +
        '\n```\n' +
        `Reason: ${input.reason.trim()}\n\n` +
        (input.execute
          ? 'The command was sent with auto-execute on. Watch the terminal for output and any password / confirmation prompts.'
          : "The command is sitting at the user's prompt — they need to press Enter to run it, then complete any password or confirmation prompts in the terminal. Wait for the user to tell you it finished before re-probing."),
    };
  }
}
