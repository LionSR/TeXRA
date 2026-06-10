// In-tree slash command registry.

import {
  editDistance,
  typoSuggestionThreshold,
} from '@utils/text/editDistance';

/** Help-screen grouping. Uncategorized commands land in a trailing
 *  "Other" section, so plugin-style registrations stay visible. */
export type SlashCommandCategory = 'session' | 'configuration' | 'account';

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
  /** Where the command appears in the grouped `/help` listing. */
  readonly category?: SlashCommandCategory;
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
   * Status-bar verb for Escape while `formComponent` owns input. Defaults to
   * `close`; use `cancel` for forms where Escape discards a pending choice.
   */
  readonly formEscapeAction?: string;
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

/** Lowercased name + aliases a command can be addressed by. */
function commandCandidates(command: SlashCommand): string[] {
  return [command.name, ...(command.aliases ?? [])].map((name) =>
    name.toLowerCase(),
  );
}

export function findSlashCommand(
  nameOrAlias: string,
): SlashCommand | undefined {
  const lower = nameOrAlias.toLowerCase();
  return listSlashCommands().find((cmd) =>
    commandCandidates(cmd).includes(lower),
  );
}

/**
 * Returns registered commands matching `prefix`, case-insensitively and in
 * registration order. Prefix matches (on name or alias) win; when there are
 * none, falls back to substring matches (`/odel` still finds `/model`), and
 * finally to the closest typo suggestion (`/hlp` → `/help`) so the palette
 * recovers from mistypes instead of going blank.
 */
export function matchSlashCommands(prefix: string): readonly SlashCommand[] {
  const lower = prefix.toLowerCase();
  const commands = listSlashCommands();
  const matching = (test: (candidate: string) => boolean) =>
    commands.filter((cmd) => commandCandidates(cmd).some(test));

  const prefixMatches = matching((candidate) => candidate.startsWith(lower));
  if (prefixMatches.length > 0 || !lower) return prefixMatches;

  const substringMatches = matching((candidate) => candidate.includes(lower));
  if (substringMatches.length > 0) return substringMatches;

  const suggestion = suggestSlashCommand(lower);
  return suggestion ? [suggestion] : [];
}

/**
 * Best "did you mean" candidate for a mistyped command name: the registered
 * command (matching by name or alias) within the shared typo threshold,
 * closest first, alphabetical on ties.
 */
export function suggestSlashCommand(
  nameOrAlias: string,
): SlashCommand | undefined {
  const token = nameOrAlias.toLowerCase();
  let best:
    | {
        readonly command: SlashCommand;
        readonly candidate: string;
        readonly distance: number;
      }
    | undefined;

  for (const command of listSlashCommands()) {
    for (const candidate of commandCandidates(command)) {
      const distance = editDistance(token, candidate);
      if (distance > typoSuggestionThreshold(token, candidate)) continue;
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && candidate < best.candidate)
      ) {
        best = { command, candidate, distance };
      }
    }
  }

  return best?.command;
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
  if (!text.startsWith('/')) {
    const trimmed = text.trim();
    if (trimmed === '\\clear') return { name: 'clear', remainder: '' };
    return undefined;
  }
  const body = text.slice(1);
  const ws = body.search(/\s/);
  if (ws === -1) return { name: body, remainder: '' };
  return { name: body.slice(0, ws), remainder: body.slice(ws + 1) };
}
