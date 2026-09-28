// The Claude Code hooks protocol, typed at TeXRA's edge
// (https://code.claude.com/docs/en/hooks): each event's JSON on stdin, and
// each event's JSON or plain text on stdout with its exit code. Every event's
// input and output schema lives here, and a hook's output is parsed here
// once. TeXRA defines no hook format of its own
// (`2026-09-28-code-plugins-hooks-v1.md`); the configuration that names the
// hooks is `./hookConfig`'s.

// Third-party imports
import { z } from 'zod';

// Local imports - shared contracts
import type { HookEvent, HookStatus } from '@shared/schemas';

// --------------------------------------------------------------------- input

const CommonInput = {
  session_id: z.string(),
  cwd: z.string(),
  permission_mode: z.enum(['default', 'bypassPermissions']),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
};

/** Each event's stdin, as the reference names its fields. TeXRA keeps no
 *  transcript file, so `transcript_path` is not sent. */
const HookInputSchema = z.discriminatedUnion('hook_event_name', [
  z.object({
    ...CommonInput,
    hook_event_name: z.literal('SessionStart'),
    source: z.literal('startup'),
    model: z.string().optional(),
  }),
  z.object({
    ...CommonInput,
    hook_event_name: z.literal('UserPromptSubmit'),
    prompt: z.string(),
  }),
  z.object({
    ...CommonInput,
    hook_event_name: z.literal('PreToolUse'),
    tool_name: z.string(),
    tool_input: z.unknown(),
    tool_use_id: z.string(),
  }),
  z.object({
    ...CommonInput,
    hook_event_name: z.literal('PostToolUse'),
    tool_name: z.string(),
    tool_input: z.unknown(),
    tool_response: z.unknown(),
    tool_use_id: z.string(),
    duration_ms: z.int().nonnegative().optional(),
  }),
  z.object({
    ...CommonInput,
    hook_event_name: z.literal('Stop'),
    stop_hook_active: z.literal(false),
    last_assistant_message: z.string(),
  }),
  z.object({
    ...CommonInput,
    hook_event_name: z.literal('SubagentStop'),
    stop_hook_active: z.literal(false),
    agent_id: z.string(),
    agent_type: z.string(),
    last_assistant_message: z.string(),
  }),
]);
export type HookInput = z.input<typeof HookInputSchema>;

/** The JSON a hook reads on stdin. */
export const encodeHookInput = (input: HookInput): string =>
  JSON.stringify(HookInputSchema.parse(input));

// -------------------------------------------------------------------- output

const CommonOutput = {
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  terminalSequence: z.string().optional(),
};

const specific = <E extends HookEvent, S extends z.ZodRawShape>(
  event: E,
  shape: S,
) => z.object({ hookEventName: z.literal(event), ...shape }).optional();

const StopOutput = <E extends 'Stop' | 'SubagentStop'>(event: E) =>
  z.object({
    ...CommonOutput,
    decision: z.literal('block').optional(),
    reason: z.string().optional(),
    hookSpecificOutput: specific(event, {
      additionalContext: z.string().optional(),
    }),
  });

/** Each event's stdout JSON. A field the reference defines and v1 does not
 *  act on is still validated, so it can be named as ignored. */
const HookOutputSchemas = {
  SessionStart: z.object({
    ...CommonOutput,
    hookSpecificOutput: specific('SessionStart', {
      additionalContext: z.string().optional(),
      initialUserMessage: z.string().optional(),
      sessionTitle: z.string().optional(),
      watchPaths: z.array(z.string()).optional(),
      reloadSkills: z.boolean().optional(),
    }),
  }),
  UserPromptSubmit: z.object({
    ...CommonOutput,
    decision: z.literal('block').optional(),
    reason: z.string().optional(),
    hookSpecificOutput: specific('UserPromptSubmit', {
      additionalContext: z.string().optional(),
      sessionTitle: z.string().optional(),
      suppressOriginalPrompt: z.boolean().optional(),
    }),
  }),
  PreToolUse: z.object({
    ...CommonOutput,
    // Deprecated for this event; `approve`/`block` read as allow/deny.
    decision: z.enum(['approve', 'block']).optional(),
    reason: z.string().optional(),
    hookSpecificOutput: specific('PreToolUse', {
      permissionDecision: z.enum(['allow', 'deny', 'ask', 'defer']).optional(),
      permissionDecisionReason: z.string().optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      additionalContext: z.string().optional(),
    }),
  }),
  PostToolUse: z.object({
    ...CommonOutput,
    decision: z.literal('block').optional(),
    reason: z.string().optional(),
    hookSpecificOutput: specific('PostToolUse', {
      additionalContext: z.string().optional(),
      classifierContext: z.string().optional(),
      updatedToolOutput: z.unknown().optional(),
      updatedMCPToolOutput: z.unknown().optional(),
    }),
  }),
  Stop: StopOutput('Stop'),
  SubagentStop: StopOutput('SubagentStop'),
} as const satisfies Record<HookEvent, z.ZodType>;

type HookOutput = z.infer<(typeof HookOutputSchemas)[HookEvent]>;

/** How a hook process ended, as the runner saw it. */
export type HookRun =
  | {
      readonly kind: 'exited';
      /** Null when a signal it was not sent by the runner ended it. */
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: 'timeout';
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'unstartable'; readonly message: string };

/** What one hook invocation does in v1, before it is recorded. */
interface HookVerdict {
  readonly status: HookStatus;
  /** A `PreToolUse` denial's reason. */
  readonly deny: string | null;
  /** Text the model reads beside the prompt or the tool result. */
  readonly context: string | null;
  /** What it asked for that v1 parses and does not act on. */
  readonly ignored: readonly string[];
  /** A message the hook shows the user. */
  readonly systemMessage: string | null;
  /** Why the invocation had no effect, or what it asked for in vain: logged
   *  at warn level, never dropped. */
  readonly warning: string | null;
}

/** `PreToolUse`'s deprecated top-level decisions, as the reference maps them. */
const DEPRECATED_DECISIONS = { approve: 'allow', block: 'deny' } as const;

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

const joined = (parts: readonly (string | undefined)[]) => {
  const text = parts
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n');
  return text === '' ? null : text;
};

/** The effect of output that parsed and validated. */
function effectOf(event: HookEvent, output: HookOutput) {
  const ignored: string[] = [];
  if (output.continue === false) ignored.push('continue: false');
  let deny: string | null = null;
  let context: string | null = null;
  switch (event) {
    case 'PreToolUse': {
      const pre = HookOutputSchemas.PreToolUse.parse(output);
      const hso = pre.hookSpecificOutput;
      const decision =
        hso?.permissionDecision ??
        (pre.decision && DEPRECATED_DECISIONS[pre.decision]);
      if (decision === 'deny')
        deny =
          hso?.permissionDecisionReason ??
          pre.reason ??
          'Denied by a PreToolUse hook.';
      else if (decision === 'ask' || decision === 'defer')
        ignored.push(
          `permissionDecision: "${decision}" (the approval policy decides)`,
        );
      if (hso?.updatedInput !== undefined) ignored.push('updatedInput');
      context = joined([hso?.additionalContext]);
      break;
    }
    case 'PostToolUse': {
      const post = HookOutputSchemas.PostToolUse.parse(output);
      const hso = post.hookSpecificOutput;
      context = joined([
        post.decision === 'block' ? post.reason : undefined,
        hso?.additionalContext,
      ]);
      if (hso?.updatedToolOutput !== undefined)
        ignored.push('updatedToolOutput');
      if (hso?.updatedMCPToolOutput !== undefined)
        ignored.push('updatedMCPToolOutput');
      break;
    }
    case 'UserPromptSubmit': {
      const prompt = HookOutputSchemas.UserPromptSubmit.parse(output);
      context = joined([prompt.hookSpecificOutput?.additionalContext]);
      if (prompt.decision === 'block')
        ignored.push('decision: "block" (blocking a prompt)');
      if (prompt.hookSpecificOutput?.sessionTitle !== undefined)
        ignored.push('sessionTitle');
      break;
    }
    case 'SessionStart': {
      const start = HookOutputSchemas.SessionStart.parse(output);
      const hso = start.hookSpecificOutput;
      context = joined([hso?.additionalContext]);
      for (const field of [
        'initialUserMessage',
        'sessionTitle',
        'watchPaths',
        'reloadSkills',
      ] as const)
        if (hso?.[field] !== undefined) ignored.push(field);
      break;
    }
    case 'Stop':
    case 'SubagentStop': {
      const stop = HookOutputSchemas[event].parse(output);
      if (stop.decision === 'block')
        ignored.push('decision: "block" (blocking a stop)');
      if (stop.hookSpecificOutput?.additionalContext !== undefined)
        ignored.push('additionalContext (continuing past a stop)');
      break;
    }
  }
  return {
    deny,
    context,
    ignored,
    systemMessage: output.systemMessage ?? null,
  };
}

const ignoredWarning = (event: HookEvent, ignored: readonly string[]) =>
  ignored.length === 0
    ? null
    : `A ${event} hook asked for ${ignored.join(', ')}, which TeXRA does not act on in v1.`;

/**
 * Read one hook run the way the reference does, for the v1 events: stdout
 * that starts with `{` and ends with `}` is JSON, validated against the
 * event's schema; exit 2 blocks (only `PreToolUse` in v1; the stop and
 * prompt blocks are named as ignored); another non-zero exit with valid JSON
 * lets the JSON decide, and without it is a non-blocking failure; plain
 * stdout is context on `SessionStart` and `UserPromptSubmit` only. Malformed
 * output, a timeout and a process that never started have no effect and
 * always carry a warning.
 */
export function interpretHookRun(event: HookEvent, run: HookRun): HookVerdict {
  const none = {
    deny: null,
    context: null,
    ignored: [],
    systemMessage: null,
  };
  if (run.kind === 'unstartable')
    return {
      ...none,
      status: 'unstartable',
      warning: `A ${event} hook could not start: ${run.message}`,
    };
  if (run.kind === 'timeout')
    return {
      ...none,
      status: 'timeout',
      warning: `A ${event} hook timed out and was killed; its output was discarded.`,
    };
  const text = run.stdout.trim();
  const stderr = run.stderr.trim();
  let parsed: HookOutput | undefined;
  let malformed: string | undefined;
  if (text.startsWith('{') && text.endsWith('}')) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      malformed = `its output is not valid JSON (${error instanceof Error ? error.message : String(error)})`;
    }
    if (malformed === undefined) {
      const result = HookOutputSchemas[event].safeParse(json);
      if (result.success) parsed = result.data;
      else
        malformed = `its output does not match the ${event} output: ${z.prettifyError(result.error)}`;
    }
  }
  const effect = parsed === undefined ? null : effectOf(event, parsed);
  if (run.exitCode === 2) {
    const ignored = [...(effect?.ignored ?? [])];
    let deny: string | null = null;
    let context = effect?.context ?? null;
    const reason =
      effect?.deny ?? (stderr || `A ${event} hook exited with code 2.`);
    if (event === 'PreToolUse') deny = reason;
    else if (event === 'PostToolUse')
      context = joined([context ?? undefined, stderr]);
    else if (event !== 'SessionStart')
      ignored.push(
        `exit code 2 (blocking a ${event === 'UserPromptSubmit' ? 'prompt' : 'stop'})`,
      );
    const warnings = [
      malformed === undefined
        ? null
        : `A ${event} hook exited with code 2 and ${malformed}.`,
      event === 'SessionStart' && stderr !== ''
        ? `A SessionStart hook exited with code 2: ${firstLine(stderr)}`
        : null,
      ignoredWarning(event, ignored),
    ].filter((line): line is string => line !== null);
    return {
      status: 'blocked',
      deny,
      context,
      ignored,
      systemMessage: effect?.systemMessage ?? null,
      warning: warnings.length === 0 ? null : warnings.join(' '),
    };
  }
  if (malformed !== undefined)
    return {
      ...none,
      status: 'malformed',
      warning: `A ${event} hook had no effect: ${malformed}.`,
    };
  if (effect !== null)
    return {
      ...effect,
      status: 'ok',
      warning: ignoredWarning(event, effect.ignored),
    };
  if (run.exitCode !== 0)
    return {
      ...none,
      status: 'failed',
      warning: `A ${event} hook ${run.exitCode === null ? 'was killed by a signal' : `failed with exit code ${run.exitCode}`}${stderr ? `: ${firstLine(stderr)}` : ''}; it had no effect.`,
    };
  return {
    ...none,
    status: 'ok',
    context:
      (event === 'SessionStart' || event === 'UserPromptSubmit') && text !== ''
        ? text
        : null,
    warning: null,
  };
}
