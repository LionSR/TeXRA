/**
 * `@texra-ai/agent` — the package's Promise surface, and nothing else.
 *
 * This module is the boundary the Effect migration's rule R1 names
 * (`docs/prds/2026-08-26-effect-4-runtime-migration.md`, §7 R1, boundary
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
import { disposeProcessRuntime } from '@controllers/session/sessionLayer';
import { effectRuntime } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { SessionCloseReport } from '@shared/schemas';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';

// Local imports - the Effect surface this entry renders
import { RunFailure } from './effect/errors.js';
import { composeProcess, type AgentPlatform } from './effect/runtime.js';
import { makeSessions, type SessionView } from './effect/sessions.js';

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
 * discards what it buffered.
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
   * The run's transcript rows (`StreamView.transcript`) are resident for the
   * life of the package session, which is the process: its stream and, as
   * they appear, its descendants are subscribed on the run's behalf.
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
 * own budget, then the runtime that held it goes, and its owner with it, so
 * a later `closeSession` answers as a process with none does. An Effect
 * embedder reaches the same closure through `Runtime.layer`'s scope.
 */
function agentServices(
  platform: AgentPlatform,
): ReturnType<typeof makeSessions> {
  const runtime = composeProcess(platform);
  const sessions = makeSessions(runtime);
  if (runtime.composed) {
    registerRuntimeShutdownHandlers(platform.lifecycle, {
      flushArtifacts: async (signal) => {
        await effectRuntime().runPromise(
          sessions.close(platform.roots, signal),
        );
      },
      afterExecutionSettlement: [() => disposeProcessRuntime()],
    });
  }
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
  return effectRuntime().runPromise(closeOwnedSession(roots.storage, signal));
}

/**
 * Start one agent run and expose its trace as an asynchronous event stream.
 *
 * The platform and agent registry are process-wide. Applications should create
 * one platform, then reuse it for every run in that process.
 */
export function runAgent(input: RunAgentInput): AgentRun {
  const sessions = agentServices(input.platform);
  // One fiber on the process runtime, which `runFork` evaluates to its
  // first yield before returning: the owner holds this run's session by the
  // time `runAgent` does.
  const started = effectRuntime().runFork(
    Effect.flatMap(sessions.open(), (session) => session.start(input)),
  );
  const result = effectRuntime()
    .runPromise(Fiber.join(started).pipe(Effect.flatMap((run) => run.result)))
    .catch((error: unknown) => {
      throw embedderError(error);
    });
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
      // the launch's abort signal; after it, the live run's handle.
      effectRuntime().runFork(
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
