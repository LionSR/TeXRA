// Third-party imports
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@shared/schemas';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { executed } from '@tools/core/result';
import { tailWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

const DEFAULT_TIMEOUT_MS = 300_000;
const OUTPUT_PREVIEW_MAX = 4_000;
const TERMINAL_NAME_PREFIX = 'TeXRA: ';

const SendToTerminalInputSchema = z.strictObject({
  // The single non-cosmetic guard: VS Code normalizes \n / \r when typed
  // into a terminal, so a multi-line input would smuggle a second
  // command past the bash approval dialog. The agent must rewrite
  // multi-step work as a single line.
  command: z
    .string()
    .refine((s) => !/[\r\n]/.test(s), {
      error: 'command must not contain newline / carriage-return characters.',
    })
    .describe(
      'The command to run inside the integrated terminal. One line; no embedded newlines.',
    ),
  label: z
    .string()
    .prefault('setup')
    .describe(
      `Short suffix for the terminal tab name; the tool prepends "${TERMINAL_NAME_PREFIX}".`,
    ),
  timeout: z
    .int()
    .min(1_000)
    .max(900_000)
    .nullish()
    .describe(
      'Hard cap (ms) on how long to wait for the run. Defaults to 5 min.',
    ),
});

type SendToTerminalInput = z.infer<typeof SendToTerminalInputSchema>;

export class SendToTerminalTool extends defineTool({
  name: 'send_to_terminal',
  requiresApproval: true,
  description: `Run a command in a VS Code integrated terminal: use this instead of \`bash\` when the command needs a real TTY: \`sudo\` password prompts, package managers that ask for confirmation (e.g. \`brew install --cask\`), or anything that drops the user into an interactive UI. Approval reuses the regular \`bash\` approval dialog. Returns an exit code and a tail of the output when shell integration is active (bash/zsh/pwsh/fish in VS Code-launched terminals); returns an undefined exit code with empty output otherwise: re-probe with \`verify_setup\` to confirm what actually happened. Do NOT use this to bypass \`bash\` approvals on commands that would work in \`bash\`.`,
  schema: SendToTerminalInputSchema,
}) {
  protected async execute(input: SendToTerminalInput): Promise<ToolResult> {
    const terminal = getSetupPlatform().terminal;
    if (!terminal) {
      throw new ToolError(
        'VS Code integrated terminal execution is unavailable in this host.',
      );
    }
    const command = input.command.trim();

    const approval = await requestBashApproval({ command });
    if (approval.action !== 'approve') {
      return buildBashApprovalRejectedResult(command, approval);
    }

    const name = TERMINAL_NAME_PREFIX + input.label.trim();
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;

    const { exitCode, output, timedOut } = await terminal.runCommand({
      name,
      command,
      timeoutMs,
    });

    const exitLabel = exitCode === undefined ? 'unknown' : String(exitCode);
    const summary = timedOut
      ? `"${name}" timed out after ${Math.round(timeoutMs / 1000)}s`
      : `"${name}" exited ${exitLabel}`;
    const tail = output.trim()
      ? '\n\n' + tailWithEllipsis(output, OUTPUT_PREVIEW_MAX)
      : '';

    return executed(summary + tail, summary);
  }
}
