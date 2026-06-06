// Typed approval pipeline per docs/prd/cli-tui-ink/10-architecture.md §9.
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

import { assertNever } from '../assertNever';

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
  /** Plan-only approval action when plain approve/reject is not specific enough. */
  readonly planAction?: Extract<PlanApprovalAction, 'approve_and_odyssey'>;
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

const pendingPayloads = new Map<
  (decision: ApprovalDecision) => void,
  ApprovalPayload
>();
let currentAdvance: (() => void) | undefined;

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  userMessage: 'Session interrupted.',
};

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
  const depth = pendingPayloads.size;
  STATUS.set({
    depth,
    kind:
      depth === 0
        ? 'approval'
        : approvalQueueStatusKind(pendingPayloads.values()),
  });
}

export function enqueueApproval(
  payload: ApprovalPayload,
  options: EnqueueApprovalOptions = {},
): Promise<ApprovalDecision> {
  let resolveOuter!: (decision: ApprovalDecision) => void;
  const outer = new Promise<ApprovalDecision>((resolve) => {
    resolveOuter = resolve;
  });
  pendingPayloads.set(resolveOuter, payload);
  syncApprovalStatus();

  void queue
    .add(async () => {
      // Already cleared before scheduling — resolveOuter was settled
      // by clearApprovals; nothing more to do.
      if (!pendingPayloads.has(resolveOuter)) return;
      await new Promise<void>((advance) => {
        currentAdvance = advance;
        try {
          options.onPresent?.();
        } catch {
          // Presentation hooks update the surrounding TUI only; approval
          // resolution must remain available even if focus activation fails.
        }
        CURRENT.set({
          payload,
          decide: (decision) => {
            if (!pendingPayloads.delete(resolveOuter)) return;
            syncApprovalStatus();
            CURRENT.set(undefined);
            currentAdvance = undefined;
            resolveOuter(decision);
            advance();
          },
        });
      });
    })
    .catch(() => {
      // p-queue rejects when `queue.clear()` drops the task. Settle the
      // outer promise so the requester (e.g. ToolEditApprovalHandler)
      // doesn't hang forever.
      if (pendingPayloads.delete(resolveOuter)) {
        syncApprovalStatus();
        resolveOuter(INTERRUPT);
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
  const pendingResolves = [...pendingPayloads.keys()];
  pendingPayloads.clear();
  syncApprovalStatus();
  for (const resolve of pendingResolves) resolve(INTERRUPT);
  if (currentAdvance) {
    const advance = currentAdvance;
    currentAdvance = undefined;
    advance();
  }
}
