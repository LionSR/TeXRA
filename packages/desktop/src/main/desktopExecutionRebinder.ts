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

// Local imports - shared schemas
import {
  STREAM_PHASE,
  type ExecutionId,
  type RestoredStreamSnapshot,
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

  private forwardInteractions(ownerSession: SessionHandle): void {
    if (
      ownerSession === this.targetSession ||
      this.interactionForwards.has(ownerSession)
    ) {
      return;
    }
    const target = this.targetSession.interactions;
    this.interactionForwards.set(
      ownerSession,
      ownerSession.useHostInteractions({
        requestToolEditApproval: (request, options) =>
          target.requestToolEditApproval(request, options),
        requestBashApproval: (request, options) =>
          target.requestBashApproval(request, options),
        requestPlanApproval: (request, options) =>
          target.requestPlanApproval(request, options),
        requestAgentProposal: (request, options) =>
          target.requestAgentProposal(request, options),
        requestRetry: (request, options) =>
          target.requestRetry(request, options),
        askUserQuestion: (request, options) =>
          target.askUserQuestion(request, options),
        openExternalInquiry: (request) => target.openExternalInquiry(request),
        setApprovalBypassState: (update) =>
          target.setApprovalBypassState(update),
        resolve: (requestId, result) => target.resolve(requestId, result),
        cancel: (selector) => target.cancel(selector),
      }),
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
    };
    const releaseCurrent = (): void => {
      const staleHandle = currentHandle;
      currentHandle = undefined;
      disposeBinding();
      if (staleHandle) untrackActiveAgentExecution(staleHandle);
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
        releaseCurrent();
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
        if (
          !this.targetSession.status.transitionToTerminal(
            streamId,
            event.outcome,
          )
        ) {
          this.logger.warn('Failed to mirror rebound terminal status', {
            data: { streamId, status: event.outcome },
          });
        }
      });
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
      if (
        !this.targetSession.status.transition(
          streamId,
          change.status,
          change.cause,
          change.substate ? { substate: change.substate } : {},
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
