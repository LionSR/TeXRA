// In-tree slash command registry.

/** A structured-form component renders inline when the user picks a slash
 *  command that declares one (e.g. `/api`). Calls `onDone(result)` to
 *  commit the user's selection or `onDone(undefined)` on cancel. */
export interface SlashFormProps<T = unknown> {
  readonly onDone: (result: T | undefined) => void;
  readonly remainder: string;
  readonly availableRows?: number;
}

export interface SlashCommand {
  /** Command name without the leading `/`. */
  readonly name: string;
  readonly description: string;
  /** Optional alias list for autocomplete (matches both `name` and aliases). */
  readonly aliases?: readonly string[];
  /**
   * Fire-and-forget handler. Receives the raw remainder of the command line
   * (everything after the command name + whitespace).
   */
  readonly handler?: (remainder: string) => void;
  /**
   * Optional structured-form renderer. When present, picking the command
   * mounts this component instead of routing through `handler` / the input.
   */
  readonly formComponent?: React.ComponentType<SlashFormProps>;
  /**
   * Set for commands that take a free-text inline argument (e.g. `/foo bar`).
   * When true, Enter in the palette *completes* the command into the input
   * (with a trailing space) so the user can type the argument, rather than
   * running it argument-less. No built-in command needs this today — every
   * arg-taking command uses `formComponent` instead — but it's the hook for
   * future inline-argument commands. See `slashPickIntent`.
   */
  readonly takesArgs?: boolean;
}

export type SlashPickIntent = 'complete' | 'submit';

const COMMANDS = new Map<string, SlashCommand>();

export function registerSlashCommand(command: SlashCommand): void {
  COMMANDS.set(command.name, command);
}

export function unregisterSlashCommand(name: string): void {
  COMMANDS.delete(name);
}

export function listSlashCommands(): readonly SlashCommand[] {
  return [...COMMANDS.values()];
}

/**
 * Returns registered commands whose name or an alias starts with `prefix`.
 * Results are case-insensitive and preserve registration order.
 */
export function matchSlashCommands(prefix: string): readonly SlashCommand[] {
  const lower = prefix.toLowerCase();
  return listSlashCommands().filter((cmd) => {
    if (cmd.name.toLowerCase().startsWith(lower)) return true;
    return cmd.aliases?.some((a) => a.toLowerCase().startsWith(lower)) ?? false;
  });
}

export function slashPickIntent(
  command: SlashCommand,
  acceptKey: 'enter' | 'tab',
): SlashPickIntent {
  // Tab always just fills the input so the user can keep editing (e.g. add
  // arguments). Enter runs the highlighted command immediately — except for:
  //  - commands that mount a structured form, which need the input cleared so
  //    the form can take over (InputBar handles that branch before reading the
  //    intent, so 'complete' here is just a safe default for them); and
  //  - commands that take a free-text inline argument, which complete to
  //    `/cmd ` so the user can type the argument instead of running blank.
  if (acceptKey !== 'enter') return 'complete';
  if (command.formComponent || command.takesArgs) return 'complete';
  return 'submit';
}

/**
 * Parse a `"/cmd remainder"` input into `{ name, remainder }`.
 * Also accepts `\clear` as a compatibility alias.
 * Returns `undefined` if `text` is not a slash command.
 */
export function parseSlashInput(
  text: string,
): { name: string; remainder: string } | undefined {
  const prefix = text.startsWith('/') ? '/' : '';
  if (!prefix) {
    const trimmed = text.trim();
    if (trimmed === '\\clear') return { name: 'clear', remainder: '' };
    return undefined;
  }
  const body = text.slice(prefix.length);
  const ws = body.search(/\s/);
  if (ws === -1) return { name: body, remainder: '' };
  return { name: body.slice(0, ws), remainder: body.slice(ws + 1) };
}
