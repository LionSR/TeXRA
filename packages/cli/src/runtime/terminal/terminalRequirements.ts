import type { CliContext } from '../platform/cliContext';

type InteractiveTerminalFailureReason = 'headless' | 'dumb-terminal';

type InteractiveTerminalContext = Pick<
  CliContext,
  'mode' | 'stdoutIsTty' | 'termIsDumb'
>;

export function interactiveTerminalFailure(
  context: InteractiveTerminalContext,
): InteractiveTerminalFailureReason | undefined {
  if (context.mode === 'headless' || !context.stdoutIsTty) {
    return 'headless';
  }
  if (context.termIsDumb) return 'dumb-terminal';
  return undefined;
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
  const commandName = options.dumbTerminalOptions?.commandName || 'texra';
  const fallback = options.dumbTerminalOptions?.nonInteractiveFallback;
  const fallbackHint =
    fallback == null ? '' : ` For non-interactive runs, use ${fallback}.`;
  return `${commandName} ${options.dumbTerminalCommand} needs an interactive terminal (TERM=dumb disables cursor controls). Try \`TERM=xterm-256color\`.${fallbackHint}`;
}
