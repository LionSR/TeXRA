// The TUI's approval Surface (PRD one-fold-three-renderers, 9 and 10.1).
//
// Which requests are pending is a fold fact: `view.approvals` holds every
// `approval.requested` the runtime has not resolved. This module owns only
// what the fold cannot: the presentation payload a host hook hands over
// beside the fact (a tool edit's before and after text, a retry's
// personal-key lookup), the settle latch of the two kinds the host still
// answers through its hook (tool edit, retry), the "decided here, not yet
// resolved there" gap, and the jump-to-waiting order.
// Every other decision is a `decision.*` runtime request; the runtime settles
// its pending set and publishes `approval.resolved`, which the fold drops.

import { computed, signal } from '@lit-labs/signals';
import { Effect } from 'effect';

import { currentSession } from '@agent/runtime';
import { USER_QUESTION_SKIPPED_FEEDBACK } from '@cli/runtime/userQuestionAnswer';
import { effectRuntime } from '@platform/processRuntime';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { QuotaFallbackRouteId } from '@shared/quotaFallbackRoutes';
import type {
  ApprovalDecision as SharedApprovalDecision,
  PermissionPayload,
  PlanApprovalAction,
  ProgressPermissionKind,
  RunId,
} from '@shared/schemas';
import {
  APPROVE_ALL_DELEGATED_WORK_ACTION,
  APPROVE_SESSION_ACTION,
  approvalDecisionArms,
  type PermissionDecision,
  sessionBypassRequest,
} from '@shared/session/approvalDecision';
import type { SessionView } from '@shared/session/sessionView';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { assertNever, groupBy } from '@utils/core';

import { registerCliStateResetHook } from './cliState';
import { sessionView } from './sessionView';
import { appendLocalRequestRefusal } from './transcript';

interface TuiApprovalAdornments {
  readonly toolEdit: {
    readonly originalContent: string;
    readonly proposedContent: string;
  };
  readonly retry: {
    readonly personalApiKeyAvailable?: boolean;
    readonly missingPersonalApiKeyMessage?: string;
  };
}

/**
 * The kinds this surface presents: the wire vocabulary without the external
 * inquiry. The CLI does not offer the async inquiry flow (the inquiry tool
 * declares `unavailableHosts: ['cli']`), and an inquiry is a durable thread,
 * never an `approval.requested` fact: only a `SettledInteractionKind` request
 * publishes one, and that union has no `externalInquiry`.
 */
export type PendingApprovalKind = Exclude<
  ProgressPermissionKind,
  'externalInquiry'
>;

/**
 * The presented payload IS the wire {@link PermissionPayload}, with the
 * TUI-only adornments above carried beside its `data`. Derivation is the
 * point: a kind added to the wire union appears here without an edit, so
 * every `switch` below and in the modal dispatcher stops compiling until the
 * TUI handles it.
 */
export type ApprovalPayload = {
  [K in PendingApprovalKind]: Extract<PermissionPayload, { kind: K }> &
    (K extends keyof TuiApprovalAdornments
      ? { readonly tui: TuiApprovalAdornments[K] }
      : { readonly tui?: never });
}[PendingApprovalKind];

/** The two arms modals read adornments from. */
export type ToolEditApprovalPayload = Extract<
  ApprovalPayload,
  { kind: 'toolEdit' }
>;
export type RetryApprovalPayload = Extract<ApprovalPayload, { kind: 'retry' }>;

/**
 * The TUI decision = the host-neutral {@link SharedApprovalDecision}
 * (accepted / userMessage / userQuestionAnswers) plus the CLI-only session
 * bypass + credential mode applied before accepting.
 */
export interface ApprovalDecision extends Readonly<SharedApprovalDecision> {
  /** Queue or prompt lifecycle failure, never text entered by the user. */
  readonly rejectionCause?: string;
  /** Automatic policy denial, never text entered by the user. */
  readonly rejectionReason?: string;
  /** Session bypass to activate before accepting this approval. */
  readonly bypass?: ApprovalBypassKind;
  /** Turn off the matching quota-fallback preference before accepting. */
  readonly disableQuotaRoute?: QuotaFallbackRouteId;
  /** Plan-only approval action when plain approve/reject is not specific enough. */
  readonly planAction?: Extract<PlanApprovalAction, 'approve_and_goal'>;
  /** Run-as-goal only: extend automatic commands to edits and delegated work. */
  readonly goalAutoApproveAll?: true;
}

export interface PendingApproval {
  readonly payload: ApprovalPayload;
  readonly decide: (decision: ApprovalDecision) => void;
}

/** A pending `approval.requested` fact, typed to {@link PendingApprovalKind}. */
type PendingApprovalFact = SessionView['approvals'][number] & {
  readonly payload: Extract<PermissionPayload, { kind: PendingApprovalKind }>;
};

/**
 * The fold's pending approvals under {@link PendingApprovalKind}. The
 * narrowing holds by the construction that type names; a fact outside it
 * fails loudly at the exhaustive kind switches that read these.
 */
function pendingApprovalFacts(
  view: SessionView,
): readonly PendingApprovalFact[] {
  return view.approvals as readonly PendingApprovalFact[];
}

/** Each run's pending approval kinds in commit order: the badge the session
 *  list and the workflow popup paint on its row. */
export const pendingApprovalKindsByRun = computed(() =>
  groupBy(
    pendingApprovalFacts(sessionView().get()),
    (approval) => approval.runId,
    (approval) => approval.payload.kind,
  ),
);

/** One request the user's attention is on: a fold fact, read once. */
interface AttentionRequest {
  readonly requestId: string;
  readonly runId: RunId;
  readonly kind: PendingApprovalKind;
  /** The fact's payload; the host payload replaces it when presented. */
  readonly payload: PendingApprovalFact['payload'];
}

/**
 * What a host hook holds for one request beside the fact: the payload it
 * presents, and for the hook-settled kinds the latch its promise waits on.
 * A retry enters unpresentable (its keychain lookup runs first) and presents
 * once prepared; a `decided` entry stays until its hook releases it.
 */
interface HostRequest {
  readonly payload: ApprovalPayload;
  readonly presentable: boolean;
  readonly settle: ((decision: ApprovalDecision) => void) | undefined;
  readonly preparation: AbortController | undefined;
  readonly owner: object | undefined;
}

const hostRequests = signal<ReadonlyMap<string, HostRequest>>(new Map());

/** Decided on this surface; hidden until the fold drops the fact. */
const decided = signal<ReadonlySet<string>>(new Set());

/** Jump-to-waiting: the focused stream's requests lead the order. */
const promoted = signal<
  | {
      readonly runId: RunId;
      readonly includeRunIds: ReadonlySet<RunId>;
    }
  | undefined
>(undefined);

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  rejectionCause: 'Session interrupted.',
};

/** Whether `payload` presents; a hook keys its host entry by the same id. */
export function approvalPayloadRunId(
  payload: Pick<ApprovalPayload, 'data'>,
): RunId | undefined {
  return payload.data.runId || undefined;
}

/**
 * Every request awaiting the user, from the fold: the outstanding approvals
 * in commit order. The promoted stream's requests lead; nothing is settled,
 * resolved, or re-notified by a promotion. The status bar, the title, and
 * the modal all read this one list.
 */
export function attentionRequests(
  view: SessionView,
  lead = promoted.get(),
): readonly AttentionRequest[] {
  const requests = pendingApprovalFacts(view).map(
    (approval): AttentionRequest => ({
      requestId: approval.requestId,
      runId: approval.runId,
      kind: approval.payload.kind,
      payload: approval.payload,
    }),
  );
  if (!lead) return requests;
  const leads = (request: AttentionRequest): boolean =>
    request.runId === lead.runId || lead.includeRunIds.has(request.runId);
  return [...requests.filter(leads), ...requests.filter((r) => !leads(r))];
}

/** The payload the modal renders: the host's when presented, else the fact's. */
function presentedPayload(
  request: AttentionRequest,
  host: ReadonlyMap<string, HostRequest>,
): ApprovalPayload | undefined {
  const entry = host.get(request.requestId);
  if (entry) return entry.presentable ? entry.payload : undefined;
  const payload = request.payload;
  switch (payload.kind) {
    case 'bash':
    case 'planApproval':
    case 'proposal':
    case 'userQuestion':
      return payload;
    case 'toolEdit':
    case 'retry':
      // Presentable only through the hook that carries its adornments.
      return undefined;
  }
  assertNever(payload, 'Unhandled approval payload kind');
}

/** The order requests became presentable: a request that only became
 *  showable now (a retry after its key lookup) joins behind the modal the
 *  user is already answering rather than displacing it. */
const presentedOrder = new Map<string, number>();

/** The entry the modal shows: the first pending request this surface can
 *  render and has not decided, in presentation order under the promoted
 *  stream's lead. */
export const currentApproval = computed<PendingApproval | undefined>(() => {
  const view = sessionView().get();
  const host = hostRequests.get();
  const done = decided.get();
  const candidates: Array<{
    readonly request: AttentionRequest;
    readonly payload: ApprovalPayload;
    readonly rank: number;
  }> = [];
  attentionRequests(view).forEach((request, rank) => {
    if (done.has(request.requestId)) return;
    const payload = presentedPayload(request, host);
    if (!payload) return;
    if (!presentedOrder.has(request.requestId)) {
      presentedOrder.set(request.requestId, presentedOrder.size);
    }
    candidates.push({ request, payload, rank });
  });
  const lead = promoted.get();
  const leads = (request: AttentionRequest): boolean =>
    lead !== undefined &&
    (request.runId === lead.runId || lead.includeRunIds.has(request.runId));
  candidates.sort((a, b) => {
    const leadDelta = Number(leads(b.request)) - Number(leads(a.request));
    if (leadDelta !== 0) return leadDelta;
    return (
      (presentedOrder.get(a.request.requestId) ?? a.rank) -
      (presentedOrder.get(b.request.requestId) ?? b.rank)
    );
  });
  const first = candidates[0];
  if (!first) return undefined;
  return {
    payload: first.payload,
    decide: (decision) => decideRequest(first.request, first.payload, decision),
  };
});

/**
 * Stable-partition the pending requests so `runId`'s lead, then re-read
 * the head. Used by jump-to-waiting: focusing a session surfaces that
 * session's request immediately. `includeRunIds` lets a composite surface
 * promote requests owned by the runs it presents, such as a workflow
 * popup's direct children.
 */
export function promoteApprovalsForRun(
  runId: RunId,
  options: { readonly includeRunIds?: ReadonlySet<RunId> } = {},
): void {
  promoted.set({
    runId,
    includeRunIds: options.includeRunIds ?? new Set(),
  });
}

function markDecided(requestId: string): void {
  const view = sessionView().get();
  const live = new Set(
    attentionRequests(view).map((request) => request.requestId),
  );
  const next = new Set([...decided.get()].filter((id) => live.has(id)));
  next.add(requestId);
  decided.set(next);
  for (const id of presentedOrder.keys()) {
    if (!live.has(id)) presentedOrder.delete(id);
  }
}

function updateHost(
  mutate: (
    previous: ReadonlyMap<string, HostRequest>,
  ) => ReadonlyMap<string, HostRequest>,
): void {
  hostRequests.set(mutate(hostRequests.get()));
}

/** A hook-settled request leaves the surface with its decision. */
function settleHost(
  requestId: string,
  decision: ApprovalDecision,
  options: { readonly cancelled?: boolean } = {},
): boolean {
  const entry = hostRequests.get().get(requestId);
  if (!entry) return false;
  if (options.cancelled) {
    entry.preparation?.abort(new Error('Approval request was cancelled.'));
    updateHost((previous) => {
      const next = new Map(previous);
      next.delete(requestId);
      return next;
    });
  }
  entry.settle?.(decision);
  return true;
}

/** Issue runtime requests in order; a refusal reads in the conversation. */
function issue(runId: RunId, ...requests: RuntimeRequest[]): void {
  const session = currentSession();
  void effectRuntime().runPromise(
    Effect.forEach(requests, (request) => session.requests.request(request), {
      discard: true,
    }).pipe(
      Effect.match({
        onFailure: (error) => appendLocalRequestRefusal(error, runId),
        onSuccess: () => undefined,
      }),
    ),
  );
}

/** The runtime requests `arms` names, in the order they name them. */
function issueArms(
  runId: RunId,
  arms: readonly { readonly runtime: RuntimeRequest }[],
): void {
  issue(runId, ...arms.map((arm) => arm.runtime));
}

/**
 * The TUI decision in the shared vocabulary's terms: the bag the modals hand
 * over is host-neutral plus the bypass the card named, and a bypass on an
 * accepted decision IS one of that vocabulary's actions. A refusal's
 * provenance (queue failure, policy denial, typed text) collapses into the
 * one `feedback` string the protocol carries.
 */
function rejectDecision(decision: ApprovalDecision): {
  readonly action: 'reject';
  readonly feedback: string | undefined;
} {
  const { rejectionCause, rejectionReason, userMessage } = decision;
  return {
    action: 'reject',
    feedback: rejectionCause ?? rejectionReason ?? userMessage,
  };
}

function bashDecision(decision: ApprovalDecision): PermissionDecision<'bash'> {
  if (!decision.accepted) return rejectDecision(decision);
  return {
    action: decision.bypass === 'bash' ? APPROVE_SESSION_ACTION : 'approve',
  };
}

function proposalDecision(
  decision: ApprovalDecision,
): PermissionDecision<'proposal'> {
  if (!decision.accepted) return rejectDecision(decision);
  return {
    action:
      decision.bypass === 'superYolo'
        ? APPROVE_ALL_DELEGATED_WORK_ACTION
        : 'approve',
  };
}

function planDecision(
  decision: ApprovalDecision,
): PermissionDecision<'planApproval'> {
  if (!decision.accepted) return rejectDecision(decision);
  if (decision.planAction === 'approve_and_goal') {
    return {
      action: 'approve_and_goal',
      autoApproveAll: decision.goalAutoApproveAll,
    };
  }
  return { action: 'approve' };
}

function userQuestionDecision(
  decision: ApprovalDecision,
): PermissionDecision<'userQuestion'> {
  if (decision.accepted && decision.userQuestionAnswers) {
    return { action: 'submit', answers: decision.userQuestionAnswers };
  }
  if (decision.rejectionCause !== undefined) return rejectDecision(decision);
  return {
    action: 'skip',
    feedback: decision.userMessage || USER_QUESTION_SKIPPED_FEEDBACK,
  };
}

/**
 * Apply one decision: the three kinds a host hook answers resolve their
 * latch, the rest become the `decision.*` requests the shared vocabulary
 * names (PRD 8.2), each preceded by the `policy.set` the modal's bypass
 * choice names.
 */
function decideRequest(
  request: AttentionRequest,
  payload: ApprovalPayload,
  decision: ApprovalDecision,
): void {
  markDecided(request.requestId);
  const { runId } = request;
  switch (payload.kind) {
    case 'toolEdit':
    case 'retry':
      if (decision.accepted && decision.bypass === 'toolEdit') {
        issue(runId, sessionBypassRequest(runId, 'toolEdit'));
      }
      settleHost(request.requestId, decision);
      return;
    case 'bash':
      issueArms(
        runId,
        approvalDecisionArms<'bash'>(payload, bashDecision(decision)),
      );
      return;
    case 'planApproval':
      issueArms(
        runId,
        approvalDecisionArms<'planApproval'>(payload, planDecision(decision)),
      );
      return;
    case 'proposal':
      issueArms(
        runId,
        approvalDecisionArms<'proposal'>(payload, proposalDecision(decision)),
      );
      if (decision.accepted && decision.bypass === 'superYolo') {
        approveQueuedDelegatedWorkForRun(runId);
      }
      return;
    case 'userQuestion':
      issueArms(
        runId,
        approvalDecisionArms<'userQuestion'>(
          payload,
          userQuestionDecision(decision),
        ),
      );
      return;
  }
  assertNever(payload, 'Unhandled approval payload kind');
}

/**
 * A host hook's hold on one request from before it can be shown until the
 * hook has acted on the decision: the latch its promise awaits, the abort
 * that stops its preparation and commit work, and the presentation payload.
 * Every operation is a no-op once the entry has left the surface.
 */
export interface HostReservation {
  /** Resolves with the surface's decision: the modal's, an auto-decision
   *  passed to {@link settle}, a replacement, or a cancel. */
  readonly decided: Promise<ApprovalDecision>;
  /** Aborts when the entry is cancelled or replaced, never on its own
   *  decision, so work running for it stops at its next await. */
  readonly signal: AbortSignal;
  /** Publish the finished payload; the modal can show it from here on. */
  readonly present: (payload: ApprovalPayload) => void;
  /** Answer without showing a modal. */
  readonly settle: (decision: ApprovalDecision) => void;
  /** Hand the entry back once the decision has been acted on. */
  readonly release: () => void;
}

/**
 * Take a host entry for a request the runtime has published and this host's
 * hook will settle.
 */
export function reserveHostRequest(
  payload: ApprovalPayload,
  options: { readonly owner?: object; readonly presentable?: boolean } = {},
): HostReservation {
  const requestId = payload.data.requestId;
  const preparation = new AbortController();
  let decide!: (decision: ApprovalDecision) => void;
  const decidedPromise = new Promise<ApprovalDecision>((resolve) => {
    decide = resolve;
  });
  const entry: HostRequest = {
    payload,
    presentable: options.presentable ?? false,
    settle: decide,
    preparation,
    owner: options.owner,
  };
  updateHost((previous) => new Map(previous).set(requestId, entry));
  const live = (): boolean =>
    hostRequests.get().get(requestId)?.settle === decide;
  return {
    decided: decidedPromise,
    signal: preparation.signal,
    present: (presented) => {
      if (!live()) return;
      updateHost((previous) =>
        new Map(previous).set(requestId, {
          ...entry,
          payload: presented,
          presentable: true,
        }),
      );
    },
    settle: (decision) => {
      if (!live()) return;
      markDecided(requestId);
      decide(decision);
    },
    release: () => {
      if (!live()) return;
      updateHost((previous) => {
        const next = new Map(previous);
        next.delete(requestId);
        return next;
      });
    },
  };
}

/**
 * Settle the host entries `predicate` selects with `decision`, aborting their
 * work. The runtime's own pending set is not touched: cancelling a runtime
 * request is `session.interactions.cancel(selector)`, which calls back into
 * the host's `cancel` hook, which is where this runs.
 */
export function settleHostRequestsWhere(
  predicate: (payload: ApprovalPayload, owner: object | undefined) => boolean,
  decision: ApprovalDecision = INTERRUPT,
): number {
  let count = 0;
  for (const [requestId, entry] of hostRequests.get()) {
    if (!predicate(entry.payload, entry.owner)) continue;
    if (settleHost(requestId, decision, { cancelled: true })) count += 1;
  }
  return count;
}

/** Approve every delegated request pending on `runId` once its bypass is
 *  on: the decisions the user's super-YOLO choice implied. */
function approveQueuedDelegatedWorkForRun(runId: RunId): void {
  const view = sessionView().get();
  const host = hostRequests.get();
  const done = decided.get();
  for (const request of attentionRequests(view)) {
    if (request.runId !== runId || done.has(request.requestId)) continue;
    if (
      request.kind !== 'proposal' &&
      request.kind !== 'toolEdit' &&
      request.kind !== 'bash'
    ) {
      continue;
    }
    const payload = presentedPayload(request, host);
    if (!payload) continue;
    decideRequest(request, payload, { accepted: true });
  }
}

/** Forget every host entry and decision latch: the Surface reset (`/clear`). */
function resetApprovalSurface(): void {
  settleHostRequestsWhere(() => true);
  hostRequests.set(new Map());
  decided.set(new Set());
  promoted.set(undefined);
  presentedOrder.clear();
}

registerCliStateResetHook(resetApprovalSurface);
