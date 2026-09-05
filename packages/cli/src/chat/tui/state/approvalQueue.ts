// The TUI's approval Surface (PRD one-fold-three-renderers, 9 and 10.1).
//
// Which requests are pending is a fold fact: `view.approvals` holds every
// `approval.requested` the runtime has not resolved, and `view.inquiries`
// every inquiry thread with its status. This module owns only what the fold
// cannot: the presentation payload a host hook hands over beside the fact (a
// tool edit's before and after text, a retry's personal-key lookup, an
// inquiry's full question), the settle latch of the three kinds the host
// still answers through its hook (tool edit, retry, external inquiry), the
// "decided here, not yet resolved there" gap, and the jump-to-waiting order.
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
  StreamTabId,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { assertNever } from '@utils/core';

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
 * The presented payload IS the wire {@link PermissionPayload}, with the
 * TUI-only adornments above carried beside its `data`. Derivation is the
 * point: a kind added to the wire union appears here without an edit, so
 * every `switch` below and in the modal dispatcher stops compiling until the
 * TUI handles it.
 */
export type ApprovalPayload = {
  [K in ProgressPermissionKind]: Extract<PermissionPayload, { kind: K }> &
    (K extends keyof TuiApprovalAdornments
      ? { readonly tui: TuiApprovalAdornments[K] }
      : { readonly tui?: never });
}[ProgressPermissionKind];

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

/** Derived from the wire contract, so every kind-keyed record here stays
 *  exhaustive against it. */
export type PendingApprovalKind = ProgressPermissionKind;

/** One request the user's attention is on: a fold fact, read once. */
export interface AttentionRequest {
  readonly requestId: string;
  readonly streamId: StreamTabId;
  readonly kind: PendingApprovalKind;
  /** The fact's payload; the host payload replaces it when presented. */
  readonly payload: PermissionPayload;
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
      readonly streamId: StreamTabId;
      readonly includeStreamIds: ReadonlySet<StreamTabId>;
    }
  | undefined
>(undefined);

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  rejectionCause: 'Session interrupted.',
};

/** Whether `payload` presents; a hook keys its host entry by the same id. */
export function approvalPayloadStreamId(
  payload: Pick<ApprovalPayload, 'data'>,
): StreamTabId | undefined {
  return payload.data.streamId || undefined;
}

function inquiryHostRequest(
  host: ReadonlyMap<string, HostRequest>,
  threadId: string,
): [string, HostRequest] | undefined {
  for (const entry of host) {
    const payload = entry[1].payload;
    if (
      payload.kind === 'externalInquiry' &&
      payload.data.threadId === threadId
    )
      return entry;
  }
  return undefined;
}

/**
 * Every request awaiting the user, from the fold: the outstanding approvals
 * in commit order, then the open inquiry threads. The promoted stream's
 * requests lead; nothing is settled, resolved, or re-notified by a
 * promotion. The status bar, the title, and the modal all read this one
 * list.
 */
export function attentionRequests(
  view: SessionView,
  host: ReadonlyMap<string, HostRequest> = hostRequests.get(),
  lead = promoted.get(),
): readonly AttentionRequest[] {
  const requests: AttentionRequest[] = view.approvals.map((approval) => ({
    requestId: approval.requestId,
    streamId: approval.streamId,
    kind: approval.payload.kind,
    payload: approval.payload,
  }));
  for (const thread of view.inquiries) {
    if (thread.status !== 'open') continue;
    const entry = inquiryHostRequest(host, thread.threadId);
    if (!entry) continue;
    requests.push({
      requestId: entry[0],
      streamId: entry[1].payload.data.streamId as StreamTabId,
      kind: 'externalInquiry',
      payload: entry[1].payload,
    });
  }
  if (!lead) return requests;
  const leads = (request: AttentionRequest): boolean =>
    request.streamId === lead.streamId ||
    lead.includeStreamIds.has(request.streamId);
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
    case 'externalInquiry':
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
  attentionRequests(view, host, promoted.get()).forEach((request, rank) => {
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
    (request.streamId === lead.streamId ||
      lead.includeStreamIds.has(request.streamId));
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
 * Stable-partition the pending requests so `streamId`'s lead, then re-read
 * the head. Used by jump-to-waiting: focusing a session surfaces that
 * session's request immediately. `includeStreamIds` lets a composite surface
 * promote requests owned by the streams it presents, such as a workflow
 * popup's direct children.
 */
export function promoteApprovalsForStream(
  streamId: StreamTabId,
  options: { readonly includeStreamIds?: ReadonlySet<StreamTabId> } = {},
): void {
  promoted.set({
    streamId,
    includeStreamIds: options.includeStreamIds ?? new Set(),
  });
}

function markDecided(requestId: string): void {
  const view = sessionView().get();
  const live = new Set(
    attentionRequests(view, hostRequests.get(), undefined).map(
      (request) => request.requestId,
    ),
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
function issue(streamId: StreamTabId, ...requests: RuntimeRequest[]): void {
  const session = currentSession();
  void effectRuntime().runPromise(
    Effect.forEach(requests, (request) => session.requests.request(request), {
      discard: true,
    }).pipe(
      Effect.match({
        onFailure: (error) => appendLocalRequestRefusal(error, streamId),
        onSuccess: () => undefined,
      }),
    ),
  );
}

function bypassRequest(
  streamId: StreamTabId,
  bypass: ApprovalBypassKind | undefined,
): RuntimeRequest[] {
  if (bypass === undefined) return [];
  return [
    {
      kind: 'policy.set',
      change: { field: 'bypass', streamId, bypass, enabled: true },
    },
  ];
}

function rejection(decision: ApprovalDecision): {
  readonly action: 'reject';
  readonly feedback: string | null;
} {
  return {
    action: 'reject',
    feedback:
      decision.rejectionCause ??
      decision.rejectionReason ??
      decision.userMessage ??
      null,
  };
}

type DecisionOf<K extends RuntimeRequest['kind']> =
  Extract<RuntimeRequest, { kind: K }> extends { decision: infer D }
    ? D
    : never;

function planDecision(decision: ApprovalDecision): DecisionOf<'decision.plan'> {
  if (!decision.accepted) return rejection(decision);
  if (decision.planAction === 'approve_and_goal') {
    return {
      action: 'approve_and_goal',
      autoApproveAll: decision.goalAutoApproveAll ?? null,
    };
  }
  return { action: 'approve' };
}

function userQuestionDecision(
  decision: ApprovalDecision,
): DecisionOf<'decision.userQuestion'> {
  if (decision.accepted && decision.userQuestionAnswers) {
    return { action: 'submit', answers: decision.userQuestionAnswers };
  }
  if (decision.rejectionCause !== undefined) return rejection(decision);
  return {
    action: 'skip',
    feedback: decision.userMessage || USER_QUESTION_SKIPPED_FEEDBACK,
  };
}

/**
 * Apply one decision: the hook-settled kinds resolve their latch, the rest
 * become `decision.*` requests (PRD 8.2), each preceded by the `policy.set`
 * the modal's bypass choice names.
 */
function decideRequest(
  request: AttentionRequest,
  payload: ApprovalPayload,
  decision: ApprovalDecision,
): void {
  markDecided(request.requestId);
  const { streamId } = request;
  const approvalId = request.requestId;
  switch (payload.kind) {
    case 'toolEdit':
    case 'retry':
    case 'externalInquiry':
      if (decision.accepted && decision.bypass === 'toolEdit') {
        issue(streamId, ...bypassRequest(streamId, decision.bypass));
      }
      settleHost(request.requestId, decision);
      return;
    case 'bash':
      issue(
        streamId,
        ...bypassRequest(
          streamId,
          decision.accepted ? decision.bypass : undefined,
        ),
        {
          kind: 'decision.bash',
          streamId,
          approvalId,
          decision: decision.accepted
            ? { action: 'approve' }
            : rejection(decision),
        },
      );
      return;
    case 'planApproval':
      issue(streamId, {
        kind: 'decision.plan',
        streamId,
        approvalId,
        decision: planDecision(decision),
      });
      return;
    case 'proposal': {
      const delegated = decision.accepted && decision.bypass === 'superYolo';
      issue(
        streamId,
        ...bypassRequest(
          streamId,
          decision.accepted ? decision.bypass : undefined,
        ),
        {
          kind: 'decision.proposal',
          streamId,
          approvalId,
          decision: decision.accepted
            ? { action: 'approve' }
            : rejection(decision),
        },
      );
      if (delegated) approveQueuedDelegatedWorkForStream(streamId);
      return;
    }
    case 'userQuestion':
      issue(streamId, {
        kind: 'decision.userQuestion',
        streamId,
        approvalId,
        decision: userQuestionDecision(decision),
      });
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
 * Take a host entry for a request the runtime has published (or, for an
 * inquiry, opened) and this host's hook will settle.
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

/** Approve every delegated request pending on `streamId` once its bypass is
 *  on: the decisions the user's super-YOLO choice implied. */
function approveQueuedDelegatedWorkForStream(streamId: StreamTabId): number {
  const view = sessionView().get();
  const host = hostRequests.get();
  const done = decided.get();
  let count = 0;
  for (const request of attentionRequests(view, host, undefined)) {
    if (request.streamId !== streamId || done.has(request.requestId)) continue;
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
    count += 1;
  }
  return count;
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
