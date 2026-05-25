// Typed approval pipeline per docs/prd/cli-tui-ink/10-architecture.md §9.
//
// Each enqueued approval becomes a `p-queue` task. When its turn comes up
// it publishes itself on the `currentApproval` signal and waits for the
// modal to call `decide(decision)`. Both `pendingResolvers` (outer Promise
// returned to the caller) and the currently-running task's `advance` are
// settled by `clearApprovals` so a session interrupt never leaves the
// queue blocked or the caller hanging.

import { signal, type Signal } from '@lit-labs/signals';
import PQueue from 'p-queue';

import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
  UserQuestionAnswers,
  UserQuestionPermission,
} from '@shared/schemas';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

export type ApprovalBypassKind = 'toolEdit' | 'superYolo';

export type ApprovalPayload =
  | { kind: 'bash'; payload: BashPermission }
  | { kind: 'toolEdit'; request: ToolEditApprovalRequest }
  | { kind: 'plan'; payload: PlanApprovalPermission }
  | { kind: 'proposal'; payload: AgentProposalPermission }
  | { kind: 'retry'; payload: RetryPermission }
  | { kind: 'externalInquiry'; payload: ExternalInquiryPermission }
  | { kind: 'userQuestion'; payload: UserQuestionPermission };

export interface ApprovalDecision {
  readonly accepted: boolean;
  /**
   * Free-text payload carried with the decision. For rejections this is the
   * user's `e`-reject-with-feedback note; for the ExternalInquiry kind on
   * accept, it's the answer the agent gets back.
   */
  readonly userMessage?: string;
  /** Structured answers for an AskUserQuestion request. */
  readonly userQuestionAnswers?: UserQuestionAnswers;
  /** Session bypass to activate before accepting this approval. */
  readonly bypass?: ApprovalBypassKind;
  /** Credential mode to apply before accepting this approval. */
  readonly apiMode?: CliApiMode;
}

export interface PendingApproval {
  readonly payload: ApprovalPayload;
  readonly decide: (decision: ApprovalDecision) => void;
}

export interface EnqueueApprovalOptions {
  readonly onPresent?: () => void;
}

const CURRENT = signal<PendingApproval | undefined>(undefined);
const DEPTH = signal<number>(0);

export const currentApproval = CURRENT as Signal.State<
  PendingApproval | undefined
>;
export const approvalQueueDepth = DEPTH as Signal.State<number>;

const queue = new PQueue({ concurrency: 1 });

const pendingResolvers = new Set<(decision: ApprovalDecision) => void>();
let currentAdvance: (() => void) | undefined;

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  userMessage: 'Session interrupted.',
};

function syncApprovalDepth(): void {
  DEPTH.set(pendingResolvers.size);
}

export function enqueueApproval(
  payload: ApprovalPayload,
  options: EnqueueApprovalOptions = {},
): Promise<ApprovalDecision> {
  let resolveOuter!: (decision: ApprovalDecision) => void;
  const outer = new Promise<ApprovalDecision>((resolve) => {
    resolveOuter = resolve;
  });
  pendingResolvers.add(resolveOuter);
  syncApprovalDepth();

  void queue
    .add(async () => {
      // Already cleared before scheduling — resolveOuter was settled
      // by clearApprovals; nothing more to do.
      if (!pendingResolvers.has(resolveOuter)) return;
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
            if (!pendingResolvers.delete(resolveOuter)) return;
            syncApprovalDepth();
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
      if (pendingResolvers.delete(resolveOuter)) {
        syncApprovalDepth();
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
  for (const resolve of [...pendingResolvers]) {
    pendingResolvers.delete(resolve);
    resolve(INTERRUPT);
  }
  syncApprovalDepth();
  if (currentAdvance) {
    const advance = currentAdvance;
    currentAdvance = undefined;
    advance();
  }
}
