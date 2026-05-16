// In-tree slash command registry.
//
// Phase 5 ships an inline-action registry (just `name`, `description`,
// `handler`); structured-form commands (`/model`, `/status`, `/agent`)
// register via a `formComponent` field that lands in a follow-up PR per the
// PRD's Phase-5 split note.

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

/** Returns the registered commands whose name or any alias starts with the
 *  given prefix (case-insensitive). Ordered by registration. */
export function matchSlashCommands(prefix: string): readonly SlashCommand[] {
  const lower = prefix.toLowerCase();
  return listSlashCommands().filter((cmd) => {
    if (cmd.name.toLowerCase().startsWith(lower)) return true;
    return cmd.aliases?.some((a) => a.toLowerCase().startsWith(lower)) ?? false;
  });
}

/** Parse a `"/cmd remainder"` input into `{ name, remainder }`. Returns
 *  `undefined` if `text` doesn't begin with `/`. */
export function parseSlashInput(
  text: string,
): { name: string; remainder: string } | undefined {
  if (!text.startsWith('/')) return undefined;
  const body = text.slice(1);
  const ws = body.search(/\s/);
  if (ws === -1) return { name: body, remainder: '' };
  return { name: body.slice(0, ws), remainder: body.slice(ws + 1) };
}
