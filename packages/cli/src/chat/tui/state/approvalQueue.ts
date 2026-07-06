// Typed approval pipeline per docs/prds/cli-tui-ink/10-architecture.md §9.
//
// Each enqueued approval or human-input prompt becomes a `p-queue` task.
// When its turn comes up it publishes itself on the `currentApproval` signal
// and waits for the modal to call `decide(decision)`. Both pending outer
// Promises returned to callers and the currently-running task's `advance` are
// settled by `clearApprovals` so a session interrupt never leaves the queue
// blocked or the caller hanging.

import { signal, type Signal } from '@lit-labs/signals';
import PQueue from 'p-queue';

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

export type ApprovalBypassKind = 'bash' | 'toolEdit' | 'superYolo';
export type ApprovalQueueStatusKind = 'approval' | 'question' | 'request';

export type ApprovalPayload =
  | { kind: 'bash'; payload: BashPermission }
  | { kind: 'toolEdit'; request: ToolEditApprovalRequest }
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

const queue = new PQueue({ concurrency: 1 });
const clearListeners = new Set<() => void>();

interface ApprovalQueueItem {
  readonly payload: ApprovalPayload;
  readonly resolve: (decision: ApprovalDecision) => void;
  advance: (() => void) | undefined;
}

const pendingItems = new Set<ApprovalQueueItem>();
let currentItem: ApprovalQueueItem | undefined;

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  userMessage: 'Session interrupted.',
};

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
      return payload.payload.streamId || undefined;
    case 'toolEdit':
      return payload.request.streamId || undefined;
    default:
      return assertNever(payload, 'Unhandled approval payload kind');
  }
}

function syncApprovalStatus(): void {
  const depth = pendingItems.size;
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
  let item!: ApprovalQueueItem;
  const outer = new Promise<ApprovalDecision>((resolve) => {
    item = { payload, resolve, advance: undefined };
  });
  pendingItems.add(item);
  syncApprovalStatus();

  void queue
    .add(async () => {
      // Already cleared before scheduling: clearApprovals settled the caller.
      if (!pendingItems.has(item)) return;
      await new Promise<void>((advance) => {
        item.advance = advance;
        currentItem = item;
        try {
          options.onPresent?.();
        } catch {
          // Presentation hooks update the surrounding TUI only; approval
          // resolution must remain available even if focus activation fails.
        }
        CURRENT.set({
          payload,
          decide: (decision) => {
            if (!pendingItems.delete(item)) return;
            syncApprovalStatus();
            CURRENT.set(undefined);
            if (currentItem === item) currentItem = undefined;
            item.advance = undefined;
            item.resolve(decision);
            advance();
          },
        });
      });
    })
    .catch(() => {
      // p-queue rejects when `queue.clear()` drops the task. Settle the
      // outer promise so the requester (e.g. ToolEditApprovalHandler)
      // doesn't hang forever.
      if (pendingItems.delete(item)) {
        syncApprovalStatus();
        item.resolve(INTERRUPT);
      }
    });

  return outer;
}

/**
 * Hard-cancel: settle every pending resolver AND unblock the
 * currently-running task so the queue's single concurrency slot doesn't
 * stay permanently occupied.
 */
export function clearApprovals(): void {
  queue.clear();
  CURRENT.set(undefined);
  for (const listener of clearListeners) {
    try {
      listener();
    } catch {
      // Clear hooks invalidate surrounding async state only; approval
      // interruption must continue even if a hook fails.
    }
  }
  const items = [...pendingItems];
  pendingItems.clear();
  syncApprovalStatus();
  const activeItem = currentItem;
  currentItem = undefined;
  for (const item of items) {
    const advance = item.advance;
    item.advance = undefined;
    item.resolve(INTERRUPT);
    if (item === activeItem) advance?.();
  }
}

export function clearRetryApprovalsForStream(streamId: string): void {
  clearApprovalsWhere(
    (payload) =>
      payload.kind === 'retry' && payload.payload.streamId === streamId,
    INTERRUPT,
  );
}

export function clearApprovalsWhere(
  predicate: (payload: ApprovalPayload) => boolean,
  decision: ApprovalDecision = INTERRUPT,
): number {
  let cleared = 0;
  for (const item of [...pendingItems]) {
    if (!predicate(item.payload)) continue;
    if (!pendingItems.delete(item)) continue;
    cleared += 1;
    const advance = item.advance;
    item.advance = undefined;
    item.resolve(decision);
    if (currentItem === item) {
      currentItem = undefined;
      CURRENT.set(undefined);
      advance?.();
    }
  }
  if (cleared > 0) syncApprovalStatus();
  return cleared;
}
