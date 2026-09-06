/**
 * The sessions of `@texra-ai/agent/effect` and the runs on them.
 *
 * `Sessions` is the process's one session owner as an Effect service: it
 * opens, lists and closes through `@agent/runtime`'s owner port, so a root
 * opened here is the same session every TeXRA host opens (one session per
 * workspace storage root, never a second registry). A {@link Session} is a
 * value, not a tag — there are N of them, one per root — and a pure
 * function of the owner's handle: it stores nothing the owner already
 * holds.
 *
 * Every decision a run makes is stated once, here, in Effect: which level
 * is the run's first, when its transcript interest changes, when the drain
 * ends, and which failure wins. `packages/agent/src/index.ts` renders this
 * as Promises and adds nothing of its own.
 */
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Stream,
  type Cause,
  type Scope,
} from 'effect';

// Values, and types used only inside function bodies, come through the
// curated `@agent/runtime` barrel rather than by module path, so this
// package stops pinning the runtime's internal file layout. These never
// reach the emitted declarations, so they carry no provider-type leak risk.
import { loadAgents, resolveAgent } from '@agent/index';
import {
  closeSession as closeOwnedSession,
  listSessions as listOwnedSessions,
  openSessionEffect,
  runAgent as runValidatedAgent,
  type AgentRunHandle as RuntimeAgentRunHandle,
  type SessionHandle as RuntimeSessionHandle,
} from '@agent/runtime';
import type { AgentEvent } from '@agent/trace';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';

// `AgentFlowResult` is deliberately sourced from its own module rather than
// from the `@agent/runtime` barrel above: it appears in this subpath's
// PUBLIC declarations, and declaration emit follows whichever module a
// public type comes from, so taking it from the barrel would pull the
// barrel's whole `.d.ts` graph — model handlers included — into the
// published type surface and trip the provider-type leak check in
// `scripts/validate-artifacts.mjs`.
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';

import { createLog } from '@logger/logUtils';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  AgentCategory,
  aggregateId as qualifyAggregateId,
  type ExecutionId,
  type SessionCloseReport,
  type StreamTabId,
  type TranscriptSubscription,
} from '@shared/schemas';
import type { RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import type {
  SessionView as RuntimeSessionView,
  StreamView as RuntimeStreamView,
  TranscriptView as RuntimeTranscriptView,
} from '@shared/session/sessionView';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  AgentNotFound,
  RunFailure,
  ToolsRefused,
  type LaunchError,
} from './errors.js';
import type { AgentRuntime } from './runtime.js';

/**
 * A runtime value as the embedder may hold it: read-only all the way down,
 * every map, array, and record included. The value itself is not copied
 * (the fold publishes immutable levels); the type is what keeps a write
 * from reaching it.
 */
type ReadonlyDeep<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<K, ReadonlyDeep<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<ReadonlyDeep<V>>
      : T extends readonly (infer E)[]
        ? readonly ReadonlyDeep<E>[]
        : T extends object
          ? { readonly [P in keyof T]: ReadonlyDeep<T[P]> }
          : T;

/** One published level of the session's fold: an immutable value. */
export type SessionView = ReadonlyDeep<RuntimeSessionView>;
/** One stream of the {@link SessionView}. */
export type StreamView = ReadonlyDeep<RuntimeStreamView>;
/** A stream's transcript slice: what hosts paint. */
export type TranscriptView = ReadonlyDeep<RuntimeTranscriptView>;

/** What starting a run on a session takes. */
export interface StartInput {
  readonly agent: string;
  readonly instruction: string;
  readonly model?: string;
  readonly tools?: readonly ITool[];
}

/** One run of an agent, from the moment it exists in its session. */
export interface Run {
  /** The run's execution id, minted here and handed to the launcher, so it
   *  identifies the run before its first model call. */
  readonly executionId: ExecutionId;
  readonly streamId: StreamTabId;
  /**
   * The run's own outcome first: on failure the fold's fate never replaces
   * it; on success this waits for the level holding the durable outcome.
   */
  readonly result: Effect.Effect<AgentFlowResult, RunFailure>;
  /**
   * The session's levels sliced to this run: from the first level holding
   * its stream through the first holding its durable outcome. Typed error
   * `never`: a dead fold is a defect, as `SessionViewService.changes`
   * publishes it.
   */
  readonly view: Stream.Stream<SessionView>;
  /**
   * The run's trace, buffered from the moment the run enters the session so
   * that no launch event is lost to a reader that has yet to attach. Ends
   * when the run settles, fails with {@link RunFailure} when the run failed,
   * and drops what it holds when the run settles unread. Running it once is
   * the contract: ending the iteration detaches the trace while the run
   * continues. The pre-reader buffer is bounded: a run whose events pass
   * {@link TRACE_HANDOVER_EVENTS} with nobody reading has no reader, so it
   * warns and detaches rather than retaining the whole trace.
   */
  readonly events: Stream.Stream<AgentEvent, RunFailure>;
  /** Before the runtime hands over the live handle this aborts the launch;
   *  after, it interrupts the run. */
  readonly interrupt: Effect.Effect<void>;
}

/** One session of the process's owner, as this package works on it. */
export interface Session {
  readonly roots: WorkspaceRoots;
  /**
   * Admission: succeeds when the run exists in the session, with its stream
   * published and its trace live. Interrupting the caller before admission
   * aborts the launch; interrupting it during the handoff that follows ends
   * the run too, so a caller that does not receive a {@link Run} has none
   * running.
   */
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<Run, LaunchError | RunFailure>;
  /** The one handler of every request a surface issues to this session:
   *  answered exactly once, an outcome or a request error. */
  readonly request: (
    request: RuntimeRequest,
  ) => Effect.Effect<Outcome, RequestError>;
  /** The fold's levels, each an immutable value. */
  readonly view: { readonly changes: Stream.Stream<SessionView> };
  /** The session's event plane, reads only. */
  readonly events: Omit<SessionEventsShape, 'publish'>;
  /**
   * This reader's transcript interest, held for the scope and cleared when
   * it closes. Its port is the reader's own, so it never disturbs a run's.
   */
  readonly subscribe: (
    interests: readonly TranscriptSubscription[],
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/** The process's session owner: one session per workspace storage root. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session of these roots, or the runtime's, through the process's
     *  one owner. */
    readonly open: (roots?: WorkspaceRoots) => Effect.Effect<Session>;
    /**
     * Refuse new runs, settle the ones it owns inside `signal`'s budget or
     * the runtime's shutdown-phase budget, flush, release.
     */
    readonly close: (
      roots?: WorkspaceRoots,
      signal?: AbortSignal,
    ) => Effect.Effect<SessionCloseReport>;
    readonly list: Effect.Effect<readonly Session[]>;
  }
>()('@texra-ai/agent/Sessions') {}

/**
 * The session's one host, for its whole life, like every TeXRA host
 * attaches one per session: the interaction hub keeps a single active host
 * and tells runs apart by the stream its requests and cancellations name.
 * Attaching per run instead would make each new run displace the previous
 * run's host. The package has no interactive prompts, so there is nothing
 * for a cancellation to settle; a retry prompt is denied so that it never
 * parks the run waiting for a host.
 */
const HEADLESS_HOST = {
  cancel: () => {},
  requestRetry: async () => ({
    action: 'deny' as const,
    reason: 'Interactive retries are unavailable in the agent package.',
  }),
};

/** A run that returned without ever publishing its stream: the launcher's
 *  contract broke, and a caller waiting on admission must hear it. */
const NEVER_ENTERED = 'The run ended without entering the session.';

const log = createLog('agentPackage');

/**
 * How many trace events a run holds for a reader that has yet to attach.
 * The buffer exists only to bridge admission to the reader's first pull, so
 * a run that passes it with nobody reading has no reader: it says so and
 * detaches its trace, instead of retaining a long run's whole trace (every
 * `stream.chunk` included) until the run settles. A reader that did attach
 * is never dropped: past its first pull the buffer is the reader's, and
 * nothing here discards what it has yet to read.
 */
const TRACE_HANDOVER_EVENTS = 512;

/** The run's stream and every descendant the view holds. */
function runStreamIds(view: SessionView, streamId: StreamTabId): StreamTabId[] {
  const ids: StreamTabId[] = [];
  for (const stream of view.streams.values()) {
    if (
      stream.id === streamId ||
      stream.ancestors.some((ancestor) => ancestor.id === streamId)
    ) {
      ids.push(stream.id);
    }
  }
  return ids;
}

/**
 * The refusal the package states from the caller's own input, before
 * anything of the process is touched: it has no approval channel, so a tool
 * that requires one cannot run here whatever the agent turns out to be.
 * {@link admitInput} states it in its own order; the Promise entry states
 * it first, because there a composition is a side effect of the call and a
 * caller being refused must not pay for one (`../index.ts`).
 */
export function admitTools(
  tools: readonly ITool[] | undefined,
): Effect.Effect<void, ToolsRefused> {
  const needApproval = (tools ?? [])
    .filter((tool) => tool.requiresApproval)
    .map((tool) => tool.definition.name);
  return needApproval.length > 0
    ? Effect.fail(
        new ToolsRefused({
          tools: needApproval,
          message: `The agent package cannot run approval-requiring tools: ${needApproval.join(', ')}`,
        }),
      )
    : Effect.void;
}

/** The run's configuration, or the refusal that stops it before any model
 *  work: the three the package states. */
function admitInput(
  input: StartInput,
): Effect.Effect<
  ReturnType<typeof AgentConfigSchema.parse>,
  LaunchError | RunFailure
> {
  return Effect.gen(function* () {
    const tools = input.tools ?? [];
    yield* admitTools(tools);
    // The agent scan reads the configured directories through the
    // platform, so it can fail on the environment. That is a failure of
    // `start`, in the vocabulary the surface already names, not a defect
    // an embedder's `catchTag` never sees.
    yield* Effect.tryPromise({
      try: () => loadAgents({ includeRemote: false }),
      catch: (cause) =>
        new RunFailure({ cause, message: toErrorMessage(cause) }),
    });
    const resolved = resolveAgent(input.agent);
    if (!resolved) {
      return yield* new AgentNotFound({
        agent: input.agent,
        message: `Agent "${input.agent}" was not found in the configured agent directory.`,
      });
    }
    if (tools.length > 0 && resolved.entry.category !== AgentCategory.ToolUse) {
      return yield* new ToolsRefused({
        tools: tools.map((tool) => tool.definition.name),
        message: `Custom tools are supported only for tool-use agents; "${input.agent}" is a workflow agent.`,
      });
    }
    // The schema is the launch's last refusal, and it is a refusal rather
    // than a defect: an instruction this surface will not accept reaches an
    // embedder's `catchTag` in the vocabulary the surface names, as the
    // agent scan's failure above does.
    return yield* Effect.try({
      try: () =>
        AgentConfigSchema.parse({
          agent: resolved.entry.name,
          agentCategory: resolved.entry.category,
          agentSource: resolved.entry.source,
          instruction: input.instruction,
          ...(input.model ? { model: input.model } : {}),
        }),
      catch: (cause) =>
        new RunFailure({ cause, message: toErrorMessage(cause) }),
    });
  });
}

/**
 * Start one run on `session` and hand back the {@link Run} once it exists
 * there. The launch itself is the one foreign boundary this subpath wraps
 * (`runAgent` is Promise-native until lane D converts the run loops): its
 * abort signal is what an interruption before admission reaches.
 *
 * The handoff is all-or-nothing, which is what lets a caller treat the
 * `Run` as the only handle on the run: this either returns one, or it ends
 * every fiber it started. There is no exit in which a run keeps working
 * with nobody holding it.
 */
function start(
  session: RuntimeSessionHandle,
  input: StartInput,
): Effect.Effect<Run, LaunchError | RunFailure> {
  return Effect.gen(function* () {
    const config = yield* admitInput(input);
    const executionId = generateExecutionId();
    const trace = yield* Queue.unbounded<AgentEvent, RunFailure | Cause.Done>();
    const admitted = yield* Deferred.make<StreamTabId, RunFailure>();
    let handle: RuntimeAgentRunHandle | undefined;
    let detach: (() => void) | undefined;
    let reading = false;
    let buffered = 0;
    /** Detach the trace, once: the reader's close does it while the run
     *  continues, and the run's settlement does it for a reader that never
     *  came. */
    const release = (): void => {
      detach?.();
      detach = undefined;
    };
    const settle = (
      exit: Exit.Exit<AgentFlowResult, RunFailure>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        release();
        // A run nobody read retains nothing: what it buffered goes with it.
        if (!reading) yield* Effect.orDie(Queue.clear(trace));
        if (Exit.isFailure(exit)) {
          yield* Deferred.failCause(admitted, exit.cause);
          yield* Queue.failCause(trace, exit.cause);
          return;
        }
        yield* Deferred.fail(
          admitted,
          new RunFailure({
            cause: new Error(NEVER_ENTERED),
            message: NEVER_ENTERED,
          }),
        );
        yield* Queue.end(trace);
      });
    // The launch and the drain are the run's, and until the caller holds
    // the `Run` that names them they are nobody's: whatever ends this
    // handoff short of that ends them too. So the handoff is
    // uninterruptible but for the admission wait, where the launch's own
    // abort signal is what an interruption reaches, and the exit handler
    // outside the mask covers the rest, the boundary included: an interrupt
    // that lands while the tail runs is raised the moment the mask lifts,
    // with a `Run` built that reaches no one.
    const spawned: Fiber.Fiber<unknown, unknown>[] = [];
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const runFiber = yield* Effect.forkDetach(
          Effect.tryPromise({
            try: (signal) =>
              runValidatedAgent(
                { kind: 'fresh', config, executionId },
                {
                  approvalPromptsUnavailable: true,
                  launchSignal: signal,
                  onRun: (live) => {
                    handle = live;
                  },
                  onStreamResolved: (streamId, runTrace) => {
                    detach = runTrace.subscribe((event) => {
                      if (!reading && (buffered += 1) > TRACE_HANDOVER_EVENTS) {
                        log.warn(
                          `Run ${executionId} buffered ${TRACE_HANDOVER_EVENTS} trace events with no reader attached; detaching its trace. Iterate the run's events in the turn that starts it, or await only its result.`,
                        );
                        release();
                        return;
                      }
                      Queue.offerUnsafe(trace, event);
                    });
                    Deferred.doneUnsafe(admitted, Effect.succeed(streamId));
                  },
                  session,
                  stopAfterCycle: true,
                  tools: input.tools,
                },
              ),
            catch: (cause) =>
              new RunFailure({ cause, message: toErrorMessage(cause) }),
          }).pipe(Effect.onExit(settle)),
          { startImmediately: true },
        );
        spawned.push(runFiber);
        const streamId = yield* restore(Deferred.await(admitted));
        const view = session.viewChanges.pipe(
          // The level replays on subscribe, and the fold lands the run's
          // `run.start` asynchronously, so a replayed level can predate the
          // run.
          Stream.dropWhile((level) => !level.streams.has(streamId)),
          // The view is the end condition: the first level holding the
          // run's durable outcome is the last element.
          Stream.takeUntil(
            (level) => level.streams.get(streamId)?.durableOutcome != null,
          ),
        );
        // The transcript tier folds only for subscribed aggregates, on a
        // port of this run's own: its stream now, its descendants as the
        // view gains them. The port is never cleared, by choice: the run's
        // rows stay resident for the life of the package session, as a
        // TUI's do.
        const port = `sdk/${streamId}`;
        let subscribed = '';
        const interest = (ids: readonly StreamTabId[]): Effect.Effect<void> =>
          Effect.suspend(() => {
            const key = ids.join('\0');
            if (key === subscribed) return Effect.void;
            subscribed = key;
            return session.subscriptions.set(
              port,
              ids.map((id) => ({
                id: qualifyAggregateId('stream', id),
                fromSeq: 0,
              })),
            );
          });
        yield* interest([streamId]);
        // The package owns this drain: the descendants join the
        // subscription as the view gains them, and the run's `result` waits
        // for its final fold even when nobody reads `view`, and fails if
        // the fold dies first.
        const drain = yield* Effect.forkDetach(
          Stream.runDrain(
            view.pipe(
              Stream.tap((level) => interest(runStreamIds(level, streamId))),
            ),
          ),
          { startImmediately: true },
        );
        spawned.push(drain);
        return {
          executionId,
          streamId,
          result: Fiber.join(runFiber).pipe(
            Effect.flatMap((value) => Effect.as(Fiber.join(drain), value)),
          ),
          view,
          events: Stream.unwrap(
            Effect.sync(() => {
              reading = true;
              return Stream.fromQueue(trace);
            }),
          ).pipe(Stream.ensuring(Effect.sync(release))),
          interrupt: Effect.suspend(() =>
            handle
              ? Effect.sync(() => {
                  handle?.interrupt();
                })
              : Fiber.interrupt(runFiber),
          ),
        };
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Fiber.interruptAll(spawned),
      ),
    );
  });
}

/** One reader port per `subscribe`, so no reader disturbs another's set. */
let readerPorts = 0;

/** The session as this package works on it: a pure function of the owner's
 *  handle, holding nothing the owner already holds. */
function sessionOf(handle: RuntimeSessionHandle): Session {
  return {
    roots: handle.roots,
    start: (input) => start(handle, input),
    request: (request) => handle.requests.request(request),
    view: { changes: handle.viewChanges },
    events: handle.events,
    subscribe: (interests) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const port = `sdk/reader/${(readerPorts += 1)}`;
          return Effect.as(handle.subscriptions.set(port, interests), port);
        }),
        (port) => handle.subscriptions.set(port, []),
      ).pipe(Effect.asVoid),
  };
}

/** The package's session policy over the process's owner: an ephemeral
 *  transcript store and one headless host for the session's life. */
export function makeSessions(
  runtime: AgentRuntime,
): Context.Service.Shape<typeof Sessions> {
  return {
    open: (roots?: WorkspaceRoots) =>
      Effect.map(
        Effect.suspend(() =>
          openSessionEffect({
            roots: roots ?? runtime.roots,
            transcripts: StreamLogStore.ephemeral('npm package consumer'),
            interactions: HEADLESS_HOST,
          }),
        ),
        sessionOf,
      ),
    close: (roots?: WorkspaceRoots, signal?: AbortSignal) =>
      closeOwnedSession((roots ?? runtime.roots).storage, signal),
    list: Effect.map(listOwnedSessions(), (handles) => handles.map(sessionOf)),
  };
}
