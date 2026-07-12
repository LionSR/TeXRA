// Type imports - tracing
import type { AgentTrace } from '@agent/trace';

// Local imports - agent runtime
import {
  AgentExecutionHandle,
  ProcessExecutionHandle,
  type ExecutionHandle,
} from '@agent/runtime/executionRegistry';
import {
  findActiveAgentExecutionHandle,
  type SessionHandle,
  untrackActiveAgentExecution,
} from '@agent/runtime/SessionHandle';

// Local imports - constants
import { isTerminalOutcomePhase } from '@common/constants/streamStatus';

// Local imports - shared schemas
import {
  STREAM_PHASE,
  type ExecutionId,
  type RestoredStreamSnapshot,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';

interface ReboundAgentBinding {
  readonly streamId: StreamTabId;
  readonly ownerSession: SessionHandle;
  dispose(): void;
}

interface ReboundProcessBinding {
  readonly ownerSession: SessionHandle;
  dispose(): void;
}

/**
 * Bridges executions retained by a closed desktop window into a replacement
 * window without migrating their run-context ownership.
 */
export class DesktopExecutionRebinder {
  private readonly interactionForwards = new Map<SessionHandle, () => void>();
  private readonly agentBindings = new Map<ExecutionId, ReboundAgentBinding>();
  private readonly rootOwners = new Map<StreamTabId, SessionHandle>();
  private readonly processBindings = new Map<
    ExecutionId,
    ReboundProcessBinding
  >();
  private readonly ownerRegistrationObservers = new Map<
    SessionHandle,
    () => void
  >();

  constructor(
    private readonly targetSession: SessionHandle,
    private readonly logger: Pick<AgentTrace, 'debug' | 'warn'>,
  ) {}

  rebind(
    activeExecutionIds: ReadonlySet<string>,
    allExecutionIds: ReadonlyMap<StreamTabId, ExecutionId>,
    restoredStreams: ReadonlyMap<StreamTabId, RestoredStreamSnapshot>,
  ): void {
    const reboundRoots = new Map(this.rootOwners);
    for (const [streamId, snapshot] of restoredStreams) {
      const executionId = snapshot.executionId ?? allExecutionIds.get(streamId);
      if (!executionId || !activeExecutionIds.has(executionId)) continue;
      let binding = this.agentBindings.get(executionId);
      if (!binding) {
        const found = findActiveAgentExecutionHandle(executionId);
        if (!found || found.handle.childStreamId !== streamId) continue;
        this.bindAgent(executionId, streamId, found.session);
        binding = this.agentBindings.get(executionId);
      }
      if (!binding) continue;
      this.forwardInteractions(binding.ownerSession);
      this.rootOwners.set(streamId, binding.ownerSession);
      reboundRoots.set(streamId, binding.ownerSession);
      this.observeOwnerRegistrations(binding.ownerSession);
    }
    for (const [streamId, ownerSession] of reboundRoots) {
      this.bindDescendants(streamId, ownerSession);
    }
  }

  /** Detach every bridge and remove mirrored handles from the closing window. */
  dispose(): void {
    for (const binding of [...this.agentBindings.values()]) binding.dispose();
    for (const binding of [...this.processBindings.values()]) binding.dispose();
    for (const detach of this.ownerRegistrationObservers.values()) detach();
    this.ownerRegistrationObservers.clear();
    for (const detach of this.interactionForwards.values()) detach();
    this.interactionForwards.clear();
  }

  /** Resolve the durable runtime owner for a stream mirrored into this window. */
  ownerSessionForStream(streamId: StreamTabId): SessionHandle | undefined {
    const rootOwner = this.rootOwners.get(streamId);
    if (rootOwner) return rootOwner;
    for (const binding of this.agentBindings.values()) {
      if (binding.streamId === streamId) return binding.ownerSession;
    }
    return undefined;
  }

  private forwardInteractions(ownerSession: SessionHandle): void {
    if (
      ownerSession === this.targetSession ||
      this.interactionForwards.has(ownerSession)
    ) {
      return;
    }
    this.interactionForwards.set(
      ownerSession,
      ownerSession.useHostInteractions(
        this.targetSession.interactions.createForwarder(),
      ),
    );
  }

  private bindAgent(
    executionId: ExecutionId,
    streamId: StreamTabId,
    ownerSession: SessionHandle,
  ): void {
    if (this.agentBindings.has(executionId)) return;
    let currentHandle: AgentExecutionHandle | undefined;
    let detachTrace: (() => void) | undefined;
    let detachTerminalMirror: (() => void) | undefined;
    let detachOwnerHandle = (): void => undefined;
    let detachOwnerStatus = (): void => undefined;
    let detachTargetHandle = (): void => undefined;
    let disposed = false;

    const disposeBinding = (): void => {
      if (disposed) return;
      disposed = true;
      detachOwnerHandle();
      detachOwnerStatus();
      detachTargetHandle();
      detachTrace?.();
      detachTerminalMirror?.();
      if (this.agentBindings.get(executionId) === binding) {
        this.agentBindings.delete(executionId);
      }
      if (this.rootOwners.get(streamId) === ownerSession) {
        this.rootOwners.delete(streamId);
        this.detachOwnerObserverIfUnused(ownerSession);
      }
      this.detachInteractionForwardIfUnused(ownerSession);
    };
    const releaseCurrent = (): void => {
      const staleHandle = currentHandle;
      currentHandle = undefined;
      disposeBinding();
      if (staleHandle) untrackActiveAgentExecution(staleHandle);
    };
    // Drop only the per-handle mirrors (trace, terminal, mirrored registry
    // entry), keeping the binding and its owner-status mirror alive.
    const releaseHandleMirror = (): void => {
      const staleHandle = currentHandle;
      currentHandle = undefined;
      detachTrace?.();
      detachTrace = undefined;
      detachTerminalMirror?.();
      detachTerminalMirror = undefined;
      if (staleHandle) untrackActiveAgentExecution(staleHandle);
    };
    const mirrorTerminalStatus = (status: StreamPhase): void => {
      if (
        !this.targetSession.status.transitionToTerminal(streamId, status, {
          events: this.targetSession.events,
        })
      ) {
        this.logger.warn('Failed to mirror rebound terminal status', {
          data: { streamId, status },
        });
      }
    };
    // Tear down only once the target itself holds a terminal phase, so a
    // rejected terminal mirror doesn't strand the tab non-terminal with the
    // mirror already detached; a still-alive binding is reaped on window
    // close, and a re-tracked handle rebinds through it.
    const disposeBindingIfTargetTerminal = (): void => {
      if (isTerminalOutcomePhase(this.targetSession.status.get(streamId))) {
        disposeBinding();
      }
    };
    const seedStatus = (handle: AgentExecutionHandle): void => {
      const status = ownerSession.status.get(streamId);
      if (!status) return;
      const emitOptions = { trace: handle.trace };
      const seeded =
        status === STREAM_PHASE.WAITING
          ? this.targetSession.status.transitionToWaiting(
              streamId,
              'restart-repair',
              emitOptions,
            )
          : this.targetSession.status.transition(
              streamId,
              status,
              'restart-repair',
              emitOptions,
            ) ||
            (status === STREAM_PHASE.RUNNING &&
              this.targetSession.status.transition(
                streamId,
                STREAM_PHASE.RUNNING,
                'resume',
                emitOptions,
              ));
      if (!seeded) {
        this.logger.warn('Failed to seed rebound stream status', {
          data: {
            streamId,
            status,
            hydrated: this.targetSession.status.get(streamId),
          },
        });
      }
    };
    const bindOwnerHandle = (handle: ExecutionHandle | undefined): void => {
      if (disposed) return;
      if (
        !(handle instanceof AgentExecutionHandle) ||
        handle.childStreamId !== streamId
      ) {
        // The owner untracks BEFORE its terminal stream-status transition
        // lands (`finalizeRunTerminal` untracks first), and a child stream's
        // finalization never emits a `result` trace event, so tearing the
        // whole binding down here would strand the mirrored stream at
        // RUNNING/WAITING (#8257). Release the handle mirror only; the
        // owner-status mirror below stays attached until the terminal phase
        // arrives (or a replacement handle rebinds).
        releaseHandleMirror();
        const ownerStatus = ownerSession.status.get(streamId);
        if (isTerminalOutcomePhase(ownerStatus)) {
          mirrorTerminalStatus(ownerStatus);
          disposeBindingIfTargetTerminal();
        }
        return;
      }
      if (handle === currentHandle) return;
      const staleHandle = currentHandle;
      detachTrace?.();
      detachTerminalMirror?.();
      currentHandle = handle;
      this.targetSession.executions.track(handle);
      detachTrace = handle.trace
        ? this.targetSession.attachRunTrace(handle.trace, streamId)
        : undefined;
      detachTerminalMirror = handle.trace?.subscribe((event) => {
        if (event.type !== 'result' || event.streamId !== streamId) return;
        mirrorTerminalStatus(event.outcome);
      });
      // Launch facts (run.config, child description) fired before this
      // binding subscribed to the trace; replay them so the rebound stream
      // carries its real task state and label, not defaults (#8258).
      const facts = handle.initialRunFacts;
      if (facts) {
        this.targetSession.publishRunEvent(streamId, {
          type: 'run.config',
          streamId,
          executionId,
          config: facts.config,
        });
        if (facts.description !== undefined) {
          this.targetSession.events.emit({
            scope: 'session',
            event: {
              type: 'updateStreamDescription',
              payload: { streamId, description: facts.description },
            },
          });
        }
      }
      seedStatus(handle);
      if (staleHandle) untrackActiveAgentExecution(staleHandle);
    };

    const binding: ReboundAgentBinding = {
      streamId,
      ownerSession,
      dispose: () => {
        const mirroredHandle = currentHandle;
        currentHandle = undefined;
        disposeBinding();
        if (mirroredHandle) {
          this.targetSession.executions.untrackIfCurrent(mirroredHandle);
        }
      },
    };
    this.agentBindings.set(executionId, binding);
    detachTargetHandle = this.targetSession.executions.addListener(
      executionId,
      (handle) => {
        if (disposed || handle === currentHandle) return;
        releaseCurrent();
      },
    );
    detachOwnerStatus = ownerSession.status.onDidChange((change) => {
      if (disposed || change.streamId !== streamId) return;
      if (isTerminalOutcomePhase(change.status)) {
        // Terminal outcomes need `transitionToTerminal`'s choreography (a
        // WAITING or unseeded target resumes to RUNNING first); the plain
        // cause-preserving transition below would reject those mirrors.
        mirrorTerminalStatus(change.status);
        // Owner already untracked the handle (see bindOwnerHandle): this
        // terminal mirror is the binding's last mirrored fact.
        if (!currentHandle) disposeBindingIfTargetTerminal();
        return;
      }
      if (
        !this.targetSession.status.transition(
          streamId,
          change.status,
          change.cause,
          {
            // Publish the mirror as an `updateStreamStatus` session fact:
            // without `events`, the transition only updates the in-memory
            // status map and never reaches the UI or snapshot store (#8256).
            events: this.targetSession.events,
            ...(change.substate ? { substate: change.substate } : {}),
          },
        ) &&
        this.targetSession.status.get(streamId) !== change.status
      ) {
        this.logger.debug('Rejected rebound stream status mirror', {
          data: {
            streamId,
            status: change.status,
            current: this.targetSession.status.get(streamId),
          },
        });
      }
    });
    const ownerDetach = ownerSession.executions.observeHandle(
      executionId,
      bindOwnerHandle,
    );
    detachOwnerHandle = ownerDetach;
    if (disposed) ownerDetach();
  }

  private bindDescendants(
    rootStreamId: StreamTabId,
    ownerSession: SessionHandle,
  ): void {
    const childStreams = new Set<StreamTabId>([rootStreamId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const executionId of ownerSession.executions.getActiveIds()) {
        const child = ownerSession.executions.getHandle(executionId);
        if (child instanceof AgentExecutionHandle) {
          if (
            !child.isChildExecution ||
            !childStreams.has(child.parentStreamId)
          ) {
            continue;
          }
          if (!childStreams.has(child.childStreamId)) {
            childStreams.add(child.childStreamId);
            grew = true;
          }
          this.bindAgent(child.executionId, child.childStreamId, ownerSession);
        } else if (
          child instanceof ProcessExecutionHandle &&
          childStreams.has(child.parentStreamId)
        ) {
          this.bindProcess(child.executionId, ownerSession);
        }
      }
    }
  }

  private observeOwnerRegistrations(ownerSession: SessionHandle): void {
    if (this.ownerRegistrationObservers.has(ownerSession)) return;
    this.ownerRegistrationObservers.set(
      ownerSession,
      ownerSession.executions.addRegistrationListener(() => {
        for (const [rootStreamId, owner] of this.rootOwners) {
          if (owner === ownerSession) {
            this.bindDescendants(rootStreamId, ownerSession);
          }
        }
      }),
    );
  }

  private detachOwnerObserverIfUnused(ownerSession: SessionHandle): void {
    for (const owner of this.rootOwners.values()) {
      if (owner === ownerSession) return;
    }
    this.ownerRegistrationObservers.get(ownerSession)?.();
    this.ownerRegistrationObservers.delete(ownerSession);
  }

  private detachInteractionForwardIfUnused(ownerSession: SessionHandle): void {
    for (const binding of this.agentBindings.values()) {
      if (binding.ownerSession === ownerSession) return;
    }
    for (const binding of this.processBindings.values()) {
      if (binding.ownerSession === ownerSession) return;
    }
    this.interactionForwards.get(ownerSession)?.();
    this.interactionForwards.delete(ownerSession);
  }

  private bindProcess(
    executionId: ExecutionId,
    ownerSession: SessionHandle,
  ): void {
    if (this.processBindings.has(executionId)) return;
    let currentHandle: ProcessExecutionHandle | undefined;
    let detachOwnerHandle = (): void => undefined;
    let disposed = false;
    const disposeBinding = (): void => {
      if (disposed) return;
      disposed = true;
      detachOwnerHandle();
      if (currentHandle) {
        this.targetSession.executions.untrackIfCurrent(currentHandle);
      }
      if (this.processBindings.get(executionId) === binding) {
        this.processBindings.delete(executionId);
      }
      this.detachInteractionForwardIfUnused(ownerSession);
    };
    const binding: ReboundProcessBinding = {
      ownerSession,
      dispose: disposeBinding,
    };
    this.processBindings.set(executionId, binding);
    const ownerDetach = ownerSession.executions.observeHandle(
      executionId,
      (handle) => {
        if (disposed) return;
        if (!(handle instanceof ProcessExecutionHandle)) {
          disposeBinding();
          return;
        }
        currentHandle = handle;
        this.targetSession.executions.track(handle);
      },
    );
    detachOwnerHandle = ownerDetach;
    if (disposed) ownerDetach();
  }
}
