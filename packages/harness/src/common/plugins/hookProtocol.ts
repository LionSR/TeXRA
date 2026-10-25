// The Claude Code hooks protocol, typed at the harness's edge
// (https://code.claude.com/docs/en/hooks): each event's JSON on stdin, and
// each event's JSON or plain text on stdout with its exit code. Every event's
// input and output schema lives here, and a hook's output is parsed here
// once. The harness defines no hook format of its own; the configuration
// that names the hooks is `./hookConfig`'s.

// Third-party imports
import { Result, Schema } from 'effect';

// Local imports
import { safeParseJson } from '@common/parsing/safeParseJson';
import type { HookEvent, HookStatus } from '@shared/schemas';

// --------------------------------------------------------------------- input

const CommonInput = {
  session_id: Schema.String,
  cwd: Schema.String,
  permission_mode: Schema.Literals(['default', 'bypassPermissions']),
  agent_id: Schema.optional(Schema.String),
  agent_type: Schema.optional(Schema.String),
};

/** Each event's stdin, as the reference names its fields. The harness keeps
 *  no transcript file, so `transcript_path` is not sent. */
const HookInputSchema = Schema.Union([
  Schema.Struct({
    ...CommonInput,
    hook_event_name: Schema.Literal('SessionStart'),
    source: Schema.Literal('startup'),
    model: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...CommonInput,
    hook_event_name: Schema.Literal('UserPromptSubmit'),
    prompt: Schema.String,
  }),
  Schema.Struct({
    ...CommonInput,
    hook_event_name: Schema.Literal('PreToolUse'),
    tool_name: Schema.String,
    tool_input: Schema.Unknown,
    tool_use_id: Schema.String,
  }),
  Schema.Struct({
    ...CommonInput,
    hook_event_name: Schema.Literal('PostToolUse'),
    tool_name: Schema.String,
    tool_input: Schema.Unknown,
    tool_response: Schema.Unknown,
    tool_use_id: Schema.String,
    duration_ms: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
  Schema.Struct({
    ...CommonInput,
    hook_event_name: Schema.Literal('Stop'),
    stop_hook_active: Schema.Boolean,
    last_assistant_message: Schema.String,
  }),
  Schema.Struct({
    ...CommonInput,
    hook_event_name: Schema.Literal('SubagentStop'),
    stop_hook_active: Schema.Boolean,
    agent_id: Schema.String,
    agent_type: Schema.String,
    last_assistant_message: Schema.String,
  }),
]);
export type HookInput = typeof HookInputSchema.Encoded;

/** The JSON a hook reads on stdin. */
export const encodeHookInput = (input: HookInput): string =>
  JSON.stringify(Schema.decodeUnknownSync(HookInputSchema)(input));

// -------------------------------------------------------------------- output

const CommonOutput = {
  continue: Schema.optional(Schema.Boolean),
  stopReason: Schema.optional(Schema.String),
  suppressOutput: Schema.optional(Schema.Boolean),
  systemMessage: Schema.optional(Schema.String),
  terminalSequence: Schema.optional(Schema.String),
};

const specific = <E extends HookEvent, const F extends Schema.Struct.Fields>(
  event: E,
  fields: F,
) =>
  Schema.optional(
    Schema.Struct({ hookEventName: Schema.Literal(event), ...fields }),
  );

const StopOutput = <E extends 'Stop' | 'SubagentStop'>(event: E) =>
  Schema.Struct({
    ...CommonOutput,
    decision: Schema.optional(Schema.Literal('block')),
    reason: Schema.optional(Schema.String),
    hookSpecificOutput: specific(event, {
      additionalContext: Schema.optional(Schema.String),
    }),
  });

/** Each event's stdout JSON. A field the reference defines and v1 does not
 *  act on is still validated, so it can be named as ignored. */
const HookOutputSchemas = {
  SessionStart: Schema.Struct({
    ...CommonOutput,
    hookSpecificOutput: specific('SessionStart', {
      additionalContext: Schema.optional(Schema.String),
      initialUserMessage: Schema.optional(Schema.String),
      sessionTitle: Schema.optional(Schema.String),
      watchPaths: Schema.optional(Schema.Array(Schema.String)),
      reloadSkills: Schema.optional(Schema.Boolean),
    }),
  }),
  UserPromptSubmit: Schema.Struct({
    ...CommonOutput,
    decision: Schema.optional(Schema.Literal('block')),
    reason: Schema.optional(Schema.String),
    hookSpecificOutput: specific('UserPromptSubmit', {
      additionalContext: Schema.optional(Schema.String),
      sessionTitle: Schema.optional(Schema.String),
      suppressOriginalPrompt: Schema.optional(Schema.Boolean),
    }),
  }),
  PreToolUse: Schema.Struct({
    ...CommonOutput,
    // Deprecated for this event; `approve`/`block` read as allow/deny.
    decision: Schema.optional(Schema.Literals(['approve', 'block'])),
    reason: Schema.optional(Schema.String),
    hookSpecificOutput: specific('PreToolUse', {
      permissionDecision: Schema.optional(
        Schema.Literals(['allow', 'deny', 'ask', 'defer']),
      ),
      permissionDecisionReason: Schema.optional(Schema.String),
      updatedInput: Schema.optional(
        Schema.Record(Schema.String, Schema.Unknown),
      ),
      additionalContext: Schema.optional(Schema.String),
    }),
  }),
  PostToolUse: Schema.Struct({
    ...CommonOutput,
    decision: Schema.optional(Schema.Literal('block')),
    reason: Schema.optional(Schema.String),
    hookSpecificOutput: specific('PostToolUse', {
      additionalContext: Schema.optional(Schema.String),
      classifierContext: Schema.optional(Schema.String),
      updatedToolOutput: Schema.optional(Schema.Unknown),
      updatedMCPToolOutput: Schema.optional(Schema.Unknown),
    }),
  }),
  Stop: StopOutput('Stop'),
  SubagentStop: StopOutput('SubagentStop'),
} as const satisfies Record<HookEvent, Schema.Top>;

type HookOutput = (typeof HookOutputSchemas)[HookEvent]['Type'];

/** How a hook process ended, as the runner saw it. */
export type HookRun =
  | {
      readonly kind: 'exited';
      /** Null when a signal it was not sent by the runner ended it. */
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unstartable'; readonly message: string };

/** What reading a run depends on in the input the hook was given: its
 *  event, and for a stop whether a block already continued the run. */
type HookAsked = Pick<HookInput, 'hook_event_name'> & {
  readonly stop_hook_active?: boolean;
};

/** What one hook invocation does in v1, before it is recorded. */
interface HookVerdict {
  readonly status: HookStatus;
  /** A `PreToolUse` denial's reason. */
  readonly deny: string | null;
  /** Text the model reads beside the prompt or the tool result; for a
   *  stop, the instruction its block continues the run with. */
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

const SECOND_BLOCK =
  'a second block in a row (blocking a stop a block continued)';

/**
 * Whether a stop's block continues the run, and with what: a stop that ends
 * a turn a block opened (`stop_hook_active`) is not blocked again, which is
 * what bounds the loop; its block is named as ignored instead.
 */
function stopBlock(
  asked: HookAsked,
  reason: string,
  ignored: string[],
): string | null {
  if (asked.stop_hook_active !== true) return reason;
  // Exit 2 with a JSON block reaches here twice; it is one thing ignored.
  if (!ignored.includes(SECOND_BLOCK)) ignored.push(SECOND_BLOCK);
  return null;
}

/** The effect of output that parsed and validated. */
function effectOf(asked: HookAsked, output: HookOutput) {
  const event = asked.hook_event_name;
  const ignored: string[] = [];
  if (output.continue === false) ignored.push('continue: false');
  for (const field of [
    'stopReason',
    'suppressOutput',
    'terminalSequence',
  ] as const)
    if (output[field] !== undefined) ignored.push(field);
  let deny: string | null = null;
  let context: string | null = null;
  switch (event) {
    case 'PreToolUse': {
      const pre = Schema.decodeUnknownSync(HookOutputSchemas.PreToolUse)(
        output,
      );
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
      const post = Schema.decodeUnknownSync(HookOutputSchemas.PostToolUse)(
        output,
      );
      const hso = post.hookSpecificOutput;
      context = joined([
        post.decision === 'block' ? post.reason : undefined,
        hso?.additionalContext,
      ]);
      for (const field of [
        'updatedToolOutput',
        'updatedMCPToolOutput',
        'classifierContext',
      ] as const)
        if (hso?.[field] !== undefined) ignored.push(field);
      break;
    }
    case 'UserPromptSubmit': {
      const prompt = Schema.decodeUnknownSync(
        HookOutputSchemas.UserPromptSubmit,
      )(output);
      context = joined([prompt.hookSpecificOutput?.additionalContext]);
      if (prompt.decision === 'block')
        ignored.push('decision: "block" (blocking a prompt)');
      for (const field of ['sessionTitle', 'suppressOriginalPrompt'] as const)
        if (prompt.hookSpecificOutput?.[field] !== undefined)
          ignored.push(field);
      break;
    }
    case 'SessionStart': {
      const start = Schema.decodeUnknownSync(HookOutputSchemas.SessionStart)(
        output,
      );
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
      const stop = Schema.decodeUnknownSync(HookOutputSchemas[event])(output);
      const extra = stop.hookSpecificOutput?.additionalContext;
      const reason = stop.reason ?? `A ${event} hook blocked the stop.`;
      if (stop.decision === 'block')
        context = stopBlock(
          asked,
          extra === undefined ? reason : `${reason}\n${extra}`,
          ignored,
        );
      else if (extra !== undefined)
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
    : `A ${event} hook asked for ${ignored.join(', ')}, which this build does not act on yet.`;

/**
 * Read one hook run the way the reference does, for the v1 events, against
 * the input it was `asked` with: stdout that starts with `{` and ends with
 * `}` is JSON, validated against the event's schema; exit 2 blocks a tool
 * call or a stop (the prompt block is named as ignored), and a stop's block,
 * by exit 2 or `decision: "block"`, is the instruction the run continues
 * with, once (`stopBlock`); another non-zero exit with valid JSON lets the
 * JSON decide, and without it is a non-blocking failure; plain stdout is
 * context on `SessionStart` and `UserPromptSubmit` only. Malformed output, a
 * timeout and a process that never started have no effect and always carry
 * a warning.
 */
export function interpretHookRun(asked: HookAsked, run: HookRun): HookVerdict {
  const event = asked.hook_event_name;
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
    const json = safeParseJson(text);
    if (Result.isFailure(json)) {
      malformed = `its output is not valid JSON (${json.failure.message})`;
    } else {
      const result = Schema.decodeUnknownResult(HookOutputSchemas[event])(
        json.success,
      );
      if (Result.isSuccess(result)) parsed = result.success;
      else
        malformed = `its output does not match the ${event} output: ${result.failure.message}`;
    }
  }
  const effect = parsed === undefined ? null : effectOf(asked, parsed);
  if (run.exitCode === 2) {
    const ignored = [...(effect?.ignored ?? [])];
    let deny: string | null = null;
    let context = effect?.context ?? null;
    const reason =
      effect?.deny ?? (stderr || `A ${event} hook exited with code 2.`);
    if (event === 'PreToolUse') deny = reason;
    else if (event === 'PostToolUse')
      context = joined([context ?? undefined, stderr]);
    else if ((event === 'Stop' || event === 'SubagentStop') && context === null)
      context = stopBlock(
        asked,
        stderr || `A ${event} hook exited with code 2.`,
        ignored,
      );
    else if (event === 'UserPromptSubmit')
      ignored.push('exit code 2 (blocking a prompt)');
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
