/**
 * A tool call made under a run, as only the harness's built-in tools read
 * it: its place in the run (`RunCall`: the files the run read, the
 * response and attempt it belongs to), the script that issued it
 * (`IssuingScript`), and a `script` call's door to the run's tools
 * (`ScriptCalls`). The public contract every tool reads, the run
 * included, is `ToolContext` (`@agent/core/tools/ToolTypes`); an app's
 * tool reads nothing here.
 */
import { Context, Data, Effect } from 'effect';

import type { ScriptOp } from '@agent/codeSandbox/codeSandbox';
import {
  ToolContext,
  type CallRequests,
  type ToolContextShape,
} from '@agent/core/tools/ToolTypes';
import {
  ToolError,
  type ToolResult,
  type ToolDefinition,
  type ToolResultPayload,
} from '@shared/schemas';
import { errorResult } from '@tools/core/result';

import type { InvokeError } from './ModelInvoker';
import type { AgentRunShape } from './run/AgentRun';

/** A resumed script issued another call at `seq` than its rows recorded. */
export class ScriptDiverged extends Data.TaggedError('ScriptDiverged')<{
  readonly seq: number;
  readonly recorded: string;
  readonly issued: string;
}> {
  override get message(): string {
    return `The resumed script diverged at call ${this.seq}: it recorded ${this.recorded} and now issued ${this.issued}.`;
  }
}

/** The program a `script` call runs, as its call's arguments carry it. */
export interface ScriptSource {
  readonly source: string;
  readonly title: string | null;
}

/**
 * How a `script` call's guest reaches the run's tools: through the run
 * loop's per-call program, which commits each call's rows (`script.call`,
 * `tool.intent`, its card, `tool.result`) and on a resume hands back what
 * the rows already settled instead of running it again.
 */
export interface ScriptDoor {
  /** The tools the guest may call, as the step that offered the script
   *  pinned them: its offered tools, less `script`, each with its plugin. */
  readonly catalog: readonly {
    readonly definition: ToolDefinition;
    readonly plugin: string;
  }[];
  /** The tools of the catalog that are also script globals, taking their
   *  `positional` field first (`ITool.scriptGlobal`). */
  readonly globals: readonly {
    readonly tool: string;
    readonly positional: string;
  }[];
  /** Settles one issued call, at its `tool.result` commit: its result and
   *  the attachment bytes that commit captured. */
  readonly call: (
    op: ScriptOp,
    script: ScriptSource,
  ) => Effect.Effect<
    Pick<ToolResultPayload, 'result' | 'attachments'>,
    ScriptDiverged | InvokeError
  >;
  /**
   * Settles one call of the script's own host functions (`searchTools`,
   * `describeTool`) with `answer`, which reads nothing but {@link catalog}.
   * It is recorded as a call with no card or tool, so a resume hands the
   * recorded answer back as it hands back a tool's.
   */
  readonly answer: (
    op: ScriptOp,
    source: ScriptSource,
    answer: () => ToolResultPayload['result'],
  ) => Effect.Effect<ToolResultPayload['result'], ScriptDiverged | InvokeError>;
  /** The sandbox delivered `seq`'s settlement to the guest. */
  readonly delivered: (seq: number) => Effect.Effect<void>;
}

/**
 * What a call a script issued knows of that script: what a person is shown
 * of it, and what the script's calls share for as long as it runs here.
 */
export interface ScriptScope extends ScriptSource {
  /** The `script` call that issued this one. */
  readonly callId: string;
  /** The calls the script has issued so far, this one included, in issue
   *  order, as their `script.call` rows record them. */
  readonly calls: Effect.Effect<
    readonly { readonly toolName: string; readonly input: unknown }[]
  >;
  /**
   * The value the script's calls share under `key`: the first call to ask
   * makes it, and every later one, concurrent or not, gets what that made
   * (its failure included). Held in memory for the script's run in this
   * process; what must outlive a restart is made from rows.
   */
  readonly shared: <A, E, R>(
    key: string,
    make: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * What a tool reads of the run its call works for (its session, model,
 * policy, configuration and scope), read from the run rather than copied
 * onto the call. A tool that starts something the run should stop at its
 * end registers that stop on the run's scope.
 */
export type ToolRun = Pick<
  AgentRunShape,
  | 'session'
  | 'runId'
  | 'toolPolicy'
  | 'config'
  | 'model'
  | 'delegationAgentScope'
  | 'steps'
  | 'scope'
  | 'task'
  | 'opening'
  | 'logger'
  | 'callbacks'
  | 'fileService'
>;

/** A call made under a run, as its loop dispatched it (`RunCall`). */
export interface RunCallShape {
  /** The files the run read since its loop started, which an edit of an
   *  existing file requires. Memory only: a resumed run reads again. */
  readonly readFiles: Set<string>;
  /** The response whose call this is; a script's calls are its script's.
   *  A provider's call ids are unique within one response only. */
  readonly responseId: string;
  /** The user instruction that response answers. */
  readonly instruction: string | undefined;
  /** The intent attempt this execution of the call runs under: 1, then
   *  one more for each re-run a resume admitted. */
  readonly attempt: number;
  /** The card this call's rows open under: what a run the call launches
   *  names as its `parentCard`. */
  readonly logId: string;
}

/** The current call's place in its run; null for a standalone host
 *  invocation outside an agent run. */
export class RunCall extends Context.Service<RunCall, RunCallShape | null>()(
  '@texra/agent/RunCall',
) {}

/** The script that issued the current call; null for a call a response
 *  (or a host) issued. */
export class IssuingScript extends Context.Service<
  IssuingScript,
  ScriptScope | null
>()('@texra/agent/IssuingScript') {}

/** The calls a `script` call's guest may issue, built on the first
 *  `yield*`; null for a call a script (or a host) issued. */
export class ScriptCalls extends Context.Service<
  ScriptCalls,
  Effect.Effect<ScriptDoor> | null
>()('@texra/agent/ScriptCalls') {}

/** The run the current call works for; none for a standalone host call. */
export const callerRun: Effect.Effect<ToolRun | undefined, never, ToolContext> =
  Effect.gen(function* () {
    return (yield* ToolContext).run;
  });

/**
 * The current call, narrowed to one made under a run, or the shared refusal:
 * the one place it is worded, so the model reads the same sentence whichever
 * tool it reached for. `toolName` names what needs the run, which can be
 * narrower than the tool (`'bash run_in_background'`).
 */
export const requireRun = (
  toolName: string,
): Effect.Effect<
  ToolContextShape & {
    readonly run: NonNullable<ToolContextShape['run']>;
    readonly requests: CallRequests;
  },
  ToolError,
  ToolContext
> =>
  Effect.gen(function* () {
    const call = yield* ToolContext;
    const { run } = call;
    if (run === undefined)
      return yield* Effect.fail(
        new ToolError(`${toolName} requires an active run context.`),
      );
    return { ...call, run, requests: run.requests };
  });

/** A built-in's call made under a run: the call, the run, where its
 *  requests open, and its place in the run. */
export type RunToolCall = ToolContextShape &
  RunCallShape & {
    readonly run: NonNullable<ToolContextShape['run']>;
    readonly requests: CallRequests;
  };

/** {@link requireRun}, with the call's place in its run, for built-ins. */
export const requireToolRun = (
  toolName: string,
): Effect.Effect<RunToolCall, ToolError, ToolContext | RunCall> =>
  Effect.gen(function* () {
    const call = yield* requireRun(toolName);
    const runCall = yield* RunCall;
    if (runCall === null)
      return yield* Effect.fail(
        new ToolError(`${toolName} requires an active run context.`),
      );
    return { ...call, ...runCall };
  });

/** Count `path` as read by the current call's run: a later edit of it then
 *  needs no fresh read. */
export const recordToolFileRead = Effect.fn('RunCall.recordFileRead')(
  function* (path: string): Effect.fn.Return<void, never, RunCall> {
    if (path) (yield* RunCall)?.readFiles.add(path);
  },
);

/** The refusal an edit of an existing file gets when the run never read it,
 *  or null: an edit needs a read first, which the run's `readFiles` holds. */
export const requireFileReadForEdit = Effect.fn('RunCall.requireReadForEdit')(
  function* (
    path: string,
    exists: boolean,
    errorMessage?: string,
    /** How the card names the file; the tracker keys on `path`. */
    displayPath: string = path,
  ): Effect.fn.Return<ToolResult | null, never, RunCall> {
    const call = yield* RunCall;
    if (!exists || call?.readFiles.has(path) === true) {
      return null;
    }
    return errorResult(
      errorMessage ??
        'Edits to existing files require a prior read in this session. Please call read_file first.',
      {
        // Not "Read …": the card would read as a read_file call.
        summary: `Not edited: ${displayPath} was not read first`,
        diagnostics: { reason: 'unread-file', path },
      },
    );
  },
);
