/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * SDK Step 7d composition root. It is a **composition record**, not a facade:
 * it re-exposes no per-concern methods, so callers keep the existing instance
 * vocabulary they already use after 7a–c landed (`session.interactions.x(...)`,
 * `session.executions.y(...)`). It composes the landed runtime owners —
 * {@link ExecutionRegistry}, {@link ExecutionSubscriptionBinder},
 * {@link SessionHostInteractions} — plus the other session-scoped owners.
 *
 * A session is one per host context: extension activation (per VS Code window),
 * CLI process, or desktop Electron process. The default instance is installed
 * explicitly through {@link initializeDefaultSession}; {@link defaultSession}
 * only retrieves that process-wide owner. There is no other way to reach
 * these owners: the invariant is "no session-scoped mutable module export"
 * (#7694) — a run-scoped caller resolves through {@link currentSession} /
 * {@link defaultSession}, never a standalone singleton import.
 *
 * Fresh construction is in FORCED dependency order with every cross-reference
 * explicit: no member is ever allowed to default to a neighboring module
 * singleton (the "silent state split" trap — a fresh member quietly sharing a
 * singleton would leak cross-session `clearAll` sweeps). The
 * fresh-ctor test in `SessionHandle.vitest.ts` locks this.
 *
 * It is deliberately NOT a conversation/session API (send/stream/resume/history):
 * Anthropic shipped and then deleted exactly that shape in the Agent SDK.
 * Continuity stays in options + storage (`ValidatedExecutionRequest`). The
 * session is justified only as the ownership container.
 */

import type { AgentEvent, AgentTrace, ResultEvent } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';
import type { RunTraceFlushEntry } from '@transcript/runTrace';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import { getRunContextSession, tryUseRunContext } from './RunContext';
import { ExecutionRegistry } from './executionRegistry';
import { ExecutionSubscriptionBinder } from './ExecutionSubscriptionBinder';
import { StreamStatusMachine } from './StreamStatusService';
import {
  SessionHostInteractions,
  type HostInteractions,
} from './HostInteractions';
import { SessionEventHub } from './SessionEventHub';
import { ModelRetryGate } from './ModelRetryGate';
import {
  createSessionApprovals,
  type SessionApprovals,
} from './streamApprovalQueue';
import { WorkflowControlRegistry } from './workflowControlRegistry';
import { releaseExecutionLeaseAfterArtifacts } from './executionOwnership';

const logger = createChannelTrace('sessionHandle');

interface ResultListenerRegistration {
  readonly listener: (event: ResultEvent) => void;
  readonly replayMissed: boolean;
}

interface ArtifactFlushBatch {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function createArtifactFlushBatch(): ArtifactFlushBatch {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function isReplayableTerminalResult(event: ResultEvent): boolean {
  return (
    !event.isSubagent && event.error != null && event.error.kind !== 'abort'
  );
}

/** A valid transcript store is required; other owners may be injected. */
export type SessionHandleInit = Pick<SessionHandle, 'transcripts'> &
  Partial<
    Pick<
      SessionHandle,
      | 'executions'
      | 'subscriptions'
      | 'events'
      | 'status'
      | 'followUps'
      | 'flushers'
      | 'interactions'
      | 'modelRetries'
      | 'workflowControls'
    >
  >;

export class SessionHandle {
  /** Per-run execution handles; owns the process-output poller + status sub. */
  readonly executions: ExecutionRegistry;
  /** Execution-status subscriptions bound to agent stream lifecycles. */
  readonly subscriptions: ExecutionSubscriptionBinder;
  /** Session-scoped one-way fact plane. */
  readonly events: SessionEventHub;
  /** Session-scoped status plane. */
  readonly status: StreamStatusMachine;
  /** Session-owned transcript store for run traces launched in this session. */
  readonly transcripts: StreamLogStore;
  /** Session-owned follow-up queue owner. */
  readonly followUps: ToolUseFollowUpQueue;
  /** This session's execution-keyed trace flushers. */
  readonly flushers: Map<string, RunTraceFlushEntry>;
  private readonly artifactFlushers = new Set<() => Promise<void>>();
  private pendingArtifactFlush: ArtifactFlushBatch | undefined;
  private artifactFlushWorkerRunning = false;
  /** Session-scoped host interaction owner. */
  readonly interactions: SessionHostInteractions;
  /** Session-owned approval queues, pending registries, and bypass state. */
  readonly approvals: SessionApprovals;
  /** Coordinates recovery probes for model routes shared by parallel runs. */
  readonly modelRetries: ModelRetryGate;
  /**
   * Session-owned bridge from a workflow-script grandchild's execution id to
   * its run's engine skip/retry control. Populated by the workflow-script
   * strategy while a run is in flight; a host (the CLI child list) consumes it
   * to skip/retry a focused grandchild `agent()` call.
   */
  readonly workflowControls: WorkflowControlRegistry;
  constructor(init: SessionHandleInit) {
    if (init.transcripts.mode.kind === 'read-only') {
      throw new Error(
        'SessionHandle requires a writable transcript store; read-only stores are reserved for call-scoped readers.',
      );
    }
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    const status = init.status ?? new StreamStatusMachine();
    const events = init.events ?? new SessionEventHub();
    const transcripts = init.transcripts;
    const followUps = init.followUps ?? new ToolUseFollowUpQueue();
    const approvals = createSessionApprovals();
    const executions =
      init.executions ??
      new ExecutionRegistry({ streamStatus: status, events });
    // Attaching here also supports an explicitly supplied registry while
    // keeping result publication scoped to this session's listeners.
    executions.attachSessionEvents(events, (event, streamId) =>
      this.publishRunEvent(streamId, event),
    );
    executions.attachSessionApprovals(approvals);

    this.executions = executions;
    const subscriptions =
      init.subscriptions ??
      new ExecutionSubscriptionBinder({
        registry: executions,
        releaseSource: followUps,
        session: this,
      });
    this.subscriptions = subscriptions;
    this.events = events;
    this.status = status;
    this.transcripts = transcripts;
    this.followUps = followUps;
    this.interactions = init.interactions ?? new SessionHostInteractions();
    this.approvals = approvals;
    this.modelRetries = init.modelRetries ?? new ModelRetryGate();
    this.workflowControls =
      init.workflowControls ?? new WorkflowControlRegistry();
    // Every session owns exactly one trace-flusher map. There is no
    // process-wide registry: a host drains the session it is shutting down.
    this.flushers = init.flushers ?? new Map<string, RunTraceFlushEntry>();
    executions.attachRootExecutionLeaseRelease((executionId) =>
      releaseExecutionLeaseAfterArtifacts(this, executionId),
    );
    liveSessions.add(this);
  }

  useHostInteractions(interactions: HostInteractions): () => void {
    return this.interactions.use(interactions);
  }

  /** Drain one execution's pending trace, or every trace during shutdown. */
  flushPendingTraces(ownerKey?: string): void {
    const failures: unknown[] = [];
    const flushers =
      ownerKey === undefined
        ? [...this.flushers.values()]
        : [this.flushers.get(ownerKey)].filter(
            (entry): entry is RunTraceFlushEntry => entry !== undefined,
          );
    for (const entry of flushers) {
      try {
        entry.flush();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Multiple session trace writers failed to flush',
      );
    }
  }

  /** Register a session-owned durable writer such as a snapshot store. */
  useArtifactFlusher(flush: () => Promise<void>): () => void {
    this.artifactFlushers.add(flush);
    return () => this.artifactFlushers.delete(flush);
  }

  /** Persist one execution's trace plus the session's shared artifact stores. */
  flushArtifacts(ownerKey?: string): Promise<void> {
    let traceFailure: unknown;
    try {
      this.flushPendingTraces(ownerKey);
    } catch (error) {
      traceFailure = error;
    }
    this.pendingArtifactFlush ??= createArtifactFlushBatch();
    const batch = this.pendingArtifactFlush;
    if (!this.artifactFlushWorkerRunning) {
      this.artifactFlushWorkerRunning = true;
      queueMicrotask(() => {
        void this.drainArtifactFlushBatches();
      });
    }
    if (traceFailure === undefined) return batch.promise;
    return batch.promise.then(
      () => {
        throw traceFailure;
      },
      (artifactFailure: unknown) => {
        throw new AggregateError(
          [traceFailure, artifactFailure],
          'Trace and shared artifact writers failed to flush',
        );
      },
    );
  }

  /**
   * Drain one current batch and, when calls arrived during it, one trailing
   * batch at a time. This preserves each caller's durability boundary without
   * repeating a full session flush for every execution ending in one burst.
   */
  private async drainArtifactFlushBatches(): Promise<void> {
    while (this.pendingArtifactFlush) {
      const batch = this.pendingArtifactFlush;
      this.pendingArtifactFlush = undefined;
      try {
        await this.flushArtifactsOnce();
        batch.resolve();
      } catch (error) {
        batch.reject(error);
      }
    }
    this.artifactFlushWorkerRunning = false;
  }

  private async flushArtifactsOnce(): Promise<void> {
    const writers = [() => this.transcripts.flush(), ...this.artifactFlushers];
    const results = await Promise.allSettled(
      writers.map((flush) => Promise.resolve().then(flush)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Multiple session artifact writers failed to flush',
      );
    }
  }

  /** Listeners for terminal run results in this session (the host channel). */
  private readonly resultListeners = new Set<ResultListenerRegistration>();
  private readonly missedTerminalResults = new Map<
    ResultEvent['executionId'],
    ResultEvent
  >();
  private replayMissedResultsEnabled = false;
  private disposeStarted = false;

  /**
   * Subscribe to terminal `result` events for runs in this session. Hosts hold
   * the session, so this is how they receive a run's outcome — per-run traces
   * are created inside the run and are not reachable from the host otherwise.
   */
  onResult(
    listener: (event: ResultEvent) => void,
    options: { replayMissed?: boolean } = {},
  ): () => void {
    const registration: ResultListenerRegistration = {
      listener,
      replayMissed: options.replayMissed ?? false,
    };
    this.resultListeners.add(registration);
    if (registration.replayMissed) {
      this.replayMissedResultsEnabled = true;
      queueMicrotask(() => {
        if (!this.resultListeners.has(registration)) return;
        const missed = [...this.missedTerminalResults.values()];
        this.missedTerminalResults.clear();
        for (const event of missed) this.notifyResultListener(listener, event);
      });
    }
    return () => this.resultListeners.delete(registration);
  }

  /**
   * Bridge a run's trace into this session's `onResult` channel: re-publish its
   * `result` events to the session's listeners. Returns a detach disposer the
   * run bundles into its trace teardown.
   */
  attachRunTrace(trace: AgentTrace, streamId: StreamTabId): () => void {
    return trace.subscribe((event) => this.publishRunEvent(streamId, event));
  }

  /**
   * Forward one run-scoped event to this session's event bus and, for
   * terminal `result` events, to `onResult` listeners. Shared by
   * `attachRunTrace` (the live per-run trace subscription above) and by
   * `ExecutionRegistry`'s injected `publishResult` callback (see
   * `attachSessionEvents`), which needs the identical forwarding for a
   * terminal event synthesized *after* the originating run's own trace has
   * already been disposed — killing a native subagent suspended at WAITING
   * (`terminateWaitingHandle`) settles `handle.result` and the run's own
   * (already-torn-down) trace, but has no other way to reach this session's
   * `onResult` subscribers.
   */
  publishRunEvent(streamId: StreamTabId, event: AgentEvent): void {
    this.events.emit({ scope: 'run', streamId, event });
    if (event.type !== 'result') return;
    const replaying = [...this.resultListeners].some(
      (registration) => registration.replayMissed,
    );
    if (replaying) {
      this.missedTerminalResults.delete(event.executionId);
    } else if (
      this.replayMissedResultsEnabled &&
      isReplayableTerminalResult(event)
    ) {
      this.missedTerminalResults.set(event.executionId, event);
    }
    // Guard each listener so one throwing consumer can't starve the rest:
    // the whole fan-out is a single trace subscriber, so without this a throw
    // would skip the remaining listeners (TraceEmitter only guards at the
    // subscriber boundary, not between listeners).
    for (const registration of this.resultListeners) {
      this.notifyResultListener(registration.listener, event);
    }
  }

  private notifyResultListener(
    listener: (event: ResultEvent) => void,
    event: ResultEvent,
  ): void {
    try {
      listener(event);
    } catch (err) {
      logger.warn('onResult listener threw', { data: err });
    }
  }

  /**
   * Tear down everything this session owns. Order matters: drain this session's
   * pending trace writes, drop subscription disposers, dispose the execution
   * registry, settle pending host interactions via `interactions.dispose()`,
   * and drop result listeners. Deregistration from `liveSessions` happens even
   * when either phase fails, and every collected failure returns only after
   * teardown has been attempted.
   */
  dispose(): void {
    if (this.disposeStarted) return;
    this.disposeStarted = true;

    const failures: unknown[] = [];
    try {
      this.flushPendingTraces();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.teardownOwners();
    } catch (error) {
      failures.push(error);
    } finally {
      this.deregisterSession();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Session teardown failed');
    }
  }

  /** Dispose the runtime owners and drop result listeners. */
  private teardownOwners(): void {
    this.subscriptions.dispose();
    this.executions.dispose();
    // Settle any approval still pending in this session (rejected) and drop
    // its bypass state before the interaction slot itself is torn down.
    this.approvals.rejectAndClearAll();
    this.modelRetries.dispose();
    this.interactions.dispose();
    this.artifactFlushers.clear();
    this.resultListeners.clear();
    this.missedTerminalResults.clear();
  }

  /** Leave the live-session registry. */
  private deregisterSession(): void {
    liveSessions.delete(this);
  }
}

/** Live sessions whose background processes must be stopped at shutdown. */
const liveSessions = new Set<SessionHandle>();

/** Stop background OS processes owned by every live runtime session. */
export function killAllSessionBackgroundProcesses(): void {
  for (const session of liveSessions) {
    session.executions.killBackgroundProcesses();
  }
}

let cachedDefaultSession: SessionHandle | undefined;

export type DefaultSessionInit = Omit<SessionHandleInit, 'flushers'>;

/** Install the process-default session after its transcript store is valid. */
export function initializeDefaultSession(
  init: DefaultSessionInit,
): SessionHandle {
  if (cachedDefaultSession) {
    throw new Error('The default session has already been initialized.');
  }
  cachedDefaultSession = new SessionHandle(init);
  return cachedDefaultSession;
}

/** Inspect whether the host has installed its process-default session. */
export function tryDefaultSession(): SessionHandle | undefined {
  return cachedDefaultSession;
}

/** Clear and dispose the process-default session during host teardown. */
export function teardownDefaultSession(): void {
  const session = cachedDefaultSession;
  cachedDefaultSession = undefined;
  session?.dispose();
}

/**
 * The process-default session — the sole owner of the process-wide runtime
 * singletons (#7694). Every member the constructor doesn't receive is
 * fresh-built in the same FORCED dependency order any other `SessionHandle`
 * uses; there is no separate `Shared*`/`*Service` module export to alias
 * anymore, so this construction *is* where those singletons now live.
 *
 * Hosts must initialize it explicitly after opening transcript persistence.
 * Access before that composition step is a lifecycle error rather than an
 * implicit memory-only session.
 */
export function defaultSession(): SessionHandle {
  if (!cachedDefaultSession) {
    throw new Error(
      'The default session has not been initialized. Call initializeDefaultSession() after opening its transcript store.',
    );
  }
  return cachedDefaultSession;
}

/**
 * Resolve the session for the calling context: the active run's session when
 * called inside a run, otherwise the process {@link defaultSession}. This is
 * the single resolution point run-scoped code (flows, tools, formatters) uses
 * to reach session-owned state — there is no other way to reach it (#7694) —
 * and the seam that lets a host inject an isolated session per run.
 */
export function currentSession(): SessionHandle {
  return getRunContextSession(tryUseRunContext()) ?? defaultSession();
}
