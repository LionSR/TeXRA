/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * SDK Step 7d composition root. It is a **composition record**, not a facade:
 * it re-exposes no per-concern methods, so callers keep the existing instance
 * vocabulary they already use after 7a–c landed (`session.interactions.x(...)`,
 * `session.executions.y(...)`). It composes the landed runtime owners —
 * {@link ExecutionRegistry}, {@link ExecutionSubscriptionBinder},
 * {@link SessionHostInteractions} — plus the trace flusher set and an
 * optional session-scoped host channel.
 *
 * A session is one per host context: extension activation (per VS Code window),
 * CLI process, or desktop `BrowserWindow`. The default instance,
 * {@link defaultSession}, is the sanctioned single-session entry point —
 * it lazily constructs its owners on first use (module-private, process-wide)
 * exactly like any other fresh session. There is no other way to reach
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

import {
  getActiveFlushers,
  StreamLogStore,
  unregisterFlushers,
} from '@transcript';
import type { AgentEvent, AgentTrace, ResultEvent } from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';

import { getRunContextSession, tryUseRunContext } from './RunContext';
import {
  AgentExecutionHandle,
  ExecutionRegistry,
  type ExecutionHandle,
} from './executionRegistry';
import { ExecutionSubscriptionBinder } from './ExecutionSubscriptionBinder';
import { StreamStatusMachine } from './StreamStatusService';
import {
  SessionHostInteractions,
  type HostInteractions,
} from './HostInteractions';
import { SessionEventHub } from './SessionEventHub';
import {
  createSessionApprovals,
  type SessionApprovals,
} from './streamApprovalQueue';
import type { AgentRuntimeHost } from './AgentRuntimeHost';

const logger = createChannelTrace('sessionHandle');

/** Members callers may inject; everything else is fresh-constructed in order. */
export type SessionHandleInit = Partial<
  Pick<
    SessionHandle,
    | 'executions'
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
  /** This session's trace-flush callbacks (drained on dispose / shutdown). */
  readonly flushers: Set<() => void>;
  /** Session-scoped host interaction owner. */
  readonly interactions: SessionHostInteractions;
  /** Session-owned approval queues, pending registries, and bypass state. */
  readonly approvals: SessionApprovals;
  /**
   * Optional session-scoped emit surface for the non-run-scoped host-path
   * emissions (SDK Step 7d follow-on F-1). Unset ⇒ those stay on the bus.
   */
  readonly hostChannel?: AgentRuntimeHost;

  constructor(init: SessionHandleInit = {}) {
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    const status = init.status ?? new StreamStatusMachine();
    const events = init.events ?? new SessionEventHub();
    const transcripts = init.transcripts ?? new StreamLogStore();
    const followUps = init.followUps ?? new ToolUseFollowUpQueue();
    const executions =
      init.executions ??
      new ExecutionRegistry({ streamStatus: status, events });
    // Re-attaching on every `SessionHandle` construction — even when
    // `executions` is caller-injected rather than fresh-built here — rebinds
    // `publishResult` to *this* session's listeners.
    executions.attachSessionEvents(events, (event, streamId) =>
      this.publishRunEvent(streamId, event),
    );

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
    this.approvals = createSessionApprovals();
    // A fresh session owns its own flusher set; the default session aliases
    // the process-module set (`getActiveFlushers()`) so the process-wide
    // shutdown drain (`flushPendingRunTraces()`) still reaches it.
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
  }

  /**
   * Tear down everything this session owns. Order matters: drain this session's
   * pending trace writes, then either defer teardown while active executions
   * must remain visible for process-wide guards, or drop subscription
   * disposers, dispose the execution registry, settle pending host
   * interactions via `interactions.dispose()`, and drop result listeners.
   * Finally unregister this session's flusher set from the process-wide drain
   * and deregister from `liveSessions` once no active executions remain —
   * both in `finally` so a teardown throw can't strand a fully disposed
   * session in the cross-session aggregate.
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

  /** Dispose the runtime owners and drop result listeners. */
  private teardownOwners(): void {
    this.subscriptions.dispose();
    this.executions.dispose();
    // Settle any approval still pending in this session (rejected) and drop
    // its bypass state before the interaction slot itself is torn down.
    this.approvals.rejectAndClearAll();
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

/** A still-active execution found on some other live session, plus that
 * owning session itself. The owner's `status`/`executions` are the run's live
 * runtime spine — authoritative over any stale on-disk snapshot a rebinding
 * window may have separately hydrated — so a rebinder reads live status,
 * walks child handles, and forwards host interactions through it. */
export interface ActiveAgentExecutionLookup {
  readonly handle: AgentExecutionHandle;
  readonly session: SessionHandle;
}

/**
 * Look up a still-active {@link AgentExecutionHandle} by id across every live
 * session, not just one. A desktop window's own session is fresh per
 * `BrowserWindow` (see the class doc), so a run kept alive across window
 * recreation (`SessionHandle.dispose({ keepActiveExecutions: true })`) lives
 * on in its *previous* window's retained session — invisible to a newly
 * created window's session unless explicitly rebound onto it.
 */
export function findActiveAgentExecutionHandle(
  executionId: string,
): ActiveAgentExecutionLookup | undefined {
  for (const session of liveSessions) {
    const handle = session.executions.getHandle(executionId);
    if (handle instanceof AgentExecutionHandle) {
      return { handle, session };
    }
  }
  return undefined;
}

/**
 * Untrack an execution handle from every live session that still has it
 * registered — not just the one session that happens to finalize it. A
 * cross-session rebind (via {@link findActiveAgentExecutionHandle} above)
 * tracks the same handle into a second session's registry without removing
 * it from the first. Without this, whichever session finalizes the run
 * (e.g. a user stop issued from a newly recreated window) only clears its
 * own registry, leaving the original `keepActiveExecutions` session's
 * registry non-idle forever: its `disposeWhenIdle` wait loop never observes
 * the change and that session never leaves {@link liveSessions} (#8148).
 *
 * Matches on the handle identity, not the execution id: a resume replaces a
 * rebound WAITING handle with a *fresh* handle under the same execution id
 * (#8229), and releasing the superseded handle by id alone would tear the
 * fresh, live registration out of its session's registry too.
 */
export function untrackActiveAgentExecution(handle: ExecutionHandle): void {
  for (const session of liveSessions) {
    session.executions.untrackIfCurrent(handle);
  }
}

/** Stop background OS processes owned by every live runtime session. */
export function killAllSessionBackgroundProcesses(): void {
  for (const session of liveSessions) {
    session.executions.killBackgroundProcesses();
  }
}

let cachedDefaultSession: SessionHandle | undefined;

/**
 * The process-default session — the sole owner of the process-wide runtime
 * singletons (#7694). Every member the constructor doesn't receive is
 * fresh-built in the same FORCED dependency order any other `SessionHandle`
 * uses; there is no separate `Shared*`/`*Service` module export to alias
 * anymore, so this construction *is* where those singletons now live.
 *
 * Constructed lazily on first use rather than at module evaluation: many
 * run-scoped modules import `currentSession`, which pulls this module into
 * their import cycle, and an eager construction here would risk reading a
 * cross-module singleton before its own module finished initializing (TDZ).
 * Deferring to first call sidesteps that entirely.
 */
export function defaultSession(): SessionHandle {
  return (cachedDefaultSession ??= new SessionHandle({
    flushers: getActiveFlushers(),
  }));
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
