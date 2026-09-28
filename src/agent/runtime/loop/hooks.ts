/**
 * The installed plugins' Claude Code hooks at the run loop's points
 * (`2026-09-28-code-plugins-hooks-v1.md`). A point is one site a set of
 * hooks answers: a run's opening, a user follow-up, a tool call, a turn's
 * end. The hooks are the ones the run's step pinned, so a plugin enabled or
 * disabled mid-run reaches the next step. Each invocation is recorded as a
 * `hook.outcome` row, which the caller commits through the run's one writer
 * in the batch that the point belongs to; a point the run already recorded
 * is never run again, and its recorded effect is used instead.
 */
import { Clock, Effect, FileSystem, SynchronizedRef } from 'effect';

import {
  claudeToolName,
  matchesHook,
  type ConfiguredHook,
} from '@common/plugins/hookConfig';
import {
  encodeHookInput,
  interpretHookRun,
  type HookInput,
} from '@common/plugins/hookProtocol';
import { pluginDataDir, runHook } from '@common/plugins/pluginHooks';
import type { HookOutcomePayload, ToolResult } from '@shared/schemas';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';

import { rowAggregate } from './rows';
import type { AgentRunShape } from '../run/AgentRun';
import type { InputPart } from '../run/mediaInput';
import type { RunCell } from './runProgram';
import type { StepTools } from './step';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** One installed plugin's command hook, as a step pinned it. */
export interface StepHook {
  /** The plugin's id, `plugin:<name>`. */
  readonly plugin: string;
  readonly name: string;
  /** The plugin directory. */
  readonly root: string;
  readonly hook: ConfiguredHook;
}

/** What the hooks of one point decided, and the rows that record it. */
interface HookPoint {
  readonly rows: readonly RunLedgerDraft[];
  /** A `PreToolUse` denial's reasons, joined; null when none denied. */
  readonly deny: string | null;
  /** The context the model reads beside the prompt or the result, each
   *  labelled with its event and plugin; null when none. */
  readonly context: string | null;
}

type Services = ChildProcessSpawner | FileSystem.FileSystem;

const NONE: HookPoint = { rows: [], deny: null, context: null };

/** The start of a failed hook's stderr the row keeps. */
const STDERR_KEPT = 2_000;

const effectOf = (
  outcomes: readonly HookOutcomePayload[],
): Omit<HookPoint, 'rows'> => {
  const denials = outcomes.flatMap(({ plugin, deny }) =>
    deny === null ? [] : [`${deny} (hook of ${plugin})`],
  );
  const contexts = outcomes.flatMap(({ event, plugin, context }) =>
    context === null ? [] : [`[${event} hook of ${plugin}]\n${context}`],
  );
  return {
    deny: denials.length === 0 ? null : denials.join('\n'),
    context: contexts.length === 0 ? null : contexts.join('\n\n'),
  };
};

/**
 * Run the hooks of `input`'s event that `names` matches (a tool's names, a
 * session source, an agent type; every hook of an event without matcher
 * support when absent) at `point`, concurrently, or reuse the outcomes the
 * run recorded there. Warnings and hook messages reach the run's log.
 * Never fails: a hook that cannot run is a recorded outcome with no effect.
 */
const hooksAt = Effect.fn('Hooks.at')(function* (
  run: AgentRunShape,
  state: RunState,
  hooks: readonly StepHook[],
  point: string,
  input: HookInput,
  names?: readonly string[],
): Effect.fn.Return<HookPoint, never, Services> {
  const recorded = state.hookOutcomes[point];
  if (recorded !== undefined) return { rows: [], ...effectOf(recorded) };
  const event = input.hook_event_name;
  const matched = hooks.filter(
    ({ hook }) =>
      hook.event === event &&
      (names === undefined || matchesHook(hook.matcher, names)),
  );
  if (matched.length === 0) return NONE;
  const { workspace, globalStorage } = run.session.roots;
  if (workspace === undefined) {
    run.logger.warn(
      `Not running ${matched.length} ${event} hook(s): this run has no workspace to run them in.`,
    );
    return NONE;
  }
  const stdin = encodeHookInput(input);
  const outcomes = yield* Effect.forEach(
    matched,
    (step) =>
      Effect.gen(function* () {
        const { run: ended, durationMs } = yield* runHook(step.hook, stdin, {
          pluginRoot: step.root,
          projectDir: workspace,
          pluginData: pluginDataDir(globalStorage, step.name),
        });
        const verdict = interpretHookRun(event, ended);
        if (verdict.warning !== null)
          run.logger.warn(`${verdict.warning} (plugin ${step.name})`);
        if (verdict.systemMessage !== null)
          run.logger.info(
            `${event} hook of ${step.name}: ${verdict.systemMessage}`,
          );
        // A failure keeps the start of stderr, or why the process never ran.
        const stderr =
          verdict.status === 'ok'
            ? ''
            : (ended.kind === 'unstartable'
                ? ended.message
                : ended.stderr
              ).slice(0, STDERR_KEPT);
        return {
          point,
          event,
          plugin: step.plugin,
          hook: step.hook.id,
          durationMs,
          status: verdict.status,
          exitCode: ended.kind === 'exited' ? ended.exitCode : null,
          deny: verdict.deny,
          context: verdict.context,
          ignored: verdict.ignored,
          stderr: stderr === '' ? null : stderr,
        } satisfies HookOutcomePayload;
      }),
    { concurrency: 'unbounded' },
  );
  return {
    rows: outcomes.map((payload): RunLedgerDraft => ({
      type: 'hook.outcome',
      aggregateId: rowAggregate(run.runId),
      payload,
    })),
    ...effectOf(outcomes),
  };
});

/** The root of `run`'s parent chain: the session its hooks see. */
const rootOf = (run: AgentRunShape) => {
  let root = run.runId;
  for (let up = run.session.runs.getHandle(root)?.parent; up != null;) {
    root = up;
    up = run.session.runs.getHandle(root)?.parent;
  }
  return root;
};

/**
 * The fields every event's input carries for `run`: its root run's id as the
 * session, and for a child its own id and agent, as the reference gives a
 * subagent's hooks.
 */
const inputBase = (run: AgentRunShape) => {
  const root = rootOf(run);
  return {
    session_id: root,
    cwd: run.session.roots.workspace ?? '',
    permission_mode:
      run.session.approvalPolicy === 'yolo'
        ? ('bypassPermissions' as const)
        : ('default' as const),
    ...(root === run.runId
      ? {}
      : { agent_id: run.runId, agent_type: run.config.agent }),
  };
};

/** The hooks of the run's current step. */
const currentHooks = (run: AgentRunShape) =>
  Effect.map(SynchronizedRef.get(run.steps), (open) => open?.tools.hooks ?? []);

/** A prompt point's rows, and the text parts its context adds to the
 *  prompt's message. */
interface PromptPoint {
  readonly rows: readonly RunLedgerDraft[];
  readonly parts: InputPart[];
}

const partsOf = (context: string | null): InputPart[] =>
  context === null ? [] : [{ kind: 'text', text: context }];

/**
 * A root run's opening: `SessionStart` (`source: "startup"`), then the
 * opening prompt's `UserPromptSubmit`. Their rows commit in the opening
 * batch, and their context joins the first user message.
 */
export const openingHooks = Effect.fn('Hooks.opening')(function* (
  run: AgentRunShape,
  state: RunState,
  prompt: string,
): Effect.fn.Return<PromptPoint, never, Services> {
  if (rootOf(run) !== run.runId) return { rows: [], parts: [] };
  const hooks = yield* currentHooks(run);
  const base = inputBase(run);
  const model = (yield* SynchronizedRef.get(run.model)).modelId;
  const start = yield* hooksAt(
    run,
    state,
    hooks,
    'SessionStart',
    { ...base, hook_event_name: 'SessionStart', source: 'startup', model },
    ['startup'],
  );
  // The prompt is what the user asked; the launch's request text wraps it.
  const asked =
    run.config.displayInstruction || run.config.instruction || prompt;
  const submit = yield* promptHooks(run, state, 'open', asked);
  return {
    rows: [...start.rows, ...submit.rows],
    parts: [...partsOf(start.context), ...submit.parts],
  };
});

/** A root run's user prompt (`key`: `open`, or the follow-up that carries
 *  it): `UserPromptSubmit`, whose context joins the prompt's message. */
export const promptHooks = Effect.fn('Hooks.prompt')(function* (
  run: AgentRunShape,
  state: RunState,
  key: string,
  prompt: string,
): Effect.fn.Return<PromptPoint, never, Services> {
  if (rootOf(run) !== run.runId) return { rows: [], parts: [] };
  const submit = yield* hooksAt(
    run,
    state,
    yield* currentHooks(run),
    `UserPromptSubmit:${key}`,
    { ...inputBase(run), hook_event_name: 'UserPromptSubmit', prompt },
  );
  return { rows: submit.rows, parts: partsOf(submit.context) };
});

/** A completed turn's `Stop` (a root) or `SubagentStop` (a child): a
 *  notification in v1, so only its rows, which commit before the turn's
 *  `waiting` position; none for a turn that did not complete. */
export const stopHooks = Effect.fn('Hooks.stop')(function* (
  run: AgentRunShape,
  turn: { readonly state: RunState; readonly outcome: string },
  lastMessage: string,
): Effect.fn.Return<readonly RunLedgerDraft[], never, Services> {
  if (turn.outcome !== 'completed') return [];
  const { state } = turn;
  const base = inputBase(run);
  const child = rootOf(run) !== run.runId;
  const common = {
    stop_hook_active: false,
    last_assistant_message: lastMessage,
  } as const;
  const stopped = yield* hooksAt(
    run,
    state,
    yield* currentHooks(run),
    `Stop:${state.turn}`,
    child
      ? {
          ...base,
          ...common,
          hook_event_name: 'SubagentStop',
          agent_id: run.runId,
          agent_type: run.config.agent,
        }
      : { ...base, ...common, hook_event_name: 'Stop' },
    child ? [run.config.agent] : undefined,
  );
  return stopped.rows;
});

/**
 * One tool call's `PreToolUse`, under the hooks of the step that offered it,
 * matched on the call's Claude Code name and its own. `denied` is the error
 * result a denial settles the call with; anything else leaves the decision
 * to the approval policy. `after` runs the call's `PostToolUse` once it
 * executed, timed from here, and returns the rows that commit with its
 * settlement (none for a denied call, or a result that is not `executed`).
 */
export const preToolUse = Effect.fn('Hooks.preToolUse')(function* (
  run: AgentRunShape,
  cell: Pick<RunCell, 'current'>,
  step: Pick<StepTools, 'hooks'>,
  call: { readonly callId: string; readonly toolName: string },
  toolInput: unknown,
) {
  const toolName = claudeToolName(call.toolName);
  const names = [toolName, call.toolName];
  const base = {
    ...inputBase(run),
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: call.callId,
  };
  const pre = yield* hooksAt(
    run,
    yield* cell.current,
    step.hooks,
    `PreToolUse:${call.callId}`,
    { ...base, hook_event_name: 'PreToolUse' },
    names,
  );
  const startedAt = yield* Clock.currentTimeMillis;
  const after = Effect.fn('Hooks.postToolUse')(function* (result: ToolResult) {
    if (pre.deny !== null || result.status !== 'executed') return [];
    const post = yield* hooksAt(
      run,
      yield* cell.current,
      step.hooks,
      `PostToolUse:${call.callId}`,
      {
        ...base,
        hook_event_name: 'PostToolUse',
        tool_response: result,
        duration_ms: (yield* Clock.currentTimeMillis) - startedAt,
      },
      names,
    );
    return post.rows;
  });
  const denied: ToolResult | null =
    pre.deny === null
      ? null
      : {
          status: 'error',
          error: `Blocked by a PreToolUse hook: ${pre.deny}`,
          diagnostics: { code: 'hook_denied', tool: call.toolName },
        };
  return { rows: pre.rows, denied, after };
});

/** The text part a call's recorded hooks add after its result, if any. */
export const callHookText = (state: RunState, callId: string): InputPart[] => {
  const { context } = effectOf([
    ...(state.hookOutcomes[`PreToolUse:${callId}`] ?? []),
    ...(state.hookOutcomes[`PostToolUse:${callId}`] ?? []),
  ]);
  return partsOf(context);
};
