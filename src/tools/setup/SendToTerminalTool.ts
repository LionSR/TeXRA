// Third-party imports
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@tools/result';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

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
 * For those cases the agent runs the command inside a real VS Code
 * integrated terminal. Approval re-uses the regular `bash` approval
 * dialog — there's no second gate to maintain, and the user already
 * understands that surface.
 *
 * When the terminal has shell integration active (the default for
 * bash/zsh/pwsh/fish in VS Code-launched terminals since 1.93), the
 * tool reads back the exit code and output via
 * `Terminal.shellIntegration.executeCommand`. When integration isn't
 * available, the tool falls back to `terminal.sendText` and reports
 * `captured: false` — the agent must then ask the user to confirm the
 * command finished and re-probe.
 */

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min — installs can be slow

/**
 * Reject any control character that would behave as Enter inside the
 * terminal. Even with shell integration, embedded `\n` / `\r` would
 * smuggle a second command past the user's view of what they
 * approved — keep the schema strict and let the agent rewrite
 * multi-line input as a single command.
 */
const FORBIDDEN_COMMAND_CHARS = /[\r\n]/;

const SendToTerminalInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .max(2048)
    .refine((s) => !FORBIDDEN_COMMAND_CHARS.test(s), {
      message:
        'command must not contain newline / carriage-return characters — they would smuggle a second command past the approval surface.',
    })
    .describe(
      'The command to run inside the integrated terminal. One command per call. Must not contain newline or carriage-return characters.',
    ),
  reason: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => s.trim().length > 0, {
      message: 'reason must include non-whitespace text',
    })
    .describe(
      'One short sentence stating why this needs an interactive terminal instead of the regular `bash` tool — typically "sudo password prompt" or "interactive confirmation". Shown back to the user.',
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
      'Short suffix for the terminal tab name. The tool always prepends "TeXRA: " so the terminal cannot impersonate other terminals or extensions.',
    ),
  timeout: z
    .int()
    .min(1_000)
    .max(900_000)
    .nullish()
    .describe(
      'Hard cap (ms) on how long the tool waits for the captured run before giving up. Defaults to 300,000 ms (5 min). Ignored when shell integration is unavailable.',
    ),
});

type SendToTerminalInput = z.infer<typeof SendToTerminalInputSchema>;

/** Length cap for the command preview in tool output. */
const COMMAND_PREVIEW_MAX = 80;
/** Length cap for the captured-output tail surfaced to the agent. */
const OUTPUT_PREVIEW_MAX = 4_000;

function commandPreview(command: string): string {
  if (command.length <= COMMAND_PREVIEW_MAX) return command;
  return `${command.slice(0, COMMAND_PREVIEW_MAX)}…`;
}

export class SendToTerminalTool extends defineTool({
  name: 'send_to_terminal',
  description: `Run a command in a VS Code integrated terminal — use this instead of \`bash\` when the command needs a real TTY: \`sudo\` password prompts, package managers that ask for confirmation (e.g. \`brew install --cask\`), or anything that drops the user into an interactive UI. Approval reuses the regular \`bash\` approval dialog. When the terminal has shell integration enabled (bash/zsh/pwsh/fish in a VS Code-launched terminal), the tool returns the exit code and a tail of the captured output. When shell integration is unavailable the tool reports \`captured: false\` and you must wait for the user to confirm completion before re-probing. Do NOT use this to bypass \`bash\` approvals on commands that would work in \`bash\`.`,
  schema: SendToTerminalInputSchema,
}) {
  protected async execute(input: SendToTerminalInput): Promise<ToolResult> {
    const command = input.command.trim();
    if (command.length === 0) {
      throw new ToolError('Refusing to send an empty command to the terminal.');
    }

    // Reuse the same approval dialog the `bash` tool uses. The user
    // sees the exact command before anything is sent to the terminal.
    const approval = await requestBashApproval({ command });
    if (!approval.accepted) {
      return buildBashApprovalRejectedResult(command, approval.userMessage);
    }

    const platform = getSetupPlatform();
    const label = input.label.trim();
    const name = `TeXRA: ${label}`;
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const reason = input.reason.trim();
    const preview = commandPreview(command);

    const result = await platform.terminal.runCommand({
      name,
      command,
      timeoutMs,
    });

    if (!result.captured) {
      return {
        summary: `Ran command in terminal "${name}" (no output capture)`,
        output:
          `Ran a command in the integrated terminal "${name}" — preview: \`${preview}\`. ` +
          `Reason: ${reason}. ` +
          'Shell integration was not available on this terminal, so I cannot read back the exit code or output. ' +
          'Wait for the user to tell you the command finished (and any password / confirmation prompts are answered) before re-probing with `verify_setup` or `probe_environment`.',
      };
    }

    if (result.timedOut) {
      return {
        summary: `Command in terminal "${name}" timed out after ${(timeoutMs / 1000).toFixed(0)}s`,
        output:
          `The command was running in "${name}" — preview: \`${preview}\` — but did not finish within ${(timeoutMs / 1000).toFixed(0)}s. ` +
          'It may still be running in the terminal; ask the user whether to keep waiting, raise the `timeout`, or interrupt it (Ctrl+C in the terminal). ' +
          (result.output
            ? 'Captured output so far is appended below.\n\n' +
              wrapOutput(truncateWithEllipsis(result.output, OUTPUT_PREVIEW_MAX))
            : 'No output was captured before the timeout.'),
      };
    }

    const exit = result.exitCode;
    const ok = exit === 0;
    const exitLabel =
      exit === undefined
        ? 'unknown (terminal interrupted before completion)'
        : String(exit);

    const outputBlock = result.output.trim()
      ? wrapOutput(truncateWithEllipsis(result.output, OUTPUT_PREVIEW_MAX))
      : '(no output captured)';

    return {
      summary: ok
        ? `Ran command in terminal "${name}" (exit 0)`
        : `Command in terminal "${name}" exited ${exitLabel}`,
      output:
        `Ran in integrated terminal "${name}" — preview: \`${preview}\`. ` +
        `Reason: ${reason}. Exit code: ${exitLabel}.\n\n` +
        outputBlock,
    };
  }
}

function wrapOutput(text: string): string {
  return '```\n' + text + '\n```';
}
