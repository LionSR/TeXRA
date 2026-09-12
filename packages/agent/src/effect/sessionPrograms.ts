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
  Layer,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Stream,
  type Cause,
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

import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';

// The composition root supplies its existing scoped services privately;
// public Session capabilities carry no process implementation types.
import { createLog } from '@logger/logUtils';
import type { ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  AgentCategory,
  aggregateId as qualifyAggregateId,
  type RunId,
} from '@shared/schemas';
import { descendantRuns } from '@shared/session/sessionView';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  AgentNotFound,
  RunFailure,
  ToolsRefused,
  type LaunchError,
} from './errors.js';
import {
  Sessions,
  type Session,
  type Run,
  type StartInput,
} from './sessions.js';
import type { AgentRuntime } from './runtime.js';

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

/** What a run on a package session hears instead of a retry prompt. */
const RETRY_DENIAL =
  'Interactive retries are unavailable in the agent package.';

/**
 * The package's standing answer to a retry request, for the life of a
 * session it opened: there is nobody here to ask, so a run parked on a
 * user-retryable provider failure is denied rather than left waiting for a
 * surface that never comes. It answers through `request.decide`, the one
 * door every host answers through, and reads the same pending list a host
 * renders, so the denial lands as the run's `request.decided` row and
 * nothing else in the protocol is special-cased for this package.
 */
function denyRetryRequests(handle: RuntimeSessionHandle): Effect.Effect<void> {
  /** The requests this listener has answered, dropped as the fold drops
   *  them: a level published before the decision lands lists the request
   *  again, and answering twice is refused as already settled. */
  const answered = new Set<string>();
  return Stream.runForEach(handle.viewChanges, (level) => {
    const live = new Set(level.requests.map((pending) => pending.requestId));
    for (const requestId of answered) {
      if (!live.has(requestId)) answered.delete(requestId);
    }
    return Effect.forEach(
      level.requests.filter(
        (pending) =>
          pending.payload.kind === 'retry' && !answered.has(pending.requestId),
      ),
      (pending) => {
        answered.add(pending.requestId);
        return handle.requests
          .request({
            kind: 'request.decide',
            runId: pending.runId,
            requestId: pending.requestId,
            decision: { action: 'deny', reason: RETRY_DENIAL },
          })
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                // A refused write answered nothing: the request stays
                // pending, so this listener must forget it or no later
                // level would ever deny it again and the run would wait
                // for a surface that never comes.
                answered.delete(pending.requestId);
                log.warn(
                  `The retry denial for request ${pending.requestId} was refused: ${toErrorMessage(error)}`,
                );
              }),
            ),
          );
      },
      { discard: true },
    );
  });
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
    yield* loadAgents({ includeRemote: false }).pipe(
      Effect.mapError((cause) => {
        // The agent scan reads the configured directories through the
        // platform, so it can fail on the environment. That is a failure of
        // `start`, in the vocabulary the surface already names, not a defect
        // an embedder's `catchTag` never sees.
        return new RunFailure({ cause, message: toErrorMessage(cause) });
      }),
    );
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
  services: Layer.Layer<ProcessServices>,
  input: StartInput,
): Effect.Effect<Run, LaunchError | RunFailure> {
  return Effect.gen(function* () {
    const config = yield* admitInput(input);
    const runId = generateRunId();
    const trace = yield* Queue.unbounded<AgentEvent, RunFailure | Cause.Done>();
    const admitted = yield* Deferred.make<void, RunFailure>();
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
    const interruptLaunch = ():
      Pick<RuntimeAgentRunHandle, 'interrupt'> | undefined => {
      const current = handle ?? session.runs.getHandle(runId);
      current?.interrupt();
      return current;
    };
    const spawned: Fiber.Fiber<unknown, unknown>[] = [];
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const runFiber = yield* Effect.forkDetach(
          runValidatedAgent(
            { kind: 'fresh', config, runId },
            {
              approvalPromptsUnavailable: true,
              onRun: (live) => {
                handle = live;
              },
              onRunResolved: (_, runTrace) => {
                detach = runTrace.subscribe((event) => {
                  if (!reading && (buffered += 1) > TRACE_HANDOVER_EVENTS) {
                    log.warn(
                      `Run ${runId} buffered ${TRACE_HANDOVER_EVENTS} trace events with no reader attached; detaching its trace. Iterate the run's events in the turn that starts it, or await only its result.`,
                    );
                    release();
                    return;
                  }
                  Queue.offerUnsafe(trace, event);
                });
                Deferred.doneUnsafe(admitted, Effect.void);
              },
              session,
              stopAfterCycle: true,
              tools: input.tools,
            },
          ).pipe(
            // The embedder owns this runtime. Provide the process's existing
            // context so native tool I/O shares its scoped clients and stores.
            Effect.provide(services),
            Effect.mapError(
              (cause) =>
                new RunFailure({ cause, message: toErrorMessage(cause) }),
            ),
            Effect.onExit(settle),
          ),
          { startImmediately: true },
        );
        spawned.push(runFiber);
        yield* restore(Deferred.await(admitted));
        const view = session.viewChanges.pipe(
          // The level replays on subscribe, and the fold lands the run's
          // `run.start` asynchronously, so a replayed level can predate the
          // run.
          Stream.dropWhile((level) => !level.runs.has(runId)),
          // The view is the end condition: the first level holding the
          // run's durable outcome is the last element.
          Stream.takeUntil(
            (level) => level.runs.get(runId)?.durableOutcome != null,
          ),
        );
        // The transcript tier folds only for subscribed aggregates, on a
        // port of this run's own: its stream now, its descendants as the
        // view gains them. The port is never cleared, by choice: the run's
        // rows stay resident for the life of the package session, as a
        // TUI's do.
        const port = `sdk/${runId}`;
        let subscribed = '';
        const interest = (ids: readonly RunId[]): Effect.Effect<void> =>
          Effect.suspend(() => {
            const key = ids.join('\0');
            if (key === subscribed) return Effect.void;
            subscribed = key;
            return session.subscriptions.set(
              port,
              ids.map((id) => ({
                id: qualifyAggregateId('run', id),
                fromSeq: 0,
              })),
            );
          });
        yield* interest([runId]);
        // The package owns this drain: the descendants join the
        // subscription as the view gains them, and the run's `result` waits
        // for its final fold even when nobody reads `view`, and fails if
        // the fold dies first.
        const drain = yield* Effect.forkDetach(
          Stream.runDrain(
            view.pipe(
              Stream.tap((level) =>
                interest(descendantRuns(level, runId, { includeRoot: true })),
              ),
            ),
          ),
          { startImmediately: true },
        );
        spawned.push(drain);
        return {
          runId,
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
            interruptLaunch() ? Effect.void : Fiber.interrupt(runFiber),
          ),
        };
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.suspend(() => {
              interruptLaunch();
              return Fiber.interruptAll(spawned);
            }),
      ),
    );
  });
}

/** One reader port per `subscribe`, so no reader disturbs another's set. */
let readerPorts = 0;

/** The session as this package works on it: a pure function of the owner's
 *  handle, holding nothing the owner already holds. */
function sessionOf(
  handle: RuntimeSessionHandle,
  services: Layer.Layer<ProcessServices>,
): Session {
  return {
    roots: handle.roots,
    start: (input) => start(handle, services, input),
    request: (request) => handle.requests.request(request),
    view: { changes: handle.viewChanges },
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
 *  transcript store and, on the sessions it opens, the retry denial that
 *  stands in for the person a package session has no way to ask. */
export function makeSessions(
  runtime: AgentRuntime,
  services: Layer.Layer<ProcessServices>,
): Context.Service.Shape<typeof Sessions> {
  /** The retry listener of each session this package opened, by storage
   *  root, ended with the session it answers for. */
  const deniers = new Map<string, Fiber.Fiber<void>>();
  return {
    open: (roots?: WorkspaceRoots) =>
      Effect.gen(function* () {
        const resolved = roots ?? runtime.roots;
        // A root a host already opened keeps that host's decision delivery:
        // its UI prompts for the retries of every run on the session, this
        // package's included. Only a session opened here gets the denial.
        const hostOpened = (yield* listOwnedSessions()).some(
          (other) => other.roots.storage === resolved.storage,
        );
        const handle = yield* openSessionEffect({
          roots: resolved,
          transcriptMode: {
            kind: 'ephemeral',
            reason: 'npm package consumer',
          },
        });
        if (!hostOpened && !deniers.has(resolved.storage)) {
          const root = resolved.storage;
          // The listener ends with the session it answers for: interrupted
          // by the close below, or finished when that session is invalidated
          // after its abandoned runs settle. Its key ends with it, so a
          // later open on this root installs a live listener rather than
          // trusting a dead entry and leaving its retries unanswered.
          deniers.set(
            root,
            yield* Effect.forkDetach(
              Effect.ensuring(
                denyRetryRequests(handle),
                Effect.sync(() => deniers.delete(root)),
              ),
            ),
          );
        }
        return sessionOf(handle, services);
      }),
    close: (roots?: WorkspaceRoots, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const root = (roots ?? runtime.roots).storage;
        const report = yield* closeOwnedSession(root, signal);
        // A close that could not settle leaves the session open with its
        // runs live, so the listener stays with them; the close that finally
        // settles ends it, and its own finalizer drops the key.
        if (report.settled) {
          const denier = deniers.get(root);
          if (denier) yield* Fiber.interrupt(denier);
        }
        return report;
      }),
    list: Effect.map(listOwnedSessions(), (handles) =>
      handles.map((handle) => sessionOf(handle, services)),
    ),
  };
}
