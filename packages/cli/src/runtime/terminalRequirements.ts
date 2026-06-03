import type { CliContext } from './cliContext';

export type InteractiveTerminalFailureReason = 'headless' | 'dumb-terminal';

export function interactiveTerminalFailure(
  context: Pick<CliContext, 'mode' | 'stdoutIsTty' | 'termIsDumb'>,
): InteractiveTerminalFailureReason | undefined {
  if (context.mode === 'headless' || context.stdoutIsTty !== true) {
    return 'headless';
  }
  if (context.termIsDumb === true) return 'dumb-terminal';
  return undefined;
}

export function dumbTerminalMessage(
  command: string,
  options: { nonInteractiveFallback?: string } = {},
): string {
  const fallback =
    options.nonInteractiveFallback == null
      ? ''
      : ` For non-interactive runs, use ${options.nonInteractiveFallback}.`;
  return `texra ${command} needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with \`TERM=xterm-256color\`.${fallback}`;
}

export function formatInteractiveTerminalFailure(
  reason: InteractiveTerminalFailureReason,
  options: {
    readonly headlessMessage: string;
    readonly dumbTerminalCommand: string;
    readonly dumbTerminalOptions?: { readonly nonInteractiveFallback?: string };
  },
): string {
  if (reason === 'headless') return options.headlessMessage;
  return dumbTerminalMessage(
    options.dumbTerminalCommand,
    options.dumbTerminalOptions,
  );
}
