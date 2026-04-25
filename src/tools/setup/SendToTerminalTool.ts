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
 * integrated terminal. The terminal is shown to the user; the command
 * is left at the prompt unexecuted so the user's Enter keystroke is the
 * explicit approval (and gives them a chance to edit or cancel). The
 * tool intentionally does NOT expose an auto-execute switch — that
 * would defeat the entire approval model.
 *
 * This is intentionally a separate tool from `bash`:
 *   - `bash`: captured stdio, agent reads the result, approval dialog gates execution.
 *   - `send_to_terminal`: interactive TTY, no captured output, the visible terminal + Enter keystroke is the approval.
 *
 * Use the right one for the job — never reach for this tool to bypass
 * `bash` approvals on commands that would have worked in `bash`.
 */
/**
 * Reject any control character that VS Code's terminal would treat as an
 * Enter / line-feed, defeating the approval gate. `terminal.sendText`
 * normalizes both `\n` and `\r` into a CR the shell reads as Enter, so
 * `"cmd1\ncmd2"` with execute=false would still auto-run `cmd1`. We
 * reject the raw string at parse time rather than stripping silently —
 * the agent should rewrite multi-line input as a single command.
 */
const FORBIDDEN_COMMAND_CHARS = /[\r\n]/;

const SendToTerminalInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .max(2048)
    .refine((s) => !FORBIDDEN_COMMAND_CHARS.test(s), {
      message:
        'command must not contain newline / carriage-return characters — they would auto-execute past the Enter approval gate.',
    })
    .describe(
      'The command to type into the integrated terminal. One command per call (a script is fine if it is the user-visible operation, but no chaining unrelated steps). Must not contain newline or carriage-return characters; those would auto-execute past the Enter approval gate.',
    ),
  reason: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => s.trim().length > 0, {
      message: 'reason must include non-whitespace text',
    })
    .describe(
      'One short sentence stating why this needs an interactive terminal instead of the regular `bash` tool — typically "sudo password prompt" or "interactive confirmation". The reason is shown back to the user.',
    ),
  label: z
    .string()
    .min(1)
    .max(40)
    .prefault('setup')
    .refine((s) => s.trim().length > 0, {
      message: 'label must include non-whitespace text',
    })
    .describe(
      'Short suffix for the terminal tab name. The tool always prepends "TeXRA: " so the terminal cannot be made to impersonate other terminals or extensions. Examples: "setup", "install LaTeX", "PATH fix".',
    ),
});

type SendToTerminalInput = z.infer<typeof SendToTerminalInputSchema>;

/** Cap on the command preview echoed back into the tool transcript. */
const COMMAND_PREVIEW_MAX = 80;

/**
 * Build a short, transcript-safe preview of the command. The user can
 * already see the command in the revealed terminal, so we deliberately
 * avoid echoing the full text into the saved transcript / exports —
 * that would mirror a known footgun where secrets ride along in tool
 * output (cf. `InvokeCommandTool`'s arg redaction).
 */
function commandPreview(command: string): string {
  if (command.length <= COMMAND_PREVIEW_MAX) return command;
  return `${command.slice(0, COMMAND_PREVIEW_MAX)}…`;
}

export class SendToTerminalTool extends defineTool({
  name: 'send_to_terminal',
  description: `Type a command into a VS Code integrated terminal and reveal the terminal to the user. Use this — instead of \`bash\` — when the command needs a real TTY: \`sudo\` password prompts, package managers that ask for confirmation (e.g. \`brew install --cask\`), or anything that drops the user into an interactive UI. The command is left at the prompt unexecuted; the user must press Enter to run it (that keystroke is the approval). The terminal tab is always named "TeXRA: <label>" so it cannot impersonate other terminals. You receive no captured output and only a redacted preview of the command — after sending, ask the user to confirm completion before continuing, then re-probe with \`verify_setup\` or \`probe_environment\`. Do NOT use this to bypass \`bash\` approvals for commands that would work in \`bash\`.`,
  schema: SendToTerminalInputSchema,
}) {
  protected async execute(input: SendToTerminalInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const command = input.command.trim();

    if (command.length === 0) {
      throw new ToolError('Refusing to send an empty command to the terminal.');
    }

    const label = input.label.trim();
    const name = `TeXRA: ${label}`;
    await platform.terminal.sendCommand({ name, command });

    const reason = input.reason.trim();
    const preview = commandPreview(command);
    return {
      summary: `Typed command into terminal "${name}" (awaiting Enter)`,
      output:
        `Typed a command into the integrated terminal "${name}" — preview: \`${preview}\`. ` +
        `Reason: ${reason}. ` +
        "The command is sitting at the user's prompt; they need to press Enter to run it, then complete any password or confirmation prompts in the terminal. " +
        'Wait for the user to tell you it finished before re-probing. ' +
        '(Full command text is intentionally not echoed into the transcript — the user can see it in the revealed terminal.)',
    };
  }
}
