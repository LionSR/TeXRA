// The TUI's request Surface (PRD one-fold-three-renderers, 9 and 10.1).
//
// Which requests are pending is a fold fact: `view.requests` holds every
// `request.opened` no `request.decided` has answered. This module owns only
// what the fold cannot: the presentation a host stages beside the fact (a
// tool edit's before and after text, a retry's personal-key lookup), the
// "decided here, not yet folded there" gap, and the jump-to-waiting order.
// A decision leaves as the arms `approvalDecisionArms` names: the run's
// `request.decide`, the `policy.set` a session bypass names, and the host
// capability a retry on the user's own key needs.

import { computed, signal } from '@lit-labs/signals';
import { Effect } from 'effect';

import { currentSession } from '@agent/runtime';
import { warn as logWarning } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import type {
  PermissionPayload,
  ProgressPermissionKind,
  RunId,
} from '@shared/schemas';
import {
  APPROVE_ALL_DELEGATED_WORK_ACTION,
  APPROVE_SESSION_ACTION,
  approvalDecisionArms,
  type SurfaceDecision,
} from '@shared/session/approvalDecision';
import type { HostRequest } from '@shared/session/hostRequest';
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
 * declares `unavailableHosts: ['cli']`), so no inquiry request is opened on
 * this host.
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

export interface PendingApproval {
  readonly payload: ApprovalPayload;
  readonly decide: (decision: SurfaceDecision) => void;
}

/** A pending `request.opened` fact, typed to {@link PendingApprovalKind}. */
type PendingApprovalFact = SessionView['requests'][number] & {
  readonly payload: Extract<PermissionPayload, { kind: PendingApprovalKind }>;
};

/**
 * The fold's pending requests under {@link PendingApprovalKind}. The
 * narrowing holds by the construction that type names; a fact outside it
 * reaches the `assertNever` payload switches, but not every reader (the row
 * label lookup would render an undefined label).
 */
function pendingApprovalFacts(
  view: SessionView,
): readonly PendingApprovalFact[] {
  return view.requests as readonly PendingApprovalFact[];
}

/** Each run's pending request kinds in commit order: the badge the session
 *  list and the workflow popup paint on its row. */
export const pendingApprovalKindsByRun = computed(() =>
  groupBy(
    pendingApprovalFacts(sessionView().get()),
    (request) => request.runId,
    (request) => request.payload.kind,
  ),
);

/** One request the user's attention is on: a fold fact, read once. */
interface AttentionRequest {
  readonly requestId: string;
  readonly runId: RunId;
  readonly kind: PendingApprovalKind;
  /** The fact's payload; a staged presentation replaces it when there is one. */
  readonly payload: PendingApprovalFact['payload'];
}

/**
 * What a host staged for one request beside the fact: the payload it
 * presents. A tool edit's preview arrives with the request; a retry's
 * key-availability lookup lands once it finishes, which is what keeps the
 * retry card off the screen until it can say whether `k` is offered.
 */
const stagedPresentations = signal<ReadonlyMap<string, ApprovalPayload>>(
  new Map(),
);

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

/**
 * The host capabilities a decision can name (`approvalDecisionArms`'s host
 * arms): the attached TUI host installs its executor for as long as it is
 * attached. A capability named while nothing is attached cannot be dropped
 * quietly — the request would stay pending with nobody working on it.
 */
let hostCapability: ((arm: HostRequest) => void) | undefined;

export function useHostCapability(
  execute: (arm: HostRequest) => void,
): () => void {
  hostCapability = execute;
  return () => {
    if (hostCapability === execute) hostCapability = undefined;
  };
}

/** Whether `payload` presents; a stager keys its entry by the same id. */
export function approvalPayloadRunId(
  payload: Pick<ApprovalPayload, 'data'>,
): RunId | undefined {
  return payload.data.runId || undefined;
}

/**
 * Every request awaiting the user, from the fold: the outstanding requests
 * in commit order. The promoted stream's requests lead; nothing is decided
 * or re-notified by a promotion. The status bar, the title, and the modal
 * all read this one list.
 */
export function attentionRequests(
  view: SessionView,
  lead = promoted.get(),
): readonly AttentionRequest[] {
  const requests = pendingApprovalFacts(view).map(
    (pending): AttentionRequest => ({
      requestId: pending.requestId,
      runId: pending.runId,
      kind: pending.payload.kind,
      payload: pending.payload,
    }),
  );
  if (!lead) return requests;
  const leads = (request: AttentionRequest): boolean =>
    request.runId === lead.runId || lead.includeRunIds.has(request.runId);
  return [...requests.filter(leads), ...requests.filter((r) => !leads(r))];
}

/** The payload the modal renders: the staged one when there is one, else the
 *  fact's, for the kinds that need nothing staged. */
function presentedPayload(
  request: AttentionRequest,
  staged: ReadonlyMap<string, ApprovalPayload>,
): ApprovalPayload | undefined {
  const entry = staged.get(request.requestId);
  if (entry) return entry;
  const payload = request.payload;
  switch (payload.kind) {
    case 'bash':
    case 'planApproval':
    case 'proposal':
    case 'userQuestion':
      return payload;
    case 'toolEdit':
    case 'retry':
      // Presentable only once the host stages its adornments.
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
  const staged = stagedPresentations.get();
  const done = decided.get();
  const candidates: Array<{
    readonly request: AttentionRequest;
    readonly payload: ApprovalPayload;
    readonly rank: number;
  }> = [];
  attentionRequests(view).forEach((request, rank) => {
    if (done.has(request.requestId)) return;
    const payload = presentedPayload(request, staged);
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

/** Staged presentations whose request the fold has listed at least once. A
 *  host stages a tool edit's preview before its `request.opened` commits, so
 *  "not listed" alone cannot mean "settled". */
const stagedSeenListed = new Set<string>();

/** Forget what this surface holds for requests the fold no longer lists: a
 *  settled request leaves with its staged presentation. */
function forgetSettledRequests(live: ReadonlySet<string>): void {
  const staged = stagedPresentations.get();
  for (const id of staged.keys()) if (live.has(id)) stagedSeenListed.add(id);
  const remaining = [...staged].filter(
    ([id]) => live.has(id) || !stagedSeenListed.has(id),
  );
  if (remaining.length !== staged.size) {
    stagedPresentations.set(new Map(remaining));
    for (const id of stagedSeenListed) {
      if (!live.has(id)) stagedSeenListed.delete(id);
    }
  }
  for (const id of presentedOrder.keys()) {
    if (!live.has(id)) presentedOrder.delete(id);
  }
}

function markDecided(requestId: string): void {
  const view = sessionView().get();
  const live = new Set(
    attentionRequests(view).map((request) => request.requestId),
  );
  const next = new Set([...decided.get()].filter((id) => live.has(id)));
  next.add(requestId);
  decided.set(next);
  forgetSettledRequests(live);
}

/**
 * Publish the presentation a host prepared for one request: the payload the
 * modal renders from here on. A tool edit stages before its request opens
 * and a retry's key lookup lands after, so this takes either order; the
 * entry leaves when the fold drops the request it names.
 */
export function stagePresentation(payload: ApprovalPayload): void {
  stagedPresentations.set(
    new Map(stagedPresentations.get()).set(payload.data.requestId, payload),
  );
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

/**
 * Apply one decision: the arms the shared vocabulary names (PRD 8.2), in the
 * order it names them — the `policy.set` a session bypass implies before the
 * `request.decide` it precedes, and the host capability a retry on the
 * user's own key needs instead of a decision, since that host lands the
 * decision itself once the credential is in place.
 */
function decideRequest(
  request: AttentionRequest,
  payload: PermissionPayload,
  decision: SurfaceDecision,
): void {
  markDecided(request.requestId);
  const { runId } = request;
  const arms = approvalDecisionArms(payload, decision);
  const runtimeArms = arms.flatMap((arm) =>
    'runtime' in arm ? [arm.runtime] : [],
  );
  if (runtimeArms.length > 0) issue(runId, ...runtimeArms);
  for (const arm of arms) {
    if (!('host' in arm)) continue;
    if (!hostCapability) {
      logWarning(
        'cli.tui',
        `No attached host performs ${arm.host.kind}: request ${request.requestId} stays pending.`,
      );
      continue;
    }
    hostCapability(arm.host);
  }
  // Both approve-all actions on a proposal turn the run's delegated-work
  // bypass on, so the work already queued behind it follows.
  if (
    payload.kind === 'proposal' &&
    (decision.action === APPROVE_ALL_DELEGATED_WORK_ACTION ||
      decision.action === APPROVE_SESSION_ACTION)
  ) {
    approveQueuedDelegatedWorkForRun(runId);
  }
}

/** Approve every delegated request pending on `runId` once its bypass is
 *  on: the decisions the user's super-YOLO choice implied. */
function approveQueuedDelegatedWorkForRun(runId: RunId): void {
  const view = sessionView().get();
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
    decideRequest(request, request.payload, { action: 'approve' });
  }
}

/**
 * Decide one pending request by id, for a surface answer that is not the
 * modal's: the CLI policy's own answer for the kinds it settles without a
 * person, and the retry a stored credential lets this host take. A request
 * the fold no longer lists cannot be answered, and saying so is the point —
 * a decision dropped in silence reads as a run waiting on nobody.
 */
export function decidePendingRequest(
  requestId: string,
  decision: SurfaceDecision,
): void {
  const request = attentionRequests(sessionView().get()).find(
    (pending) => pending.requestId === requestId,
  );
  if (!request) {
    logWarning(
      'cli.tui',
      `Request ${requestId} is no longer pending: its ${decision.action} decision was not sent.`,
    );
    return;
  }
  decideRequest(request, request.payload, decision);
}

/** Forget every staged presentation and local decision: the Surface reset
 *  (`/clear`). The pending requests themselves are the fold's, closed by the
 *  runs they belong to. */
function resetApprovalSurface(): void {
  stagedPresentations.set(new Map());
  stagedSeenListed.clear();
  decided.set(new Set());
  promoted.set(undefined);
  presentedOrder.clear();
}

registerCliStateResetHook(resetApprovalSurface);
