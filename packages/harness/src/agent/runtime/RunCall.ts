/**
 * A tool call made under a run, as only the harness's built-in tools read
 * it (`RunCall`): the run's step and callbacks, the response and attempt
 * the call belongs to, the script that issued it, and, for a `script` call,
 * the door its guest calls the run's tools through. `RunCall` is a
 * `Context.Reference` whose default is null, so a standalone host
 * invocation outside a run provides nothing. The public contract every tool
 * reads, the run included, is `ToolContext`; an app's tool reads nothing
 * else. The read-before-edit helpers here (`recordToolFileRead`,
 * `requireFileReadForEdit`) read the run's `fileService.readFiles` through
 * `ToolContext`, so any tool may use them.
 */
import {
  Context,
  Data,
  Effect,
  type Scope,
  type SynchronizedRef,
} from 'effect';

import type { ScriptOp } from '@agent/codeSandbox/codeSandbox';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  ToolContext,
  type CallRequests,
  type ToolContextShape,
  type ToolRun,
} from '@agent/core/tools/ToolTypes';
import type { TemplateOpening } from '@agent/prompt/templateInputs';
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  ToolError,
  type AgentDelegationScope,
  type PermissionPayload,
  type ToolResult,
  type ToolDefinition,
  type ToolResultPayload,
} from '@shared/schemas';
import type { CellError } from '@shared/session/runHistory';
import { errorResult } from '@tools/core/result';
import type { RunFileService } from '@utils/files/runStorage';

import type { InvokeError } from './ModelInvoker';
import type { BoundModel } from './modelAccess/ModelAccess';
import type { AgentRunShape, ToolPolicy } from './run/AgentRun';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

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
  /** The modules the guest may import, source by specifier, as the step
   *  that offered the script pinned them. */
  readonly modules: Readonly<Record<string, string>>;
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
  /**
   * Settles, as skipped, every call the script issued that has no result
   * yet. Run once the guest has ended and no issued call runs any more, and
   * before the script's own result commits, so no row of the script's stays
   * open behind it: a resume then finds nothing to replay or re-adopt.
   */
  readonly settleAbandoned: Effect.Effect<void, InvokeError>;
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
 * The rest of what a plugin's tool reads of its run (`ToolRun`, whose id
 * the core declares): exactly the fields the app's tools read. Its policy,
 * configuration, model, delegation scope, scope (a tool that starts
 * something the run should stop registers that stop there), opening,
 * trace and stage (what a plugin's own stages nest under); and its run
 * files, which hold what the run read (`fileService.readFiles`). Never its
 * session: a plugin reaches the session's runs through `ChildRuns`, and
 * shows the person something through its call's `requests.present`.
 * What only the built-ins read is `BuiltinRun`.
 */
declare module '../core/tools/ToolTypes.js' {
  interface ToolRun {
    readonly toolPolicy: ToolPolicy;
    readonly config: AgentConfig;
    readonly model: SynchronizedRef.SynchronizedRef<BoundModel>;
    readonly delegationAgentScope?: AgentDelegationScope | null;
    readonly scope: Scope.Scope;
    readonly opening: TemplateOpening | null;
    readonly logger: AgentTrace;
    readonly parentStage: StageHandle;
    readonly fileService: RunFileService;
  }
  interface CallRequests {
    /**
     * Open a request the call does not wait on, under `requestId`: its
     * `request.opened` commits on the run's history, and the plugin owning
     * its kind takes the decision when it lands (`Plugin.decision`). A
     * failed commit is not proof that nothing landed: the run's rows decide.
     */
    readonly post: (
      requestId: string,
      payload: PermissionPayload,
    ) => Effect.Effect<void, CellError>;
    /** Show the person something on the session's host (a file opened
     *  beside what they are looking at, a notice), answered by nothing. */
    readonly present: <K extends RuntimePresentationEvent>(
      event: K,
      payload: RuntimePresentationEventPayloads[K],
    ) => Effect.Effect<void>;
  }
}

/** The run as the harness's built-in tools read it: what a plugin's tool
 *  sees (`ToolRun`), with its session, its open step and its host
 *  callbacks. */
type BuiltinRun = ToolRun &
  Pick<AgentRunShape, 'session' | 'steps' | 'callbacks'>;

/** A call made under a run, as its loop dispatched it (`RunCall`). */
export interface RunCallShape {
  /** The run the call works for, as the built-ins read it. */
  readonly run: BuiltinRun;
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
  /** The script that issued this call; null for a call a response issued. */
  readonly script: ScriptScope | null;
  /** For a `script` call, the door its guest calls the run's tools through,
   *  built on the first `yield*`; null for any other call. */
  readonly scriptCalls: Effect.Effect<ScriptDoor> | null;
}

/** The current call's place in its run, which the run loop provides beside
 *  each call; null outside a run (a standalone host invocation), which is
 *  the reference's default, so nothing provides the null. */
export const RunCall = Context.Reference<RunCallShape | null>(
  '@texra-ai/harness/agent/RunCall',
  { defaultValue: () => null },
);

/** The session of a call's run, for the harness's own helpers a plugin's
 *  tool may call (an edit's approval, which `accept_run_files` asks for);
 *  a plugin's tool reads no session. */
export const sessionOf = (run: ToolRun): AgentRunShape['session'] =>
  // The run on every call the runtime makes is its `AgentRun`.
  // cast: `toolUseDispatch` puts the `AgentRun`, which has its session.
  (run as BuiltinRun).session;

/** The run the current call works for; none for a standalone host call. */
export const callerRun: Effect.Effect<ToolRun | undefined, never, ToolContext> =
  Effect.gen(function* () {
    return (yield* ToolContext).env.run;
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
    readonly run: ToolRun;
    readonly requests: CallRequests;
  },
  ToolError,
  ToolContext
> =>
  Effect.gen(function* () {
    const call = yield* ToolContext;
    const { run } = call.env;
    const { requests } = call;
    if (run === undefined || requests === undefined)
      return yield* Effect.fail(
        new ToolError(`${toolName} requires an active run context.`),
      );
    return { ...call, run, requests };
  });

/** A built-in's call made under a run: the call, the run, where its
 *  requests open, and its place in the run. */
export type RunToolCall = ToolContextShape &
  RunCallShape & { readonly requests: CallRequests };

/** {@link requireRun}, with the call's place in its run, for built-ins. */
export const requireToolRun = (
  toolName: string,
): Effect.Effect<RunToolCall, ToolError, ToolContext> =>
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
  function* (path: string): Effect.fn.Return<void, never, ToolContext> {
    const files = (yield* ToolContext).env.run?.fileService;
    // Recording a read is this helper's job alone: plugins see it read-only.
    // cast: what the run read is a Set; the contract shows it read-only.
    if (path) (files?.readFiles as Set<string> | undefined)?.add(path);
  },
);

/** The refusal an edit of an existing file gets when the run never read it,
 *  or null: an edit needs a read first, which the run's files record. */
export const requireFileReadForEdit = Effect.fn('RunCall.requireReadForEdit')(
  function* (
    path: string,
    exists: boolean,
    errorMessage?: string,
    /** How the card names the file; the tracker keys on `path`. */
    displayPath: string = path,
  ): Effect.fn.Return<ToolResult | null, never, ToolContext> {
    const { run } = (yield* ToolContext).env;
    if (!exists || run?.fileService.readFiles.has(path) === true) {
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
