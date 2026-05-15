// Typed approval pipeline per docs/prd/cli-tui-ink/10-architecture.md §9.
//
// Each enqueued approval gets a position in a serial queue plus a slot on
// the `currentApproval` signal when its turn comes up. The modal calls
// `decide(decision)` to resolve and advance. Hard-cancel resolves every
// in-flight + pending entry so the original requester promises don't leak.

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
   * user's `e`-reject-with-feedback note; for the ExternalInquiry kind on
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

// Tracks every in-flight + queued resolver so `clearApprovals()` can settle
// them on session interrupt instead of leaving them dangling.
const pendingResolvers = new Set<(decision: ApprovalDecision) => void>();

export function enqueueApproval(
  payload: ApprovalPayload,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolveOuter) => {
    pendingResolvers.add(resolveOuter);
    void queue
      .add(async () => {
        await new Promise<void>((advance) => {
          const pending: PendingApproval = {
            payload,
            decide: (decision) => {
              if (!pendingResolvers.delete(resolveOuter)) return;
              CURRENT.set(undefined);
              resolveOuter(decision);
              advance();
            },
          };
          CURRENT.set(pending);
        });
      })
      .catch(() => {
        // Queue cleared while waiting — the matching resolver was either
        // settled by clearApprovals() or removed before scheduling.
        if (pendingResolvers.delete(resolveOuter)) {
          resolveOuter({
            accepted: false,
            userMessage: 'Session interrupted.',
          });
        }
      });
  });
}

/** Hard-cancel: settle every pending resolver so requesters don't hang. */
export function clearApprovals(): void {
  queue.clear();
  CURRENT.set(undefined);
  for (const resolve of [...pendingResolvers]) {
    pendingResolvers.delete(resolve);
    resolve({ accepted: false, userMessage: 'Session interrupted.' });
  }
}
