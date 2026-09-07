/**
 * `@texra-ai/agent` — the package's Promise surface, and nothing else.
 *
 * This module is the boundary the Effect migration's rule R1 names
 * (`.agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md`, §7 R1, boundary
 * kind 3: the published SDK speaks Promises). Every decision this package
 * makes is stated once, in Effect, on `@texra-ai/agent/effect`; what
 * follows renders those services as Promises and AsyncIterables and adds no
 * logic of its own. Every `Effect.runPromise` / `runFork` in the package is
 * here and nowhere below it.
 */
// Third-party imports
import { Effect, Exit, Fiber, Stream } from 'effect';

// Local imports - agent runtime
//
// Values, and types used only inside function bodies, come through the
// curated `@agent/runtime` barrel rather than by module path, so this
// package stops pinning the runtime's internal file layout — the same
// fold-in the three hosts took in #10011. These never reach the emitted
// declarations, so they carry no provider-type leak risk.
import type { AgentEvent } from '@agent/trace';
import { closeSession as closeOwnedSession } from '@agent/runtime';
import type { ITool } from '@agent/core/tools/ToolTypes';

// `AgentFlowResult` is deliberately sourced from its own module rather than
// from the `@agent/runtime` barrel above. It appears in this package's PUBLIC
// declarations (`AgentRun.result`, and the re-export below), and declaration
// emit follows whichever module a public type comes from: taking it from the
// barrel pulls the barrel's whole `.d.ts` graph — model handlers included —
// into the published type surface, which trips the provider-type leak check in
// `scripts/validate-artifacts.mjs` (`@anthropic-ai/sdk`).
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';

// Local imports - host services this boundary wires
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { SessionCloseReport } from '@shared/schemas';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';

// Local imports - the Effect surface this entry renders
import { RunFailure } from './effect/errors.js';
import { composeProcess, type AgentPlatform } from './effect/runtime.js';
import {
  admitTools,
  makeSessions,
  type SessionView,
} from './effect/sessions.js';

/**
 * The owner's session effects supply their own context, so every run site
 * below runs on Effect's own runtime rather than borrowing the process
 * runtime the composition installs. That is what lets `closeSession`
 * answer for a process no run has initialized, and for one whose shutdown
 * has already disposed that runtime, exactly as its contract says.
 */

export type { AgentEvent } from '@agent/trace';
export type { SessionCloseReport } from '@shared/schemas';
export type {
  ITool,
  IToolRegistry,
  ToolHost,
} from '@agent/core/tools/ToolTypes';
export { MapToolRegistry } from '@agent/core/tools/ToolTypes';
export { defineTool } from '@tools/core/define';
export type { DefinedToolClass } from '@tools/core/define';
export type {
  AgentFlowResult,
  ToolUseFlowResult,
  WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
export type { AgentPlatform } from './effect/runtime.js';
export type {
  SessionView,
  StreamView,
  TranscriptView,
} from './effect/sessions.js';

/** Input accepted by the public package-level run function. */
export interface RunAgentInput {
  readonly platform: AgentPlatform;
  readonly agent: string;
  readonly instruction: string;
  readonly model?: string;
  readonly tools?: readonly ITool[];
}

/**
 * A running agent's single-consumer event stream and eventual terminal result.
 *
 * Trace events are buffered from the moment the run enters its session, so
 * an iteration begun right after `runAgent()` misses none of the launch
 * events. Ending the iteration detaches the event source while the run
 * itself continues, and a run that settles without ever being iterated
 * discards what it buffered. Unread trace data is capped at 512 events and
 * 8 MiB, including after attachment. Overload fails only the trace reader;
 * execution and its result continue. Retained state is available from the
 * session view or canonical events.
 *
 * Every execution failure arrives on `result`, never as a throw from `runAgent()`
 * itself. A refusal before any model work is the tagged error the Effect
 * surface names (`AgentNotFound`, `ToolsRefused`, `PlatformConflict`), or,
 * for a run started after the platform's shutdown has run, the plain
 * `Error` this entry states: that one is the Promise entry's own condition,
 * since the Effect surface composes per scope. A run that fails after it
 * entered the session rejects with exactly what the launch path threw.
 */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly result: Promise<AgentFlowResult>;
  /**
   * The session view the run folds into (PRD one-fold-three-renderers,
   * 10.3): the same state every TeXRA host renders, so an embedder reads
   * stream status, transcript rows, and approvals from here instead of
   * re-folding the trace. Each iteration yields the current view first, then
   * every later level, and ends with the first view in which the run is
   * durably final (that terminal view is the last element, also for a
   * consumer that starts after the run ended) or when the consumer breaks.
   * The first view yielded holds the run's stream: a level from before the
   * run entered the session is not this run's and is skipped.
   *
   * Every yielded view is immutable: an older view stays what it was for as
   * long as it is held, and a branch the later level did not touch is the
   * same object in both. The type is read-only all the way down; a write
   * through a cast corrupts the session every host and every later run on
   * it reads.
   *
   * The run's transcript rows and descendants stay resident through its
   * final hydrated fold. Each view iterator holds its own scoped interest
   * and releases it when iteration ends. A late iterator waits for any
   * evicted transcript to replay before yielding the terminal view.
   *
   * A run that fails before it enters the session has no view: the
   * iteration ends empty and `result` carries the failure. If the session's
   * fold dies, every iteration fails with the fold's defect; `result` fails
   * with that defect only when the run itself completed, otherwise the run's
   * own error wins.
   */
  readonly view: AsyncIterable<SessionView>;
  interrupt(): void;
}

/**
 * The Promise entry's one composition of the process, and the hold it took
 * on it.
 *
 * This entry's owner for a composition is the embedder's shutdown path, and
 * a lifecycle host drains each phase exactly once and caches its shutdown,
 * so there is one such owner per process and therefore one composition: a
 * later `runAgent` on the same platform reuses this rather than taking a
 * second hold nothing would release. The shutdown releases the hold and
 * clears this, and `shutdownRan` refuses a run that arrives after it, so no
 * run composes a session with no shutdown path left to close and flush it.
 * The Effect surface has no such limit: there the owner is the scope, so a
 * new `Runtime.layer` scope composes the process again.
 */
let composition:
  | {
      readonly platform: AgentPlatform;
      readonly sessions: ReturnType<typeof makeSessions>;
    }
  | undefined;

/**
 * The package's services over the process it composes.
 *
 * `composeProcess` is synchronous, so everything from the platform check to
 * the owner's registration of this run's root happens before `runAgent`
 * returns: a `closeSession` or a `runShutdown` issued right after it settles
 * this launch too. It is the same call `Runtime.layer` acquires, so
 * composition has one implementation with two entry paths.
 *
 * The composing call also puts the session on the embedder's shutdown path:
 * the session's agent-spawned children and agent-CLI sessions are stopped,
 * then the platform's session is closed through its owner under the phase's
 * own budget, then this entry's hold on the composition ends. The runtime
 * and the owner on it go with that hold when it is the last one, so a later
 * `closeSession` answers as a process with none does, and they stay while an
 * Effect scope of the same process still holds them. An Effect embedder
 * reaches the same closure through `Runtime.layer`'s scope.
 */
function agentServices(
  platform: AgentPlatform,
): ReturnType<typeof makeSessions> {
  if (platform.lifecycle.shutdownRan) {
    throw new Error(
      "This platform's shutdown has already run, and it runs once: a session opened now would have no shutdown path to close and flush it, and the runtime under it none to dispose it. Run further agents in a new process, or take the Effect surface (@texra-ai/agent/effect), whose scope owns each composition.",
    );
  }
  if (composition?.platform === platform) return composition.sessions;
  // A different platform reaches `composeProcess`, which is what states the
  // refusal.
  const hold = composeProcess(platform);
  const sessions = makeSessions(hold.runtime);
  composition = { platform, sessions };
  registerRuntimeShutdownHandlers(platform.lifecycle, {
    flushArtifacts: async (signal) => {
      await Effect.runPromise(sessions.close(platform.roots, signal));
    },
    afterExecutionSettlement: [
      async () => {
        composition = undefined;
        await Effect.runPromise(hold.release);
      },
    ],
  });
  return sessions;
}

/**
 * Close the session of a workspace's storage root: refuse new runs on it,
 * interrupt the ones it owns and wait for them to settle within `signal`'s
 * budget (the embedder's own shutdown phase) or, without one, the runtime's
 * shutdown budget, flush its artifacts, and release it. The report says
 * whether every run settled; the runs it names as `abandoned` were still
 * live when the budget ran out, and the session stays open, refusing new
 * runs, until they end. A root with no open session reports `settled`, as
 * does a process no run has initialized. The embedder's shutdown path
 * (`lifecycle.runShutdown()`) closes the platform's session this way, under
 * its phase budget; call it directly to close a root before that, or to
 * close one of several roots one platform opened.
 */
export function closeSession(
  roots: WorkspaceRoots,
  signal?: AbortSignal,
): Promise<SessionCloseReport> {
  return Effect.runPromise(closeOwnedSession(roots.storage, signal));
}

/**
 * Start one agent run and expose its trace as an asynchronous event stream.
 *
 * The platform and agent registry are process-wide. Applications should create
 * one platform, then reuse it for every run in that process; a second,
 * different platform is refused, and the refusal arrives on the returned
 * run's `result` like every other launch refusal.
 */
export function runAgent(input: RunAgentInput): AgentRun {
  // One fiber, which `runFork` evaluates to its first yield before it
  // returns: the process is composed and this run's root is the owner's by
  // the time `runAgent` returns. The composition runs inside the fiber so
  // that its one refusal, `PlatformConflict`, reaches the caller on
  // `result`, where every other launch refusal arrives, rather than
  // throwing from a call whose declared shape is an `AgentRun`.
  const started = Effect.runFork(
    // The refusal the package can state from the input alone comes first,
    // as it did before this entry composed inside the fiber: a caller that
    // hands over an approval-requiring tool is refused without a process
    // runtime, a session owner, or a session being composed on its behalf.
    // `start` states it again in its own order, over the agent it resolved.
    admitTools(input.tools).pipe(
      Effect.andThen(
        Effect.try({
          try: () => agentServices(input.platform),
          catch: (refusal) => refusal,
        }),
      ),
      Effect.flatMap((sessions) => sessions.open()),
      Effect.flatMap((session) => session.start(input)),
    ),
  );
  const result = Effect.runPromise(
    Fiber.join(started).pipe(
      Effect.flatMap((run) => run.result),
      // The error an embedder catches, named once, inside the Effect, as
      // the events path names it with the same function.
      Effect.mapError(embedderError),
    ),
  );
  // An embedder that only iterates events must not take an unhandled
  // rejection for the result it never asked for: allSettled subscribes to
  // the rejection and settles regardless, so it is observed either way.
  void Promise.allSettled([result]);
  return {
    result,
    view: Stream.toAsyncIterable(
      Stream.unwrap(
        Fiber.join(started).pipe(
          Effect.map((run) => run.view),
          // A run that fails before it enters the session has no view.
          Effect.catchCause(() => Effect.succeed(Stream.empty)),
        ),
      ),
    ),
    interrupt: () => {
      // Two windows, one expression: before admission the interrupt reaches
      // the launch's abort signal; after it, the live run's handle. The
      // exits are exhaustive because `start`'s handoff is: a success holds
      // the `Run` and its `interrupt` is the live run's, and any other exit
      // is either a launch that already failed or one this interrupt ended
      // in the admission wait, where `start` ended the run with it. There
      // is no exit that leaves a run for this to miss.
      Effect.runFork(
        Fiber.interrupt(started).pipe(
          Effect.andThen(Fiber.await(started)),
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit) ? exit.value.interrupt : Effect.void,
          ),
        ),
      );
    },
    [Symbol.asyncIterator]: () =>
      Stream.toAsyncIterable(
        Stream.unwrap(
          Fiber.join(started).pipe(Effect.map((run) => run.events)),
        ).pipe(Stream.mapError(embedderError)),
      )[Symbol.asyncIterator](),
  };
}

/** The error an embedder catches: a run's own failure carries what the
 *  launch path threw, and a refusal is itself the error. */
function embedderError(error: unknown): unknown {
  return error instanceof RunFailure ? error.cause : error;
}
