// In-tree slash command registry.

/** A structured-form component renders inline when the user picks a slash
 *  command that declares one (e.g. `/model`). Calls `onDone(result)` to
 *  commit the user's selection or `onDone(undefined)` on cancel. */
export interface SlashFormProps<T = unknown> {
  readonly onDone: (result: T | undefined) => void;
  readonly remainder: string;
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
}

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

/**
 * Parse a `"/cmd remainder"` input into `{ name, remainder }`.
 * Returns `undefined` if `text` does not begin with `/`.
 */
export function parseSlashInput(
  text: string,
): { name: string; remainder: string } | undefined {
  if (!text.startsWith('/')) return undefined;
  const body = text.slice(1);
  const ws = body.search(/\s/);
  if (ws === -1) return { name: body, remainder: '' };
  return { name: body.slice(0, ws), remainder: body.slice(ws + 1) };
}
