// Typed approval pipeline per docs/prds/cli-tui-ink/10-architecture.md §9.
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

export type ApprovalPayload =
  | { kind: 'bash'; payload: BashPermission }
  | { kind: 'toolEdit'; payload: ToolEditApprovalRequest }
  | { kind: 'plan'; payload: PlanApprovalPermission }
  | { kind: 'proposal'; payload: AgentProposalPermission }
  | { kind: 'retry'; payload: RetryPermission }
  | { kind: 'externalInquiry'; payload: ExternalInquiryPermission }
  | { kind: 'userQuestion'; payload: UserQuestionPermission };

/**
 * The TUI decision = the host-neutral {@link SharedApprovalDecision}
 * (accepted / userMessage / userQuestionAnswers) plus the CLI-only session
 * bypass + credential mode applied before accepting. See
 * docs/proposals/tui-extension-sharing.md (Rung 1).
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

const CURRENT = signal<PendingApproval | undefined>(undefined);
const STATUS = signal<ApprovalQueueStatus>({ depth: 0, kind: 'approval' });

export const currentApproval = CURRENT as Signal.State<
  PendingApproval | undefined
>;
export const approvalQueueStatus = STATUS as Signal.State<ApprovalQueueStatus>;

const clearListeners = new Set<() => void>();

interface ApprovalQueueItem {
  readonly payload: ApprovalPayload;
  readonly resolve: (decision: ApprovalDecision) => void;
  readonly onPresent?: () => void;
}

const pendingItems: ApprovalQueueItem[] = [];

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  userMessage: 'Session interrupted.',
};

function presentForeground(): void {
  const item = pendingItems[0];
  if (!item || CURRENT.get()) return;

  try {
    item.onPresent?.();
  } catch {
    // Presentation hooks update surrounding TUI state only; approval
    // resolution must remain available even if focus activation fails.
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
  const removed: ApprovalQueueItem[] = [];
  const retained: ApprovalQueueItem[] = [];
  for (const item of pendingItems) {
    (predicate(item) ? removed : retained).push(item);
  }
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
