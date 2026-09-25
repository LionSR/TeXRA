/**
 * Node.js semver range the `texra` CLI supports; the same value
 * `packages/cli/package.json` declares as `engines.node`, so `texra doctor`
 * and npm never disagree about what runs.
 *
 * The official Effect SQLite client requires the `node:sqlite` backup,
 * columns and setReturnArrays APIs, and the bundled undici 8.x requires
 * `>=22.19.0`. Node 22.19.0 and Node 24 satisfy both; Node 23 lacks
 * setReturnArrays.
 */
export const TEXRA_CLI_SUPPORTED_NODE_RANGE = '^22.19.0 || >=24.0.0';

type InteractiveTerminalFailureReason = 'headless' | 'dumb-terminal';

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

function dumbTerminalMessage(
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
