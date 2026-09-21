// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { TERMINAL_OUTPUT_MAX_CHARS } from '@common/terminalOutput';
import { ToolError } from '@shared/schemas';
import { executed } from '@tools/core/result';

// Local file imports
import { nullishWithDefault } from '@tools/core/inputSchema';
import { defineTool } from '../core/define';
import { SetupPlatform } from './platform';

const DEFAULT_TIMEOUT_MS = 300_000;
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
  label: nullishWithDefault(z.string(), 'setup').describe(
    `Short suffix for the terminal tab name; the tool prepends "${TERMINAL_NAME_PREFIX}".`,
  ),
  timeout: nullishWithDefault(
    z.int().min(1_000).max(900_000),
    DEFAULT_TIMEOUT_MS,
  ).describe(
    'Hard cap (ms) on how long to wait for the run. Defaults to 5 min.',
  ),
});

type SendToTerminalInput = z.infer<typeof SendToTerminalInputSchema>;

const sendToTerminal = Effect.fn('SendToTerminalTool.execute')(function* (
  input: SendToTerminalInput,
) {
  const { terminal } = yield* SetupPlatform;
  if (!terminal) {
    return yield* Effect.fail(
      new ToolError(
        'VS Code integrated terminal execution is unavailable in this host.',
      ),
    );
  }
  const command = input.command.trim();
  const name = TERMINAL_NAME_PREFIX + input.label.trim();

  const { exitCode, output, timedOut } = yield* terminal({
    name,
    command,
    timeoutMs: input.timeout,
  }).pipe(
    // The host's own fault, reported as the tool's error rather than as an
    // `unknown` the run loop has to guess at. `terminal-unavailable` means
    // no command ran; `execution-failed` means one may have.
    Effect.catchTag('TerminalRunFailed', (failure) =>
      Effect.fail(
        new ToolError(
          failure.reason === 'terminal-unavailable'
            ? `${failure.message} The command was not run; retry, or run it yourself in a terminal.`
            : `${failure.message} Re-probe with \`verify_setup\` to see whether it took effect.`,
        ),
      ),
    ),
  );

  const exitLabel = exitCode === undefined ? 'unknown' : String(exitCode);
  const summary = timedOut
    ? `"${name}" timed out after ${Math.round(input.timeout / 1000)}s`
    : `"${name}" exited ${exitLabel}`;
  const outputText = output.trim() ? `\n\n${output}` : '';

  return executed(summary + outputText, summary);
});

export const SendToTerminalTool = defineTool({
  name: 'send_to_terminal',
  // Requires a VS Code terminal.
  unavailableHosts: ['cli', 'desktop'],
  requiresApproval: true,
  description: `Run a command in a VS Code integrated terminal: use this instead of \`bash\` when the command needs a real TTY: \`sudo\` password prompts, package managers that ask for confirmation (e.g. \`brew install --cask\`), or anything that drops the user into an interactive UI. Approval reuses the regular \`bash\` approval dialog. Returns an exit code and an ANSI-stripped output tail of up to ${TERMINAL_OUTPUT_MAX_CHARS} characters when shell integration is active (bash/zsh/pwsh/fish in VS Code-launched terminals); returns an undefined exit code with empty output otherwise: re-probe with \`verify_setup\` to confirm what actually happened. Do NOT use this to bypass \`bash\` approvals on commands that would work in \`bash\`.`,
  schema: SendToTerminalInputSchema,
  // Approval reuses the regular bash dialog: the loop gates the same trimmed
  // command the terminal receives. No cwd: the command goes to a named
  // terminal whose shell keeps its own directory, which this tool never sets.
  guard: {
    bash: (input: SendToTerminalInput) => Effect.succeed(input.command.trim()),
    cwd: 'unknown',
  },
  execute: sendToTerminal,
});
