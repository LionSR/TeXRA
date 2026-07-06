/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * SDK Step 7d composition root. It is a **composition record**, not a facade:
 * it re-exposes no per-concern methods, so callers keep the existing instance
 * vocabulary they already use after 7a–c landed (`session.coordinators.x(...)`,
 * `session.executions.y(...)`). It composes the four landed runtime owners —
 * {@link InterruptRegistry}, {@link ExecutionRegistry}, {@link RunCoordinatorBridge},
 * {@link ExecutionSubscriptionBinder} — plus the trace flusher set and an
 * optional session-scoped host channel.
 *
 * A session is one per host context: extension activation (per VS Code window),
 * CLI process, or desktop `BrowserWindow`. The default instance,
 * {@link defaultSession}, wraps the existing process-global singletons
 * **by identity**, so every unmigrated call site keeps hitting the same objects
 * byte-for-byte while the 7d train migrates call sites incrementally.
 *
 * Fresh construction is in FORCED dependency order with every cross-reference
 * explicit: no member is ever allowed to default to a neighboring module
 * singleton (the "silent state split" trap — a fresh member quietly sharing a
 * singleton would leak interrupts or cross-session `clearAll` sweeps). The
 * fresh-ctor test in `SessionHandle.vitest.ts` locks this.
 *
 * It is deliberately NOT a conversation/session API (send/stream/resume/history):
 * Anthropic shipped and then deleted exactly that shape in the Agent SDK.
 * Continuity stays in options + storage (`ValidatedExecutionRequest`). The
 * session is justified only as the ownership container.
 */

import {
  getActiveFlushers,
  getDefaultStreamLogStore,
  StreamLogStore,
  unregisterFlushers,
} from '@transcript';
import type { AgentTrace, ResultEvent } from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';

import { tryUseRunContext } from './RunContext';
import { ExecutionRegistry, executionRegistry } from './executionRegistry';
import { InterruptRegistry, interruptRegistry } from './InterruptRegistry';
import { RunCoordinatorBridge, runCoordinatorBridge } from './runCoordinators';
import {
  ExecutionSubscriptionBinder,
  executionSubscriptionBinder,
} from './ExecutionSubscriptionBinder';
import {
  StreamStatusMachine,
  StreamStatusService,
} from './StreamStatusService';
import {
  SessionHostInteractions,
  type HostInteractions,
} from './HostInteractions';
import { SessionEventHub } from './SessionEventHub';
import type { AgentRuntimeHost } from './AgentRuntimeHost';

const logger = createChannelTrace('sessionHandle');

/** Members callers may inject; everything else is fresh-constructed in order. */
export type SessionHandleInit = Partial<
  Pick<
    SessionHandle,
    | 'interrupts'
    | 'executions'
    | 'coordinators'
    | 'subscriptions'
    | 'events'
    | 'status'
    | 'transcripts'
    | 'followUps'
    | 'flushers'
    | 'interactions'
    | 'hostChannel'
  >
>;

export interface SessionDisposeOptions {
  /**
   * Keep active executions registered after host teardown so process-wide
   * running-execution guards still see headless runs until they settle.
   */
  keepActiveExecutions?: boolean;
}

export class SessionHandle {
  /** Live executions that can be interrupted by stream id. */
  readonly interrupts: InterruptRegistry;
  /** Per-run execution handles; owns the process-output poller + status sub. */
  readonly executions: ExecutionRegistry;
  /** Resolve-side request index bridging host decisions to run coordinators. */
  readonly coordinators: RunCoordinatorBridge;
  /** Execution-status subscriptions bound to agent stream lifecycles. */
  readonly subscriptions: ExecutionSubscriptionBinder;
  /** Session-scoped one-way fact plane. */
  readonly events: SessionEventHub;
  /** Session-scoped status plane; wraps shared status data during migration. */
  readonly status: StreamStatusMachine;
  /** Session-owned transcript store for run traces launched in this session. */
  readonly transcripts: StreamLogStore;
  /** Session-owned follow-up queue owner. */
  readonly followUps: ToolUseFollowUpQueue;
  /** This session's trace-flush callbacks (drained on dispose / shutdown). */
  readonly flushers: Set<() => void>;
  /** Session-scoped host interaction owner. */
  readonly interactions: SessionHostInteractions;
  /**
   * Optional session-scoped emit surface for the non-run-scoped host-path
   * emissions (SDK Step 7d follow-on F-1). Unset ⇒ those stay on the bus.
   */
  readonly hostChannel?: AgentRuntimeHost;

  constructor(init: SessionHandleInit = {}) {
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    const interrupts = init.interrupts ?? new InterruptRegistry();
    const status = init.status ?? new StreamStatusMachine();
    const events = init.events ?? new SessionEventHub();
    const transcripts = init.transcripts ?? new StreamLogStore();
    const followUps = init.followUps ?? new ToolUseFollowUpQueue();
    const executions =
      init.executions ??
      new ExecutionRegistry({ interrupts, streamStatus: status, events });
    executions.attachSessionEvents(events);
    const coordinators =
      init.coordinators ?? new RunCoordinatorBridge(executions);

    this.interrupts = interrupts;
    this.executions = executions;
    this.coordinators = coordinators;
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
    // A fresh session owns its own flusher set; the default session aliases the
    // process-module set so `createRunTrace`'s default writes still drain.
    this.flushers = init.flushers ?? new Set<() => void>();
    this.hostChannel = init.hostChannel;
    liveSessions.add(this);
  }

  useHostInteractions(interactions: HostInteractions): () => void {
    return this.interactions.use(interactions);
  }

  /** Drain pending trace writes for this session's streams only. */
  flushPendingTraces(): void {
    for (const flush of [...this.flushers]) flush();
  }

  /** Listeners for terminal run results in this session (the host channel). */
  private readonly resultListeners = new Set<(event: ResultEvent) => void>();
  private disposeStarted = false;
  private idleDisposeStarted = false;

  /**
   * Subscribe to terminal `result` events for runs in this session. Hosts hold
   * the session, so this is how they receive a run's outcome — per-run traces
   * are created inside the run and are not reachable from the host otherwise.
   */
  onResult(listener: (event: ResultEvent) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  /**
   * Bridge a run's trace into this session's `onResult` channel: re-publish its
   * `result` events to the session's listeners. Returns a detach disposer the
   * run bundles into its trace teardown.
   */
  attachRunTrace(trace: AgentTrace, streamId: StreamTabId): () => void {
    return trace.subscribe((event) => {
      this.events.emit({ scope: 'run', streamId, event });
      if (event.type !== 'result') return;
      // Guard each listener so one throwing consumer can't starve the rest:
      // the whole fan-out is a single trace subscriber, so without this a throw
      // would skip the remaining listeners (TraceEmitter only guards at the
      // subscriber boundary, not between listeners).
      for (const listener of this.resultListeners) {
        try {
          listener(event);
        } catch (err) {
          logger.warn('onResult listener threw', { data: err });
        }
      }
    });
  }

  /**
   * Tear down everything this session owns. Order matters: drain this session's
   * pending trace writes, then either defer teardown while active executions
   * must remain visible for process-wide guards, or resolve pending coordinator
   * requests, drop subscription disposers, dispose the execution registry, clear
   * interrupt entries (`InterruptRegistry` has no `clear()`; `retainOnly` with
   * the empty set is the existing precedent), and drop result listeners. Finally
   * unregister this session's flusher set from the process-wide drain and
   * deregister from `liveSessions` once no active executions remain — both in
   * `finally` so a teardown throw can't strand a fully disposed session in the
   * cross-session aggregate.
   */
  dispose(options: SessionDisposeOptions = {}): void {
    if (this.disposeStarted) return;
    this.disposeStarted = true;

    const keepActiveExecutions =
      options.keepActiveExecutions === true &&
      this.executions.getActiveIds().length > 0;
    try {
      // Drain throttled writes before the flusher set leaves the drain registry
      // (the default session's set is permanent; a fresh session's is not).
      this.flushPendingTraces();
      if (keepActiveExecutions) {
        void this.disposeWhenIdle().catch((err) => {
          logger.warn('Idle session disposal failed', { data: err });
        });
      } else {
        this.teardownOwners();
      }
    } finally {
      if (!keepActiveExecutions) {
        this.deregisterSession();
      }
    }
  }

  private async disposeWhenIdle(): Promise<void> {
    if (this.idleDisposeStarted) return;
    this.idleDisposeStarted = true;
    try {
      while (true) {
        const activeIds = this.executions.getActiveIds();
        if (activeIds.length === 0) break;
        await this.executions.waitForAnyChange(activeIds);
      }
    } finally {
      this.flushPendingTraces();
      this.teardownOwners();
      this.deregisterSession();
    }
  }

  /** Dispose the four runtime owners and drop result listeners. */
  private teardownOwners(): void {
    this.coordinators.cleanupAllRequests();
    this.subscriptions.dispose();
    this.executions.dispose();
    this.interrupts.retainOnly(new Set());
    this.interactions.dispose();
    this.resultListeners.clear();
  }

  /** Leave the process-wide trace drain and the cross-session registry. */
  private deregisterSession(): void {
    unregisterFlushers(this.flushers);
    liveSessions.delete(this);
  }
}

/**
 * Every live session in this process, so global queries (e.g. a host's
 * "is this execution running anywhere" history guard) can aggregate across
 * sessions instead of seeing only one. Sessions register on construction and
 * deregister on {@link SessionHandle.dispose}.
 */
const liveSessions = new Set<SessionHandle>();

/**
 * Active execution ids across every live session — the cross-session view a
 * multi-window host needs so deleting history from one window still respects an
 * execution running in another. For a single-session process this equals the
 * one session's `executions.getActiveIds()`.
 */
export function getAllActiveExecutionIds(): string[] {
  const ids = new Set<string>();
  for (const session of liveSessions) {
    for (const id of session.executions.getActiveIds()) ids.add(id);
  }
  return [...ids];
}

let cachedDefaultSession: SessionHandle | undefined;

/**
 * The process-default session. Its members ARE the existing exported singletons
 * — identity is the behavior-neutral compatibility mechanism for the 7d train:
 * unmigrated call sites keep hitting the same objects, and per-call-site
 * migration is `runCoordinatorBridge.x(...)` → `session.coordinators.x(...)`
 * against the identical instance.
 *
 * Constructed lazily on first use rather than at module evaluation: many
 * run-scoped modules import `currentSession`, which pulls this module into
 * their import cycle, and an eager construction here would read the
 * `executionSubscriptionBinder` singleton before its own module finished
 * initializing (TDZ). Deferring to first call sidesteps that entirely.
 */
export function defaultSession(): SessionHandle {
  return (cachedDefaultSession ??= new SessionHandle({
    interrupts: interruptRegistry,
    executions: executionRegistry,
    coordinators: runCoordinatorBridge,
    subscriptions: executionSubscriptionBinder,
    status: StreamStatusService,
    transcripts: getDefaultStreamLogStore(),
    followUps: ToolUseFollowUpQueue.defaultInstance(),
    flushers: getActiveFlushers(),
  }));
}

/**
 * Resolve the session for the calling context: the active run's session when
 * called inside a run, otherwise the process {@link defaultSession}. This is
 * the single resolution point run-scoped code (flows, tools, formatters) uses
 * instead of touching the process singletons directly — behavior-neutral while
 * the default session aliases those singletons, and the seam that lets a host
 * inject an isolated session per run.
 */
export function currentSession(): SessionHandle {
  return tryUseRunContext()?.session ?? defaultSession();
}
