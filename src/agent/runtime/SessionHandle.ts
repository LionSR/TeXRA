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
 * {@link defaultSessionHandle}, wraps the existing process-global singletons
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

import { getActiveFlushers } from '@transcript';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';

import { ExecutionRegistry, executionRegistry } from './executionRegistry';
import { InterruptRegistry, interruptRegistry } from './InterruptRegistry';
import { RunCoordinatorBridge, runCoordinatorBridge } from './runCoordinators';
import {
  ExecutionSubscriptionBinder,
  executionSubscriptionBinder,
} from './ExecutionSubscriptionBinder';
import { StreamStatusService } from './StreamStatusService';
import type { AgentRuntimeHost } from './AgentRuntimeHost';

/** Members callers may inject; everything else is fresh-constructed in order. */
export type SessionHandleInit = Partial<
  Pick<
    SessionHandle,
    | 'interrupts'
    | 'executions'
    | 'coordinators'
    | 'subscriptions'
    | 'flushers'
    | 'hostChannel'
  >
>;

export class SessionHandle {
  /** Live executions that can be interrupted by stream id. */
  readonly interrupts: InterruptRegistry;
  /** Per-run execution handles; owns the process-output poller + status sub. */
  readonly executions: ExecutionRegistry;
  /** Resolve-side request index bridging host decisions to run coordinators. */
  readonly coordinators: RunCoordinatorBridge;
  /** Execution-status subscriptions bound to agent stream lifecycles. */
  readonly subscriptions: ExecutionSubscriptionBinder;
  /** This session's trace-flush callbacks (drained on dispose / shutdown). */
  readonly flushers: Set<() => void>;
  /**
   * Optional session-scoped emit surface for the non-run-scoped host-path
   * emissions (SDK Step 7d follow-on F-1). Unset ⇒ those stay on the bus.
   */
  readonly hostChannel?: AgentRuntimeHost;

  constructor(init: SessionHandleInit = {}) {
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    const interrupts = init.interrupts ?? new InterruptRegistry();
    const executions =
      init.executions ??
      new ExecutionRegistry({ interrupts, streamStatus: StreamStatusService });
    const coordinators =
      init.coordinators ?? new RunCoordinatorBridge(executions);
    const subscriptions =
      init.subscriptions ??
      new ExecutionSubscriptionBinder({
        registry: executions,
        releaseSource: ToolUseFollowUpQueue,
      });

    this.interrupts = interrupts;
    this.executions = executions;
    this.coordinators = coordinators;
    this.subscriptions = subscriptions;
    // A fresh session owns its own flusher set; the default session aliases the
    // process-module set so `createRunTrace`'s default writes still drain.
    this.flushers = init.flushers ?? new Set<() => void>();
    this.hostChannel = init.hostChannel;
  }

  /** Drain pending trace writes for this session's streams only. */
  flushPendingTraces(): void {
    for (const flush of [...this.flushers]) flush();
  }

  /**
   * Tear down everything this session owns. Order matters: resolve any pending
   * coordinator requests, drop subscription disposers, then dispose the
   * execution registry (the first production caller — this retires the
   * module-level status-subscription residue for non-default sessions), then
   * clear interrupt entries (`InterruptRegistry` has no `clear()`; `retainOnly`
   * with the empty set is the existing precedent).
   */
  dispose(): void {
    this.coordinators.cleanupAllRequests();
    this.subscriptions.dispose();
    this.executions.dispose();
    this.interrupts.retainOnly(new Set());
  }
}

/**
 * The process-default session. Its members ARE the existing exported singletons
 * — identity is the behavior-neutral compatibility mechanism for the 7d train:
 * unmigrated call sites keep hitting the same objects, and per-call-site
 * migration is `runCoordinatorBridge.x(...)` → `session.coordinators.x(...)`
 * against the identical instance.
 */
export const defaultSessionHandle = new SessionHandle({
  interrupts: interruptRegistry,
  executions: executionRegistry,
  coordinators: runCoordinatorBridge,
  subscriptions: executionSubscriptionBinder,
  flushers: getActiveFlushers(),
});
