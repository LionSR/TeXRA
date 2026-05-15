// Typed approval pipeline per docs/prd/cli-tui-ink/10-architecture.md §9.
//
// Pattern: each launcher constructs a typed payload from a runtime-host
// event and enqueues it on a `p-queue` with concurrency 1. The head item is
// mirrored onto the `currentApproval` signal so `<ApprovalModal>` can
// dispatch on its discriminant. When the modal resolves the head, the
// queue advances to the next.
//
// The original event resolvers are unchanged — the modal calls them on
// decide. Phase 1's free-text `askApproval` stderr prompt is replaced for
// every approval kind below; the legacy adapter still runs when `--tui`
// is off.

import { signal, type Signal } from '@lit-labs/signals';
import PQueue from 'p-queue';

import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
} from '@shared/schemas';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';

export type ApprovalPayload =
  | { kind: 'bash'; payload: BashPermission }
  | {
      kind: 'toolEdit';
      request: ToolEditApprovalRequest;
      resolve: (result: ToolEditApprovalResult) => void;
    }
  | { kind: 'plan'; payload: PlanApprovalPermission }
  | { kind: 'proposal'; payload: AgentProposalPermission }
  | { kind: 'retry'; payload: RetryPermission }
  | { kind: 'externalInquiry'; payload: ExternalInquiryPermission };

export interface ApprovalDecision {
  readonly accepted: boolean;
  /**
   * Free-text payload carried with the decision. For rejections this is the
   * user's `e`-reject-with-feedback note; for the External Inquiry kind on
   * accept, it's the answer the agent gets back.
   */
  readonly userMessage?: string;
}

/** Modal's reply primitive — `decide(decision)` advances the queue. */
export interface PendingApproval {
  readonly payload: ApprovalPayload;
  readonly decide: (decision: ApprovalDecision) => void;
}

const CURRENT = signal<PendingApproval | undefined>(undefined);

export const currentApproval = CURRENT as Signal.State<
  PendingApproval | undefined
>;

const queue = new PQueue({ concurrency: 1 });

/**
 * Enqueue an approval payload. Returns a Promise that resolves with the
 * user's decision once `<ApprovalModal>` dispatches it.
 */
export function enqueueApproval(
  payload: ApprovalPayload,
): Promise<ApprovalDecision> {
  return queue.add(async () => {
    return new Promise<ApprovalDecision>((resolve) => {
      const pending: PendingApproval = {
        payload,
        decide: (decision) => {
          CURRENT.set(undefined);
          resolve(decision);
        },
      };
      CURRENT.set(pending);
    });
  }) as Promise<ApprovalDecision>;
}

/** Hard-cancel: clear the queue + current item (e.g. session interrupt). */
export function clearApprovals(): void {
  queue.clear();
  const head = CURRENT.get();
  if (head) {
    head.decide({ accepted: false, userMessage: 'Session interrupted.' });
  }
  CURRENT.set(undefined);
}
