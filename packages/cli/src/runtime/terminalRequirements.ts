export type InteractiveTerminalFailureReason = 'headless' | 'dumb-terminal';

interface InteractiveTerminalContext {
  readonly mode: 'headless' | 'interactive';
  readonly stdoutIsTty?: boolean;
  readonly termIsDumb?: boolean;
}

export function interactiveTerminalFailure(
  context: InteractiveTerminalContext,
): InteractiveTerminalFailureReason | undefined {
  if (context.mode === 'headless' || !context.stdoutIsTty) {
    return 'headless';
  }
  if (context.termIsDumb) return 'dumb-terminal';
  return undefined;
}

export function dumbTerminalMessage(
  command: string,
  options: { commandName?: string; nonInteractiveFallback?: string } = {},
): string {
  const commandName = options.commandName || 'texra';
  const fallback =
    options.nonInteractiveFallback == null
      ? ''
      : ` For non-interactive runs, use ${options.nonInteractiveFallback}.`;
  return `${commandName} ${command} needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with \`TERM=xterm-256color\`.${fallback}`;
}

export function formatInteractiveTerminalFailure(
  reason: InteractiveTerminalFailureReason,
  options: {
    readonly headlessMessage: string;
    readonly dumbTerminalCommand: string;
    readonly dumbTerminalOptions?: {
      readonly commandName?: string;
      readonly nonInteractiveFallback?: string;
    };
  },
): string {
  if (reason === 'headless') return options.headlessMessage;
  return dumbTerminalMessage(
    options.dumbTerminalCommand,
    options.dumbTerminalOptions,
  );
}
