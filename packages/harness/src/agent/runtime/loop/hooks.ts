/**
 * The installed plugins' Claude Code hooks at the run loop's points. A point
 * is one site a set of hooks answers: a run's opening, a user follow-up, a
 * tool call, a turn's end. A step pins its hooks as one value
 * ({@link StepHooks}) and the loop runs each point through the value of the
 * step it runs under, so a plugin enabled or disabled mid-run reaches the
 * next step. Each invocation is recorded as a `hook.outcome` row, which the
 * caller commits through the run's one writer in the batch that the point
 * belongs to; a point the run already recorded is never run again, and its
 * recorded effect is used instead.
 */
import { callKey } from '@shared/session/runFacts';
import * as path from 'node:path';

import {
  Clock,
  Effect,
  FileSystem,
  Result,
  Schema,
  ScopedRef,
  SynchronizedRef,
} from 'effect';

import type { FollowUpBatch } from '@agent/followUp/FollowUpReader';
import {
  claudeToolCall,
  matchesHook,
  type ConfiguredHook,
} from '@common/plugins/hookConfig';
import {
  encodeHookInput,
  interpretHookRun,
  type HookInput,
} from '@common/plugins/hookProtocol';
import { pluginDataDir, runHook } from '@common/plugins/pluginHooks';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { SessionRoots } from '@platform/rootedFs';
import {
  qualifyAggregateId,
  type HookOutcomePayload,
  type ToolDefinition,
  type ToolResult,
} from '@shared/schemas';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';

import { type RunCell, SessionViewAccess } from '@shared/session/runHistory';
import { workAutoApproved } from '../requests';
import type { SessionServices } from '../rootLaunch';
import type { AgentRunShape } from '../run/AgentRun';
import type { InputPart } from '../run/mediaInput';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** One installed plugin's command hook, as a step pinned it. */
interface StepHook {
  /** The plugin's id, `plugin:<name>`. */
  readonly plugin: string;
  readonly name: string;
  /** The plugin directory. */
  readonly root: string;
  /** The plugin's trust digest: a changed script is a different hook. */
  readonly revision: string;
  readonly hook: ConfiguredHook;
}

/** A hook's identity, as `tools.offered` records the step's set. */
const identityOf = (step: StepHook) =>
  `${step.plugin}@${step.revision}#${step.hook.id}`;

/** What the hooks of one point said, and the rows that record it. */
interface HookPoint {
  readonly rows: readonly RunHistoryDraft[];
  readonly outcomes: readonly HookOutcomePayload[];
  /** The context the model reads beside the prompt or the result, each
   *  labelled with its event and plugin; null when none. */
  readonly context: string | null;
}

/** A prompt point's rows, and the text parts its context adds to the
 *  prompt's message. */
interface PromptPoint {
  readonly rows: readonly RunHistoryDraft[];
  readonly parts: InputPart[];
}

type Services = ChildProcessSpawner | FileSystem.FileSystem | SessionServices;

/** Why a call is denied when a `PreToolUse` hook it was offered under is
 *  gone or changed: the hook is not run in its place. */
const GONE_MESSAGE = 'the hook this call was offered under is gone or changed';

/** The recorded outcome of a gone `PreToolUse` hook (`identity`) at
 *  `point`: never run, it denies the call. */
const goneDenial = (point: string, identity: string): HookOutcomePayload => {
  const [head = '', hook = ''] = identity.split('#');
  return {
    point,
    event: 'PreToolUse',
    plugin: head.slice(0, head.lastIndexOf('@')),
    hook,
    durationMs: 0,
    status: 'unstartable',
    exitCode: null,
    decision: 'deny',
    reason: `${GONE_MESSAGE}: the call is not run`,
    updatedInput: null,
    context: null,
    ignored: [],
    stderr: GONE_MESSAGE,
  };
};

const pointOf = (
  outcomes: readonly HookOutcomePayload[],
  rows: readonly RunHistoryDraft[] = [],
): HookPoint => {
  const contexts = outcomes.flatMap(({ event, plugin, context }) =>
    context === null ? [] : [`[${event} hook of ${plugin}]\n${context}`],
  );
  return {
    rows,
    outcomes,
    context: contexts.length === 0 ? null : contexts.join('\n\n'),
  };
};

const partsOf = (context: string | null): InputPart[] =>
  context === null ? [] : [{ kind: 'text', text: context }];

/**
 * Run the hooks of `input`'s event that `names` matches (a tool's names, a
 * session source, an agent type; every hook of an event without matcher
 * support when absent) at `point`, concurrently, or reuse the outcomes the
 * run recorded there. `gone` names the `PreToolUse` hooks the call was
 * offered under that are gone or changed: each denies it, never run.
 * Warnings and hook messages reach the run's log. Never fails: a hook that
 * cannot run is a recorded outcome with no effect.
 */
const hooksAt = Effect.fn('Hooks.at')(function* (
  run: AgentRunShape,
  state: RunState,
  hooks: readonly StepHook[],
  point: string,
  input: HookInput,
  names?: readonly string[],
  gone: readonly string[] = [],
): Effect.fn.Return<HookPoint, never, Services> {
  const recorded = state.hookOutcomes[point];
  if (recorded !== undefined) return pointOf(recorded);
  const event = input.hook_event_name;
  const denied = gone.map((identity) => goneDenial(point, identity));
  const matched = hooks.filter(
    ({ hook }) =>
      hook.event === event &&
      (names === undefined || matchesHook(hook.matcher, names)),
  );
  const { workspace, globalStorage } = yield* SessionRoots;
  if (matched.length > 0 && workspace === undefined)
    run.logger.warn(
      `Not running ${matched.length} ${event} hook(s): this run has no workspace to run them in.`,
    );
  const stdin = encodeHookInput(input);
  const ran = yield* Effect.forEach(
    workspace === undefined ? [] : matched,
    Effect.fnUntraced(function* (step) {
      const { run: ended, durationMs } = yield* runHook(step.hook, stdin, {
        pluginRoot: step.root,
        projectDir: workspace ?? '',
        pluginData: pluginDataDir(globalStorage, step.name),
      });
      const { status, warning, systemMessage, ...said } = interpretHookRun(
        input,
        ended,
      );
      if (warning !== null) run.logger.warn(`${warning} (plugin ${step.name})`);
      if (systemMessage !== null)
        run.logger.info(`${event} hook of ${step.name}: ${systemMessage}`);
      // A failure keeps the start of stderr, or why the process never ran.
      const stderr =
        status === 'ok' || ended.kind === 'timeout'
          ? ''
          : (ended.kind === 'unstartable' ? ended.message : ended.stderr).slice(
              0,
              2_000,
            );
      return {
        point,
        event,
        plugin: step.plugin,
        hook: step.hook.id,
        durationMs,
        status,
        exitCode: ended.kind === 'exited' ? ended.exitCode : null,
        ...said,
        stderr: stderr === '' ? null : stderr,
      } satisfies HookOutcomePayload;
    }),
    { concurrency: 'unbounded' },
  );
  const outcomes = [...ran, ...denied];
  return pointOf(
    outcomes,
    outcomes.map((payload): RunHistoryDraft => ({
      type: 'hook.outcome',
      aggregateId: qualifyAggregateId('run', run.runId),
      payload,
    })),
  );
});

/** The fields every event's input carries for `run`: its root run's id as
 *  the session (the view's ancestry of its parent), its permission mode as
 *  its approvals decide, and for a child its own id and agent, as the
 *  reference gives a subagent's hooks. */
const inputBase = Effect.fn('inputBase')(function* (run: AgentRunShape) {
  const { parent } = run.entry;
  const root =
    parent === null
      ? run.runId
      : ((yield* SessionViewAccess).run(parent)?.ancestors[0]?.id ?? parent);
  return {
    session_id: root,
    cwd: run.workingDirectory ?? (yield* SessionRoots).workspace ?? '',
    permission_mode: (yield* workAutoApproved(run.runId))
      ? ('bypassPermissions' as const)
      : ('default' as const),
    ...(parent === null
      ? {}
      : { agent_id: run.runId, agent_type: run.config.agent }),
  };
});

/**
 * `run`'s hooks for one step: the command hooks of the installed plugins it
 * accepted, by plugin id. A step that dispatches a resumed response is held
 * to the hooks the offering step recorded (`held`): it runs the recorded
 * hooks still installed as they were, none added since, and each recorded
 * `PreToolUse` hook that is gone or changed denies the calls instead of
 * running; the run's log names every one gone.
 */
export function stepHooks(
  run: AgentRunShape,
  installed: ReadonlyMap<string, LoadablePlugin>,
  held: readonly string[] | null,
) {
  const current = [...installed]
    .toSorted(([a], [b]) => Number(a > b) - Number(a < b))
    .flatMap(([plugin, { record, plugin: resolved, trust }]) =>
      resolved.hooks.hooks.map((hook): StepHook => ({
        plugin,
        name: record.name,
        root: record.path,
        revision: trust.digest,
        hook,
      })),
    );
  const recorded = held === null ? null : new Set(held);
  const hooks =
    recorded === null
      ? current
      : current.filter((step) => recorded.has(identityOf(step)));
  const present = new Set(hooks.map(identityOf));
  const gone = (held ?? []).filter((identity) => !present.has(identity));
  for (const identity of gone)
    run.logger.warn(
      `Hook ${identity} was pinned when this call was offered and is gone or changed now: a PreToolUse hook denies the call instead of running.`,
    );
  // A hook's id is `<source>/<event>/<group>/<index>`.
  const goneBefore = gone.filter(
    (identity) => identity.split('/').at(-3) === 'PreToolUse',
  );
  const at = (
    state: RunState,
    point: string,
    input: HookInput,
    names?: readonly string[],
  ) => hooksAt(run, state, hooks, point, input, names);
  const prompt = Effect.fn('Hooks.prompt')(function* (
    state: RunState,
    key: string,
    text: string,
  ): Effect.fn.Return<PromptPoint, never, Services> {
    if (run.entry.parent !== null) return { rows: [], parts: [] };
    const submit = yield* at(state, `UserPromptSubmit:${key}`, {
      ...(yield* inputBase(run)),
      hook_event_name: 'UserPromptSubmit',
      prompt: text,
    });
    return { rows: submit.rows, parts: partsOf(submit.context) };
  });
  return {
    /** What the step's `tools.offered` row records. */
    identities: held ?? current.map(identityOf),
    /** A root run's user prompt (`key`: `open`, or the follow-up that
     *  carries it): `UserPromptSubmit`, whose context joins its message. */
    prompt,
    /**
     * A root run's opening: `SessionStart` (`source: "startup"`), then the
     * opening prompt's `UserPromptSubmit`. Their rows commit in the opening
     * batch, and their context joins the first user message.
     */
    opening: Effect.fn('Hooks.opening')(function* (
      state: RunState,
      text: string,
    ): Effect.fn.Return<PromptPoint, never, Services> {
      if (run.entry.parent !== null) return { rows: [], parts: [] };
      const model = (yield* ScopedRef.get(run.model)).modelId;
      const start = yield* at(
        state,
        'SessionStart',
        {
          ...(yield* inputBase(run)),
          hook_event_name: 'SessionStart',
          source: 'startup',
          model,
        },
        ['startup'],
      );
      // The prompt is what the user asked; the launch's request text wraps it.
      const asked =
        run.config.displayInstruction || run.config.instruction || text;
      const submit = yield* prompt(state, 'open', asked);
      return {
        rows: [...start.rows, ...submit.rows],
        parts: [...partsOf(start.context), ...submit.parts],
      };
    }),
    /**
     * A completed turn's `Stop` (a root) or `SubagentStop` (a child), if
     * any: its rows, which commit before `waiting`, and the turn a block
     * opens with its reason, even in a one-shot run. `stop_hook_active`
     * (after a block's turn, or in a script's run) is not blocked, which
     * bounds the loop.
     */
    stop: Effect.fn('Hooks.stop')(function* (
      turn: { readonly state: RunState; readonly outcome: string },
      lastMessage: string,
    ) {
      if (turn.outcome !== 'completed') return { rows: [], block: null };
      const { state } = turn;
      const base = yield* inputBase(run);
      const blocked = state.hookOutcomes[`Stop:${state.turn - 1}`] ?? [];
      const common = {
        stop_hook_active:
          run.config.script != null || blocked.some((o) => o.context !== null),
        last_assistant_message: lastMessage,
      } as const;
      const { rows, context: text } = yield* at(
        state,
        `Stop:${state.turn}`,
        run.entry.parent === null
          ? { ...base, ...common, hook_event_name: 'Stop' }
          : {
              ...base,
              ...common,
              hook_event_name: 'SubagentStop',
              agent_id: run.runId,
              agent_type: run.config.agent,
            },
        run.entry.parent === null ? undefined : [run.config.agent],
      );
      const block: FollowUpBatch | null =
        text === null ? null : { kind: 'synthetic', text };
      return { rows, block };
    }),
    /**
     * One tool call's `PreToolUse`, matched on the call's Claude Code name
     * and its own (or as the run recorded them), its input decoded by
     * `schema` (the tool's): their `outcomes`, which the chain
     * (`toolGuard.ts`) decides on, and `fromHook`, which reads a rewrite as
     * the harness tool's input. `after` runs the call's `PostToolUse` once
     * it executed, timed from `bodyStarts`, and returns the rows that commit
     * with its result (none for a result that is not `executed`).
     */
    preToolUse: Effect.fn('Hooks.preToolUse')(function* (
      cell: Pick<RunCell, 'current'>,
      call: { readonly callId: string; readonly toolName: string },
      responseId: string,
      toolInput: unknown,
      schema: ToolDefinition['schema'],
    ) {
      // Hooks see the decoded input, so a rewrite keeps the fields they never saw.
      const read = schema && Schema.decodeUnknownResult(schema)(toolInput);
      const issued = read && Result.isSuccess(read) ? read.success : toolInput;
      const input = yield* inputBase(run);
      const claude = claudeToolCall(call.toolName, issued, (file) =>
        typeof file === 'string' ? path.resolve(input.cwd, file.trim()) : file,
      );
      const names = [claude.toolName, call.toolName];
      const base = {
        ...input,
        tool_name: claude.toolName,
        tool_input: claude.toolInput,
        tool_use_id: call.callId,
      };
      const point = callKey(responseId, call.callId);
      const pre = yield* hooksAt(
        run,
        yield* cell.current,
        hooks,
        `PreToolUse:${point}`,
        { ...base, hook_event_name: 'PreToolUse' },
        names,
        goneBefore,
      );
      // `duration_ms` is the body's alone: timed after approval and PreToolUse.
      let startedAt: number | undefined;
      const bodyStarts = Effect.map(Clock.currentTimeMillis, (now) => {
        startedAt = now;
      });
      const after = Effect.fn('Hooks.postToolUse')(function* (
        result: ToolResult,
      ) {
        if (result.status !== 'executed') return [];
        const post = yield* at(
          yield* cell.current,
          `PostToolUse:${point}`,
          {
            ...base,
            tool_input:
              pre.outcomes.find((o) => o.updatedInput !== null)?.updatedInput ??
              claude.toolInput,
            hook_event_name: 'PostToolUse',
            tool_response: result,
            ...(startedAt === undefined
              ? {}
              : { duration_ms: (yield* Clock.currentTimeMillis) - startedAt }),
          },
          names,
        );
        return post.rows;
      });
      return { ...pre, fromHook: claude.fromHook, bodyStarts, after };
    }),
    /** The text part a call's recorded hooks add after its result. */
    callText: (state: RunState, responseId: string, callId: string) =>
      partsOf(
        pointOf([
          ...(state.hookOutcomes[`PreToolUse:${responseId}/${callId}`] ?? []),
          ...(state.hookOutcomes[`PostToolUse:${responseId}/${callId}`] ?? []),
        ]).context,
      ),
  };
}

/** What a step's hooks run at each of the loop's points. */
export type StepHooks = ReturnType<typeof stepHooks>;

/** The hooks of `run`'s current step; none before its first step opens. */
export const hooksOf = (run: AgentRunShape) =>
  Effect.map(
    SynchronizedRef.get(run.steps),
    (open) => open?.tools.hooks ?? stepHooks(run, new Map(), null),
  );
