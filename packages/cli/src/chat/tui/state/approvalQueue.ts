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
}

export interface PendingApproval {
  readonly payload: ApprovalPayload;
  readonly decide: (decision: ApprovalDecision) => void;
}

const CURRENT = signal<PendingApproval | undefined>(undefined);

export const currentApproval = CURRENT as Signal.State<
  PendingApproval | undefined
>;

const queue = new PQueue({ concurrency: 1 });

const pendingResolvers = new Set<(decision: ApprovalDecision) => void>();
let currentAdvance: (() => void) | undefined;

const INTERRUPT: ApprovalDecision = {
  accepted: false,
  userMessage: 'Session interrupted.',
};

export function enqueueApproval(
  payload: ApprovalPayload,
): Promise<ApprovalDecision> {
  let resolveOuter!: (decision: ApprovalDecision) => void;
  const outer = new Promise<ApprovalDecision>((resolve) => {
    resolveOuter = resolve;
  });
  pendingResolvers.add(resolveOuter);

  void queue
    .add(async () => {
      // Already cleared before scheduling — resolveOuter was settled
      // by clearApprovals; nothing more to do.
      if (!pendingResolvers.has(resolveOuter)) return;
      await new Promise<void>((advance) => {
        currentAdvance = advance;
        CURRENT.set({
          payload,
          decide: (decision) => {
            if (!pendingResolvers.delete(resolveOuter)) return;
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
  if (currentAdvance) {
    const advance = currentAdvance;
    currentAdvance = undefined;
    advance();
  }
}
