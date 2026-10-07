// A plugin's Claude Code hooks configuration, read as the reference writes
// it (https://code.claude.com/docs/en/hooks): the `hooks.json` events, their
// matchers and command handlers, and the tool names a matcher sees. What a
// hook reads and prints is `./hookProtocol`'s
// (`2026-09-28-code-plugins-hooks-v1.md`).

// Third-party imports
import { z } from 'zod';

// Local imports - shared contracts
import { SUPPORTED_HOOK_EVENTS, type HookEvent } from '@shared/schemas';

/** Every event the reference names; a configured event outside this list is
 *  reported as unknown, one inside it but unsupported as not run. */
const REFERENCE_HOOK_EVENTS = new Set<string>([
  ...SUPPORTED_HOOK_EVENTS,
  'Setup',
  'UserPromptExpansion',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'SubagentStart',
  'TaskCreated',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
]);

const isSupportedEvent = (event: string): event is HookEvent =>
  (SUPPORTED_HOOK_EVENTS as readonly string[]).includes(event);

/** One handler as the reference declares it; the fields TeXRA does not read
 *  are stripped. */
const HookHandlerSchema = z.object({
  type: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  timeout: z.number().positive().optional(),
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(),
  shell: z.string().optional(),
  /** Accepted, not evaluated: the hook runs for every call its matcher
   *  matches, which the reference allows when it cannot tell what a command
   *  runs (`2026-09-28-code-plugins-hooks-v1.md`). */
  if: z.string().optional(),
});

const MatcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookHandlerSchema),
});

/** The events map: event name to its matcher groups. */
const HookEventsSchema = z.record(z.string(), z.array(MatcherGroupSchema));

/** A hooks file (`hooks/hooks.json`, or a path the manifest names), or the
 *  manifest's inline `hooks` object: the events under `hooks`, optionally
 *  beside a `description`. */
export const HooksConfigSchema = z.object({
  description: z.string().optional(),
  hooks: HookEventsSchema,
});
type HooksConfig = z.infer<typeof HooksConfigSchema>;

/** One command hook TeXRA runs: its event, matcher and command as the
 *  plugin wrote them, placeholders unexpanded. */
export interface ConfiguredHook {
  /** Its position in the plugin's configuration: `<source>/<event>/<group>/<handler>`. */
  readonly id: string;
  readonly event: HookEvent;
  readonly matcher: string | undefined;
  readonly command: string;
  /** Present: exec form, no shell. Absent: shell form (`sh -c`). */
  readonly args: readonly string[] | undefined;
  readonly timeoutSeconds: number;
}

/** The reference's default timeouts for a command hook, in seconds. */
const defaultTimeout = (event: HookEvent) =>
  event === 'UserPromptSubmit' ? 30 : 600;

/** An exact matcher: only letters, digits, `_`, `-`, spaces, `,` and `|`. */
const EXACT_MATCHER = /^[\w\s,|-]+$/;

/**
 * The command hooks of one configuration `source` (a file or the manifest)
 * that TeXRA runs, and one line for each entry it does not: an event outside
 * v1 or the reference, a handler type other than `command`, an `async` or
 * PowerShell hook, a matcher that is not a valid regular expression.
 */
export function configuredHooks(source: string, config: HooksConfig) {
  const hooks: ConfiguredHook[] = [];
  const unsupported: string[] = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!isSupportedEvent(event)) {
      const count = groups.reduce((sum, group) => sum + group.hooks.length, 0);
      unsupported.push(
        REFERENCE_HOOK_EVENTS.has(event)
          ? `${event}: ${count} hook(s), an event TeXRA does not run`
          : `${event}: ${count} hook(s), not an event of the Claude Code hooks reference`,
      );
      continue;
    }
    for (const [g, group] of groups.entries()) {
      const matcher = group.matcher;
      if (
        matcher !== undefined &&
        matcher !== '' &&
        matcher !== '*' &&
        !EXACT_MATCHER.test(matcher) &&
        !isRegExp(matcher)
      ) {
        unsupported.push(
          `${event} matcher "${matcher}": not a valid regular expression`,
        );
        continue;
      }
      for (const [h, handler] of group.hooks.entries()) {
        const where = `${event}${matcher ? ` (${matcher})` : ''}`;
        let refused: string | null = null;
        if (handler.type !== 'command')
          refused = `a ${handler.type} hook; TeXRA runs command hooks only`;
        else if (handler.command === undefined || handler.command === '')
          refused = 'a command hook with no command';
        else if (handler.async === true || handler.asyncRewake === true)
          refused = 'an async hook';
        else if (handler.shell !== undefined && handler.shell !== 'bash')
          refused = `a ${handler.shell} hook`;
        if (refused !== null || handler.command === undefined) {
          unsupported.push(`${where}: ${refused}`);
          continue;
        }
        hooks.push({
          id: `${source}/${event}/${g}/${h}`,
          event,
          matcher,
          command: handler.command,
          args: handler.args,
          timeoutSeconds: handler.timeout ?? defaultTimeout(event),
        });
      }
    }
  }
  return { hooks, unsupported };
}

const isRegExp = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    // Reported by the caller as an unsupported matcher.
    return false;
  }
};

/**
 * Whether `matcher` selects a value named by any of `names` (a tool's
 * Claude Code name and its TeXRA name): all when absent, empty or `*`; an
 * exact list split on `|` or `,` when it holds only simple characters; an
 * unanchored regular expression otherwise (validated when configured).
 */
export function matchesHook(
  matcher: string | undefined,
  names: readonly string[],
): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (EXACT_MATCHER.test(matcher)) {
    const alternatives = matcher
      .split(/[|,]/)
      .map((name) => name.trim())
      .filter((name) => name !== '');
    return names.some((name) => alternatives.includes(name));
  }
  const pattern = new RegExp(matcher);
  return names.some((name) => pattern.test(name));
}

/** A tool input, field by field. */
type Fields = Readonly<Record<string, unknown>>;

/** The fields of `keys` the input carries, under the same names. */
const same =
  (...keys: readonly string[]) =>
  (input: Fields): Fields =>
    Object.fromEntries(keys.map((key) => [key, input[key]]));

/** A file path made absolute against the workspace; absent stays absent. */
type Absolute = (path: unknown) => unknown;

/**
 * TeXRA's tools that have a Claude Code counterpart, by TeXRA name: the name
 * a plugin's matcher and `tool_name` see, and the call's input under the
 * field names and meanings the Claude Code hooks reference documents for
 * that tool, file paths absolute. A TeXRA-only field (`literal`,
 * `max_results`) has no counterpart and is not sent.
 */
const CLAUDE_TOOLS: Readonly<
  Record<
    string,
    {
      readonly name: string;
      readonly input: (i: Fields, abs: Absolute) => Fields;
    }
  >
> = {
  bash: {
    name: 'Bash',
    input: same('command', 'description', 'timeout', 'run_in_background'),
  },
  read_file: {
    name: 'Read',
    input: (input, abs) => {
      const range = (input.range ?? {}) as { start?: unknown; end?: unknown };
      const start = typeof range.start === 'number' ? range.start : undefined;
      const end = typeof range.end === 'number' ? range.end : undefined;
      return {
        file_path: abs(input.path),
        offset: start,
        limit:
          start !== undefined && end !== undefined
            ? end - start + 1
            : undefined,
      };
    },
  },
  write_file: {
    name: 'Write',
    input: (input, abs) => ({
      file_path: abs(input.path),
      content: input.content,
    }),
  },
  edit_file: {
    name: 'Edit',
    input: (input, abs) => ({
      file_path: abs(input.path),
      old_string: input.old_str,
      new_string: input.new_str,
      replace_all: input.replace_all,
    }),
  },
  glob: {
    name: 'Glob',
    input: (input, abs) => ({ pattern: input.pattern, path: abs(input.path) }),
  },
  grep: {
    name: 'Grep',
    input: (input, abs) => ({
      ...same(
        ...['pattern', 'glob', 'output_mode', '-A', '-B', '-C', '-n', '-i'],
        ...['type', 'head_limit', 'offset', 'multiline'],
      )(input),
      path: abs(input.path),
    }),
  },
  web_fetch: { name: 'WebFetch', input: same('url', 'prompt') },
  web_search: { name: 'WebSearch', input: same('query') },
};

/**
 * A call as a Claude Code hook sees it: for a tool with a Claude Code
 * counterpart, that tool's name and its input translated (absent fields
 * dropped); any other tool, or an input that is not an object, keeps its
 * TeXRA name and input unchanged.
 */
export function claudeToolCall(
  name: string,
  input: unknown,
  abs: Absolute,
): { readonly toolName: string; readonly toolInput: unknown } {
  const tool = CLAUDE_TOOLS[name];
  if (tool === undefined || typeof input !== 'object' || input === null)
    return { toolName: name, toolInput: input };
  return {
    toolName: tool.name,
    toolInput: Object.fromEntries(
      Object.entries(tool.input(input as Fields, abs)).filter(
        ([, value]) => value != null,
      ),
    ),
  };
}
