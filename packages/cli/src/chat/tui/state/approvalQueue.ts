// Typed approval pipeline per docs/prds/cli-tui-ink/2026-05-14-10-architecture.md §9.
//
// One explicit FIFO owns every pending approval or human-input prompt. The
// head is projected onto `currentApproval`; settling or removing it promotes
// the next entry. `clearApprovals` resolves every caller promise directly, so
// a session interrupt cannot leave a hidden scheduler task or queue slot
// blocked.
//
// The queue is also the only owner of "this request is still live".
// `reserveApproval` takes a slot before the request can be shown (a retry has
// to read the keychain first) and keeps it after the decision while its owner
// commits, so one clear or cancel settles the pre-modal lookup, the modal, and
// the committing work through the same structure — there is no second registry
// to sweep and no staleness re-check at the call sites.

import { computed, signal, type Signal } from '@lit-labs/signals';

import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { StreamTabId } from '@shared/schemas';
import type {
  AgentProposalPermission,
  ApprovalDecision as SharedApprovalDecision,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalAction,
  PlanApprovalPermission,
  ProgressPermissionKind,
  RetryPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import type { ApiAccessMode } from '@shared/schemas/profileViewMessages';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { assertNever } from '@utils/core';

export type { ApprovalBypassKind };
export type ApprovalQueueStatusKind = 'approval' | 'question' | 'request';

export type TuiRetryRequest = RetryPermission & {
  readonly personalApiKeyAvailable?: boolean;
  readonly missingPersonalApiKeyMessage?: string;
};

export type ApprovalPayload =
  | { kind: 'bash'; payload: BashPermission }
  | { kind: 'toolEdit'; payload: ToolEditApprovalRequest }
  | { kind: 'planApproval'; payload: PlanApprovalPermission }
  | { kind: 'proposal'; payload: AgentProposalPermission }
  | {
      kind: 'retry';
      payload: TuiRetryRequest;
    }
  | { kind: 'externalInquiry'; payload: ExternalInquiryPermission }
  | { kind: 'userQuestion'; payload: UserQuestionPermission };

/**
 * The TUI decision = the host-neutral {@link SharedApprovalDecision}
 * (accepted / userMessage / userQuestionAnswers) plus the CLI-only session
 * bypass + credential mode applied before accepting. See
 * docs/proposals/2026-05-31-tui-extension-sharing.md (Rung 1).
 */
export interface ApprovalDecision extends Readonly<SharedApprovalDecision> {
  /** Session bypass to activate before accepting this approval. */
  readonly bypass?: ApprovalBypassKind;
  /** Credential mode to apply before accepting this approval. */
  readonly apiMode?: ApiAccessMode;
  /** Turn off the "prefer ChatGPT subscription" preference before accepting,
   *  so a Codex usage-limit retry routes through the OpenAI API key. */
  readonly disableChatGptSubscription?: boolean;
  /** Turn off the "Prefer Kimi Code" preference before accepting, so a Kimi
   *  Code usage-limit retry routes through the Moonshot open-platform API key. */
  readonly disableKimiCode?: boolean;
  /** Turn off the GLM Coding Plan toggle before accepting, so a GLM Coding
   *  Plan usage-limit retry routes through the regular GLM endpoint. */
  readonly disableGlmCodingPlan?: boolean;
  /** Plan-only approval action when plain approve/reject is not specific enough. */
  readonly planAction?: Extract<PlanApprovalAction, 'approve_and_goal'>;
}

export interface PendingApproval {
  readonly payload: ApprovalPayload;
  readonly decide: (decision: ApprovalDecision) => void;
}

export interface ApprovalQueueStatus {
  readonly depth: number;
  readonly kind: ApprovalQueueStatusKind;
}

export interface EnqueueApprovalOptions {
  /** Called with the payload as presented, once, when the entry becomes the
   *  foreground modal. */
  readonly onPresent?: (payload: ApprovalPayload) => void;
}

interface ReserveApprovalOptions extends EnqueueApprovalOptions {
  /** The host attachment this reservation belongs to. Hosts overlap while a
   *  previous run's detached children finish, so a detaching host must settle
   *  its own reservations without touching the live host's. */
  readonly owner?: object;
}

/** Derived from the wire contract, so the queue's payload kinds and every
 *  kind-keyed record here stay exhaustive against it. */
export type PendingApprovalKind = ProgressPermissionKind;

/** Stream key for payloads that carry no stream id — they are session-wide
 *  and belong to the root/main row, never a child row. */
export const ROOT_APPROVAL_STREAM_KEY = '';

/** One queued approval as seen by list surfaces: its owning stream key and
 *  payload kind, in global FIFO position. */
export interface PendingApprovalSummary {
  readonly streamKey: string;
  readonly kind: PendingApprovalKind;
}

const CURRENT: Signal.State<PendingApproval | undefined> = signal<
  PendingApproval | undefined
>(undefined);

export const currentApproval = CURRENT;

/**
 * `preparing` holds a slot for a request that cannot be shown yet: invisible
 * to the modal, the depth, and the summaries, but settleable and cancellable.
 * `pending` is a live request waiting for its turn at the modal. `committing`
 * is a decided reservation whose owner is still acting on the answer, so a
 * later cancel can still reach that work.
 */
type ApprovalQueuePhase = 'preparing' | 'pending' | 'committing';

interface ApprovalQueueItem {
  /** Mutable so a reservation can publish the finished request when it
   *  presents; every other entry keeps the payload it was queued with. */
  payload: ApprovalPayload;
  readonly resolve: (decision: ApprovalDecision) => void;
  readonly onPresent?: (payload: ApprovalPayload) => void;
  /** Reservations only. Aborted when the entry is cleared or replaced — never
   *  by its own decision — so preparation and commit work stops at its next
   *  await. */
  readonly preparation?: AbortController;
  /** Reservations only. The host attachment that took the slot. */
  readonly owner?: object;
  phase: ApprovalQueuePhase;
  /** Set once the item has been foregrounded, so re-presentations after a
   *  queue reorder cannot re-fire focus/notification side effects. */
  presented?: boolean;
}

/** The queue itself. Every mutation republishes a fresh array, so the
 *  projections below are derived rather than mirrored: there is no second
 *  write that can be forgotten or ordered wrongly. */
const QUEUE = signal<readonly ApprovalQueueItem[]>([]);

/** Entries the user can act on right now: a reservation is not a prompt
 *  before it presents, and no longer one once it is decided. */
const WAITING = computed(() =>
  QUEUE.get().filter((item) => item.phase === 'pending'),
);

export const approvalQueueStatus: Signal.Computed<ApprovalQueueStatus> =
  computed(() => {
    const waiting = WAITING.get();
    return {
      depth: waiting.length,
      kind:
        waiting.length === 0
          ? 'approval'
          : approvalQueueStatusKind(waiting.map((item) => item.payload)),
    };
  });

/** Every pending approval's stream key and kind, in global FIFO order;
 *  stream-less payloads carry {@link ROOT_APPROVAL_STREAM_KEY}. Kept flat so
 *  callers that fold buckets together (e.g. root row + session-wide) can
 *  still order by first-to-present. Powers the session list's per-row
 *  "waiting on what" suffix. */
export const pendingApprovalSummaries: Signal.Computed<
  readonly PendingApprovalSummary[]
> = computed(() =>
  WAITING.get().map((item) => ({
    streamKey:
      approvalPayloadStreamId(item.payload) ?? ROOT_APPROVAL_STREAM_KEY,
    kind: item.payload.kind,
  })),
);

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  userMessage: 'Session interrupted.',
};

/** The entry the modal shows: the first one waiting for a user decision. */
function foregroundItem(): ApprovalQueueItem | undefined {
  return QUEUE.get().find((item) => item.phase === 'pending');
}

function presentForeground(): void {
  const item = foregroundItem();
  if (!item || CURRENT.get()) return;

  if (!item.presented) {
    item.presented = true;
    try {
      item.onPresent?.(item.payload);
    } catch {
      // Presentation hooks update surrounding TUI state only; approval
      // resolution must remain available even if focus activation fails.
    }
  }
  if (foregroundItem() !== item) return;

  CURRENT.set({
    payload: item.payload,
    decide: (decision) => {
      settleItems((candidate) => candidate === item, decision);
    },
  });
}

/**
 * Apply one queue mutation and re-project the foreground from the result.
 * `settle` runs at the single point where the queue is already consistent and
 * the next modal has not been presented yet, so a bulk cancellation cannot
 * briefly foreground an item that the same operation removes.
 */
function updateQueue(
  mutate: () => readonly ApprovalQueueItem[],
  settle?: () => void,
): void {
  const previousForeground = foregroundItem();
  QUEUE.set(mutate());
  const foregroundChanged = previousForeground !== foregroundItem();
  if (foregroundChanged) CURRENT.set(undefined);
  settle?.();
  if (foregroundChanged) presentForeground();
}

/**
 * Settle every matching entry with `decision`. A cancelled settlement drops
 * each entry and aborts any reservation among them; an answered one keeps a
 * reservation's slot (as `committing`) until its owner releases it, so a
 * cancel arriving after the decision still reaches the work that decision
 * started.
 */
function settleItems(
  predicate: (item: ApprovalQueueItem) => boolean,
  decision: ApprovalDecision,
  options: { readonly cancelled?: boolean } = {},
): number {
  const matched = QUEUE.get().filter(predicate);
  if (matched.length === 0) return 0;
  const dropped = new Set(
    options.cancelled === true
      ? matched
      : matched.filter((item) => !item.preparation),
  );

  updateQueue(
    () => {
      for (const item of matched) {
        if (!dropped.has(item)) item.phase = 'committing';
      }
      return QUEUE.get().filter((item) => !dropped.has(item));
    },
    () => {
      for (const item of matched) {
        if (options.cancelled === true) {
          item.preparation?.abort(new Error('Approval request was cancelled.'));
        }
        item.resolve(decision);
      }
    },
  );
  return matched.length;
}

function statusKindForPayload(
  payload: ApprovalPayload,
): Exclude<ApprovalQueueStatusKind, 'request'> {
  switch (payload.kind) {
    case 'externalInquiry':
    case 'userQuestion':
      return 'question';
    case 'bash':
    case 'toolEdit':
    case 'planApproval':
    case 'proposal':
    case 'retry':
      return 'approval';
    default:
      return assertNever(payload, 'Unknown approval payload kind');
  }
}

function approvalQueueStatusKind(
  payloads: Iterable<ApprovalPayload>,
): ApprovalQueueStatusKind {
  let sawApproval = false;
  let sawQuestion = false;
  for (const payload of payloads) {
    const kind = statusKindForPayload(payload);
    sawApproval ||= kind === 'approval';
    sawQuestion ||= kind === 'question';
    if (sawApproval && sawQuestion) return 'request';
  }
  return sawQuestion ? 'question' : 'approval';
}

export function approvalPayloadStreamId(
  payload: ApprovalPayload,
): StreamTabId | undefined {
  // Every payload variant carries a `streamId` field; all resolve the same way.
  return payload.payload.streamId || undefined;
}

/**
 * Stable-partition the queue so `streamId`'s pending items lead, then
 * re-project the head. Settling matches by item identity, so a decision made
 * against the previous projection still resolves the right item; nothing is
 * settled, resolved, or (re-)notified by a promotion. Used by jump-to-waiting:
 * focusing a session surfaces that session's approval immediately.
 * `includeSessionWide` also promotes stream-less (session-wide) items — pass
 * it when promoting the root stream, whose row those items fold onto.
 */
export function promoteApprovalsForStream(
  streamId: StreamTabId,
  options: { readonly includeSessionWide?: boolean } = {},
): void {
  const items = QUEUE.get();
  if (items.length < 2) return;
  const matches = (item: ApprovalQueueItem): boolean => {
    const itemStreamId = approvalPayloadStreamId(item.payload);
    return (
      itemStreamId === streamId ||
      (options.includeSessionWide === true && itemStreamId === undefined)
    );
  };
  const promoted = items.filter(matches);
  if (promoted.length === 0) return;
  const next = [...promoted, ...items.filter((item) => !matches(item))];
  // Already a contiguous prefix (a head-only check would miss matching items
  // still parked behind other streams) — nothing to reorder.
  if (next.every((item, index) => item === items[index])) return;
  // The current projection's decide closure settles by item identity, so it
  // stays valid when the foreground entry keeps its place.
  updateQueue(() => next);
}

export function enqueueApproval(
  payload: ApprovalPayload,
  options: EnqueueApprovalOptions = {},
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    QUEUE.set([
      ...QUEUE.get(),
      {
        payload,
        resolve,
        onPresent: options.onPresent,
        phase: 'pending',
      },
    ]);
    presentForeground();
  });
}

/**
 * A queue entry held from before its request can be shown until its owner has
 * finished acting on the decision. Every operation is a no-op once the queue
 * has settled the entry from the other direction, which is what makes a
 * staleness check at the call site unnecessary.
 */
interface ApprovalReservation {
  /** Resolves once the queue answers this entry: its own modal decision, an
   *  auto-decision passed to {@link settle}, a replacement, or a clear. */
  readonly decided: Promise<ApprovalDecision>;
  /** Aborts when the entry is cleared or replaced, never on its own decision,
   *  so work running for the entry stops at its next await. */
  readonly signal: AbortSignal;
  /** Publish the finished payload and join the visible queue. */
  readonly present: (payload: ApprovalPayload) => void;
  /** Answer the entry without showing a modal. */
  readonly settle: (decision: ApprovalDecision) => void;
  /** Hand the slot back once the decision has been acted on. */
  readonly release: () => void;
}

/**
 * Take a queue slot for a request that is not ready to show yet.
 */
export function reserveApproval(
  payload: ApprovalPayload,
  options: ReserveApprovalOptions = {},
): ApprovalReservation {
  const preparation = new AbortController();
  let decide!: (decision: ApprovalDecision) => void;
  const decided = new Promise<ApprovalDecision>((resolve) => {
    decide = resolve;
  });
  const item: ApprovalQueueItem = {
    payload,
    resolve: decide,
    onPresent: options.onPresent,
    preparation,
    owner: options.owner,
    phase: 'preparing',
  };
  QUEUE.set([...QUEUE.get(), item]);

  return {
    decided,
    signal: preparation.signal,
    present: (presented) => {
      if (item.phase !== 'preparing' || !QUEUE.get().includes(item)) return;
      updateQueue(() => {
        item.payload = presented;
        item.phase = 'pending';
        // Enter the visible queue at its tail: the reservation held liveness,
        // not a place in line, so a request that only became showable now
        // cannot displace a modal the user is already answering.
        return [...QUEUE.get().filter((candidate) => candidate !== item), item];
      });
    },
    settle: (decision) => {
      settleItems((candidate) => candidate === item, decision);
    },
    release: () => {
      if (!QUEUE.get().includes(item)) return;
      updateQueue(() => QUEUE.get().filter((candidate) => candidate !== item));
    },
  };
}

/**
 * Hard-cancel every entry and clear the foreground projection.
 */
export function clearApprovals(): void {
  settleItems(() => true, INTERRUPT, { cancelled: true });
}

/**
 * Settle the reservations `owner` took, leaving every other entry alone. A host
 * detaches when the last execution it owns finishes, which can be after a newer
 * host has taken over the session, so this must not reach the newer host's
 * requests.
 */
export function clearApprovalsForOwner(owner: object): number {
  return settleItems((item) => item.owner === owner, INTERRUPT, {
    cancelled: true,
  });
}

/** Replace a retry only within the host attachment that owns it. */
export function clearRetryApprovalsForStream(
  streamId: string,
  owner: object,
): void {
  settleItems(
    (item) =>
      item.owner === owner &&
      item.payload.kind === 'retry' &&
      item.payload.payload.streamId === streamId,
    INTERRUPT,
    { cancelled: true },
  );
}

/** Approve delegated requests that were queued before stream bypass began. */
export function approveQueuedDelegatedWorkForStream(
  streamId: StreamTabId,
): number {
  return clearApprovalsWhere(
    (payload) =>
      approvalPayloadStreamId(payload) === streamId &&
      (payload.kind === 'proposal' ||
        payload.kind === 'toolEdit' ||
        payload.kind === 'bash'),
    { accepted: true },
  );
}

export function clearApprovalsWhere(
  predicate: (payload: ApprovalPayload) => boolean,
  decision: ApprovalDecision = INTERRUPT,
): number {
  return settleItems((item) => predicate(item.payload), decision, {
    cancelled: true,
  });
}
