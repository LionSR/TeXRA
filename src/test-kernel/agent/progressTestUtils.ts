// Local imports
import type { AgentEvent } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  matchesCancelSelector,
  type HostBashApprovalResult,
  type HostInteractionCancelSelector,
  type HostInteractions,
  type HostUserQuestionResult,
  type PendingInteractionKind,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
} from '@agent/runtime/HostInteractions';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import type {
  SessionEvent,
  SessionEventHub,
  SessionEventSubscriptionFilter,
  SessionFact,
} from '@agent/runtime/SessionEventHub';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createSessionApprovals } from '@agent/runtime/streamApprovalQueue';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

/**
 * Loosely-typed recording of host emissions. The recording host also encodes
 * typed `HostInteractions` requests/resolutions as legacy-style show/resolve
 * entries (including keys that no longer exist on the frozen production map),
 * so the vocabulary is a plain string.
 */
export type RecordedProgressEvent = {
  event: string;
  payload: unknown;
};

export interface RecordingProgressSink {
  emit(event: string, payload: unknown): void;
}

export function recordSessionEvents(
  hub: SessionEventHub,
  filter: SessionEventSubscriptionFilter = {},
): {
  readonly events: SessionEvent[];
  readonly detach: () => void;
} {
  const events: SessionEvent[] = [];
  const detach = hub.subscribe((event) => events.push(event), filter);
  return { events, detach };
}

export function sessionFactPayloads<T extends SessionFact['type']>(
  events: readonly SessionEvent[],
  type: T,
): unknown[] {
  const payloads: unknown[] = [];
  for (const entry of events) {
    if (entry.scope !== 'session' || entry.event.type !== type) continue;
    payloads.push(entry.event.payload);
  }
  return payloads;
}

export function runEventsOfType<T extends AgentEvent['type']>(
  events: readonly SessionEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.flatMap((entry) => {
    if (entry.scope !== 'run' || entry.event.type !== type) return [];
    return [entry.event as Extract<AgentEvent, { type: T }>];
  });
}

export function createRecordingHost(): {
  events: RecordedProgressEvent[];
  interactions: HostInteractions;
  host: AgentRuntimeHost & RecordingProgressSink;
} {
  const events: RecordedProgressEvent[] = [];
  const pendingPlans = new Map<
    string,
    { streamId: string; settle: (result: PlanApprovalResult) => void }
  >();
  const pendingProposals = new Map<
    string,
    { streamId: string; settle: (result: ProposalResult) => void }
  >();
  const pendingRetries = new Map<
    string,
    { streamId: string; settle: (result: RetryResult) => void }
  >();
  const pendingBashes = new Map<
    string,
    { streamId?: string; settle: (result: HostBashApprovalResult) => void }
  >();
  const pendingUserQuestions = new Map<
    string,
    { streamId?: string; settle: (result: HostUserQuestionResult) => void }
  >();
  // Mirrors the host contract: interaction requests register the stream
  // without switching the active tab (#8246).
  const revealStream = (streamId?: string | null) => {
    events.push({ event: 'requestEnsureProgressView', payload: {} });
    if (streamId) {
      events.push({
        event: 'setActiveStream',
        payload: {
          streamId,
          suppressViewSwitch: true,
          ensureVisible: true,
        },
      });
    }
  };
  const interactions: HostInteractions = {
    requestBashApproval: (request) => {
      const requestId = `bash-${pendingBashes.size + 1}`;
      const streamId = request.streamId ?? '';
      revealStream(request.streamId);
      events.push({
        event: 'showBashPermission',
        payload: {
          requestId,
          command: request.command,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          allowBypass: true,
          streamId,
        },
      });
      return new Promise((resolve) => {
        pendingBashes.set(requestId, {
          streamId: request.streamId ?? undefined,
          settle: resolve,
        });
      });
    },
    requestPlanApproval: (request) => {
      events.push({
        event: 'showPlanApproval',
        payload: request,
      });
      return new Promise((resolve) => {
        pendingPlans.set(request.approvalId, {
          streamId: request.streamId,
          settle: resolve,
        });
      });
    },
    requestAgentProposal: (request) => {
      events.push({
        event: 'showAgentProposal',
        payload: request,
      });
      return new Promise((resolve) => {
        pendingProposals.set(request.proposalId, {
          streamId: request.streamId,
          settle: resolve,
        });
      });
    },
    requestRetry: (request) => {
      events.push({
        event: 'showRetryRequest',
        payload: request,
      });
      return new Promise((resolve) => {
        pendingRetries.set(request.streamId, {
          streamId: request.streamId,
          settle: resolve,
        });
      });
    },
    askUserQuestion: (request) => {
      revealStream(request.streamId || undefined);
      events.push({
        event: 'showUserQuestion',
        payload: request,
      });
      return new Promise((resolve) => {
        pendingUserQuestions.set(request.requestId, {
          streamId: request.streamId || undefined,
          settle: resolve,
        });
      });
    },
    resolve: (requestId, result) => {
      if (result.kind === 'bash') {
        const pending = pendingBashes.get(requestId);
        if (!pending) return false;
        pendingBashes.delete(requestId);
        events.push({
          event: 'resolveBashPermission',
          payload: { requestId },
        });
        pending.settle({
          accepted: result.action === 'approve',
          userMessage:
            result.action === 'reject' ? result.feedback?.trim() : undefined,
        });
        return true;
      }
      if (result.kind === 'plan') {
        const pending = pendingPlans.get(requestId);
        if (!pending) return false;
        pendingPlans.delete(requestId);
        events.push({
          event: 'resolvePlanApproval',
          payload: { approvalId: requestId },
        });
        pending.settle({
          action: result.action as PlanApprovalResult['action'],
          ...(result.feedback ? { feedback: result.feedback } : {}),
        } as PlanApprovalResult);
        return true;
      }
      if (result.kind === 'proposal') {
        const pending = pendingProposals.get(requestId);
        if (!pending) return false;
        pendingProposals.delete(requestId);
        events.push({
          event: 'resolveAgentProposal',
          payload: { proposalId: requestId },
        });
        pending.settle(
          (result.value ?? {
            action: result.action,
            ...(result.feedback ? { feedback: result.feedback } : {}),
          }) as ProposalResult,
        );
        return true;
      }
      if (result.kind === 'retry') {
        const pending = pendingRetries.get(requestId);
        if (!pending) return false;
        pendingRetries.delete(requestId);
        events.push({
          event: 'resolveRetryRequest',
          payload: { streamId: requestId },
        });
        pending.settle({
          action: result.action as RetryResult['action'],
          ...(result.feedback ? { feedback: result.feedback } : {}),
        } as RetryResult);
        return true;
      }
      if (result.kind === 'userQuestion') {
        const pending = pendingUserQuestions.get(requestId);
        if (!pending) return false;
        pendingUserQuestions.delete(requestId);
        events.push({
          event: 'resolveUserQuestion',
          payload: { requestId },
        });
        pending.settle({
          submitted: result.action === 'submit',
          answers:
            result.action === 'submit'
              ? (result.value as HostUserQuestionResult['answers'])
              : undefined,
          feedback: result.action === 'submit' ? undefined : result.feedback,
        });
        return true;
      }
      return false;
    },
    cancel: (selector = {}) => cancelWhere(selector),
    dispose: () => cancelWhere({}),
  };
  function cancelWhere(selector: HostInteractionCancelSelector): void {
    const match = (kind: PendingInteractionKind, streamId?: string) =>
      matchesCancelSelector(
        { kind, streamId: streamId || undefined },
        selector,
      );
    for (const [requestId, pending] of pendingBashes) {
      if (!match('bash', pending.streamId)) continue;
      pendingBashes.delete(requestId);
      events.push({
        event: 'resolveBashPermission',
        payload: { requestId },
      });
      pending.settle({ accepted: false });
    }
    for (const [approvalId, pending] of pendingPlans) {
      if (!match('plan', pending.streamId)) continue;
      pendingPlans.delete(approvalId);
      events.push({
        event: 'resolvePlanApproval',
        payload: { approvalId },
      });
      pending.settle({ action: 'reject' });
    }
    for (const [proposalId, pending] of pendingProposals) {
      if (!match('proposal', pending.streamId)) continue;
      pendingProposals.delete(proposalId);
      events.push({
        event: 'resolveAgentProposal',
        payload: { proposalId },
      });
      pending.settle({ action: 'reject' });
    }
    for (const [streamId, pending] of pendingRetries) {
      if (!match('retry', pending.streamId)) continue;
      pendingRetries.delete(streamId);
      events.push({
        event: 'resolveRetryRequest',
        payload: { streamId },
      });
      pending.settle({ action: 'cancel' });
    }
    for (const [requestId, pending] of pendingUserQuestions) {
      if (!match('userQuestion', pending.streamId)) continue;
      pendingUserQuestions.delete(requestId);
      events.push({
        event: 'resolveUserQuestion',
        payload: { requestId },
      });
      pending.settle({ submitted: false });
    }
  }
  const host = {
    interactions,
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
  } as AgentRuntimeHost & RecordingProgressSink;
  return {
    events,
    interactions,
    host,
  };
}

/**
 * Minimal session stand-in exposing `interactions` plus fresh session-owned
 * approval state — enough for run-scoped code that resolves
 * `currentSession().interactions` (plan approvals, proposals, retries) or
 * `currentSession().approvals` (bypass state, queues) to reach isolated
 * instances.
 */
export function sessionWithInteractions(
  interactions: HostInteractions | undefined,
): SessionHandle {
  return {
    interactions,
    approvals: createSessionApprovals(),
  } as unknown as SessionHandle;
}

/**
 * Run `fn` inside a launch `RunContext` carrying `runtimeHost`/`streamId`.
 *
 * Flow nodes read these from the ambient `RunContext` rather than the
 * services bag (DI cleanup Step 2) — production always runs them inside
 * `withExecutionRunContext`, which always projects a `launch` context. Tests
 * that call a node's `exec`/`post` directly need the same scope.
 */
export function withTestRunContext<T>(
  runtimeHost: AgentRuntimeHost,
  streamId: string,
  fn: () => Promise<T>,
  options: {
    delegationDepth?: number;
    approvalPromptsUnavailable?: boolean;
    runtimeUnavailableTools?: readonly string[];
    stopAfterCycle?: boolean;
  } = {},
): Promise<T> {
  return withRunContext(
    createRunContext({
      runScope: createRunScope({
        runtimeHost,
        streamId: streamId as StreamTabId,
        executionId: 'deadbeef' as ExecutionId,
        agentName: 'test-agent',
        session: sessionWithInteractions(runtimeHost.interactions),
      }),
      modelSource: 'live',
      getModel: () => undefined,
      ...options,
    }),
    fn,
  ) as Promise<T>;
}
