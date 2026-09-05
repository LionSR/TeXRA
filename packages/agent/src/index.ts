// Third-party imports
import { Effect, Fiber, Stream } from 'effect';

// Local imports - agent runtime
//
// Values, and types used only inside function bodies, come through the curated
// `@agent/runtime` barrel rather than by module path, so this package stops
// pinning the runtime's internal file layout — the same fold-in the three hosts
// took in #10011. These never reach the emitted declarations, so they carry no
// provider-type leak risk.
import type { AgentEvent, AgentTrace } from '@agent/trace';
import { loadAgents, resolveAgent } from '@agent/index';
import {
  runAgent as runValidatedAgent,
  SessionHandle as RuntimeSessionHandle,
  type AgentRunHandle as RuntimeAgentRunHandle,
} from '@agent/runtime';
import type { ITool } from '@agent/core/tools/ToolTypes';

// `AgentFlowResult` is deliberately sourced from its own module rather than
// from the `@agent/runtime` barrel above. It appears in this package's PUBLIC
// declarations (`AgentRun.result`, and the re-export below), and declaration
// emit follows whichever module a public type comes from: taking it from the
// barrel pulls the barrel's whole `.d.ts` graph — model handlers included —
// into the published type surface, which trips the provider-type leak check in
// `scripts/validate-artifacts.mjs` (`@anthropic-ai/sdk`).
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';

// Local imports - config and host services
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { initPlatform, tryPlatform, type Platform } from '@platform/platform';
import {
  initProcessWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import { effectRuntime } from '@platform/processRuntime';
import { initNodeAgentRuntime } from '@platform/defaults/nodeAgentRuntime';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import type {
  SessionView as RuntimeSessionView,
  StreamView as RuntimeStreamView,
  TranscriptView as RuntimeTranscriptView,
} from '@shared/session/sessionView';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import { StreamLogStore } from '@transcript/StreamLogStore';

export type { AgentEvent } from '@agent/trace';
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

/**
 * A runtime value as the embedder may hold it: read-only all the way down,
 * every map, array, and record included. The value itself is not copied
 * (the fold's own view is what every host reads, PRD 10.3); the type is what
 * keeps a write from reaching it.
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

/** The session view as {@link AgentRun.view} yields it (PRD 5.1). */
export type SessionView = ReadonlyDeep<RuntimeSessionView>;
/** One stream of the {@link SessionView}. */
export type StreamView = ReadonlyDeep<RuntimeStreamView>;
/** A stream's transcript slice: what hosts paint. */
export type TranscriptView = ReadonlyDeep<RuntimeTranscriptView>;

/**
 * The process platform together with the workspace roots the package's runs
 * work in. `nodePlatform()` builds both; an embedder supplying its own
 * platform names its workspace roots beside it.
 */
export interface AgentPlatform extends Platform {
  readonly roots: WorkspaceRoots;
}

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
 * Event delivery begins with the iterator's first `next()` call. Awaiting only
 * `result` does not retain trace events, and ending iteration detaches the
 * event source while the run itself continues.
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
   * Each view is the runtime's own value, never a copy. The fold replaces
   * the envelope per level and appends to the maps and arrays beneath it in
   * place, so a yielded view supersedes the one before it, and a value read
   * through an older view may already show a later level. The type is
   * read-only all the way down; a write through a cast corrupts the session
   * every host and every later run on it reads.
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

/** A run that exists in its session: the view levels it folds into and the
 *  stream the fold keys it by. */
interface EnteredRun {
  readonly streamId: StreamTabId;
  readonly view: RuntimeSessionHandle['viewChanges'];
}

/**
 * The package's one process-wide state, made on the first run and torn down
 * on the embedder's shutdown path: the node runtime features, the Effect
 * runtime the package sessions' graphs run on, and the sessions themselves,
 * one per storage root (PRD 7.3, 11). `Sessions` keys a root's graph by its
 * storage root and bridges the transcript store the root's first handle
 * opened, so every run on a root shares one handle, or a later run's rows
 * would land in a store no graph reads. The shutdown path resets this owner,
 * so the sessions have no life of their own past it.
 */
let packageSessions: Promise<Map<string, RuntimeSessionHandle>> | undefined;

function sessionFor(
  sessions: Map<string, RuntimeSessionHandle>,
  platform: AgentPlatform,
): RuntimeSessionHandle {
  let session = sessions.get(platform.roots.storage);
  if (!session) {
    session = new RuntimeSessionHandle({
      roots: platform.roots,
      transcripts: StreamLogStore.ephemeral('npm package consumer'),
    });
    // The session's one host, for its whole life, like every TeXRA host
    // attaches one per session: the interaction hub keeps a single active
    // host and tells runs apart by the stream its requests and cancellations
    // name. Attaching per run instead would make each new run displace the
    // previous run's host. The package has no interactive prompts, so there
    // is nothing for a cancellation to settle; a retry prompt is denied so
    // that it never parks the run waiting for a host.
    session.interactions.use({
      cancel: () => {},
      requestRetry: async () => ({
        action: 'deny',
        reason: 'Interactive retries are unavailable in the agent package.',
      }),
    });
    sessions.set(platform.roots.storage, session);
  }
  return session;
}

/** The run's stream and every descendant the view holds. */
function runStreamIds(
  view: RuntimeSessionView,
  streamId: StreamTabId,
): StreamTabId[] {
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

class AgentRunStream implements AgentRun {
  private readonly events: AgentEvent[] = [];
  private readonly readers: Array<{
    readonly resolve: (result: IteratorResult<AgentEvent>) => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];
  private liveHandle: RuntimeAgentRunHandle | undefined;
  private detachEvents: (() => void) | undefined;
  private ended = false;
  private iteratorClosed = false;
  private iteratorStarted = false;
  private failure: { readonly error: unknown } | undefined;
  private readonly launchAbortController = new AbortController();
  private enter!: (run: EnteredRun | null) => void;
  private readonly viewChanges: Stream.Stream<RuntimeSessionView>;
  /** The package's own reader of the run's view levels, from attach to the
   *  run's final view; what the run's settlement joins. */
  private drain: Fiber.Fiber<void> | undefined;
  readonly launchSignal = this.launchAbortController.signal;
  readonly result: Promise<AgentFlowResult>;
  readonly view: AsyncIterable<SessionView>;

  constructor(start: (stream: AgentRunStream) => Promise<AgentFlowResult>) {
    const entered = new Promise<EnteredRun | null>((resolve) => {
      this.enter = resolve;
    });
    // The session's view levels, read through Effect's own async-iterable
    // destructor once the run exists in the session. The level replays on
    // subscribe, so no level is missed, and the fold lands the run's
    // `run.start` asynchronously, so a replayed level can predate the run:
    // `dropWhile` skips it. The view itself is the end condition:
    // `takeUntil` delivers the first view holding the run's durable outcome
    // as the last element, whether that view folds during the iteration or
    // was current before it began. Breaking the loop closes the stream's
    // scope.
    this.viewChanges = Stream.unwrap(
      Effect.map(
        Effect.promise(() => entered),
        (run) =>
          run === null
            ? Stream.empty
            : run.view.pipe(
                Stream.dropWhile((view) => !view.streams.has(run.streamId)),
                Stream.takeUntil(
                  (view) =>
                    view.streams.get(run.streamId)?.durableOutcome != null,
                ),
              ),
      ),
    );
    this.view = Stream.toAsyncIterable(this.viewChanges);
    this.result = start(this);
    void this.result.then(
      () => this.end(),
      (error: unknown) => this.end({ error }),
    );
  }

  /**
   * The existence fact: the run's stream is in the session (its `run.start`
   * has been published, and every launch failure from here ends it with a
   * terminal `result`), and the run's own trace is the event source: every
   * trace event of the run, durable or not, in emission order. The launcher
   * hands both over before the run's first trace event (the instruction
   * log, the root stage, the launch warnings), so an iteration begun right
   * after `runAgent()` misses none of them.
   */
  attachRun(
    streamId: StreamTabId,
    session: RuntimeSessionHandle,
    trace: AgentTrace,
  ): void {
    this.enter({ streamId, view: session.viewChanges });
    this.detachEvents = trace.subscribe((event) => {
      if (this.iteratorStarted) this.push(event);
    });
    // The transcript tier folds only for subscribed aggregates (PRD 7.2), on
    // a port of this run's own: its stream now, its descendants as the view
    // gains them. The port is never cleared: the fold evicts an unsubscribed
    // stream's rows through the maps a delivered view shares, so clearing
    // at the terminal view would empty the transcript of the view a consumer
    // just received. The rows live as long as the session, as a TUI's do.
    const port = `sdk/${streamId}`;
    let subscribed = '';
    const subscribe = (ids: readonly StreamTabId[]): void => {
      const key = ids.join('\0');
      if (key === subscribed) return;
      subscribed = key;
      session.setTranscriptSubscriptions(
        port,
        ids.map((id) => ({ id, fromSeq: 0 })),
      );
    };
    subscribe([streamId]);
    // The package owns this drain, from here: the descendants join the
    // subscription as the view gains them, and the run's `result` waits for
    // its final fold even when the embedder never iterates `view` or stops
    // early, and fails if the fold dies before publishing it.
    this.drain = effectRuntime().runFork(
      Stream.runDrain(
        this.viewChanges.pipe(
          Stream.tap((view) =>
            Effect.sync(() => subscribe(runStreamIds(view, streamId))),
          ),
        ),
      ),
    );
  }

  /** The run's final view in the session, or the fold's defect: what the
   *  run settles on. Nothing to wait for while the run never entered. */
  finalView(): Effect.Effect<void> {
    return this.drain ? Fiber.join(this.drain) : Effect.void;
  }

  /** The live handle once the run is tracked: what `interrupt()` targets. */
  attachHandle(handle: RuntimeAgentRunHandle): void {
    this.liveHandle = handle;
  }

  interrupt(): void {
    if (this.liveHandle) {
      this.liveHandle.interrupt();
    } else {
      this.launchAbortController.abort();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        this.iteratorStarted = true;
        if (this.iteratorClosed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        const event = this.events.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.failure) return Promise.reject(this.failure.error);
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) =>
          this.readers.push({ resolve, reject }),
        );
      },
      return: () => {
        this.closeIterator();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  private push(event: AgentEvent): void {
    if (this.iteratorClosed) return;
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ done: false, value: event });
    } else {
      this.events.push(event);
    }
  }

  private detach(): void {
    this.detachEvents?.();
    this.detachEvents = undefined;
  }

  private closeIterator(): void {
    this.iteratorClosed = true;
    this.events.splice(0);
    this.detach();
    for (const reader of this.readers.splice(0)) {
      reader.resolve({ done: true, value: undefined });
    }
  }

  private end(failure?: { readonly error: unknown }): void {
    this.ended = true;
    this.failure = failure;
    // A run that settled without ever entering the session has no view to
    // wait for; a no-op once `attachRun` has resolved the same promise.
    this.enter(null);
    this.detach();
    for (const reader of this.readers.splice(0)) {
      if (failure) reader.reject(failure.error);
      else reader.resolve({ done: true, value: undefined });
    }
  }
}

/**
 * Start one agent run and expose its trace as an asynchronous event stream.
 *
 * The platform and agent registry are process-wide. Applications should create
 * one platform, then reuse it for every run in that process.
 */
export function runAgent(input: RunAgentInput): AgentRun {
  return new AgentRunStream(async (stream) => {
    const approvalToolNames =
      input.tools
        ?.filter((tool) => tool.requiresApproval)
        .map((tool) => tool.definition.name) ?? [];
    if (approvalToolNames.length > 0) {
      throw new Error(
        `The agent package cannot run approval-requiring tools: ${approvalToolNames.join(', ')}`,
      );
    }

    const activePlatform = tryPlatform();
    if (activePlatform && activePlatform !== input.platform) {
      throw new Error(
        'The agent package is already using another platform in this process.',
      );
    }
    if (!activePlatform) {
      initPlatform(input.platform);
      initProcessWorkspaceRoots(input.platform.roots);
    }
    packageSessions ??= (async () => {
      initNodeAgentRuntime(input.platform.lifecycle);
      // The one Effect runtime of the embedding process (PRD 7.7), for the
      // package sessions' graphs.
      const runtime = installProcessRuntime(
        await input.platform.processes.selfIdentity(),
      );
      const sessions = new Map<string, RuntimeSessionHandle>();
      // The hosts' shutdown order, on the embedder's shutdown path: the
      // sessions' agent-spawned children and agent-CLI sessions are stopped
      // and their live executions settled, then each session goes with the
      // owner that held it, then the runtime its graph ran on.
      registerRuntimeShutdownHandlers(input.platform.lifecycle, {
        flushArtifacts: async () => {
          for (const session of sessions.values()) {
            await session.flushArtifacts();
          }
        },
        afterExecutionSettlement: [
          () => {
            for (const session of sessions.values()) session.dispose();
            packageSessions = undefined;
          },
          () => runtime.dispose(),
        ],
      });
      return sessions;
    })();
    const session = sessionFor(await packageSessions, input.platform);
    await loadAgents({ includeRemote: false });
    const resolved = resolveAgent(input.agent);
    if (!resolved) {
      throw new Error(
        `Agent "${input.agent}" was not found in the configured agent directory.`,
      );
    }
    if (
      input.tools &&
      input.tools.length > 0 &&
      resolved.entry.category !== AgentCategory.ToolUse
    ) {
      throw new Error(
        `Custom tools are supported only for tool-use agents; "${input.agent}" is a workflow agent.`,
      );
    }
    const config = AgentConfigSchema.parse({
      agent: resolved.entry.name,
      agentCategory: resolved.entry.category,
      agentSource: resolved.entry.source,
      instruction: input.instruction,
      ...(input.model ? { model: input.model } : {}),
    });
    const result = await runValidatedAgent(
      { kind: 'fresh', config },
      {
        approvalPromptsUnavailable: true,
        launchSignal: stream.launchSignal,
        onRun: (handle) => stream.attachHandle(handle),
        onStreamResolved: (streamId, trace) =>
          stream.attachRun(streamId, session, trace),
        session,
        stopAfterCycle: true,
        tools: input.tools,
      },
    );
    // A run that completed settles only once the asynchronous fold holds its
    // final view, or has died trying. A run that failed on its own settled
    // above, with its own error: the fold's fate never replaces it.
    await effectRuntime().runPromise(stream.finalView());
    return result;
  });
}
