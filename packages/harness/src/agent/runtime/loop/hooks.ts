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
import * as path from 'node:path';

import { Clock, Effect, FileSystem, SynchronizedRef } from 'effect';

import type { FollowUpBatch } from '@agent/followUp/RunInput';
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
import {
  SUPPORTED_HOOK_EVENTS,
  type HookOutcomePayload,
  type ToolResult,
} from '@shared/schemas';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';

import { rowAggregate } from './rows';
import type { AgentRunShape } from '../run/AgentRun';
import type { InputPart } from '../run/mediaInput';
import type { RunCell } from './runProgram';
import type { StepTools } from './step';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** One installed plugin's command hook, as a step pinned it. */
export interface StepHook {
  /** The plugin's id, `plugin:<name>`. */
  readonly plugin: string;
  readonly name: string;
  /** The plugin directory. */
  readonly root: string;
  /** The plugin's trust digest: a changed script is a different hook. */
  readonly revision: string;
  readonly hook: ConfiguredHook;
  /** A hook the offering step recorded that is gone or changed now: it is
   *  not run, and a `PreToolUse` one denies the call it would have seen. */
  readonly stale?: true;
}

/** A hook's identity, as `tools.offered` records the step's set. */
const identityOf = (step: StepHook) =>
  `${step.plugin}@${step.revision}#${step.hook.id}`;

/** A recorded hook that no installed plugin offers as it was. */
const staleHook = (identity: string): StepHook => {
  const [head = '', id = ''] = identity.split('#');
  const [plugin = '', revision = ''] = head.split('@');
  const named = id.split('/').at(-3);
  const event =
    SUPPORTED_HOOK_EVENTS.find((known) => known === named) ?? 'PreToolUse';
  return {
    plugin,
    name: plugin,
    root: '',
    revision,
    stale: true,
    hook: {
      id,
      event,
      matcher: undefined,
      command: '',
      args: undefined,
      timeoutSeconds: 0,
    },
  };
};

/**
 * A step's hooks: the command hooks of the installed plugins it accepted,
 * by plugin id, and their identities, which its `tools.offered` row records.
 * A step that dispatches a resumed response is held to what the offering
 * step recorded (`held`): it runs the recorded hooks still installed as
 * they were, none added since, and in place of each recorded `PreToolUse`
 * hook that is gone or changed a stale one that denies the call; `notes`
 * name them.
 */
export function stepHooks(
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
  if (held === null)
    return { hooks: current, identities: current.map(identityOf), notes: [] };
  const recorded = new Set(held);
  const kept = current.filter((step) => recorded.has(identityOf(step)));
  const present = new Set(kept.map(identityOf));
  const gone = held.filter((identity) => !present.has(identity));
  return {
    hooks: [...kept, ...gone.map(staleHook)],
    identities: [...held],
    notes: gone.map(
      (identity) =>
        `Hook ${identity} was pinned when this call was offered and is gone or changed now: a PreToolUse hook denies the call instead of running.`,
    ),
  };
}

/** What the hooks of one point decided, and the rows that record it. */
interface HookPoint {
  readonly rows: readonly RunHistoryDraft[];
  /** A `PreToolUse` denial's reasons, joined; null when none denied. */
  readonly deny: string | null;
  /** The context the model reads beside the prompt or the result, each
   *  labelled with its event and plugin; null when none. */
  readonly context: string | null;
}

type Services = ChildProcessSpawner | FileSystem.FileSystem;

/** A turn's stop: its rows, and the turn a block opens next. */
type StopPoint = Omit<PromptPoint, 'parts'> & { block: FollowUpBatch | null };

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
  if (matched.length === 0) return { rows: [], deny: null, context: null };
  const { workspace, globalStorage } = run.session.roots;
  if (workspace === undefined) {
    run.logger.warn(
      `Not running ${matched.length} ${event} hook(s): this run has no workspace to run them in.`,
    );
    return { rows: [], deny: null, context: null };
  }
  const stdin = encodeHookInput(input);
  const outcomes = yield* Effect.forEach(
    matched,
    (step) =>
      Effect.gen(function* () {
        const { run: ended, durationMs } = step.stale
          ? {
              run: {
                kind: 'unstartable' as const,
                message:
                  'the hook this call was offered under is gone or changed',
              },
              durationMs: 0,
            }
          : yield* runHook(step.hook, stdin, {
              pluginRoot: step.root,
              projectDir: workspace,
              pluginData: pluginDataDir(globalStorage, step.name),
            });
        const verdict = interpretHookRun(input, ended);
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
              ).slice(0, 2_000);
        return {
          point,
          event,
          plugin: step.plugin,
          hook: step.hook.id,
          durationMs,
          status: verdict.status,
          exitCode: ended.kind === 'exited' ? ended.exitCode : null,
          deny:
            step.stale && event === 'PreToolUse'
              ? 'the hook that governed this call when it was offered is gone or changed, so the call is not run'
              : verdict.deny,
          context: verdict.context,
          ignored: verdict.ignored,
          stderr: stderr === '' ? null : stderr,
        } satisfies HookOutcomePayload;
      }),
    { concurrency: 'unbounded' },
  );
  return {
    rows: outcomes.map((payload): RunHistoryDraft => ({
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
  readonly rows: readonly RunHistoryDraft[];
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

/**
 * A completed turn's `Stop` (a root) or `SubagentStop` (a child), if any:
 * its rows, which commit before `waiting`, and the turn a block opens with
 * its reason, even in a one-shot run. `stop_hook_active` (after a block's
 * turn, or in a script's run) is not blocked, which bounds the loop.
 */
export const stopHooks = Effect.fn('Hooks.stop')(function* (
  run: AgentRunShape,
  turn: { readonly state: RunState; readonly outcome: string },
  lastMessage: string,
): Effect.fn.Return<StopPoint, never, Services> {
  if (turn.outcome !== 'completed') return { rows: [], block: null };
  const { state } = turn;
  const base = inputBase(run);
  const child = rootOf(run) !== run.runId;
  const blocked = state.hookOutcomes[`Stop:${state.turn - 1}`] ?? [];
  const common = {
    stop_hook_active:
      run.config.script != null || blocked.some((o) => o.context !== null),
    last_assistant_message: lastMessage,
  } as const;
  const { rows, context: text } = yield* hooksAt(
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
  return { rows, block: text === null ? null : { kind: 'synthetic', text } };
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
  responseId: string,
  toolInput: unknown,
) {
  const { toolName, toolInput: claudeInput } = claudeToolCall(
    call.toolName,
    toolInput,
    (file) =>
      typeof file === 'string'
        ? path.resolve(run.session.roots.workspace ?? '', file)
        : file,
  );
  const names = [toolName, call.toolName];
  const base = {
    ...inputBase(run),
    tool_name: toolName,
    tool_input: claudeInput,
    tool_use_id: call.callId,
  };
  // Call ids are unique within one response only.
  const at = `${responseId}/${call.callId}`;
  const pre = yield* hooksAt(
    run,
    yield* cell.current,
    step.hooks,
    `PreToolUse:${at}`,
    { ...base, hook_event_name: 'PreToolUse' },
    names,
  );
  // `duration_ms` is the body's alone: timed after approval and PreToolUse.
  let startedAt: number | undefined;
  const bodyStarts = Effect.map(Clock.currentTimeMillis, (now) => {
    startedAt = now;
  });
  const after = Effect.fn('Hooks.postToolUse')(function* (result: ToolResult) {
    if (pre.deny !== null || result.status !== 'executed') return [];
    const post = yield* hooksAt(
      run,
      yield* cell.current,
      step.hooks,
      `PostToolUse:${at}`,
      {
        ...base,
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
  const denied: ToolResult | null =
    pre.deny === null
      ? null
      : {
          status: 'error',
          error: `Blocked by a PreToolUse hook: ${pre.deny}`,
          diagnostics: { code: 'hook_denied', tool: call.toolName },
        };
  return { rows: pre.rows, denied, bodyStarts, after };
});

/** The text part a call's recorded hooks add after its result, if any. */
export const callHookText = (
  state: RunState,
  responseId: string,
  callId: string,
): InputPart[] => {
  const { context } = effectOf([
    ...(state.hookOutcomes[`PreToolUse:${responseId}/${callId}`] ?? []),
    ...(state.hookOutcomes[`PostToolUse:${responseId}/${callId}`] ?? []),
  ]);
  return partsOf(context);
};
