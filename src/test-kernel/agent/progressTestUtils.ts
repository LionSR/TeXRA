// Local imports
import type { AgentEvent } from '@agent/trace';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ReflectionFlowShared } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import type { ToolUseRunShared } from '@agent/implementations/flows/tooluse/nodes/types';
import {
  matchesCancelSelector,
  SessionHostInteractions,
  type BashSettlement,
  type HostInteractionCancelSelector,
  type HostInteractions,
  type PlanApprovalResult,
  type ProposalResult,
  type RetrySettlement,
  type RetryResult,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope, type RunScope } from '@agent/runtime/RunScope';
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';
import {
  SessionEventHub,
  type HubEvent,
  type SessionEventSubscriptionFilter,
  type SessionFact,
} from '@agent/runtime/SessionEventHub';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { createSessionApprovals } from '@agent/runtime/streamApprovalQueue';
import type { HostBashApprovalRequest } from '@agent/runtime/HostInteractions';
import type {
  ExecutionId,
  ProgressPermissionKind,
  StreamTabId,
} from '@shared/schemas';
import { prepareBashApprovalPrompt } from '@tools/approval/bashApproval';
import {
  prepareToolEditApprovalPrompt,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';
import { generateShortId } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';

/**
 * Loosely-typed recording of host emissions. The recording host flattens typed
 * `HostInteractions` requests and test-owned decisions into the same stream as
 * plain `emit` calls, using its own `show*`/`resolve*` names, so the event
 * vocabulary is a plain string.
 */
export type RecordedProgressEvent = {
  event: string;
  payload: unknown;
};

export interface RecordingProgressSink {
  emit(event: string, payload: unknown): void;
}

export interface RecordingHostDecisions {
  submitBash(requestId: string, decision: BashSettlement): boolean;
  submitPlan(requestId: string, decision: PlanApprovalResult): boolean;
  submitProposal(requestId: string, decision: ProposalResult): boolean;
  submitRetry(requestId: string, decision: RetrySettlement): boolean;
  submitUserQuestion(
    requestId: string,
    decision: UserQuestionSettlement,
  ): boolean;
}

export function recordSessionEvents(
  hub: SessionEventHub,
  filter: SessionEventSubscriptionFilter = {},
): {
  readonly events: HubEvent[];
  readonly detach: () => void;
} {
  const events: HubEvent[] = [];
  const detach = hub.subscribe((event) => events.push(event), filter);
  return { events, detach };
}

export function sessionFactsOfType<T extends SessionFact['type']>(
  events: readonly HubEvent[],
  type: T,
): Array<Extract<SessionFact, { type: T }>> {
  const facts: Array<Extract<SessionFact, { type: T }>> = [];
  for (const entry of events) {
    if (entry.scope !== 'session' || entry.event.type !== type) continue;
    facts.push(entry.event as Extract<SessionFact, { type: T }>);
  }
  return facts;
}

export type PayloadSessionFact = Exclude<SessionFact, { type: 'status' }>;

export function sessionFactPayloads<T extends PayloadSessionFact['type']>(
  events: readonly HubEvent[],
  type: T,
): unknown[] {
  const payloads: unknown[] = [];
  for (const entry of events) {
    if (entry.scope !== 'session' || entry.event.type !== type) continue;
    payloads.push(entry.event.payload);
  }
  return payloads;
}

/**
 * The `ToolUseRunShared` baseline every wait/round node test starts from:
 * no messages, no pending cycle skip, no persisted state slices yet.
 */
export function toolUseRunShared(
  overrides: Partial<ToolUseRunShared> = {},
): ToolUseRunShared {
  return {
    messages: [],
    continuationGenerationId: '7b7f4d7e-3f60-49a5-b640-df1c8f9be302',
    shouldSkipCycle: false,
    stateSlices: null,
    ...overrides,
  };
}

/**
 * The `ReflectionFlowShared` baseline reflection-node tests start from: round
 * zero of a two-round run, an empty workspace and no resolved output location.
 */
export function reflectionFlowShared(
  overrides: Partial<ReflectionFlowShared> = {},
): ReflectionFlowShared {
  const currentRound = overrides.currentRound ?? 0;
  return {
    currentRound,
    totalRounds: 2,
    workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
    context: [],
    outputLocation: null,
    runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
    roundOutputs: [],
    continueRounds: true,
    endTurn: false,
    ...overrides,
  };
}

export function runEventsOfType<T extends AgentEvent['type']>(
  events: readonly HubEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.flatMap((entry) => {
    if (entry.scope !== 'run' || entry.event.type !== type) return [];
    return [entry.event as Extract<AgentEvent, { type: T }>];
  });
}

interface RecordingHostOptions {
  /** What the fake host's `emit` reports as its presentation delivery. */
  readonly emitDelivery?: boolean;
}

export function createRecordingHost(options: RecordingHostOptions = {}): {
  events: RecordedProgressEvent[];
  interactions: HostInteractions;
  decisions: RecordingHostDecisions;
  host: SessionHostInteractions & RecordingProgressSink;
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
    { streamId?: string; settle: (result: BashSettlement) => void }
  >();
  const pendingUserQuestions = new Map<
    string,
    { streamId?: string; settle: (result: UserQuestionSettlement) => void }
  >();
  // Mirrors the host contract: interaction requests ensure the view is
  // open without switching the active tab (#8246).
  const revealStream = () => {
    events.push({ event: 'requestEnsureProgressView', payload: {} });
  };
  const decisions: RecordingHostDecisions = {
    submitBash(requestId, decision) {
      const pending = pendingBashes.get(requestId);
      if (!pending) return false;
      pendingBashes.delete(requestId);
      events.push({
        event: 'resolveBashPermission',
        payload: { requestId },
      });
      pending.settle(decision);
      return true;
    },
    submitPlan(requestId, decision) {
      const pending = pendingPlans.get(requestId);
      if (!pending) return false;
      pendingPlans.delete(requestId);
      events.push({
        event: 'resolvePlanApproval',
        payload: { requestId },
      });
      pending.settle(decision);
      return true;
    },
    submitProposal(requestId, decision) {
      const pending = pendingProposals.get(requestId);
      if (!pending) return false;
      pendingProposals.delete(requestId);
      events.push({
        event: 'resolveAgentProposal',
        payload: { requestId },
      });
      pending.settle(decision);
      return true;
    },
    submitRetry(requestId, decision) {
      const pending = pendingRetries.get(requestId);
      if (!pending) return false;
      pendingRetries.delete(requestId);
      events.push({
        event: 'resolveRetryRequest',
        payload: { streamId: requestId },
      });
      pending.settle(decision);
      return true;
    },
    submitUserQuestion(requestId, decision) {
      const pending = pendingUserQuestions.get(requestId);
      if (!pending) return false;
      pendingUserQuestions.delete(requestId);
      events.push({
        event: 'resolveUserQuestion',
        payload: { requestId },
      });
      pending.settle(decision);
      return true;
    },
  };
  const interactions: HostInteractions = {
    emit: (event, payload) => {
      events.push({ event, payload });
      return options.emitDelivery ?? false;
    },
    setApprovalBypassState: (update) =>
      events.push({ event: 'setApprovalBypassState', payload: update }),
    requestBashApproval: (request) => {
      const requestId = `bash-${pendingBashes.size + 1}`;
      const streamId = request.streamId ?? '';
      revealStream();
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
        pendingPlans.set(request.requestId, {
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
        pendingProposals.set(request.requestId, {
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
      revealStream();
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
    cancel: (selector = {}) => cancelWhere(selector),
    dispose: () => cancelWhere({}),
  };
  function cancelWhere(selector: HostInteractionCancelSelector): void {
    const match = (kind: ProgressPermissionKind, streamId?: string) =>
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
      pending.settle({ action: 'reject' });
    }
    for (const [requestId, pending] of pendingPlans) {
      if (!match('planApproval', pending.streamId)) continue;
      pendingPlans.delete(requestId);
      events.push({
        event: 'resolvePlanApproval',
        payload: { requestId },
      });
      pending.settle({ action: 'reject' });
    }
    for (const [requestId, pending] of pendingProposals) {
      if (!match('proposal', pending.streamId)) continue;
      pendingProposals.delete(requestId);
      events.push({
        event: 'resolveAgentProposal',
        payload: { requestId },
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
      pending.settle({ action: 'reject' });
    }
  }
  const host = sessionWithInteractions(undefined)
    .interactions as SessionHostInteractions & RecordingProgressSink;
  host.use(interactions);
  return {
    events,
    decisions,
    interactions,
    host,
  };
}

/**
 * Minimal session stand-in exposing the session owners used by node tests.
 * This is enough for run-scoped code that resolves
 * `currentSession().interactions` (plan approvals, proposals, retries) or
 * `currentSession().approvals` (bypass state, queues) to reach isolated
 * instances.
 */
export function sessionWithInteractions(
  interactions:
    | HostInteractions
    | SessionHostInteractions
    | Pick<SessionHostInteractions, 'emit'>
    | undefined,
  eventHub?: SessionEventHub,
): SessionHandle {
  // Like production SessionHandle, the stub carries a real event hub and
  // co-constructs the status machine on that same hub — emit sites resolve
  // `session.events` directly, and status facts publish on the hub the
  // session's listeners read (SessionHandleInit documents why an injected
  // machine is forbidden). Tests that record status facts pass the hub in.
  // The interaction owner is constructed with the stub it belongs to, as
  // production constructs it with the session.
  const events = eventHub ?? new SessionEventHub();
  const session = {
    events,
    modelRetries: new ModelRetryGate(),
    status: new StreamStatusMachine(events),
    transcripts: { ensureLoaded: async () => {} },
    followUps: { terminalize: () => false },
    publishRunEvent: (streamId: StreamTabId, event: AgentEvent) =>
      events.emit({ scope: 'run', streamId, event }),
  } as unknown as SessionHandle;
  const owner =
    interactions instanceof SessionHostInteractions
      ? interactions
      : new SessionHostInteractions(session);
  if (interactions && !(interactions instanceof SessionHostInteractions)) {
    owner.use(
      'cancel' in interactions
        ? interactions
        : { ...interactions, cancel: () => {} },
    );
  }
  Object.assign(session, {
    interactions: owner,
    approvals: createSessionApprovals(owner),
  });
  return session;
}

/**
 * The `RunScope` a flow-services fixture must carry, since nodes read run
 * identity from `services.runScope`. Pass the same object to
 * {@link withTestRunContext} so the ambient context and the services bag name
 * one scope, as production does.
 */
export function testRunScope(
  streamId: string,
  options: {
    session?: SessionHandle;
    signal?: AbortSignal;
    interactions?:
      SessionHostInteractions | Pick<SessionHostInteractions, 'emit'>;
  } = {},
): RunScope {
  const interactions =
    options.interactions ?? sessionWithInteractions(undefined).interactions;
  return createRunScope({
    streamId: streamId as StreamTabId,
    executionId: 'deadbeef' as ExecutionId,
    agentName: 'test-agent',
    session: options.session ?? sessionWithInteractions(interactions),
    signal: options.signal ?? new AbortController().signal,
  });
}

/**
 * Run `fn` inside a launch `RunContext` built on `runScope`.
 *
 * Flow nodes read run identity from `services.runScope` and read the remaining
 * ambient-only fields (`stopAfterCycle`, tool availability) off this context.
 * Production installs the run's one scope on both, so a test that also builds
 * services must pass `services.runScope` here rather than a second scope.
 */
export function withTestRunContext<T>(
  runScope: RunScope,
  fn: () => Promise<T>,
  options: {
    approvalPromptsUnavailable?: boolean;
    runtimeUnavailableTools?: readonly string[];
    stopAfterCycle?: boolean;
  } = {},
): Promise<T> {
  return withRunContext(
    createRunContext({ runScope, ...options }),
    fn,
  ) as Promise<T>;
}

/** A host bash request carrying the prompt the tool boundary prepares. */
export function bashApprovalRequest(
  request: Omit<HostBashApprovalRequest, 'permission'>,
  session: SessionHandle = sessionWithInteractions(undefined),
): HostBashApprovalRequest {
  return {
    ...request,
    permission: prepareBashApprovalPrompt(request, session),
  };
}

/** A tool-edit request carrying the prompt the tool boundary prepares. */
export function toolEditApprovalRequest(
  request: Omit<ToolEditApprovalRequest, 'permission'>,
  session: SessionHandle = sessionWithInteractions(undefined),
): ToolEditApprovalRequest {
  return {
    ...request,
    permission: prepareToolEditApprovalPrompt(session, {
      requestId: `approval-${generateShortId()}`,
      request,
      relativePath: WorkspaceFS.relativePath(request.path),
    }),
  };
}
