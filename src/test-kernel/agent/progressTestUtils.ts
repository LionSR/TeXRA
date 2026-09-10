import { Effect, Stream, SubscriptionRef } from 'effect';

// Local imports
import type { AgentEvent, AgentTrace } from '@agent/trace';
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
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import type { HostBashApprovalRequest } from '@agent/runtime/HostInteractions';
import { effectRuntime } from '@platform/processRuntime';
import type {
  ActiveChildInfo,
  RunId,
  ProgressPermissionKind,
  DisplaySessionEvent,
  RunId,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
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

type SessionEventReader = Pick<SessionHandle, 'events' | 'now'>;

/**
 * Read the committed prefix using its drain coordinate, including private rows
 * that advance the cursor without appearing on the display plane.
 */
async function readSessionEvents(
  session: SessionEventReader,
  fromCommit = 0,
): Promise<DisplaySessionEvent[]> {
  const through = session.now();
  if (through <= fromCommit) return [];
  return effectRuntime().runPromise(
    Effect.gen(function* () {
      const drained = yield* SubscriptionRef.make(fromCommit);
      return yield* session.events.all(fromCommit, drained).pipe(
        Stream.interruptWhen(
          SubscriptionRef.changes(drained).pipe(
            Stream.filter((cursor) => cursor >= through),
            Stream.runHead,
          ),
        ),
        Stream.runCollect,
      );
    }),
  );
}

/**
 * Read public events committed since this call. Each read captures its own
 * finite upper bound; `aggregateId` narrows to one stream's facts.
 */
export function recordSessionEvents(
  session: SessionEventReader,
  filter: { readonly aggregateId?: string } = {},
): { readonly read: () => Promise<DisplaySessionEvent[]> } {
  const start = session.now();
  return {
    async read() {
      const events = await readSessionEvents(session, start);
      return filter.aggregateId === undefined
        ? events
        : events.filter((event) => event.aggregateId === filter.aggregateId);
    },
  };
}

/** Every child roster a registry tells its listeners from this call on. */
export function recordChildRosters(
  registry: Pick<SessionHandle['runs'], 'onChildActivity'>,
): {
  readonly rosters: Array<{
    readonly parentRunId: RunId;
    readonly items: readonly ActiveChildInfo[];
  }>;
} {
  const rosters: Array<{
    readonly parentRunId: RunId;
    readonly items: readonly ActiveChildInfo[];
  }> = [];
  registry.onChildActivity((parentRunId, items) => {
    rosters.push({ parentRunId, items });
  });
  return { rosters };
}

/** Every stream whose follow-up queue reports input sent from this call on. */
export function recordFollowUpsSent(
  session: Pick<SessionHandle, 'followUps'>,
): { readonly sent: RunId[] } {
  const sent: RunId[] = [];
  session.followUps.onSent((runId) => sent.push(runId));
  return { sent };
}

/** Every event a run trace emits from this call on. */
export function recordTraceEvents(trace: AgentTrace): {
  readonly events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  trace.subscribe((event) => events.push(event));
  return { events };
}

export function traceEventsOfType<T extends AgentEvent['type']>(
  events: readonly AgentEvent[],
  type: T,
): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: T }> => event.type === type,
  );
}

/**
 * Let every reader of a session's plane (`events.all`, the fold fiber)
 * deliver what was published before this call: the readers run on the
 * process runtime's scheduler, which drains on a macrotask.
 */
export async function settleSessionEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** The events (or drafts) of one arm. */
export function eventsOfType<
  E extends { readonly type: string },
  T extends E['type'],
>(events: readonly E[], type: T): Array<Extract<E, { type: T }>> {
  return events.filter(
    (event): event is Extract<E, { type: T }> => event.type === type,
  );
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
    { runId: string; settle: (result: PlanApprovalResult) => void }
  >();
  const pendingProposals = new Map<
    string,
    { runId: string; settle: (result: ProposalResult) => void }
  >();
  const pendingRetries = new Map<
    string,
    { runId: string; settle: (result: RetryResult) => void }
  >();
  const pendingBashes = new Map<
    string,
    { runId?: string; settle: (result: BashSettlement) => void }
  >();
  const pendingUserQuestions = new Map<
    string,
    { runId?: string; settle: (result: UserQuestionSettlement) => void }
  >();
  // Mirrors the host contract: interaction requests ensure the view is
  // open without switching the active tab (#8246).
  const revealRun = () => {
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
        payload: { runId: requestId },
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
      const runId = request.runId ?? '';
      revealRun();
      events.push({
        event: 'showBashPermission',
        payload: {
          requestId,
          command: request.command,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          allowBypass: true,
          runId,
        },
      });
      return new Promise((resolve) => {
        pendingBashes.set(requestId, {
          runId: request.runId ?? undefined,
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
          runId: request.runId,
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
          runId: request.runId,
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
        pendingRetries.set(request.runId, {
          runId: request.runId,
          settle: resolve,
        });
      });
    },
    askUserQuestion: (request) => {
      revealRun();
      events.push({
        event: 'showUserQuestion',
        payload: request,
      });
      return new Promise((resolve) => {
        pendingUserQuestions.set(request.requestId, {
          runId: request.runId || undefined,
          settle: resolve,
        });
      });
    },
    cancel: (selector = {}) => cancelWhere(selector),
    dispose: () => cancelWhere({}),
  };
  function cancelWhere(selector: HostInteractionCancelSelector): void {
    const match = (kind: ProgressPermissionKind, runId?: string) =>
      matchesCancelSelector(
        { kind, runId || undefined },
        selector,
      );
    for (const [requestId, pending] of pendingBashes) {
      if (!match('bash', pending.runId)) continue;
      pendingBashes.delete(requestId);
      events.push({
        event: 'resolveBashPermission',
        payload: { requestId },
      });
      pending.settle({ action: 'reject' });
    }
    for (const [requestId, pending] of pendingPlans) {
      if (!match('planApproval', pending.runId)) continue;
      pendingPlans.delete(requestId);
      events.push({
        event: 'resolvePlanApproval',
        payload: { requestId },
      });
      pending.settle({ action: 'reject' });
    }
    for (const [requestId, pending] of pendingProposals) {
      if (!match('proposal', pending.runId)) continue;
      pendingProposals.delete(requestId);
      events.push({
        event: 'resolveAgentProposal',
        payload: { requestId },
      });
      pending.settle({ action: 'reject' });
    }
    for (const [runId, pending] of pendingRetries) {
      if (!match('retry', pending.runId)) continue;
      pendingRetries.delete(runId);
      events.push({
        event: 'resolveRetryRequest',
        payload: { runId },
      });
      pending.settle({ action: 'cancel' });
    }
    for (const [requestId, pending] of pendingUserQuestions) {
      if (!match('userQuestion', pending.runId)) continue;
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
 * An isolated session for node tests, with the given host interactions
 * attached: run-scoped code that resolves `currentSession().interactions`
 * (plan approvals, proposals, retries) or `currentSession().approvals`
 * (bypass state, queues) reaches this session's owners. A session's facts are
 * read back with {@link recordSessionEvents}. Passing another session's
 * `SessionHostInteractions` makes it this session's owner too, so a
 * recording host can be shared across the sessions of one test.
 */
export function sessionWithInteractions(
  interactions:
    | HostInteractions
    | SessionHostInteractions
    | Pick<SessionHostInteractions, 'emit'>
    | undefined,
): SessionHandle {
  const session = createTestSession();
  if (interactions instanceof SessionHostInteractions) {
    Object.assign(session, {
      interactions,
      approvals: createSessionApprovals(interactions),
    });
    return session;
  }
  if (interactions) {
    session.interactions.use(
      'cancel' in interactions
        ? interactions
        : { ...interactions, cancel: () => {} },
    );
  }
  return session;
}

/**
 * The `RunScope` a flow-services fixture must carry, since nodes read run
 * identity from `services.runScope`. Pass the same object to
 * {@link withTestRunContext} so the ambient context and the services bag name
 * one scope, as production does.
 */
export function testRunScope(
  runId: string,
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
    runId as RunId,
    runId: 'deadbeef' as RunId,
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
    permission: {
      requestId: `bash-${generateShortId()}`,
      command: request.command,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      allowBypass: true,
      runId: request.runId ?? '',
    },
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
