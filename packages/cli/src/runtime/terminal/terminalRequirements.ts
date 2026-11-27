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

/**
 * Why `command` cannot open its interactive terminal here, worded for its
 * usage error; undefined when it can. Headless takes precedence: in CI,
 * where headless and `TERM=dumb` often co-occur, the actionable advice is
 * the scripting alternative (`headlessMessage`), not the TERM fix.
 */
export function interactiveTerminalRejection(
  context: InteractiveTerminalContext & Pick<CliContext, 'commandName'>,
  command: string,
  options: {
    readonly headlessMessage: string;
    /** What a non-interactive run uses instead, named on a dumb terminal. */
    readonly nonInteractiveFallback?: string;
  },
): string | undefined {
  const reason = interactiveTerminalFailure(context);
  if (reason === undefined) return undefined;
  if (reason === 'headless') return options.headlessMessage;
  const fallbackHint =
    options.nonInteractiveFallback === undefined
      ? ''
      : ` For non-interactive runs, use ${options.nonInteractiveFallback}.`;
  return `${context.commandName} ${command} needs an interactive terminal (TERM=dumb disables cursor controls). Try \`TERM=xterm-256color\`.${fallbackHint}`;
}
