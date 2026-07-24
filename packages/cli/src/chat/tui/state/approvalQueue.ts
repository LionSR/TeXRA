// Typed approval pipeline per docs/prds/cli-tui-ink/2026-05-14-10-architecture.md §9.
//
// One explicit FIFO owns every pending approval or human-input prompt. The
// head is projected onto `currentApproval`; settling or removing it promotes
// the next entry. `clearApprovals` resolves every caller promise directly, so
// a session interrupt cannot leave a hidden scheduler task or queue slot
// blocked.

import { signal, type Signal } from '@lit-labs/signals';

import type { ApprovalBypassKind as HostApprovalBypassKind } from '@agent/runtime/HostInteractions';
import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type { StreamTabId } from '@shared/schemas';
import type {
  AgentProposalPermission,
  ApprovalDecision as SharedApprovalDecision,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalAction,
  PlanApprovalPermission,
  RetryPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { assertNever } from '@utils/core';

export type ApprovalBypassKind = HostApprovalBypassKind;
export type ApprovalQueueStatusKind = 'approval' | 'question' | 'request';

export type TuiRetryRequest = RetryPermission & {
  readonly personalApiKeyAvailable?: boolean;
  readonly missingPersonalApiKeyMessage?: string;
};

export type ApprovalPayload =
  | { kind: 'bash'; payload: BashPermission }
  | { kind: 'toolEdit'; payload: ToolEditApprovalRequest }
  | { kind: 'plan'; payload: PlanApprovalPermission }
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
  readonly apiMode?: CliApiMode;
  /** Turn off the "prefer ChatGPT subscription" preference before accepting,
   *  so a Codex usage-limit retry routes through the OpenAI API key. */
  readonly disableChatGptSubscription?: boolean;
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
  readonly onPresent?: () => void;
}

export type PendingApprovalKind = ApprovalPayload['kind'];

/** Stream key for payloads that carry no stream id — they are session-wide
 *  and belong to the root/main row, never a child row. */
export const ROOT_APPROVAL_STREAM_KEY = '';

/** One queued approval as seen by list surfaces: its owning stream key and
 *  payload kind, in global FIFO position. */
export interface PendingApprovalSummary {
  readonly streamKey: string;
  readonly kind: PendingApprovalKind;
}

const CURRENT = signal<PendingApproval | undefined>(undefined);
const STATUS = signal<ApprovalQueueStatus>({ depth: 0, kind: 'approval' });
const PENDING_SUMMARIES = signal<readonly PendingApprovalSummary[]>([]);

export const currentApproval = CURRENT as Signal.State<
  PendingApproval | undefined
>;
export const approvalQueueStatus = STATUS as Signal.State<ApprovalQueueStatus>;
/** Every pending approval's stream key and kind, in global FIFO order;
 *  stream-less payloads carry {@link ROOT_APPROVAL_STREAM_KEY}. Kept flat so
 *  callers that fold buckets together (e.g. root row + session-wide) can
 *  still order by first-to-present. Powers the session list's per-row
 *  "waiting on what" suffix. */
export const pendingApprovalSummaries = PENDING_SUMMARIES as Signal.State<
  readonly PendingApprovalSummary[]
>;

const clearListeners = new Set<() => void>();

interface ApprovalQueueItem {
  readonly payload: ApprovalPayload;
  readonly resolve: (decision: ApprovalDecision) => void;
  readonly onPresent?: () => void;
  /** Set once the item has been foregrounded, so re-presentations after a
   *  queue reorder cannot re-fire focus/notification side effects. */
  presented?: boolean;
}

const pendingItems: ApprovalQueueItem[] = [];

/** Split `items` into [matching, non-matching], each order-preserving. */
function partitionItems(
  items: readonly ApprovalQueueItem[],
  predicate: (item: ApprovalQueueItem) => boolean,
): [ApprovalQueueItem[], ApprovalQueueItem[]] {
  const matching: ApprovalQueueItem[] = [];
  const rest: ApprovalQueueItem[] = [];
  for (const item of items) {
    (predicate(item) ? matching : rest).push(item);
  }
  return [matching, rest];
}

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  userMessage: 'Session interrupted.',
};

function presentForeground(): void {
  const item = pendingItems[0];
  if (!item || CURRENT.get()) return;

  if (!item.presented) {
    item.presented = true;
    try {
      item.onPresent?.();
    } catch {
      // Presentation hooks update surrounding TUI state only; approval
      // resolution must remain available even if focus activation fails.
    }
  }
  if (pendingItems[0] !== item) return;

  CURRENT.set({
    payload: item.payload,
    decide: (decision) => {
      settleItems((candidate) => candidate === item, decision);
    },
  });
}

/**
 * Atomically remove and settle every matching item. The queue is partitioned
 * before any promise resolves or survivor is presented, so a bulk cancellation
 * cannot briefly foreground another item that the same operation removes.
 */
function settleItems(
  predicate: (item: ApprovalQueueItem) => boolean,
  decision: ApprovalDecision,
): number {
  const previousForeground = pendingItems[0];
  const [removed, retained] = partitionItems(pendingItems, predicate);
  if (removed.length === 0) return 0;

  pendingItems.splice(0, pendingItems.length, ...retained);
  const foregroundChanged = previousForeground !== pendingItems[0];
  if (foregroundChanged) CURRENT.set(undefined);
  syncApprovalStatus();
  for (const item of removed) item.resolve(decision);
  if (foregroundChanged) presentForeground();
  return removed.length;
}

export function onApprovalsCleared(listener: () => void): () => void {
  clearListeners.add(listener);
  return () => {
    clearListeners.delete(listener);
  };
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
    case 'plan':
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

function* pendingApprovalPayloads(): Iterable<ApprovalPayload> {
  for (const item of pendingItems) yield item.payload;
}

export function approvalPayloadStreamId(
  payload: ApprovalPayload,
): StreamTabId | undefined {
  switch (payload.kind) {
    case 'bash':
    case 'plan':
    case 'proposal':
    case 'retry':
    case 'externalInquiry':
    case 'userQuestion':
    case 'toolEdit':
      return payload.payload.streamId || undefined;
    default:
      return assertNever(payload, 'Unhandled approval payload kind');
  }
}

function syncApprovalStatus(): void {
  const depth = pendingItems.length;
  STATUS.set({
    depth,
    kind:
      depth === 0
        ? 'approval'
        : approvalQueueStatusKind(pendingApprovalPayloads()),
  });
  PENDING_SUMMARIES.set(
    pendingItems.map((item) => ({
      streamKey:
        approvalPayloadStreamId(item.payload) ?? ROOT_APPROVAL_STREAM_KEY,
      kind: item.payload.kind,
    })),
  );
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
  if (pendingItems.length < 2) return;
  const matches = (item: ApprovalQueueItem): boolean => {
    const itemStreamId = approvalPayloadStreamId(item.payload);
    return (
      itemStreamId === streamId ||
      (options.includeSessionWide === true && itemStreamId === undefined)
    );
  };
  const [promoted, rest] = partitionItems(pendingItems, matches);
  if (promoted.length === 0) return;
  const next = [...promoted, ...rest];
  // Already a contiguous prefix (a head-only check would miss matching items
  // still parked behind other streams) — nothing to reorder.
  if (next.every((item, index) => item === pendingItems[index])) return;
  const headChanged = pendingItems[0] !== next[0];
  pendingItems.splice(0, pendingItems.length, ...next);
  // Only re-project when the head actually moved; the current projection's
  // decide closure settles by item identity, so it stays valid either way.
  if (headChanged) {
    CURRENT.set(undefined);
    presentForeground();
  }
  syncApprovalStatus();
}

export function enqueueApproval(
  payload: ApprovalPayload,
  options: EnqueueApprovalOptions = {},
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    const wasEmpty = pendingItems.length === 0;
    pendingItems.push({ payload, resolve, onPresent: options.onPresent });
    syncApprovalStatus();
    if (wasEmpty) presentForeground();
  });
}

/**
 * Hard-cancel every pending resolver and clear the foreground projection.
 */
export function clearApprovals(): void {
  CURRENT.set(undefined);
  for (const listener of clearListeners) {
    try {
      listener();
    } catch {
      // Clear hooks invalidate surrounding async state only; approval
      // interruption must continue even if a hook fails.
    }
  }
  const items = pendingItems.splice(0);
  syncApprovalStatus();
  for (const item of items) {
    item.resolve(INTERRUPT);
  }
}

export function clearRetryApprovalsForStream(streamId: string): void {
  clearApprovalsWhere(
    (payload) =>
      payload.kind === 'retry' && payload.payload.streamId === streamId,
    INTERRUPT,
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
  return settleItems((item) => predicate(item.payload), decision);
}
