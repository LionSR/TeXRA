// The TUI's request surface.
//
// Which requests are pending is a session view fact: `view.requests` holds every
// `request.opened` no `request.decided` has answered. This module owns only
// what the session view cannot: the presentation a host stages beside the fact (a
// tool edit's before and after text), the "decided here, not yet applied
// there" gap, and the jump-to-waiting order.
// A decision leaves as the case `approvalDecisionArm` names: the run's
// `request.decide` (with the bypass a session-wide approval grants), or the
// host capability a retry on the user's own key needs.

import { computed, signal } from '@lit-labs/signals';
import { Cause, Effect, absurd } from 'effect';

import { withLogChannel } from '@texra-ai/harness/plugins';
import {
  attentionOf,
  type RequestPayload,
  type RequestKind,
  type RunId,
} from '@texra-ai/harness/schemas';
import {
  approvalDecisionArm,
  type SurfaceDecision,
} from '@texra/shared/session/surfaceDecision';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { ToolEditPreviewRead } from '@texra/controllers/approval/ToolEditApprovalController';

import { registerCliStateResetHook, sessionRunIds } from './cliState';
import { sessionView } from './sessionView';
import {
  appendLocalErrorTranscript,
  appendLocalRequestRefusal,
  reportRequestDefect,
} from './transcript';
import type { Session } from '@texra-ai/harness';
import type { ProcessRuntime } from '@texra-ai/harness/host';
import type { RuntimeCommand, SessionView } from '@texra-ai/harness/schemas';

interface TuiApprovalAdornments {
  /** What a tool edit's card shows: the preview staged for it, or why there
   *  is none to show. */
  readonly toolEdit: ToolEditPreviewRead;
}

/**
 * The kinds this surface presents: the harness's own, without a plugin's
 * request. The CLI does not offer the async inquiry flow (it shows no
 * inquiry panel, `texraPlugins`), and an inquiry another host opened
 * in a shared session is answered from its thread rather than from a modal
 * here, so {@link attentionRequests} leaves plugin requests out of this queue.
 */
export type PendingRequestKind = Exclude<RequestKind, 'plugin'>;

/**
 * The presented payload IS the wire {@link RequestPayload}, with the
 * TUI-only adornments above carried beside its `data`. Derivation is the
 * point: a kind added to the wire union appears here without an edit, so
 * every `switch` below and in the modal dispatcher stops compiling until the
 * TUI handles it.
 */
export type TuiRequest = {
  [K in PendingRequestKind]: Extract<RequestPayload, { kind: K }> &
    (K extends keyof TuiApprovalAdornments
      ? { readonly tui: TuiApprovalAdornments[K] }
      : { readonly tui?: never });
}[PendingRequestKind];

/** The two kinds their modals read by name. */
export type ToolEditTuiRequest = Extract<TuiRequest, { kind: 'toolEdit' }>;
export type RetryTuiRequest = Extract<TuiRequest, { kind: 'retry' }>;

/** Where a decision lands: the chat's session, here or in the service. */
export type SessionRequests = Pick<Session, 'request'>;

export interface PendingApproval {
  readonly payload: TuiRequest;
  /** Answer this request. Where requests land and the runtime come from the
   *  surface that renders the modal: this entry is a level of a module-level
   *  computed, so it has neither of its own to close over. */
  readonly decide: (
    requests: SessionRequests,
    runtime: ProcessRuntime,
    decision: SurfaceDecision,
  ) => void;
}

/** A pending `request.opened` fact, typed to {@link PendingRequestKind}. */
export type PendingApprovalFact = SessionView['requests'][number] & {
  readonly payload: Extract<RequestPayload, { kind: PendingRequestKind }>;
};

/** Each run's pending request kinds in commit order: the badge the session
 *  list and the workflow popup paint on its row. */
export const pendingApprovalKindsByRun = computed(
  () =>
    new Map(
      Array.from(
        Map.groupBy(attentionRequests.get(), (request) => request.runId),
        ([runId, requests]) => [runId, requests.map((request) => request.kind)],
      ),
    ),
);

/** One request the user's attention is on: a session view fact, read once. */
interface AttentionRequest {
  readonly requestId: string;
  readonly runId: RunId;
  readonly kind: PendingRequestKind;
  /** The fact's payload; a staged presentation replaces it when there is one. */
  readonly payload: PendingApprovalFact['payload'];
}

/**
 * What a host staged for one request beside the fact: the payload it
 * presents, a tool edit with its preview, which keeps the card off the
 * screen until the preview is read.
 */
const stagedPresentations = signal<ReadonlyMap<string, TuiRequest>>(new Map());

/** Decided on this surface; hidden until the session view drops the fact. */
const decided = signal<ReadonlySet<string>>(new Set());

/** Jump-to-waiting: the focused stream's requests lead the order. */
const promoted = signal<RunId | undefined>(undefined);

/**
 * The host capabilities a decision can name (`approvalDecisionArm`'s host
 * arms): the attached TUI host installs its executor for as long as it is
 * attached. A capability named while nothing is attached cannot be dropped
 * quietly — the request would stay pending with nobody working on it.
 */
let hostCapability: ((arm: HostCommand) => void) | undefined;

export function useHostCapability(
  execute: (arm: HostCommand) => void,
): () => void {
  hostCapability = execute;
  return () => {
    if (hostCapability === execute) hostCapability = undefined;
  };
}

/** Whether the promoted stream's requests lead `request`'s. */
function leads(request: { readonly runId: RunId }): boolean {
  return request.runId === promoted.get();
}

/** Drop each request-keyed entry whose request is no longer in `live`. */
export function pruneToLive(
  live: ReadonlySet<string>,
  ...keyed: ReadonlyArray<Set<string> | Map<string, unknown>>
): void {
  for (const entries of keyed) {
    for (const id of entries.keys()) if (!live.has(id)) entries.delete(id);
  }
}

/**
 * Every request awaiting the user, from the session view: the outstanding requests
 * in commit order, from the runs this chat owns. The promoted stream's requests lead; nothing is decided
 * or re-notified by a promotion. The status bar, the title, and the modal
 * all read this one list.
 */
export const attentionRequests = computed((): readonly AttentionRequest[] => {
  const included = sessionRunIds.get();
  const view = sessionView().get();
  // The session view lists every kind, including a plugin's request (an
  // inquiry) a persisted session carries from another host; this surface
  // renders none of those, so the narrowing is a filter rather than an
  // assertion. It renders only
  // what this window can answer (`attentionOf`, the rule every host reads):
  // not a stopped run's leftover (its modal would trap the keys `/resume`
  // needs), nor a request on a run another process holds.
  const requests = attentionOf(view)
    .requests.filter(
      (request): request is PendingApprovalFact =>
        included.has(request.runId) && request.payload.kind !== 'plugin',
    )
    .map((pending): AttentionRequest => ({
      requestId: pending.requestId,
      runId: pending.runId,
      kind: pending.payload.kind,
      payload: pending.payload,
    }));
  return [...requests.filter(leads), ...requests.filter((r) => !leads(r))];
});

/** The payload the modal renders: the staged one when there is one, else the
 *  fact's, for the kinds that need nothing staged. */
function presentedPayload(
  request: AttentionRequest,
  staged: ReadonlyMap<string, TuiRequest>,
): TuiRequest | undefined {
  const entry = staged.get(request.requestId);
  if (entry) return entry;
  const payload = request.payload;
  switch (payload.kind) {
    case 'bash':
    case 'planApproval':
    case 'proposal':
    case 'retry':
    case 'userQuestion':
      return payload;
    case 'toolEdit':
      // Presentable only once the host stages it with its preview.
      return undefined;
  }
  absurd(payload);
}

/** The requests in the order they became presentable (a `Set` keeps first
 *  insertion order): a request that only became showable now (a staged tool
 *  edit) joins behind the modal the user is already answering rather than
 *  displacing it. */
const presentedOrder = new Set<string>();

/** The entry the modal shows: the first pending request this surface can
 *  render and has not decided, in presentation order under the promoted
 *  stream's lead. */
export const currentApproval = computed<PendingApproval | undefined>(() => {
  const staged = stagedPresentations.get();
  const done = decided.get();
  const candidates: Array<{
    readonly request: AttentionRequest;
    readonly payload: TuiRequest;
  }> = [];
  for (const request of attentionRequests.get()) {
    if (done.has(request.requestId)) continue;
    const payload = presentedPayload(request, staged);
    if (!payload) continue;
    presentedOrder.add(request.requestId);
    candidates.push({ request, payload });
  }
  const order = new Map([...presentedOrder].map((id, index) => [id, index]));
  const orderOf = (request: AttentionRequest): number =>
    order.get(request.requestId) ?? 0;
  candidates.sort(
    (a, b) =>
      Number(leads(b.request)) - Number(leads(a.request)) ||
      orderOf(a.request) - orderOf(b.request),
  );
  const first = candidates[0];
  if (!first) return undefined;
  return {
    payload: first.payload,
    decide: (requests, runtime, decision) =>
      decideRequest(requests, runtime, first.request, first.payload, decision),
  };
});

/**
 * Stable-partition the pending requests so `runId`'s lead, then re-read
 * the head. Used by jump-to-waiting: focusing a session surfaces that
 * session's request immediately.
 */
export function promoteApprovalsForRun(runId: RunId): void {
  promoted.set(runId);
}

function markDecided(requestId: string): void {
  const live = new Set(
    attentionRequests.get().map((request) => request.requestId),
  );
  const next = new Set([...decided.get()].filter((id) => live.has(id)));
  next.add(requestId);
  decided.set(next);
  pruneToLive(live, presentedOrder);
}

/**
 * Publish the presentation a host prepared for one listed request: the
 * payload the modal renders from here on, until the host drops it.
 */
export function stagePresentation(payload: TuiRequest): void {
  stagedPresentations.set(
    new Map(stagedPresentations.get()).set(payload.data.requestId, payload),
  );
}

/** Drop what one request staged, once the view no longer lists it. */
export function dropPresentation(requestId: string): Effect.Effect<void> {
  return Effect.sync(() => {
    const staged = stagedPresentations.get();
    if (!staged.has(requestId)) return;
    const remaining = new Map(staged);
    remaining.delete(requestId);
    stagedPresentations.set(remaining);
    presentedOrder.delete(requestId);
  });
}

/** Put a request the user answered on this surface back in front of them:
 *  the answer did not land, and the request is still pending. */
export function reopenRequest(requestId: string): void {
  const next = new Set(decided.get());
  next.delete(requestId);
  decided.set(next);
}

/**
 * Issue the runtime request one decision names; a refusal reads in the
 * conversation and puts `requestId` back on this surface, since the
 * durable request it answered is still pending and nobody else will re-ask.
 */
function issue(
  requests: SessionRequests,
  runtime: ProcessRuntime,
  runId: RunId,
  requestId: string,
  request: RuntimeCommand,
): void {
  const reopen = (): void => reopenRequest(requestId);
  runtime.runFork(
    requests.request(request).pipe(
      Effect.match({
        onFailure: (error) => {
          reopen();
          appendLocalRequestRefusal(error, runId);
        },
        onSuccess: () => undefined,
      }),
      // `match` recovers only the typed refusal; a collaborator that rejects
      // defects, and fire-and-forget would leave it an unhandled rejection.
      // A pure interruption is teardown, not a failure to report.
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        // The durable request never recorded the decision; reopen it the
        // same way a typed refusal does, or `currentApproval` keeps
        // filtering it out and the run waits with no UI.
        reopen();
        return Effect.map(reportRequestDefect(cause), (message) =>
          appendLocalErrorTranscript(message, runId),
        );
      }),
    ),
  );
}

/**
 * Apply one decision: the case the shared vocabulary names, the
 * `request.decide`, or the host capability a retry on the user's own key
 * needs instead of a decision, since that host lands the decision itself
 * once the credential is in place.
 */
function decideRequest(
  requests: SessionRequests,
  runtime: ProcessRuntime,
  request: AttentionRequest,
  payload: RequestPayload,
  decision: SurfaceDecision,
): void {
  markDecided(request.requestId);
  const { runId } = request;
  const arm = approvalDecisionArm(payload, decision);
  if ('runtime' in arm)
    issue(requests, runtime, runId, request.requestId, arm.runtime);
  else if (hostCapability) hostCapability(arm.host);
  else
    runtime.runFork(
      Effect.logWarning(
        `No attached host performs ${arm.host.kind}: request ${request.requestId} stays pending.`,
      ).pipe(withLogChannel('cli.tui')),
    );
}

/** Forget every staged presentation and local decision: the Surface reset
 *  (`/clear`). The pending requests themselves are the session view's, closed by the
 *  runs they belong to. */
function resetApprovalSurface(): void {
  stagedPresentations.set(new Map());
  decided.set(new Set());
  promoted.set(undefined);
  presentedOrder.clear();
}

registerCliStateResetHook(resetApprovalSurface);
