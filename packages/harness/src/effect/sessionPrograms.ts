/**
 * The sessions of `@texra-ai/harness` and the runs on them.
 *
 * `Sessions` is a projection of the process's `SessionOwner`: it opens,
 * lists and closes through that one owner, so a root
 * opened here is the same session every TeXRA host opens (one session per
 * workspace storage root, never a second registry). A {@link Session} is a
 * value, not a tag — there are N of them, one per root — and a pure
 * function of the owner's handle: it stores nothing the owner already
 * holds.
 *
 * Every decision a run makes is stated once, here, in Effect: which level
 * is the run's first, when its transcript interest changes, when the drain
 * ends, and which failure wins. The root entry (`packages/harness/src/index.ts`)
 * re-exports these services as the package's surface.
 */
import {
  type Context,
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
import { getAgent } from '@agent/index';
import {
  runAgent as runValidatedAgent,
  type SessionHandle as RuntimeSessionHandle,
} from '@agent/runtime';
import type { SessionOwner } from '@agent/runtime/SessionOwner';
import type { AgentEvent } from '@agent/trace';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';

import type { RunEndResult } from '@agent/runtime/RunEndResult';

// The composition root supplies its existing scoped services privately;
// public Session capabilities carry no process implementation types.
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import { descendantRuns } from '@shared/session/sessionView';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  AgentNotFound,
  RunFailure,
  ToolsRefused,
  type LaunchError,
} from './errors.js';
import type { Sessions, Session, Run, StartInput } from './sessions.js';

/** A run that returned without ever publishing its stream: the launcher's
 *  contract broke, and a caller waiting on admission must hear it. */
const NEVER_ENTERED = 'The run ended without entering the session.';

const CHANNEL = 'agentPackage';

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

/**
 * The refusal the package states from the caller's own input, before
 * anything of the process is touched: it has no approval channel, so a tool
 * that requires one cannot run here whatever the agent turns out to be.
 * {@link admitInput} states it in its own order, before the agent scan.
 */
function admitTools(
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
 *  work: the three the package states. A named agent is looked up; an
 *  inline persona is the agent, recorded on the config and validated by its
 *  schema there. */
function admitInput(
  input: StartInput,
): Effect.Effect<
  ReturnType<typeof AgentConfigSchema.parse>,
  LaunchError | RunFailure
> {
  return Effect.gen(function* () {
    const tools = input.tools ?? [];
    yield* admitTools(tools);
    const { agent } = input;
    const persona = typeof agent === 'string' ? null : agent;
    const resolved =
      typeof agent === 'string'
        ? getAgent(agent)
        : { name: agent.name, source: 'inline' as const };
    if (!resolved) {
      return yield* new AgentNotFound({
        agent: String(agent),
        message: `Agent "${String(agent)}" was not found in the configured agent directory.`,
      });
    }
    // The schema is the launch's last refusal, and it is a refusal rather
    // than a defect: an instruction this surface will not accept reaches an
    // embedder's `catchTag` in the vocabulary the surface names, as the
    // agent scan's failure above does.
    const config = yield* Effect.try({
      try: () =>
        AgentConfigSchema.parse({
          agent: resolved.name,
          agentSource: resolved.source,
          persona,
          instruction: input.instruction,
          ...(input.model ? { model: input.model } : {}),
        }),
      catch: (cause) =>
        new RunFailure({ cause, message: toErrorMessage(cause) }),
    });
    // The run is named as its persona's schema spells the name (trimmed).
    return config.persona == null
      ? config
      : { ...config, agent: config.persona.name };
  });
}

/**
 * Start one run on `session` and hand back the {@link Run} once it exists
 * there. The launch is the runtime's `runAgent`: an interruption before
 * admission ends it through the run fiber's own interrupt.
 *
 * The handoff is all-or-nothing, which is what lets a caller treat the
 * `Run` as the only handle on the run: this either returns one, or it ends
 * every fiber it started. There is no exit in which a run keeps working
 * with nobody holding it.
 */
function start(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  input: StartInput,
): Effect.Effect<Run, LaunchError | RunFailure> {
  return Effect.gen(function* () {
    const config = yield* admitInput(input);
    const runId = generateRunId();
    const trace = yield* Queue.unbounded<AgentEvent, RunFailure | Cause.Done>();
    const admitted = yield* Deferred.make<void, RunFailure>();
    let tapping = true;
    let reading = false;
    let buffered = 0;
    /** Stop taking the run's trace events: the reader's close does it while
     *  the run continues, and the run's settlement does it for a reader that
     *  never came. */
    const release = (): void => {
      tapping = false;
    };
    const settle = (
      exit: Exit.Exit<RunEndResult, RunFailure>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        release();
        if (buffered > TRACE_HANDOVER_EVENTS) {
          yield* Effect.logWarning(
            `Run ${runId} buffered ${TRACE_HANDOVER_EVENTS} trace events with no reader attached; its trace was detached. Iterate the run's events in the turn that starts it, or await only its result.`,
          ).pipe(withLogChannel(CHANNEL));
        }
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
    const interruptLaunch = (): boolean => session.runs.interrupt(runId);
    const spawned: Fiber.Fiber<unknown, Error>[] = [];
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const runFiber = yield* Effect.forkDetach(
          runValidatedAgent(
            { config, runId },
            {
              // The run's trace is built with this tap, so it hears the run
              // from its first event.
              onTraceEvent: (event) => {
                if (!tapping) return;
                if (!reading && (buffered += 1) > TRACE_HANDOVER_EVENTS) {
                  release(); // `settle` logs it: no fiber here to log from.
                  return;
                }
                Queue.offerUnsafe(trace, event);
              },
              onRunResolved: () => {
                Deferred.doneUnsafe(admitted, Effect.void);
              },
              session,
              stopAfterCycle: true,
              tools: input.tools,
            },
          ).pipe(
            Effect.mapError(
              (cause) =>
                new RunFailure({ cause, message: toErrorMessage(cause) }),
            ),
            Effect.onExit(settle),
            // The embedder owns this runtime. Provide the process's existing
            // context: tool I/O shares its scoped clients, `settle` its logger.
            Effect.provideContext(services),
          ),
          { startImmediately: true },
        );
        spawned.push(runFiber);
        yield* restore(Deferred.await(admitted));
        const view = session.view.changes.pipe(
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
            return session.view.subscribe(
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
  services: Context.Context<ProcessServices>,
): Session {
  return {
    roots: handle.roots,
    start: (input) => start(handle, services, input),
    request: (request) => handle.requests.request(request),
    view: { changes: handle.view.changes },
    subscribe: (interests) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const port = `sdk/reader/${(readerPorts += 1)}`;
          return Effect.as(handle.view.subscribe(port, interests), port);
        }),
        (port) => handle.view.subscribe(port, []),
      ).pipe(Effect.asVoid),
  };
}

/** The package's session policy over the process's owner: an ephemeral
 *  transcript store, and a host that can answer no approval prompt, so the
 *  session's own policy settles every request a run raises. `services` is
 *  the process's context, which every run's fiber is provided. */
export function makeSessions(
  processRoots: WorkspaceRoots,
  owner: Context.Service.Shape<typeof SessionOwner>,
  services: Context.Context<ProcessServices>,
): Context.Service.Shape<typeof Sessions> {
  return {
    open: (roots?: WorkspaceRoots) =>
      owner
        .open({
          roots: roots ?? processRoots,
          // No surface here can answer an approval prompt: every run of this
          // session, launched or resumed, is offered no approval-gated tool.
          interactions: { approvalPromptsUnavailable: true },
          transcriptMode: {
            kind: 'ephemeral',
            reason: 'npm package consumer',
          },
        })
        .pipe(Effect.map((handle) => sessionOf(handle, services))),
    close: (roots?: WorkspaceRoots) =>
      owner.close((roots ?? processRoots).storage),
    list: Effect.map(owner.list, (handles) =>
      handles.map((handle) => sessionOf(handle, services)),
    ),
  };
}
